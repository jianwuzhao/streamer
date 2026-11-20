/**
 * 第三方模型适配器（OpenAI 兼容 Chat Completions；方案 §4.1 / §4.3 / §18 cloud）。
 *
 * 出域与预算硬闸门：
 * - 未启用 / 端点未配置（configure_before_acceptance）/ 日预算为 null 或已耗尽
 *   ⇒ 直接拒绝，不发起任何付费调用（§18 注：不默认为无限额度）；
 * - 主播互动由路由限制为一次实际请求，旧入口可使用一次空正文补齐；
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
import { responseLines } from './response-lines.ts'
import type { CloudRequestUsage, CloudUsageLedger } from '../routing/cloud-usage.ts'

export type CloudDisabledReason =
  | 'disabled_by_config'
  | 'provider_unconfigured'
  | 'budget_null'
  | 'budget_exhausted'
  | 'cooldown'

/** 单次调用生效的云端运行时配置（0.15.1：面板保存即时生效——resolve 每次调用时读取）。 */
export interface CloudRuntimeConfig {
  readonly baseURL: string
  readonly model: string
  readonly apiKey: string
  readonly enabled: boolean
  readonly providerConfigured: boolean
  readonly dailyBudgetCny: number | null
  readonly dailyRequestLimit?: number
  readonly inputCnyPerMillion?: number | null
  readonly outputCnyPerMillion?: number | null
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
  readonly model?: string
  readonly usage?: CloudRequestUsage
}

interface ChatStreamChunk {
  readonly model?: string
  readonly choices?: Array<{ readonly delta?: { readonly content?: string }; readonly finish_reason?: string | null }>
  readonly usage?: ChatCompletionsResponse['usage'] | null
  readonly error?: unknown
}

