/**
 * 第三方模型适配器（OpenAI 兼容 Chat Completions；方案 §4.1 / §4.3 / §18 cloud）。
 *
 * 出域与预算硬闸门：
 * - 未启用 / 端点未配置（configure_before_acceptance）/ 日预算为 null 或已耗尽
 *   ⇒ 直接拒绝，不发起任何付费调用（§18 注：不默认为无限额度）；
 * - 每逻辑请求最多一次第三方生成由路由保证，适配器自身不重试；
 * - 凭据由适配器持有（credentialRef），模型请求体不携带凭据，不上传完整档案。
 */
import {
  assertCapabilities,
  combineSignals,
  ModelCallError,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type ModelAdapter,
} from './model-adapter.ts'

export type CloudDisabledReason =
  | 'disabled_by_config'
  | 'provider_unconfigured'
  | 'budget_null'
  | 'budget_exhausted'

/** 单次调用生效的云端运行时配置（0.15.1：面板保存即时生效——resolve 每次调用时读取）。 */
export interface CloudRuntimeConfig {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly enabled: boolean
  readonly providerConfigured: boolean
  readonly dailyBudgetCny: number | null
}

export class CloudDisabledError extends Error {
  public readonly reasons: readonly CloudDisabledReason[]
  constructor(reasons: readonly CloudDisabledReason[]) {
    super(`第三方调用被禁用：${reasons.join(', ')}`)
    this.name = 'CloudDisabledError'
    this.reasons = reasons
  }
}

export interface CloudCostTracker {
  /** 今日已花费（人民币元） */
  getSpentTodayCny(): number
  /** 记录一次实际花费 */
  add(costCny: number): void
}

interface ChatCompletionsResponse {
  readonly choices?: Array<{
    readonly message?: { readonly content?: string; readonly reasoning_content?: string }
    readonly finish_reason?: string
  }>
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number }
}

export class OpenAICompatCloudAdapter implements ModelAdapter {
  readonly route = 'cloud' as const
  readonly capabilities = {
    text: true,
    structuredOutput: true,
    toolCalling: true,
    image: false,
  }

  private readonly opts: {
    costTracker: CloudCostTracker
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }
  /** 运行时配置：优先 resolve()（实时视图），否则装配时静态字段。 */
  private readonly resolveRuntime: () => CloudRuntimeConfig

  constructor(opts: Partial<CloudRuntimeConfig> & {
    costTracker: CloudCostTracker
    timeoutMs?: number
    fetchImpl?: typeof fetch
    /** 运行时配置解析（优先于静态字段；0.15.1 起面板保存即时生效） */
    resolve?: () => CloudRuntimeConfig
  }) {
    this.opts = opts
    const staticConfig: CloudRuntimeConfig = {
      baseURL: opts.baseURL ?? '',
      model: opts.model ?? '',
      apiKey: opts.apiKey ?? '',
      enabled: opts.enabled ?? false,
      providerConfigured: opts.providerConfigured ?? false,
      dailyBudgetCny: opts.dailyBudgetCny ?? null,
    }
    this.resolveRuntime = opts.resolve ?? (() => staticConfig)
  }

  private disabledReasonsNow(): CloudDisabledReason[] {
    const rt = this.resolveRuntime()
    const reasons: CloudDisabledReason[] = []
    if (!rt.enabled) reasons.push('disabled_by_config')
    if (!rt.providerConfigured) reasons.push('provider_unconfigured')
    if (rt.dailyBudgetCny === null) reasons.push('budget_null')
    return reasons
  }

  get id(): string {
    const rt = this.resolveRuntime()
    return `cloud:${rt.baseURL}:${rt.model}`
  }

  get model(): string {
    return this.resolveRuntime().model
  }

  /** 预算检查：null（禁用）或今日已耗尽 → 拒绝（§19：预算耗尽停止新增付费调用）。 */
  checkBudget(): void {
    const reasons = this.disabledReasonsNow()
    if (reasons.length > 0) throw new CloudDisabledError(reasons)
    const rt = this.resolveRuntime()
    const spent = this.opts.costTracker.getSpentTodayCny()
    if (spent >= (rt.dailyBudgetCny ?? 0)) {
      throw new CloudDisabledError(['budget_exhausted'])
    }
  }

  async generate(req: GenerateRequest, callOpts?: GenerateOptions): Promise<GenerateResult> {
    assertCapabilities(this, req)
    this.checkBudget()
    const rt = this.resolveRuntime()
    const timeoutMs = Math.min(callOpts?.timeoutMs ?? Infinity, this.opts.timeoutMs ?? 8_000)
    const { signal, cleanup } = combineSignals(callOpts?.signal, timeoutMs)
    const doFetch = this.opts.fetchImpl ?? fetch
    try {
      const doPost = async (maxTokens: number): Promise<ChatCompletionsResponse> => {
        const res = await doFetch(`${rt.baseURL}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${rt.apiKey}`,
          },
          body: JSON.stringify({
            model: rt.model,
            messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
            max_tokens: maxTokens,
            ...(req.responseSchema !== undefined
              ? { response_format: { type: 'json_object' } }
              : {}),
          }),
          ...(signal !== undefined ? { signal } : {}),
        })
        if (!res.ok) {
          throw new ModelCallError(
            'LOCAL_UNAVAILABLE',
            `云端 HTTP ${res.status} ${res.statusText}`,
          )
        }
        return (await res.json()) as ChatCompletionsResponse
      }
      const firstTokens = req.maxOutputTokens ?? 128
      let body = await doPost(firstTokens)
      // 推理模型（思考型，如 hy4 / R1 系）：思考先消耗 max_tokens 把正文截空时，
      // 单次补齐令牌预算重试（仍属同一次逻辑生成，不循环付费调用）
      const emptyContent = (body.choices?.[0]?.message?.content ?? '').trim() === ''
      if (emptyContent && body.choices?.[0]?.finish_reason === 'length') {
        body = await doPost(Math.max(1024, firstTokens * 4))
      }
      const text = body.choices?.[0]?.message?.content
      if (typeof text !== 'string') {
        throw new ModelCallError('LOCAL_UNAVAILABLE', '云端响应缺少 choices[0].message.content')
      }
      return {
        text,
        ...(body.usage?.prompt_tokens !== undefined ? { tokensIn: body.usage.prompt_tokens } : {}),
        ...(body.usage?.completion_tokens !== undefined
          ? { tokensOut: body.usage.completion_tokens }
          : {}),
        ...(body.choices?.[0]?.finish_reason !== undefined
          ? { finishReason: body.choices[0]?.finish_reason }
          : {}),
      }
    } catch (err) {
      if (err instanceof CloudDisabledError) throw err
      if (err instanceof ModelCallError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
      if (aborted || /timeout|aborted|预算|budget/i.test(msg)) {
        throw new ModelCallError('LOCAL_TIMEOUT', `云端请求超时`, err)
      }
      throw new ModelCallError('LOCAL_UNAVAILABLE', `云端不可达：${msg}`, err)
    } finally {
      cleanup()
    }
  }
}
