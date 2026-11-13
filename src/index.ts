/**
 * dsh-dafeiyu-evolve 插件入口（阶段 A）。
 *
 * 阶段 A 不 import 宿主专属包（@deepseek-ai/*），保证仓库内独立
 * `pnpm build` / `pnpm test` 可执行；宿主事件接线（agent/pre-step waterfall、
 * session/event 等）与 Web UI 半在后续阶段接入 cordis.patch.yml。
 */
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
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
import { ConsolidationService } from './governance/consolidation.ts'
import { ReleaseController } from './governance/release.ts'
import { TrainingSamplePipeline } from './training/samples.ts'
import { TrainingScheduler } from './training/scheduler.ts'
import { createRequestHandler } from './host-api.ts'
import { DouyinAssistedAdapter } from './platform/adapter.ts'
import { loadPolicyPack } from './platform/policy-pack.ts'
import { LiveSession } from './live/session.ts'
import { TrainingEntry } from './live/training-entry.ts'
import { SettingsStore } from './settings/store.ts'
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
import { SkillRegistry } from './skills/registry.ts'
import {
  applyCloudOverrides,
  packageDir,
  registerBuiltinHandlers,
  seedSkillPackages,
  skillPackagesDir,
  sqliteCostTracker,
} from './index-wiring.ts'
import type { LearningRuntime } from './types.ts'

export interface DafeiyuPluginContext {
  configPath?: string
  dataDir?: string
  log?: (message: string, ...args: unknown[]) => void
  /**
   * 向量 embedding 提供方覆盖（依赖注入）：仅测试装配使用（传入
   * src/testing/embedding-stubs.ts 的桩）；生产缺省为 Ollama 真实语义模型。
   */
  embeddingProvider?: import('./retrieval/embedding.ts').EmbeddingProvider
}