async function readChatStream(response: Response, onDraft: (text: string) => void,
  onUsage: (usage: CloudRequestUsage) => void): Promise<ChatCompletionsResponse> {
  let text = ''
  let model: string | undefined
  let finishReason: string | undefined
  let usage: ChatCompletionsResponse['usage']
  let done = false
  for await (const line of responseLines(response)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') {
      done = true
      break
    }
    if (!data) continue
    const chunk = JSON.parse(data) as ChatStreamChunk
    if (chunk.error) throw new ModelCallError('LOCAL_UNAVAILABLE', '云端流式回复中断')
    model = chunk.model || model
    usage = chunk.usage ?? usage
    if (chunk.usage) onUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (choice?.delta?.content) {
      text += choice.delta.content
      onDraft(text)
    }
    finishReason = choice?.finish_reason ?? finishReason
  }
  if (!done && !finishReason) throw new ModelCallError('LOCAL_UNAVAILABLE', '云端未返回流式回复结束标记')
  return {
    choices: [{ message: { content: text }, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
  }
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
    ledger?: CloudUsageLedger
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }
  /** 运行时配置：优先 resolve()（实时视图），否则装配时静态字段。 */
  private readonly resolveRuntime: () => CloudRuntimeConfig
  private cooldown: { channel: string; until: number } | undefined
  private transportFailures: { channel: string; count: number } | undefined

  constructor(opts: Partial<CloudRuntimeConfig> & {
    costTracker: CloudCostTracker
    ledger?: CloudUsageLedger
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
    const channel = this.id
    if (callOpts?.singleCloudRequest && this.cooldown?.channel === channel && this.cooldown.until > Date.now()) {
      throw new CloudDisabledError(['cooldown'])
    }
    const { signal, cleanup } = combineSignals(callOpts?.signal, timeoutMs)
    const doFetch = this.opts.fetchImpl ?? fetch
    const onDraft = req.responseSchema === undefined ? callOpts?.onDraft : undefined
    try {
      const doPost = async (maxTokens: number): Promise<ChatCompletionsResponse> => {
        signal?.throwIfAborted()
        const inputCeiling = req.messages.reduce((sum, message) => sum + Buffer.byteLength(message.text) + 16, 16)
        const settle = this.opts.ledger?.reserve({ model: rt.model, requestLimit: rt.dailyRequestLimit ?? 100,
          budgetCny: Math.max(0, (rt.dailyBudgetCny ?? 0) - this.opts.costTracker.getSpentTodayCny()), inputCeiling, outputCeiling: maxTokens,
          inputRate: rt.inputCnyPerMillion ?? null, outputRate: rt.outputCnyPerMillion ?? null })
        if (this.opts.ledger && !settle) throw new CloudDisabledError(['budget_exhausted'])
        let body: ChatCompletionsResponse | undefined
        let observedUsage: CloudRequestUsage | undefined
        try {
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
              ...(onDraft ? { stream: true, stream_options: { include_usage: true } } : {}),
              ...(req.responseSchema !== undefined ? { response_format: { type: 'json_object' } } : {}),
            }),
            ...(signal !== undefined ? { signal } : {}),
          })
          if (!res.ok) {
            if (res.status === 429 || res.status >= 500) this.cooldown = { channel, until: Date.now() + 15_000 }
            observedUsage = (await res.json().catch(() => undefined) as ChatCompletionsResponse | undefined)?.usage
            throw new ModelCallError('LOCAL_UNAVAILABLE', `云端 HTTP ${res.status} ${res.statusText}`)
          }
          body = onDraft && res.headers.get('content-type')?.includes('text/event-stream')
            ? await readChatStream(res, onDraft, (usage) => { observedUsage = usage }) : await res.json() as ChatCompletionsResponse
          this.transportFailures = undefined
          return body
        } finally {
          settle?.(body?.usage ?? observedUsage, body !== undefined)
        }
      }
      const firstTokens = callOpts?.singleCloudRequest ? Math.max(req.maxOutputTokens ?? 128, 512) : req.maxOutputTokens ?? 128
      let body = await doPost(firstTokens)
      const attempts = [body]
      // 推理模型（思考型，如 hy4 / R1 系）：思考先消耗 max_tokens 把正文截空时，
      // 单次补齐令牌预算重试（仍属同一次逻辑生成，不循环付费调用）
      const emptyContent = (body.choices?.[0]?.message?.content ?? '').trim() === ''
      if (!callOpts?.singleCloudRequest && emptyContent && body.choices?.[0]?.finish_reason === 'length') {
        body = await doPost(Math.max(1024, firstTokens * 4))
        attempts.push(body)
      }
      const text = body.choices?.[0]?.message?.content
      if (typeof text !== 'string' || (onDraft && !text.trim())) {
        throw new ModelCallError('LOCAL_UNAVAILABLE', '云端响应缺少 choices[0].message.content')
      }
      const sum = (read: (usage: ChatCompletionsResponse['usage']) => number | undefined) => {
        const values = attempts.map((attempt) => read(attempt.usage))
        return values.every((value): value is number => Number.isSafeInteger(value) && value! >= 0)
          ? values.reduce((total, value) => total + value, 0) : undefined
      }
      const tokensIn = sum((usage) => usage?.prompt_tokens)
      const tokensOut = sum((usage) => usage?.completion_tokens)
      const tokensTotal = sum((usage) => usage?.total_tokens ??
        (usage?.prompt_tokens !== undefined && usage.completion_tokens !== undefined ?
          usage.prompt_tokens + usage.completion_tokens : undefined))
      return {
        text, model: body.model || rt.model,
        ...(tokensIn === undefined ? {} : { tokensIn }),
        ...(tokensOut === undefined ? {} : { tokensOut }),
        ...(tokensTotal === undefined ? {} : { tokensTotal }),
        ...(body.choices?.[0]?.finish_reason !== undefined
          ? { finishReason: body.choices[0]?.finish_reason }
          : {}),
      }
    } catch (err) {
      if (err instanceof CloudDisabledError) throw err
      if (err instanceof ModelCallError) throw err
      if (!callOpts?.signal?.aborted) {
        const count = this.transportFailures?.channel === channel ? this.transportFailures.count + 1 : 1
        this.transportFailures = { channel, count }
        if (count >= 2) this.cooldown = { channel, until: Date.now() + 15_000 }
      }
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
