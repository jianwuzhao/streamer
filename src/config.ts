/**
 * 统一配置加载与校验（方案 §18 完整配置草案）。
 *
 * 语义：null 预算 / `configure_before_acceptance` 端点是部署前必填项，
 * 缺失时对应能力在 FeatureGate 中被判定为禁用，运行时使用时报明确错误，
 * 不默认为无限额度（方案 §18 注）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export class ConfigError extends Error {
  public readonly issues: readonly string[]
  constructor(
    message: string,
    issues: readonly string[] = [],
  ) {
    super(issues.length > 0 ? `${message}\n${issues.join('\n')}` : message)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

// ---------------------------------------------------------------------------
// Schema（与 config/default.yaml 一一对应）
// ---------------------------------------------------------------------------

const positiveInt = z.number().int().positive()
const nonNegativeInt = z.number().int().nonnegative()
const nonNegativeNumber = z.number().nonnegative()

export const DafeiyuConfig = z.object({
  mode: z.enum(['shadow', 'gray', 'live']),
  killSwitch: z.boolean(),
  productPreset: z.string().min(1),

  integration: z.object({
    semanticProvider: z.string().min(1),
    retrievalProvider: z.string().min(1),
    skillProvider: z.string().min(1),
    continualProvider: z.string().min(1),
    layerMap: z.string().min(1),
    singleWriter: z.boolean(),
    singleContextInjector: z.boolean(),
    disableProviderAutonomousWrites: z.boolean(),
  }),

  orchestration: z.object({
    backgroundConcurrency: positiveInt,
    subagentMaxDepth: nonNegativeInt,
    subagentMaxCountPerJob: nonNegativeInt,
    subagentMaxModelSteps: nonNegativeInt,
    sharedModelBudget: z.boolean(),
    backgroundMaxOutputTokens: positiveInt,
    refinementTarget: z.enum(['staging_only', 'production']),
    replaySideEffects: z.boolean(),
  }),

  platform: z.object({
    id: z.string().min(1),
    operationMode: z.enum(['assisted', 'human_driven']),
    requireVerifiedAllowedMode: z.boolean(),
    requirePlatformLiveReceipt: z.boolean(),
    aiLabelGuard: z.boolean(),
    onPolicyUnavailable: z.enum(['block_new_public_live', 'degrade_to_preview']),
  }),

  feedback: z.object({
    enabled: z.boolean(),
    requireTargetAttribution: z.boolean(),
    rewardSourceDedup: z.boolean(),
    rawGiftAmountTrainingWeight: nonNegativeNumber,
  }),

  gifts: z.object({
    enabled: z.boolean(),
    verifiedEventsOnlyForAcknowledgement: z.boolean(),
    viewerMergeWindowSeconds: nonNegativeInt,
    globalAckMinIntervalSeconds: nonNegativeInt,
    maxAckSpeechSeconds: nonNegativeNumber,
    publicSpendingStats: z.boolean(),
    settlementReconciliation: z.boolean(),
  }),

  scope: z.object({
    characterId: z.string().min(1),
    workspace: z.string().min(1),
    mutableLayers: z.array(z.string().min(1)).min(1),
    protectedNamespace: z.string().min(1),
    stableNamespace: z.string().min(1),
  }),

  models: z.object({
    routing: z.enum(['local_first']),
    local: z.object({
      engine: z.enum(['ollama']),
      baseModel: z.string().min(1),
      artifact: z.string().min(1),
      contextTokens: positiveInt,
      maxOutputTokens: positiveInt,
      concurrency: positiveInt,
      cpuFallbackEnabled: z.boolean(),
    }),
    cloud: z.object({
      enabled: z.boolean(),
      provider: z.string().min(1),
      model: z.string().min(1),
      credentialRef: z.string().min(1),
      maxAttemptsPerRequest: positiveInt.max(1),
      dailyBudgetCny: nonNegativeNumber.nullable(),
    }),
    totalDeadlineMs: positiveInt,
    localAttemptMs: positiveInt,
    outputReserveMs: nonNegativeInt,
    streamBeforeValidation: z.boolean(),
  }),

  memory: z.object({
    l2Enabled: z.boolean(),
    l2DefaultTtlDays: positiveInt,
    l2ReviewAfterDays: positiveInt,
    l4DefaultTtlDays: positiveInt,
    conflictDetection: z.boolean(),
    allowPersonaCoreWrite: z.boolean(),
  }),

  profiles: z.object({
    enabled: z.boolean(),
    coverage: z.enum(['all_observable_and_permitted']),
    scope: z.string().min(1),
    defaultCloudPermission: z.enum(['local_only', 'cloud_allowed']),
    defaultTrainingPermission: z.enum(['denied', 'granted_with_purpose']),
    rawEventRetentionDays: positiveInt,
    inactiveProfileRetentionDays: positiveInt,
    selfServiceAccessCorrectionDeletion: z.boolean(),
    personalizationOptOut: z.boolean(),
  }),

  retrieval: z.object({
    lexicalEnabled: z.boolean(),
    vectorEnabled: z.boolean(),
    graphEnabled: z.boolean(),
    embeddingModel: z.string().min(1),
    embeddingDevice: z.enum(['cpu', 'gpu']),
    fusion: z.enum(['rrf']),
    candidatesPerRoute: positiveInt,
    graphMaxHops: nonNegativeInt,
    graphMaxExpandedNodes: positiveInt,
    memoryTopK: positiveInt,
    skillTopK: positiveInt,
    combinedInjectedTokenLimit: positiveInt,
    latencyBudgetMs: positiveInt,
    strictScopeFilter: z.boolean(),
  }),

  skills: z.object({
    enabled: z.boolean(),
    requirePublishedManifest: z.boolean(),
    maxStepsPerRequest: nonNegativeInt,
    autoPublishWithinGrantedPermissions: z.boolean(),
    allowUnreviewedPrivilegeExpansion: z.boolean(),
  }),

  training: z.object({
    enabled: z.boolean(),
    offlineEnabled: z.boolean(),
    onlineEnabled: z.boolean(),
    onlineMode: z.enum(['gpu_time_slicing_with_cpu_serving']),
    baseProfile: z.string().min(1),
    method: z.enum(['qlora_sft']),
    minInitialReviewedSamples: positiveInt,
    minNewEligibleSamples: positiveInt,
    opportunityIntervalMinutes: positiveInt,
    maxSliceWallSeconds: positiveInt,
    maxOptimizerStepsPerSlice: positiveInt,
    sequenceLength: positiveInt,
    microBatchSize: positiveInt,
    gradientAccumulationSteps: positiveInt,
    replayFraction: nonNegativeNumber.max(1),
    requirePurposePermission: z.boolean(),
    dailyTrainingMinutesBudget: nonNegativeNumber.nullable(),
    trainingWindowCloudBudgetCny: nonNegativeNumber.nullable(),
  }),

  approval: z.object({
    autoPolicyEnabled: z.boolean(),
    failClosed: z.boolean(),
    bindPayloadHash: z.boolean(),
    requireHumanForPolicyOrPermissionExpansion: z.boolean(),
  }),

  release: z.object({
    autoPublish: z.boolean(),
    autoPromote: z.boolean(),
    autoRollback: z.boolean(),
    atomicRequestBoundarySwitch: z.boolean(),
    canaryBlockFractions: z.array(nonNegativeNumber).min(1),
    minSessionsPerStage: positiveInt,
    maxModelPromotionsPerDay: positiveInt,
    requireQuantizedArtifactEvaluation: z.boolean(),
  }),

  consolidation: z.object({
    enabled: z.boolean(),
    automatic: z.boolean(),
    sourceLayers: z.array(z.string().min(1)).min(1),
    targetLayers: z.array(z.string().min(1)).min(1),
    targetNamespace: z.string().min(1),
    minIndependentSessions: positiveInt,
    minEvidenceClusters: positiveInt,
    observationDays: positiveInt,
    reviewEveryDays: positiveInt,
    forbidProfileContent: z.boolean(),
    forbidPersonaCoreWrite: z.boolean(),
  }),

  coldStart: z.object({
    suggestedObservationDays: positiveInt,
    evidenceGatedModePromotion: z.boolean(),
  }),
})

export type DafeiyuConfigType = z.infer<typeof DafeiyuConfig>

/** 语义校验：zod 无法表达的跨字段规则 */
function validateSemantics(cfg: DafeiyuConfigType): readonly string[] {
  const issues: string[] = []
  if (cfg.memory.allowPersonaCoreWrite) {
    issues.push('memory.allowPersonaCoreWrite 必须为 false：人设内核禁止学习系统写入（§5.1）')
  }
  if (cfg.skills.allowUnreviewedPrivilegeExpansion) {
    issues.push('skills.allowUnreviewedPrivilegeExpansion 必须为 false：权限扩张需人工审核（§7.2）')
  }
  if (cfg.feedback.rawGiftAmountTrainingWeight !== 0) {
    issues.push('feedback.rawGiftAmountTrainingWeight 必须为 0：礼物金额不参与训练奖励（§10.3）')
  }
  if (cfg.models.outputReserveMs >= cfg.models.totalDeadlineMs) {
    issues.push('models.outputReserveMs 必须小于 totalDeadlineMs（§4.2）')
  }
  if (cfg.models.localAttemptMs >= cfg.models.totalDeadlineMs) {
    issues.push('models.localAttemptMs 必须小于 totalDeadlineMs（§4.2）')
  }
  return issues
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

export function parseConfig(text: string, source = '<inline>'): DafeiyuConfigType {
  let raw: unknown
  try {
    raw = parse(text)
  } catch (err) {
    throw new ConfigError(`${source}: YAML 解析失败：${(err as Error).message}`)
  }
  const parsed = DafeiyuConfig.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  ${source}: ${i.path.length > 0 ? i.path.join('.') : '<root>'} — ${i.message}`,
    )
    throw new ConfigError(`${source}: 配置校验失败`, issues)
  }
  const semantic = validateSemantics(parsed.data)
  if (semantic.length > 0) {
    throw new ConfigError(`${source}: 配置语义校验失败`, semantic.map((s) => `  ${source}: ${s}`))
  }
  return parsed.data
}

export function loadConfig(configPath?: string): DafeiyuConfigType {
  const path = configPath ?? resolve(process.cwd(), 'config/default.yaml')
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    throw new ConfigError(`无法读取配置文件 ${path}：${(err as Error).message}`)
  }
  return parseConfig(text, path)
}

// ---------------------------------------------------------------------------
// 能力开关（null 预算 ⇒ 对应付费能力禁用；§18 注）
// ---------------------------------------------------------------------------

export interface FeatureGates {
  /** 第三方付费调用可用：已启用、端点已配置且日预算非空 */
  readonly cloudCallsEnabled: boolean
  readonly cloudDisabledReasons: readonly string[]
  /** 在线训练窗口可申请：训练开启且日时长预算非空 */
  readonly trainingWindowsEnabled: boolean
  readonly trainingDisabledReasons: readonly string[]
}

export function getFeatureGates(cfg: DafeiyuConfigType): FeatureGates {
  const cloudDisabledReasons: string[] = []
  if (!cfg.models.cloud.enabled) cloudDisabledReasons.push('models.cloud.enabled=false')
  if (cfg.models.cloud.provider === 'configure_before_acceptance') {
    cloudDisabledReasons.push('models.cloud.provider 未配置（configure_before_acceptance）')
  }
  if (cfg.models.cloud.model === 'configure_before_acceptance') {
    cloudDisabledReasons.push('models.cloud.model 未配置（configure_before_acceptance）')
  }
  if (cfg.models.cloud.dailyBudgetCny === null) {
    cloudDisabledReasons.push('models.cloud.dailyBudgetCny=null（部署前必填，缺失即禁用付费调用）')
  }

  const trainingDisabledReasons: string[] = []
  if (!cfg.training.enabled) trainingDisabledReasons.push('training.enabled=false')
  if (!cfg.training.onlineEnabled) trainingDisabledReasons.push('training.onlineEnabled=false')
  if (cfg.training.dailyTrainingMinutesBudget === null) {
    trainingDisabledReasons.push('training.dailyTrainingMinutesBudget=null（部署前必填，缺失即禁用训练窗口）')
  }

  return {
    cloudCallsEnabled: cloudDisabledReasons.length === 0,
    cloudDisabledReasons,
    trainingWindowsEnabled: trainingDisabledReasons.length === 0,
    trainingDisabledReasons,
  }
}