export interface DafeiyuPluginHandle {
  readonly config: DafeiyuConfigType
  readonly featureGates: FeatureGates
  readonly settings: SettingsStore
  /** 数据目录（自检/诊断展示用） */
  readonly dataDir: string
  /** 实际加载的配置文件路径（未指定时为包内默认） */
  readonly configPath: string
  readonly db: DB
  readonly runtime: LearningRuntime
  readonly blackboard: BlackboardStore
  readonly arbiter: ResourceArbiter
  readonly policy: PolicyService
  readonly governance: {
    readonly releases: ReleaseController
    readonly consolidation: ConsolidationService
  }
  readonly training: {
    readonly samples: TrainingSamplePipeline
    readonly scheduler: TrainingScheduler
  }
  readonly live: {
    readonly session: LiveSession
    readonly trainingEntry: TrainingEntry
    readonly platform: DouyinAssistedAdapter
  }
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

/** 包根目录（lib/index.js 或 src/index.ts 均回溯到包根）；实现在 index-wiring.ts。 */
export { packageDir }

export function createPlugin(ctx: DafeiyuPluginContext = {}): DafeiyuPluginHandle {
  // 1. 基础配置（默认包内 config/default.yaml；null 预算 ⇒ 付费能力禁用）
  const configPath = ctx.configPath ?? join(packageDir(), 'config/default.yaml')
  const baseConfig = loadConfig(configPath)

  // 2. 存储与恢复（包内自定位：宿主安装后 cwd 不再是仓库目录）
  const dataDir = ctx.dataDir ?? process.env.DAFEIYU_DATA_DIR ?? join(packageDir(), 'data')
  const db = openDatabase(resolve(dataDir, 'dafeiyu.db'))
  const migration = migrate(db)
  if (migration.applied.length > 0) log(ctx, `已应用迁移：${migration.applied.join(', ')}`)
  const recovered = recoverPendingOperations(db)
  if (recovered > 0) log(ctx, `启动恢复：${recovered} 个未完成写入操作转入对账（reconcile_required）`)

  // 2.5 操作员设置（§24.1 向导输入的持久化）：云端覆盖重启生效；密钥仍走环境变量
  const settings = new SettingsStore(db)
  const config = applyCloudOverrides(baseConfig, settings.getCloud())
  const featureGates = getFeatureGates(config)
  if (!featureGates.cloudCallsEnabled) {
    log(ctx, `第三方调用禁用：${featureGates.cloudDisabledReasons.join('; ')}`)
  }
  if (config.killSwitch) {
    log(ctx, 'killSwitch=true：训练/发布/固化/个性化更新保持停用（§14）')
  }

  // 3. 模型适配器（本地优先：GPU → CPU 回退 → 第三方一次）
  const localBase = process.env.DAFEIYU_OLLAMA_URL ?? 'http://127.0.0.1:11434'
  const localGpu = new OllamaAdapter({
    baseURL: localBase,
    model: config.models.local.baseModel,
    route: 'local_gpu',
    maxOutputTokens: config.models.local.maxOutputTokens,
  })
  const localCpu = config.models.local.cpuFallbackEnabled
    ? new OllamaAdapter({
        baseURL: process.env.DAFEIYU_OLLAMA_CPU_URL ?? localBase,
        model: config.models.local.baseModel,
        route: 'local_cpu',
        maxOutputTokens: config.models.local.maxOutputTokens,
      })
    : undefined

  const providerConfigured = config.models.cloud.provider !== 'configure_before_acceptance'
  const cloud = new OpenAICompatCloudAdapter({
    baseURL: process.env.DAFEIYU_CLOUD_BASE_URL ?? 'http://127.0.0.1:9/v1',
    model: config.models.cloud.model === 'configure_before_acceptance' ? 'unset' : config.models.cloud.model,
    apiKey: process.env.DAFEIYU_CLOUD_API_KEY ?? '',
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
    (process.env.DAFEIYU_PROBE ?? 'auto') === 'ram-only' ? new UnknownGpuProbe() : new NvidiaSmiProbe()
  const arbiter = new ResourceArbiter(probe).start()

  // 5. 阶段 B 数据层：记忆、画像、技能、反馈、礼物
  const memory = new MemoryStore(db, {
    characterId: config.scope.characterId,
    l2TtlDays: config.memory.l2DefaultTtlDays,
    l2ReviewAfterDays: config.memory.l2ReviewAfterDays,
    l4TtlDays: config.memory.l4DefaultTtlDays,
    conflictDetection: config.memory.conflictDetection,
  })

  const releaseController = new ReleaseController(db, policy)
  const consolidationService = new ConsolidationService(db, policy, memory, {
    conditions: {
      minIndependentSessions: config.consolidation.minIndependentSessions,
      minEvidenceClusters: config.consolidation.minEvidenceClusters,
      observationDays: config.consolidation.observationDays,
      reviewEveryDays: config.consolidation.reviewEveryDays,
    },
  })
  const trainingSamples = new TrainingSamplePipeline(db)
  const trainingScheduler = new TrainingScheduler({
    db,
    config,
    featureGates,
    arbiter,
    policy,
    samples: trainingSamples,
    championReleaseId: releaseController.activeReleaseId() ?? 'rel-baseline',
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

  // 6. 阶段 C 检索：向量（目标机 Qwen3-Embedding）+ 图谱 + 三路融合。
  // 生产路径恒为真实语义模型（Ollama /api/embed）；测试经 ctx.embeddingProvider
  // 显式注入桩（src/testing/embedding-stubs.ts；§8.1 不以哈希向量替代语义模型）。
  const embeddingProvider: import('./retrieval/embedding.ts').EmbeddingProvider =
    ctx.embeddingProvider ??
    new OllamaEmbeddingProvider({
      baseURL: process.env.DAFEIYU_OLLAMA_URL ?? 'http://127.0.0.1:11434',
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
    releases: releaseController,
    consolidation: consolidationService,
  })

  // 6.5 第一次模拟开播服务已随演练子系统移除（v0.13.0）：
  // 现实链路 = 首次配置向导 → 本地预览（LiveSession）→ 真实开播。

  return {
    config,
    featureGates,
    settings,
    dataDir,
    configPath,
    db,
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
    governance: {
      releases: releaseController,
      consolidation: consolidationService,
    },
    live: {
      // 平台规则包随安装版本固定；缺包时开播 fail-closed（§23.2）
      session: new LiveSession(
        new DouyinAssistedAdapter(),
        existsSync(join(packageDir(), 'policy-packs/douyin/rules.json'))
          ? loadPolicyPack(join(packageDir(), 'policy-packs/douyin/rules.json'))
          : null,
        config.platform.id,
      ),
      trainingEntry: new TrainingEntry(trainingScheduler),
      platform: new DouyinAssistedAdapter(),
    },
    training: {
      samples: trainingSamples,
      scheduler: trainingScheduler,
    },
    dispose() {
      arbiter.stop()
      db.close()
    },
  }
}

// cordis 风格 activate 别名（宿主接入阶段直接使用）
export const activate = createPlugin

// ---------------------------------------------------------------------------
// 宿主 loader 入口（DSH 插件规范：name / inject / apply）
// ---------------------------------------------------------------------------

export const name = 'dsh-dafeiyu-evolve'
export const inject: readonly string[] = []

/** 宿主 apply：行 config.enabled=false 时跳过装配；ctx dispose 时释放资源。 */
export function apply(
  ctx: {
    logger?: { info(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void }
    on?(event: never, listener: never): unknown
  },
  config: { enabled?: boolean } = {},
): DafeiyuPluginHandle | null {
  if (config.enabled === false) {
    ctx.logger?.info('[dafeiyu] 行配置 disabled，跳过装配')
    return null
  }
  const handle = createPlugin({
    log: (message, ...args) => ctx.logger?.info(`[dafeiyu] ${message}`, ...args),
  })
  ctx.on?.('dispose' as never, (() => handle.dispose()) as never)
  // Web 面板同源后端：/api/dafeiyu/*（connection/request 瀑布，未匹配路径放行）
  const handler = createRequestHandler(handle)
  ctx.on?.('connection/request' as never, (async (req: unknown, res: unknown, next: () => Promise<void>) => {
    await handler(
      req as Parameters<typeof handler>[0],
      res as Parameters<typeof handler>[1],
      next,
    )
  }) as unknown as () => Promise<void> as never)
  ctx.logger?.info('[dafeiyu] 共享 API 就绪：/api/dafeiyu/*')
  return handle
}
