/**
 * 模型适配器统一契约（方案 §2.1 / §4.1）。
 *
 * - 能力在注册时探测，不能把「任意 LLM」视为支持所有模态（§2.4）；
 * - 失败统一映射为原因码，交由路由决策，适配器不自重试。
 */
import type { ReasonCode } from '../types.ts'

export interface ModelCapabilities {
  /** 纯文本对话 */
  readonly text: boolean
  /** JSON 结构化输出（严格 schema） */
  readonly structuredOutput: boolean
  /** 工具/函数调用 */
  readonly toolCalling: boolean
  /** 图像输入（多模态） */
  readonly image: boolean
}

export interface GenerateMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly text: string
}

export interface GenerateRequest {
  readonly messages: readonly GenerateMessage[]
  readonly maxOutputTokens?: number
  /** 请求严格 JSON 输出时提供；适配器能力不足须以 UNSUPPORTED_CAPABILITY 拒绝 */
  readonly responseSchema?: object
}

export interface GenerateResult {
  readonly text: string
  readonly tokensIn?: number
  readonly tokensOut?: number
  readonly finishReason?: string
}

export interface GenerateOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

/** 模型调用失败：携带路由原因码（§4.1）。 */
export class ModelCallError extends Error {
  public readonly reasonCode: ReasonCode
  public override readonly cause?: unknown
  constructor(reasonCode: ReasonCode, message: string, cause?: unknown) {
    super(`${reasonCode}: ${message}`)
    this.name = 'ModelCallError'
    this.reasonCode = reasonCode
    if (cause !== undefined) this.cause = cause
  }
}

export interface ModelAdapter {
  readonly id: string
  readonly route: 'local_gpu' | 'local_cpu' | 'cloud'
  readonly model: string
  readonly capabilities: ModelCapabilities
  generate(req: GenerateRequest, opts?: GenerateOptions): Promise<GenerateResult>
  /** 探测真实能力（注册时调用一次；探测失败按能力未知处理，禁止默认全能）。 */
  probe?(): Promise<ModelCapabilities>
}

/** 通用前置检查：请求的能力超出声明能力时拒绝（不发起无效调用，§4.1）。 */
export function assertCapabilities(
  adapter: ModelAdapter,
  req: GenerateRequest,
): void {
  if (req.responseSchema !== undefined && !adapter.capabilities.structuredOutput) {
    throw new ModelCallError('UNSUPPORTED_CAPABILITY', `${adapter.id} 不支持结构化输出`)
  }
}

/** AbortSignal 合并：外部取消 + 超时取先到者。 */
export function combineSignals(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  signal: AbortSignal | undefined
  cleanup: () => void
} {
  if (signal === undefined && timeoutMs === undefined) return { signal: undefined, cleanup: () => {} }
  const controller = new AbortController()
  const timer =
    timeoutMs !== undefined ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : undefined
  const onAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}
