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
  readonly choices?: Array<{ readonly message?: { readonly content?: string }; readonly finish_reason?: string }>
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
    baseURL: string
    model: string
    apiKey: string
    enabled: boolean
    providerConfigured: boolean
    dailyBudgetCny: number | null
    costTracker: CloudCostTracker
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }
  private readonly disabledReasons: CloudDisabledReason[]

  constructor(opts: {
    baseURL: string
    model: string
    apiKey: string
    enabled: boolean
    providerConfigured: boolean
    dailyBudgetCny: number | null
    costTracker: CloudCostTracker
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }) {
    this.opts = opts
    const reasons: CloudDisabledReason[] = []
    if (!opts.enabled) reasons.push('disabled_by_config')
    if (!opts.providerConfigured) reasons.push('provider_unconfigured')
    if (opts.dailyBudgetCny === null) reasons.push('budget_null')
    this.disabledReasons = reasons
  }

  get id(): string {
    return `cloud:${this.opts.baseURL}:${this.opts.model}`
  }

  get model(): string {
    return this.opts.model
  }

  /** 预算检查：null（禁用）或今日已耗尽 → 拒绝（§19：预算耗尽停止新增付费调用）。 */
  checkBudget(): void {
    if (this.disabledReasons.length > 0) throw new CloudDisabledError(this.disabledReasons)
    const spent = this.opts.costTracker.getSpentTodayCny()
    if (spent >= (this.opts.dailyBudgetCny ?? 0)) {
      throw new CloudDisabledError(['budget_exhausted'])
    }
  }

  async generate(req: GenerateRequest, callOpts?: GenerateOptions): Promise<GenerateResult> {
    assertCapabilities(this, req)
    this.checkBudget()
    const { signal, cleanup } = combineSignals(callOpts?.signal, this.opts.timeoutMs ?? 8_000)
    const doFetch = this.opts.fetchImpl ?? fetch
    try {
      const res = await doFetch(`${this.opts.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({
          model: this.opts.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
          max_tokens: req.maxOutputTokens ?? 128,
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
      const body = (await res.json()) as ChatCompletionsResponse
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
