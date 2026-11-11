/**
 * 受控技能执行器（方案 §7.2）。
 *
 * 执行链：active 实时检查 → 权限校验 → 输入 schema 校验 → 幂等键去重 →
 * 处理器执行 → 后置条件（输出 schema + 工具回执）验证 → 失败走技能
 * 定义的 fallback，禁止编造成功。全程记录 retrieved/selected/executed/
 * succeeded/failed/skipped 与工具回执。
 */
import { randomUUID } from 'node:crypto'
import { nowIso, run, type DB } from '../storage/db.ts'
import type { SkillRegistry } from './registry.ts'
import { validateSchemaSubset } from './schema-check.ts'

export interface SkillToolReceipt {
  readonly tool: string
  readonly ok: boolean
  readonly detail?: string
}

export interface SkillHandlerResult {
  readonly output: unknown
  readonly toolReceipts: readonly SkillToolReceipt[]
}

export type SkillHandler = (args: unknown) => Promise<SkillHandlerResult>

export interface SkillRunReceipt {
  readonly runId: string
  readonly skillId: string
  readonly version: string
  readonly outcome: 'succeeded' | 'failed' | 'skipped'
  readonly reason?: string
  readonly output?: unknown
  readonly fallbackText?: string
  readonly duplicate: boolean
  readonly toolReceipts: readonly SkillToolReceipt[]
}

export interface ExecuteInput {
  readonly requestId: string
  readonly skillId: string
  readonly version: string
  readonly arguments: unknown
}

export class SkillExecutor {
  private readonly db: DB
  private readonly registry: SkillRegistry
  private readonly grantedPermissions: readonly string[]
  private readonly handlers = new Map<string, SkillHandler>()

  constructor(
    db: DB,
    registry: SkillRegistry,
    opts: {
      grantedPermissions: readonly string[]
      maxStepsPerRequest?: number
      clock?: () => string
    } = { grantedPermissions: [] },
  ) {
    this.db = db
    this.registry = registry
    this.grantedPermissions = opts.grantedPermissions
    this.clock = opts.clock ?? nowIso
    this.maxStepsPerRequest = opts.maxStepsPerRequest ?? 2
  }
  private readonly clock: () => string
  private readonly maxStepsPerRequest: number

  registerHandler(handlerKey: string, handler: SkillHandler): void {
    this.handlers.set(handlerKey, handler)
  }

