/**
 * dsh-dafeiyu-evolve 插件入口（阶段 A）。
 *
 * 阶段 A 不 import 宿主专属包（@deepseek-ai/*），保证仓库内独立
 * `pnpm build` / `pnpm test` 可执行；宿主事件接线（agent/pre-step waterfall、
 * session/event 等）与 Web UI 半在后续阶段接入 cordis.patch.yml。
 */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { BlackboardStore } from './blackboard/store.ts'
import { getFeatureGates, loadConfig, type DafeiyuConfigType, type FeatureGates } from './config.ts'
import { OpenAICompatCloudAdapter } from './adapters/cloud.ts'
import { OllamaAdapter } from './adapters/ollama.ts'
import { DeletionService } from './audience/deletion.ts'
import { ViewerIdentity } from './audience/identity.ts'
import { ProfileStore } from './audience/profile-store.ts'
import { FeedbackStore } from './feedback/feedback-store.ts'
import { GiftAckService } from './gifts/ack.ts'
import { GiftLedger } from './gifts/ledger.ts'
import { OllamaEmbeddingProvider } from './retrieval/embedding.ts'
import { GraphStore } from './retrieval/graph.ts'
import { RetrievalIndexer } from './retrieval/indexer.ts'
import { RetrievalService } from './retrieval/retrieval.ts'
import { VectorStore } from './retrieval/vector-store.ts'
import { MemoryStore } from './memory/l2-store.ts'
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
import { SkillExecutor } from './skills/executor.ts'
import { loadSkillPackage } from './skills/package-loader.ts'
import { SkillRegistry, SKILL_LIFECYCLE } from './skills/registry.ts'
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
  readonly memory: MemoryStore
  readonly audience: {
    readonly identity: ViewerIdentity
    readonly profiles: ProfileStore
    readonly deletion: DeletionService
  }
  readonly skills: {
    readonly registry: SkillRegistry
    readonly executor: SkillExecutor
  }
  readonly feedback: FeedbackStore
  readonly gifts: {
    readonly ledger: GiftLedger
    readonly ack: GiftAckService
    /** 便捷入口：入账 + 答谢入队（仅已验证且非退款增量入队） */
    ingestGift(input: Parameters<GiftLedger['ingest']>[0], nickname?: string): ReturnType<GiftLedger['ingest']>
  }
  readonly retrieval: {
    readonly service: RetrievalService
    readonly indexer: RetrievalIndexer
    readonly vector: VectorStore
    readonly graph: GraphStore
  }
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

  // 5. 阶段 B 数据层：记忆、画像、技能、反馈、礼物
  const memory = new MemoryStore(db, {
    characterId: config.scope.characterId,
    l2TtlDays: config.memory.l2DefaultTtlDays,
    l2ReviewAfterDays: config.memory.l2ReviewAfterDays,
    l4TtlDays: config.memory.l4DefaultTtlDays,
    conflictDetection: config.memory.conflictDetection,
  })
  const identity = new ViewerIdentity(db)
  const profiles = new ProfileStore(db)
  const deletionService = new DeletionService(db)
  const feedbackStore = new FeedbackStore(db)
  const giftLedger = new GiftLedger(db)
  const giftAck = new GiftAckService(db, {
    viewerMergeWindowMs: config.gifts.viewerMergeWindowSeconds * 1000,
    globalMinIntervalMs: config.gifts.globalAckMinIntervalSeconds * 1000,
    maxAckSpeechSeconds: config.gifts.maxAckSpeechSeconds,
    screen: (text) => !qualityGate.checkRequestText(text).pass,
  })

  const skillRegistry = new SkillRegistry(db, { grantedPermissions: [] })
  const skillExecutor = new SkillExecutor(db, skillRegistry, {
    grantedPermissions: [],
    maxStepsPerRequest: config.skills.maxStepsPerRequest,
  })
  registerBuiltinHandlers(skillExecutor, qualityGate)
  seedSkillPackages(skillRegistry, skillPackagesDir(), (message) => log(ctx, message))

  // 6. 阶段 C 检索：向量（目标机 Qwen3-Embedding）+ 图谱 + 三路融合
  const embeddingProvider = new OllamaEmbeddingProvider({
    baseURL: process.env.DAFEIFYU_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: config.retrieval.embeddingModel,
  })
  const vectorStore = new VectorStore(db)
  const graphStore = new GraphStore(db)
  const retrievalIndexer = new RetrievalIndexer(db, vectorStore, graphStore, embeddingProvider)
  const retrievalIndexerGeneration = retrievalIndexer.ensureGeneration()
  log(ctx, `检索索引就绪：generation=${retrievalIndexerGeneration} model=${config.retrieval.embeddingModel}`)
  const retrievalService = new RetrievalService({ db, vector: vectorStore, graph: graphStore, embedder: embeddingProvider, config })

  const runtime = new DafeiyuRuntime({
    db,
    config,
    featureGates,
    dedup,
    router,
    blackboard,
    memory,
    profiles,
    retrieval: retrievalService,
  })

  return {
    config,
    featureGates,
    runtime,
    blackboard,
    arbiter,
    policy,
    memory,
    audience: { identity, profiles, deletion: deletionService },
    skills: { registry: skillRegistry, executor: skillExecutor },
    feedback: feedbackStore,
    gifts: {
      ledger: giftLedger,
      ack: giftAck,
      ingestGift: (input, nickname) => {
        const result = giftLedger.ingest(input)
        if (!result.duplicate && !result.ignored && result.quantityDelta > 0 && input.verified) {
          giftAck.enqueue({
            entryId: result.entryId ?? 0,
            viewerKey: input.viewerKey,
            ...(nickname !== undefined ? { nickname } : {}),
            giftName: input.giftId,
            receivedAtMs: Date.parse(input.receivedAt ?? new Date().toISOString()),
          })
        }
        return result
      },
    },
    retrieval: {
      service: retrievalService,
      indexer: retrievalIndexer,
      vector: vectorStore,
      graph: graphStore,
    },
    dispose() {
      arbiter.stop()
      db.close()
    },
  }
}

