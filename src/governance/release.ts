/**
 * 联合发布控制器（方案 §12.1–§12.4）。
 *
 * - 不可变联合版本：persona/模型/记忆/技能/检索/路由清单 + 哈希；
 * - 状态链 candidate → automated_checks → staged → canary → active，
 *   任一步失败 → rejected / suspended / rollback；
 * - 灰度 5%→20%→50%→100%，每阶段至少两场次（观察不足停留当前阶段）；
 * - 每天最多一次模型晋级（同一候选设观察冷却）；
 * - 回滚：治理 epoch+1 阻断被撤回版本的新授权/执行，恢复上一 active 清单；
 * - 发布只读取结构化验证报告（verdict=pass 且未过期）。
 */
import { randomUUID } from 'node:crypto'
import { get, nowIso, run, type DB } from '../storage/db.ts'
import type { PolicyService } from './policy-decision.ts'
import { manifestHash, Verifier, type ReleaseManifest } from './verifier.ts'
import type { PolicyDecision, VerificationReport } from '../types.ts'

export type ReleaseStatus =
  | 'candidate'
  | 'rejected'
  | 'staged'
  | 'canary'
  | 'active'
  | 'suspended'
  | 'rolled_back'
  | 'retired'

export const CANARY_LADDER = [0.05, 0.2, 0.5, 1.0] as const

interface ReleaseRow {
  release_id: string
  candidate_hash: string
  manifest: string
  status: ReleaseStatus
  canary_fraction: number
  previous_release_id: string | null
  verification_report_id: string | null
}

export class ReleaseController {
  private readonly db: DB
  private readonly policy: PolicyService
  private readonly verifier: Verifier
  private readonly clock: () => string

  constructor(db: DB, policy: PolicyService, opts: { clock?: () => string } = {}) {
    this.db = db
    this.policy = policy
    this.verifier = new Verifier(db, opts.clock !== undefined ? { clock: opts.clock } : {})
    this.clock = opts.clock ?? nowIso
  }

  /** 提交候选（不可变清单落库，返回 releaseId）。 */
  submitCandidate(manifest: ReleaseManifest): { releaseId: string; candidateHash: string } {
    const releaseId = `rel_${randomUUID().slice(0, 12)}`
    const hash = manifestHash(manifest)
    run(
      this.db,
      `INSERT INTO releases (release_id, candidate_hash, manifest, status, previous_release_id)
       VALUES (?, ?, ?, 'candidate', ?)`,
      releaseId,
      hash,
      JSON.stringify(manifest),
      this.activeReleaseId(),
    )
    return { releaseId, candidateHash: hash }
  }

  /**
   * 自动检查（§12.1 automated_checks）：pass ⇒ staged；fail ⇒ rejected；
   * inconclusive ⇒ 保持 candidate 继续观察（不放宽、不跳过）。
   */
  runAutomatedChecks(releaseId: string): VerificationReport {
    const release = this.mustGet(releaseId)
    if (release.status !== 'candidate') {
      throw new Error(`仅 candidate 可执行自动检查（当前 ${release.status}）`)
    }
    const manifest = JSON.parse(release.manifest) as ReleaseManifest
    const report = this.verifier.verify({
      manifest,
      candidateHash: release.candidate_hash,
      baselineReleaseId: release.previous_release_id ?? 'baseline',
    })
    const next: ReleaseStatus = report.verdict === 'pass' ? 'staged' : report.verdict === 'fail' ? 'rejected' : 'candidate'
    run(
      this.db,
      `UPDATE releases SET status = ?, verification_report_id = ? WHERE release_id = ?`,
      next,
      report.reportId,
      releaseId,
    )
    return report
  }

  /** 进入灰度（首个 5% 时间块）。 */
  enterCanary(releaseId: string): void {
    const release = this.mustGet(releaseId)
    if (release.status !== 'staged') throw new Error(`仅 staged 可进灰度（当前 ${release.status}）`)
    run(this.db, `UPDATE releases SET status = 'canary', canary_fraction = ? WHERE release_id = ?`, CANARY_LADDER[0], releaseId)
  }

