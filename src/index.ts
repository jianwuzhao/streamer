/**
 * dsh-dafeiyu-evolve 插件入口（阶段 A）。
 *
 * 阶段 A 不 import 宿主专属包（@deepseek-ai/*），保证仓库内独立
 * `pnpm build` / `pnpm test` 可执行；宿主事件接线（agent/pre-step waterfall、
 * session/event 等）与 Web UI 半在后续阶段接入 cordis.patch.yml。
 */
import { resolve } from 'node:path'
import { BlackboardStore } from './blackboard/store.ts'
import { getFeatureGates, loadConfig, type DafeiyuConfigType, type FeatureGates } from './config.ts'
import { OpenAICompatCloudAdapter } from './adapters/cloud.ts'
import { OllamaAdapter } from './adapters/ollama.ts'
import { PolicyService } from './governance/policy-decision.ts'
import { EventDedup } from './perception/dedup.ts'
import { ResourceArbiter } from './resources/arbiter.ts'
import { NvidiaSmiProbe, UnknownGpuProbe, type ResourceProbe } from './resources/probe.ts'
import { GenerationRegistry } from './routing/budget.ts'
import { QualityGate } from './routing/quality-gate.ts'
import { RequestRouter } from './routing/router.ts'
import { DafeiyuRuntime, SqliteUsageRecorder } from './runtime.ts'
import { migrate, openDatabase, type DB } from './storage/db.ts'
import { recoverPendingOperations } from './storage/outbox.ts'
import type { LearningRuntime } from './types.ts'

export interface DafeiyuPluginContext {
  configPath?: string
  dataDir?: string
  log?: (message: string, ...args: unknown[]) => void
}

export interface DafeiyuPluginHandle {
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly runtime: LearningRuntime
  readonly blackboard: BlackboardStore
  readonly arbiter: ResourceArbiter
  readonly policy: PolicyService
  dispose(): void
}

const log = (ctx: DafeiyuPluginContext, message: string): void => {
  ctx.log?.(message)
}

export function createPlugin(ctx: DafeiyuPluginContext = {}): DafeiyuPluginHandle {
  // 1. 配置与能力开关（null 预算 ⇒ 付费能力禁用）
  const config = loadConfig(ctx.configPath)
  const featureGates = getFeatureGates(config)
  if (!featureGates.cloudCallsEnabled) {
    log(ctx, `第三方调用禁用：${featureGates.cloudDisabledReasons.join('; ')}`)
  }
  if (config.killSwitch) {
    log(ctx, 'killSwitch=true：训练/发布/固化/个性化更新保持停用（§14）')
  }

  // 2. 存储与恢复
  const dataDir = ctx.dataDir ?? process.env.DAFEIFYU_DATA_DIR ?? resolve(process.cwd(), 'data')
  const db = openDatabase(resolve(dataDir, 'dafeiyu.db'))
  const migration = migrate(db)
  if (migration.applied.length > 0) log(ctx, `已应用迁移：${migration.applied.join(', ')}`)
  const recovered = recoverPendingOperations(db)
  if (recovered > 0) log(ctx, `启动恢复：${recovered} 个未完成写入操作转入对账（reconcile_required）`)

  // 3. 模型适配器（本地优先：GPU → CPU 回退 → 第三方一次）
  const localBase = process.env.DAFEIFYU_OLLAMA_URL ?? 'http://127.0.0.1:11434'
  const localGpu = new OllamaAdapter({
    baseURL: localBase,
    model: config.models.local.baseModel,
    route: 'local_gpu',
    maxOutputTokens: config.models.local.maxOutputTokens,
  })
  const localCpu = config.models.local.cpuFallbackEnabled
    ? new OllamaAdapter({
        baseURL: process.env.DAFEIFYU_OLLAMA_CPU_URL ?? localBase,
        model: config.models.local.baseModel,
        route: 'local_cpu',
        maxOutputTokens: config.models.local.maxOutputTokens,
      })
    : undefined

  const providerConfigured = config.models.cloud.provider !== 'configure_before_acceptance'
  const cloud = new OpenAICompatCloudAdapter({
    baseURL: process.env.DAFEIFYU_CLOUD_BASE_URL ?? 'http://127.0.0.1:9/v1',
    model: config.models.cloud.model === 'configure_before_acceptance' ? 'unset' : config.models.cloud.model,
    apiKey: process.env.DAFEIFYU_CLOUD_API_KEY ?? '',
    enabled: config.models.cloud.enabled,
    providerConfigured,
    dailyBudgetCny: config.models.cloud.dailyBudgetCny,
    costTracker: sqliteCostTracker(db),
  })

  // 4. 路由、治理与资源
  const usage = new SqliteUsageRecorder(db)
  const qualityGate = new QualityGate()
  const registry = new GenerationRegistry()
  const router = new RequestRouter({
    config,
    featureGates,
    qualityGate,
    usage,
    localGpu,
    ...(localCpu !== undefined ? { localCpu } : {}),
    cloud,
    registry,
  })
  const dedup = new EventDedup(db)
  const blackboard = new BlackboardStore(db)
  const policy = new PolicyService(db, { policyVersion: `phase-a/${config.productPreset}` })

  const probe: ResourceProbe =
    (process.env.DAFEIFYU_PROBE ?? 'auto') === 'ram-only' ? new UnknownGpuProbe() : new NvidiaSmiProbe()
  const arbiter = new ResourceArbiter(probe).start()

  const runtime = new DafeiyuRuntime({ db, config, featureGates, dedup, router, blackboard })

  return {
    config,
    featureGates,
    runtime,
    blackboard,
    arbiter,
    policy,
    dispose() {
      arbiter.stop()
      db.close()
    },
  }
}

/** 云端成本记账：usage 表当日合计（阶段 A 简化实现；对账以服务商账单为准 §19）。 */
function sqliteCostTracker(db: DB) {
  return {
    getSpentTodayCny(): number {
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const row = db
        .prepare('SELECT COALESCE(SUM(cost_cny), 0) AS total FROM usage WHERE created_at >= ?')
        .get(todayStart.toISOString()) as { total: number } | undefined
      return row?.total ?? 0
    },
    add(costCny: number): void {
      db.prepare(`INSERT INTO audit (action, summary) VALUES ('cloud_cost', ?)`).run(`+${costCny} CNY`)
    },
  }
}

// cordis 风格 activate 别名（宿主接入阶段直接使用）
export const activate = createPlugin