function skillPackagesDir(): string {
  return process.env.DAFEIFYU_SKILL_PACKAGES ?? resolve(process.cwd(), 'skill-packages')
}

/**
 * 内置表达技能处理器：礼物答谢模板（本地拼装，不调用模型，§10.2）。
 */
function registerBuiltinHandlers(executor: SkillExecutor, qualityGate: QualityGate): void {
  executor.registerHandler('gift-ack-template', async (args) => {
    const input = args as { viewerNickname?: string; giftName: string; nameMention?: boolean }
    const mention =
      input.nameMention !== false &&
      input.viewerNickname !== undefined &&
      qualityGate.checkRequestText(input.viewerNickname).pass
        ? `感谢「${input.viewerNickname}」`
        : '谢谢这位朋友'
    const phrase = `${mention}送出的${input.giftName}，先把日子过好，咱们接着种田。`
    return {
      output: { phrase },
      toolReceipts: [{ tool: 'local-template', ok: true }],
    }
  })
}

/**
 * 播种技能包目录：表达/只读技能（无权限扩张）测试通过后自动发布
 * （draft→…→active 逐级推进，§7.2）；权限超出的技能停在 draft。
 */
function seedSkillPackages(registry: SkillRegistry, dir: string, onIssue: (message: string) => void): void {
  if (!existsSync(dir)) return
  for (const skillDir of readdirSync(dir, { withFileTypes: true })) {
    if (!skillDir.isDirectory()) continue
    const versionsRoot = resolve(dir, skillDir.name)
    for (const versionDir of readdirSync(versionsRoot, { withFileTypes: true })) {
      if (!versionDir.isDirectory()) continue
      const pkgDir = resolve(versionsRoot, versionDir.name)
      try {
        const pkg = loadSkillPackage(pkgDir)
        const registered = registry.register(pkg.manifest, { packagePath: pkgDir })
        if (registered.manifest.permissions.length === 0 && registered.manifest.kind !== 'action') {
          let idx = SKILL_LIFECYCLE.indexOf(registered.status as (typeof SKILL_LIFECYCLE)[number])
          idx = idx < 0 ? SKILL_LIFECYCLE.length - 1 : idx
          for (let i = idx + 1; i < SKILL_LIFECYCLE.length; i++) {
            registry.setStatus(registered.skillId, registered.version, SKILL_LIFECYCLE[i] as (typeof SKILL_LIFECYCLE)[number])
          }
        }
      } catch (err) {
        // 坏包跳过并留日志（不阻断启动）
        onIssue(`技能包 ${pkgDir} 注册失败: ${(err as Error).message}`)
      }
    }
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
