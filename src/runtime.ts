/**
 * LearningRuntime 最小实现（阶段 A）：ingest + answer 全链路，
 * 其余接口显式抛出 NotImplementedError（声明能力边界，不做静默空实现）。
 */
import type { AnswerReceipt, DurableReceipt, LearningRuntime, LiveEnvelope, LiveRequest } from './types.ts'
import { NotImplementedError } from './types.ts'
import type { BlackboardStore } from './blackboard/store.ts'
import type { DafeiyuConfigType, FeatureGates } from './config.ts'
import { EventDedup } from './perception/dedup.ts'
import { RequestRouter, type RouteContext, type UsageEntry, type UsageRecorder } from './routing/router.ts'
import { run, type DB } from './storage/db.ts'

/** usage 表记录器：路由每次尝试都留痕（模型生成、工具执行与播出分别记录 §2.2）。 */
export class SqliteUsageRecorder implements UsageRecorder {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  record(entry: UsageEntry): number | null {
    try {
      const res = run(
        this.db,
        `INSERT INTO usage (request_id, generation_epoch, route, reason_code, model, latency_ms, tokens_in, tokens_out, cost_cny)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.requestId,
        entry.epoch,
        entry.route,
        entry.reasonCode ?? null,
        entry.model ?? null,
        entry.latencyMs,
        entry.tokensIn ?? null,
        entry.tokensOut ?? null,
        entry.costCny ?? 0,
      )
      return Number((res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0) || null
    } catch {
      return null
    }
  }
}

export interface RuntimeDeps {
  readonly db: DB
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly dedup: EventDedup
  readonly router: RequestRouter
  readonly blackboard: BlackboardStore
}

export class DafeiyuRuntime implements LearningRuntime {
  private readonly deps: RuntimeDeps

  constructor(deps: RuntimeDeps) {
    this.deps = deps
  }

  async ingest(event: LiveEnvelope): Promise<DurableReceipt> {
    const verdict = this.deps.dedup.ingest(event)
    return {
      eventId: verdict.eventId,
      duplicate: verdict.duplicate,
      late: verdict.late,
      processed: verdict.processed,
    }
  }

  answer(request: LiveRequest, ctx?: RouteContext): Promise<AnswerReceipt> {
    return this.deps.router.route(request, ctx ?? { recentReplies: [] })
  }

  // ---- 阶段 B 起实现 ------------------------------------------------------

  updateProfile(): Promise<{ revision: number }> {
    throw new NotImplementedError('updateProfile', 'B（完整数据层）')
  }

  proposeCognition(): Promise<{ ref: string }> {
    throw new NotImplementedError('proposeCognition', 'B（完整数据层）')
  }

  retrieve(): Promise<never> {
    throw new NotImplementedError('retrieve', 'C（检索优化）')
  }

  trainSlice(): Promise<never> {
    throw new NotImplementedError('trainSlice', 'D（在线与离线训练）')
  }

  evaluateRelease(): Promise<never> {
    throw new NotImplementedError('evaluateRelease', 'E（自动发布与固化）')
  }

  publish(): Promise<never> {
    throw new NotImplementedError('publish', 'E（自动发布与固化）')
  }

  consolidate(): Promise<never> {
    throw new NotImplementedError('consolidate', 'E（自动发布与固化）')
  }

  rollback(): Promise<never> {
    throw new NotImplementedError('rollback', 'E（自动发布与固化）')
  }
}
