/**
 * 训练窗口调度器（方案 §3.2 / §9.2）。
 *
 * - 每 opportunityIntervalMinutes 评估一次机会：样本门（≥ minNewEligible）、
 *   资源门（free_vram ≥ peak + reserve；探测不可用 fail-safe）、
 *   政策门（policy-engine 签发 train 授权，payloadHash 绑定任务）；
 * - 执行全程记录状态机（prepare_cpu→…→warmup_champion），OOM/依赖缺失
 *   ⇒ failed 且 champion 不变；
 * - 恢复：resume_from 最近 checkpoint（数据游标 + 步数续跑）。
 */
import { get, nowIso, run, type DB } from '../storage/db.ts'
import type { PolicyService } from '../governance/policy-decision.ts'
import type { ResourceArbiter } from '../resources/arbiter.ts'
import type { DafeiyuConfigType, FeatureGates } from '../config.ts'
import { TrainingSamplePipeline } from './samples.ts'
import { jobPayloadHash, runTrainingWorker, newRunId, type TrainingJobSpec } from './worker.ts'

export interface SchedulerDeps {
  readonly db: DB
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly arbiter: ResourceArbiter
  readonly policy: PolicyService
  readonly samples: TrainingSamplePipeline
  readonly championReleaseId: string
  /** 训练峰值/余量（目标机小批次校准后写入配置；开发机取保守值） */
  readonly measuredTrainingPeakMb?: number
  readonly reserveMb?: number
  readonly workerCwd?: string
  readonly pythonCommand?: string
}

export type OpportunityVerdict =
  | { readonly admit: true; readonly runId: string }
  | {
      readonly admit: false
      readonly reason: 'training_disabled' | 'insufficient_samples' | 'insufficient_vram' | 'policy_denied'
      readonly detail: string
    }

export class TrainingScheduler {
  private readonly deps: SchedulerDeps

  constructor(deps: SchedulerDeps) {
    this.deps = deps
  }

  /** 评估训练窗口（不做任何启动动作）。 */
  evaluateOpportunity(): OpportunityVerdict {
    if (!this.deps.featureGates.trainingWindowsEnabled) {
      return {
        admit: false,
        reason: 'training_disabled',
        detail: this.deps.featureGates.trainingDisabledReasons.join('; '),
      }
    }
    const eligible = this.deps.samples.eligibleNewCount()
    if (eligible < this.deps.config.training.minNewEligibleSamples) {
      return {
        admit: false,
        reason: 'insufficient_samples',
        detail: `合格新样本 ${eligible} < ${this.deps.config.training.minNewEligibleSamples}`,
      }
    }
    const admission = this.deps.arbiter.evaluateTrainingAdmission({
      measuredTrainingPeakMb: this.deps.measuredTrainingPeakMb ?? 2500,
      reserveMb: this.deps.reserveMb ?? 400,
    })
    if (!admission.admit) {
      return { admit: false, reason: 'insufficient_vram', detail: admission.detail }
    }
    return { admit: true, runId: newRunId() }
  }

