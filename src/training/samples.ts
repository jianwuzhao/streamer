/**
 * 训练样本管道（方案 §9.3）。
 *
 * 新事件 → 用途过滤 → 脱敏 → 来源校验 → 去重分组 → 质量验证
 * → 已授权数据流（training_samples）。
 *
 * - 不采集隐藏推理链，只保存可见上下文/最终回答/工具轨迹的表达样本；
 * - 观众个体资料不进参数：vw_* 伪名与长数字标识在入库前脱敏；
 * - 第三方输出许可不明（allowed_third_party 之外）不入库；
 * - 去重分组：近重复文本（三元组 Jaccard ≥ 0.9）同簇，批量采样按簇限量；
 * - split 隔离：heldout（冻结测试集）按簇保留，不参与梯度更新。
 */
import { randomUUID } from 'node:crypto'
import { all, get, run, type DB } from '../storage/db.ts'
import { trigramSimilarity } from '../routing/quality-gate.ts'

export type TrainingSourceKind =
  | 'human_correction'
  | 'verified_local_reply'
  | 'allowed_third_party'
  | 'skill_trajectory'
  | 'counterexample'

export interface SampleInput {
  readonly sourceKind: TrainingSourceKind
  /** 用途许可：调用方已按 §9.3 校验（如第三方输出允许训练） */
  readonly purposeAllowed: boolean
  readonly text: string
  readonly sessionId: string
  readonly origin?: string
}

export interface SampleAdmitResult {
  readonly sampleId: string | null
  readonly rejected?: 'purpose_not_allowed' | 'empty_text' | 'third_party_not_allowed'
  readonly clusterId?: string
}

const MIN_TEXT_LENGTH = 4

/** 脱敏：vw_* 伪名、11+ 位数字标识、手机/身份证样式（§9.3 观众资料不进参数）。 */
export function redact(text: string): string {
  return text
    .replace(/vw_[a-f0-9]{6,32}/g, '[viewer]')
    .replace(/\b\d{11,19}\b/g, '[id]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]')
}

export class TrainingSamplePipeline {
  private readonly db: DB
  private readonly clusterReps: Array<{ clusterId: string; text: string }> = []

  constructor(db: DB) {
    this.db = db
    for (const row of all<{ cluster_id: string; redacted_text: string }>(
      this.db,
      `SELECT DISTINCT cluster_id, redacted_text FROM training_samples ORDER BY created_at DESC LIMIT 500`,
    )) {
      this.clusterReps.push({ clusterId: row.cluster_id, text: row.redacted_text })
    }
  }

  ingest(input: SampleInput): SampleAdmitResult {
    if (!input.purposeAllowed) return { sampleId: null, rejected: 'purpose_not_allowed' }
    if (input.sourceKind === 'allowed_third_party' && (input.origin ?? '') === '') {
      return { sampleId: null, rejected: 'third_party_not_allowed' }
    }
    const redacted = redact(input.text).trim()
    if (redacted.length < MIN_TEXT_LENGTH) return { sampleId: null, rejected: 'empty_text' }

    // 去重分组：与既有簇代表近重复（≥0.9）则并入
    let clusterId = `cl_${randomUUID().slice(0, 10)}`
    for (const rep of this.clusterReps) {
      if (trigramSimilarity(redacted, rep.text) >= 0.9) {
        clusterId = rep.clusterId
        break
      }
    }
    this.clusterReps.push({ clusterId, text: redacted })

    const sampleId = `ts_${randomUUID().slice(0, 12)}`
    // split 隔离：每第 5 个新簇进 heldout（冻结测试集不参与梯度 §9.3）
    const newCluster = !this.db
      .prepare('SELECT 1 FROM training_samples WHERE cluster_id = ?')
      .get(clusterId)
    const split: 'train' | 'heldout' =
      newCluster && this.countClusters() % 5 === 0 ? 'heldout' : 'train'
    run(
      this.db,
      `INSERT INTO training_samples (sample_id, source_kind, purpose_ok, redacted_text, cluster_id, session_id, origin, status, split)
       VALUES (?, ?, 1, ?, ?, ?, ?, 'validated', ?)`,
      sampleId,
      input.sourceKind,
      redacted,
      clusterId,
      input.sessionId,
      input.origin ?? '',
      split,
    )
    return { sampleId, clusterId }
  }

  /** 批量构建：新样本/历史回放约 30%/70%，按簇与场次设上限（§9.3）。 */
  buildBatch(opts: {
    readonly minNewEligible: number
    readonly replayFraction: number
    readonly maxPerCluster: number
    readonly maxPerSession: number
  }): { sampleIds: readonly string[]; datasetId: string } | { error: 'insufficient_new_samples'; newCount: number } {
    const newSamples = all<{ sample_id: string; cluster_id: string; session_id: string }>(
      this.db,
      `SELECT sample_id, cluster_id, session_id FROM training_samples
       WHERE status = 'validated' AND split = 'train'
       ORDER BY created_at DESC`,
    )
    if (newSamples.length < opts.minNewEligible) {
      return { error: 'insufficient_new_samples', newCount: newSamples.length }
    }
    const fresh = this.capByGroups(newSamples.slice(0, Math.ceil(newSamples.length * (1 - opts.replayFraction))), opts)
    const replayPool = newSamples.slice(Math.ceil(newSamples.length * (1 - opts.replayFraction)))
    const replay = this.capByGroups(replayPool, opts)
    const ids = [...new Set([...fresh, ...replay])]
    const datasetId = `ds_${randomUUID().slice(0, 10)}`
    run(
      this.db,
      `INSERT INTO datasets (dataset_id, kind, sample_ids) VALUES (?, 'online_batch', ?)`,
      datasetId,
      JSON.stringify(ids),
    )
    return { sampleIds: ids, datasetId }
  }

  private capByGroups(
    rows: readonly { sample_id: string; cluster_id: string; session_id: string }[],
    opts: { maxPerCluster: number; maxPerSession: number },
  ): string[] {
    const perCluster = new Map<string, number>()
    const perSession = new Map<string, number>()
    const out: string[] = []
    for (const r of rows) {
      const c = perCluster.get(r.cluster_id) ?? 0
      const s = perSession.get(r.session_id) ?? 0
      if (c >= opts.maxPerCluster || s >= opts.maxPerSession) continue
      perCluster.set(r.cluster_id, c + 1)
      perSession.set(r.session_id, s + 1)
      out.push(r.sample_id)
    }
    return out
  }

  private countClusters(): number {
    const row = get<{ n: number }>(this.db, 'SELECT COUNT(DISTINCT cluster_id) AS n FROM training_samples')
    return row?.n ?? 0
  }

  eligibleNewCount(): number {
    const row = get<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM training_samples WHERE status='validated' AND split='train'`,
    )
    return row?.n ?? 0
  }
}