  async execute(input: ExecuteInput): Promise<SkillRunReceipt> {
    const idempotencyKey = `${input.requestId}:${input.skillId}:${input.version}`
    const runId = `run_${randomUUID().slice(0, 12)}`
    const startedAt = this.clock()

    // 幂等：同请求同技能已成功 → 直接复用（不重复副作用）
    const existing = this.findSucceeded(idempotencyKey)
    if (existing) {
      return { ...existing, duplicate: true }
    }

    this.recordRun(runId, input, idempotencyKey, 'selected', startedAt)

    // 1. 撤销实时检查
    const skill = this.registry.get(input.skillId, input.version)
    if (!skill) return this.fail(runId, input, 'skipped', 'skill_not_registered')
    if (!this.registry.isActive(input.skillId, input.version)) {
      return this.fail(runId, input, 'skipped', `skill_not_active(${skill.status})`)
    }

    // 2. 权限
    const ungranted = skill.manifest.permissions.filter((p) => !this.grantedPermissions.includes(p))
    if (ungranted.length > 0) {
      return this.fail(runId, input, 'skipped', `permission_not_granted(${ungranted.join(',')})`)
    }

    // 3. 每请求步骤上限
    const used = this.countStepsToday(input.requestId)
    if (used >= this.maxStepsPerRequest) {
      return this.fail(runId, input, 'skipped', 'max_steps_per_request')
    }

    // 4. 输入 schema
    if (skill.manifest.inputSchema !== undefined) {
      const issues = validateSchemaSubset(input.arguments, skill.manifest.inputSchema)
      if (issues.length > 0) {
        return this.fail(
          runId,
          input,
          'failed',
          `input_schema:${issues[0]?.path} ${issues[0]?.message}`,
          skill.manifest.fallback,
        )
      }
    }

    // 5. 处理器执行
    const handler = this.handlers.get(skill.manifest.handler)
    if (handler === undefined) {
      return this.fail(runId, input, 'failed', `handler_missing(${skill.manifest.handler})`)
    }
    this.recordRun(runId, input, idempotencyKey, 'executed', startedAt)
    let result: SkillHandlerResult
    try {
      result = await handler(input.arguments)
    } catch (err) {
      return this.fail(runId, input, 'failed', `handler_error:${(err as Error).message}`, skill.manifest.fallback)
    }

    // 6. 后置条件：输出 schema + 声明的工具回执全部成功
    if (skill.manifest.outputSchema !== undefined) {
      const issues = validateSchemaSubset(result.output, skill.manifest.outputSchema)
      if (issues.length > 0) {
        return this.fail(
          runId, input, 'failed',
          `postcondition_output_schema:${issues[0]?.path} ${issues[0]?.message}`,
          skill.manifest.fallback,
          result.toolReceipts,
        )
      }
    }
    const failedReceipt = result.toolReceipts.find((r) => !r.ok)
    if (failedReceipt) {
      return this.fail(
        runId, input, 'failed',
        `postcondition_tool:${failedReceipt.tool}`,
        skill.manifest.fallback,
        result.toolReceipts,
      )
    }

    run(
      this.db,
      `UPDATE skill_runs SET outcome = 'succeeded', tool_receipts = ?, finished_at = ? WHERE run_id = ?`,
      JSON.stringify(result.toolReceipts),
      this.clock(),
      runId,
    )
    return {
      runId,
      skillId: input.skillId,
      version: input.version,
      outcome: 'succeeded',
      output: result.output,
      duplicate: false,
      toolReceipts: result.toolReceipts,
    }
  }

  // -------------------------------------------------------------------------

  private findSucceeded(idempotencyKey: string): SkillRunReceipt | undefined {
    const row = this.db
      .prepare(`SELECT * FROM skill_runs WHERE idempotency_key = ? AND outcome = 'succeeded'`)
      .get(idempotencyKey) as
      | { run_id: string; skill_id: string; version: string; tool_receipts: string; arguments: string }
      | undefined
    if (!row) return undefined
    return {
      runId: row.run_id,
      skillId: row.skill_id,
      version: row.version,
      outcome: 'succeeded',
      output: JSON.parse(row.arguments) as unknown,
      duplicate: false,
      toolReceipts: JSON.parse(row.tool_receipts) as SkillToolReceipt[],
    }
  }

  private countStepsToday(requestId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM skill_runs WHERE request_id = ? AND outcome IN ('executed','succeeded','failed')`)
      .get(requestId) as { n: number }
    return row?.n ?? 0
  }

  private recordRun(
    runId: string,
    input: ExecuteInput,
    idempotencyKey: string,
    outcome: string,
    startedAt: string,
  ): void {
    run(
      this.db,
      `INSERT OR REPLACE INTO skill_runs (run_id, skill_id, version, request_id, idempotency_key, arguments, outcome, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      input.skillId,
      input.version,
      input.requestId,
      idempotencyKey,
      JSON.stringify(input.arguments ?? {}),
      outcome,
      startedAt,
    )
  }

  private fail(
    runId: string,
    input: ExecuteInput,
    outcome: 'failed' | 'skipped',
    reason: string,
    fallbackText?: string,
    toolReceipts: readonly SkillToolReceipt[] = [],
  ): SkillRunReceipt {
    run(
      this.db,
      `UPDATE skill_runs SET outcome = ?, error = ?, tool_receipts = ?, finished_at = ? WHERE run_id = ?`,
      outcome,
      reason,
      JSON.stringify(toolReceipts),
      this.clock(),
      runId,
    )
    return {
      runId,
      skillId: input.skillId,
      version: input.version,
      outcome,
      reason,
      ...(fallbackText !== undefined ? { fallbackText } : {}),
      duplicate: false,
      toolReceipts,
    }
  }
}