  /**
   * 灰度晋级：观察数据（场次/样本）不足 ⇒ 停留当前阶段；到 100% ⇒ active。
   * 模型发布每天最多晋级一次（同日第二次晋级拒绝 §12.3）。
   */
  advanceCanary(releaseId: string, observation: { sessions: number; samples: number }): { fraction: number; activated: boolean } {
    const release = this.mustGet(releaseId)
    if (release.status !== 'canary') throw new Error(`仅 canary 可晋级（当前 ${release.status}）`)
    if (observation.sessions < 2) {
      return { fraction: release.canary_fraction, activated: false } // 样本不足停留当前阶段
    }
    const idx = CANARY_LADDER.findIndex((f) => f >= release.canary_fraction - 1e-9)
    const next = CANARY_LADDER[Math.min(idx + 1, CANARY_LADDER.length - 1)]
    if (next === undefined) throw new Error('灰度阶梯异常')
    if (next >= 1.0) {
      this.assertDailyPromotionBudget()
      const previous = this.activeReleaseId()
      run(
        this.db,
        `UPDATE releases SET status = 'active', canary_fraction = 1.0, activated_at = ? WHERE release_id = ?`,
        this.clock(),
        releaseId,
      )
      if (previous !== null && previous !== releaseId) {
        run(this.db, `UPDATE releases SET status = 'retired', retired_at = ? WHERE release_id = ?`, this.clock(), previous)
      }
      return { fraction: 1.0, activated: true }
    }
    run(this.db, `UPDATE releases SET canary_fraction = ? WHERE release_id = ?`, next, releaseId)
    return { fraction: next, activated: false }
  }

  /**
   * 回滚（§12.4）：epoch+1（旧授权即刻失效）→ 恢复上一 active 清单 →
   * 被撤回版本标记 rolled_back。5 秒内阻断由 epoch 校验的同步性保证。
   */
  rollback(releaseId: string): { restoredReleaseId: string } {
    const release = this.mustGet(releaseId)
    if (release.status !== 'active') throw new Error(`仅 active 可回滚（当前 ${release.status}）`)
    const previous = release.previous_release_id
    const newEpoch = this.policy.bumpEpoch()
    run(this.db, `UPDATE releases SET status = 'rolled_back', retired_at = ? WHERE release_id = ?`, this.clock(), releaseId)
    if (previous !== null) {
      run(
        this.db,
        `UPDATE releases SET status = 'active', retired_at = NULL WHERE release_id = ? AND status = 'retired'`,
        previous,
      )
      return { restoredReleaseId: previous }
    }
    // 无上一版本：回到基线（epoch 阻断被撤回内容的新授权）
    void newEpoch
    return { restoredReleaseId: 'baseline' }
  }

  /** 当前 active 清单（blackboard activeReleaseId / 上下文装配来源）。 */
  activeReleaseId(): string | null {
    const row = get<{ release_id: string }>(
      this.db,
      `SELECT release_id FROM releases WHERE status = 'active' ORDER BY activated_at DESC LIMIT 1`,
    )
    return row?.release_id ?? null
  }

  activeManifest(): ReleaseManifest | null {
    const id = this.activeReleaseId()
    if (id === null) return null
    const row = get<{ manifest: string }>(this.db, 'SELECT manifest FROM releases WHERE release_id = ?', id)
    return row ? (JSON.parse(row.manifest) as ReleaseManifest) : null
  }

  get(releaseId: string): ReleaseRow | undefined {
    return get<ReleaseRow>(this.db, 'SELECT * FROM releases WHERE release_id = ?', releaseId)
  }

  /** 按候选哈希定位发布（publish 授权绑定 payloadHash → releaseId）。 */
  findIdByCandidateHash(candidateHash: string): string | null {
    const row = get<{ release_id: string }>(
      this.db,
      `SELECT release_id FROM releases WHERE candidate_hash = ? ORDER BY created_at DESC LIMIT 1`,
      candidateHash,
    )
    return row?.release_id ?? null
  }

  /**
   * 发布授权签发（§11.1）：payloadHash 绑定候选；发布服务不使用自由文本评估。
   */
  issuePublishGrant(releaseId: string): PolicyDecision {
    const release = this.mustGet(releaseId)
    return this.policy.issue({ action: 'publish', payloadHash: release.candidate_hash })
  }

  private assertDailyPromotionBudget(): void {
    const today = this.clock().slice(0, 10)
    const row = get<{ n: number }>(
      this.db,
      `SELECT COUNT(*) AS n FROM releases WHERE status IN ('active','retired','rolled_back') AND activated_at LIKE ?`,
      `${today}%`,
    )
    if ((row?.n ?? 0) > 0) {
      throw new Error(`每日最多一次模型晋级：${today} 已有晋级记录（§12.3）`)
    }
  }

  private mustGet(releaseId: string): ReleaseRow {
    const row = this.get(releaseId)
    if (!row) throw new Error(`发布不存在: ${releaseId}`)
    return row
  }
}