  /**
   * 执行一个训练窗口：政策授权 → 批量构建 → worker 分时执行 → 回执落库。
   * champion 全程不动（线上回答继续由冻结 champion 服务 §9.1）。
   */
  async executeWindow(opts: { mode?: 'dry_run' | 'qlora' } = {}): Promise<{
    readonly verdict: OpportunityVerdict
    readonly receipt: import('./worker.ts').TrainingReceipt | null
    readonly checkpointId: string | null
  }> {
    const verdict = this.evaluateOpportunity()
    if (!verdict.admit) return { verdict, receipt: null, checkpointId: null }
    const runId = verdict.runId
    const cfg = this.deps.config.training

    const batch = this.deps.samples.buildBatch({
      minNewEligible: cfg.minNewEligibleSamples,
      replayFraction: cfg.replayFraction,
      maxPerCluster: 3,
      maxPerSession: 5,
    })
    if ('error' in batch) {
      return {
        verdict: { admit: false, reason: 'insufficient_samples', detail: batch.error },
        receipt: null,
        checkpointId: null,
      }
    }
    const sampleRows = (this.deps.db.prepare(
      `SELECT redacted_text FROM training_samples WHERE sample_id IN (${batch.sampleIds.map(() => '?').join(',')})`,
    ).all(...batch.sampleIds) as Array<{ redacted_text: string }>).map((r) => ({ text: r.redacted_text }))

    // 政策授权（payloadHash 绑定任务；deny/过期即不启动 worker）
    const lastCheckpoint = get<{ checkpoint_id: string }>(
      this.deps.db,
      `SELECT checkpoint_id FROM checkpoints ORDER BY created_at DESC LIMIT 1`,
    )
    const specNoDecision = {
      run_id: runId,
      mode: opts.mode ?? 'dry_run',
      base_profile: cfg.baseProfile,
      max_steps: cfg.maxOptimizerStepsPerSlice,
      wall_budget_s: cfg.maxSliceWallSeconds,
      samples: sampleRows,
      replay_fraction: cfg.replayFraction,
      checkpoint_dir: `${process.env.DAFEIFYU_DATA_DIR ?? 'data'}/checkpoints`,
      resume_from: lastCheckpoint?.checkpoint_id ?? null,
    }
    const decision = this.deps.policy.issue({
      action: 'train',
      payloadHash: jobPayloadHash(specNoDecision),
      ttlMs: cfg.maxSliceWallSeconds * 1000 * 2,
    })
    if (decision.result !== 'allow') {
      return {
        verdict: { admit: false, reason: 'policy_denied', detail: `决策 ${decision.result}` },
        receipt: null,
        checkpointId: null,
      }
    }
    const spec: TrainingJobSpec = { ...specNoDecision, decision }

    run(
      this.deps.db,
      `INSERT INTO training_runs (run_id, base_profile, challenger_adapter, champion_release_id, decision_id, status, window_budget_ms, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      runId,
      cfg.baseProfile,
      `${runId}-challenger`,
      this.deps.championReleaseId,
      decision.id,
      cfg.maxSliceWallSeconds * 1000,
      nowIso(),
    )

    const { receipt } = await runTrainingWorker(spec, {
      ...(this.deps.pythonCommand !== undefined ? { command: this.deps.pythonCommand } : {}),
      cwd: this.deps.workerCwd ?? 'training-worker',
      timeoutMs: cfg.maxSliceWallSeconds * 1000 * 2,
    })

    if (receipt === null || receipt.state !== 'completed') {
      run(
        this.deps.db,
        `UPDATE training_runs SET status = 'failed', error = ?, optimizer_steps = ?, finished_at = ? WHERE run_id = ?`,
        receipt?.error ?? 'worker 无回执',
        receipt?.steps ?? 0,
        nowIso(),
        runId,
      )
      return { verdict, receipt, checkpointId: null }
    }

    // 状态机完成：记录 checkpoint 与 completed（champion_release_id 保持原值）
    run(
      this.deps.db,
      `INSERT INTO checkpoints (checkpoint_id, run_id, path, manifest, steps)
       VALUES (?, ?, ?, ?, ?)`,
      receipt.checkpoint_id,
      runId,
      `${spec.checkpoint_dir}/${receipt.checkpoint_id}`,
      JSON.stringify({ run_id: runId, steps: receipt.steps, params_changed: receipt.params_changed }),
      receipt.steps,
    )
    run(
      this.deps.db,
      `UPDATE training_runs SET status = 'completed', optimizer_steps = ?, finished_at = ? WHERE run_id = ?`,
      receipt.steps,
      nowIso(),
      runId,
    )
    return { verdict, receipt, checkpointId: receipt.checkpoint_id }
  }
}
