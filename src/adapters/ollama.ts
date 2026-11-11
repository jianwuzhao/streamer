/**
 * Ollama 本地模型适配器（方案 §3.1 / §18 models.local：engine=ollama）。
 * 超时/不可达映射为 LOCAL_TIMEOUT / LOCAL_UNAVAILABLE；能力探测走 /api/show。
 */
import {
  assertCapabilities,
  combineSignals,
  ModelCallError,
  type GenerateOptions,
  type GenerateRequest,
  type GenerateResult,
  type ModelAdapter,
  type ModelCapabilities,
} from './model-adapter.ts'

const DEFAULT_TIMEOUT_MS = 5_000

interface OllamaChatResponse {
  readonly message?: { readonly content?: string }
  readonly prompt_eval_count?: number
  readonly eval_count?: number
  readonly done_reason?: string
}

interface OllamaShowResponse {
  readonly capabilities?: readonly string[]
  readonly error?: string
}

export class OllamaAdapter implements ModelAdapter {
  readonly route: 'local_gpu' | 'local_cpu'
  private readonly opts: {
    baseURL: string
    model: string
    route?: 'local_gpu' | 'local_cpu'
    maxOutputTokens?: number
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }

  readonly capabilities: ModelCapabilities = {
    text: true,
    structuredOutput: false,
    toolCalling: false,
    image: false,
  }

  constructor(opts: {
    baseURL: string
    model: string
    route?: 'local_gpu' | 'local_cpu'
    maxOutputTokens?: number
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }) {
    this.opts = opts
    this.route = opts.route ?? 'local_gpu'
  }

  get id(): string {
    return `ollama:${this.opts.route ?? 'local_gpu'}:${this.opts.model}`
  }

  get model(): string {
    return this.opts.model
  }

  async generate(req: GenerateRequest, callOpts?: GenerateOptions): Promise<GenerateResult> {
    assertCapabilities(this, req)
    const timeoutMs = callOpts?.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const { signal, cleanup } = combineSignals(callOpts?.signal, timeoutMs)
    const doFetch = this.opts.fetchImpl ?? fetch
    try {
      const res = await doFetch(`${this.opts.baseURL}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.opts.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.text })),
          stream: false,
          options: { num_predict: req.maxOutputTokens ?? this.opts.maxOutputTokens ?? 128 },
        }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!res.ok) {
        throw new ModelCallError(
          res.status === 404 ? 'LOCAL_UNAVAILABLE' : 'LOCAL_UNAVAILABLE',
          `ollama HTTP ${res.status} ${res.statusText}`,
        )
      }
      const body = (await res.json()) as OllamaChatResponse
      const text = body.message?.content
      if (typeof text !== 'string') {
        throw new ModelCallError('LOCAL_UNAVAILABLE', 'ollama 响应缺少 message.content')
      }
      return {
        text,
        ...(body.prompt_eval_count !== undefined ? { tokensIn: body.prompt_eval_count } : {}),
        ...(body.eval_count !== undefined ? { tokensOut: body.eval_count } : {}),
        ...(body.done_reason !== undefined ? { finishReason: body.done_reason } : {}),
      }
    } catch (err) {
      throw mapFetchError(err, this.id)
    } finally {
      cleanup()
    }
  }

  /** 能力探测：读取 /api/show 的 capabilities（探测失败保持保守默认，不默认全能）。 */
  async probe(): Promise<ModelCapabilities> {
    const doFetch = this.opts.fetchImpl ?? fetch
    const { signal, cleanup } = combineSignals(undefined, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const res = await doFetch(`${this.opts.baseURL}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model }),
        ...(signal !== undefined ? { signal } : {}),
      })
      if (!res.ok) {
        // 探测失败：保持声明能力不变（保守值），由注册处决定是否可用
        return this.capabilities
      }
      const body = (await res.json()) as OllamaShowResponse
      const caps = body.capabilities ?? []
      return {
        text: true,
        structuredOutput: false,
        toolCalling: caps.includes('tools'),
        image: caps.includes('vision'),
      }
    } catch {
      return this.capabilities
    } finally {
      cleanup()
    }
  }
}

/** 网络错误 → 原因码：超时 LOCAL_TIMEOUT，其余本地不可达 LOCAL_UNAVAILABLE。 */
export function mapFetchError(err: unknown, adapterId: string): Error {
  if (err instanceof ModelCallError) return err
  const msg = err instanceof Error ? err.message : String(err)
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
  if (aborted || /timeout|aborted|预算|budget/i.test(msg)) {
    return new ModelCallError('LOCAL_TIMEOUT', `${adapterId} 超时`, err)
  }
  return new ModelCallError('LOCAL_UNAVAILABLE', `${adapterId} 不可达：${msg}`, err)
}
