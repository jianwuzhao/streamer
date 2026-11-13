/**
 * Embedding 提供方（方案 §8.1）。
 *
 * 生产路径：OllamaEmbeddingProvider（Qwen3-Embedding-0.6B，CPU 部署，
 * 经 /api/embed；目标机验收）。
 * 测试桩（哈希伪向量/语义映射桩）在 src/testing/embedding-stubs.ts，
 * 仅测试引用，不得进入生产装配。
 */
export interface EmbeddingVector extends ReadonlyArray<number> {}

export interface EmbeddingProvider {
  /** 模型修订标识（索引 generation 迁移依据 §8.3） */
  readonly modelRevision: string
  readonly dimensions: number
  embed(texts: readonly string[]): Promise<readonly EmbeddingVector[]>
}

interface OllamaEmbedResponse {
  readonly embeddings?: readonly number[][]
  readonly error?: string
}

/** 目标机：真实语义模型（Qwen3-Embedding-0.6B）。 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelRevision: string
  private readonly opts: {
    baseURL: string
    model: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }

  constructor(opts: {
    baseURL: string
    model: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
  }) {
    this.opts = opts
    this.modelRevision = `ollama:${opts.model}`
  }

  get dimensions(): number {
    return 0 // 以首次实际返回为准
  }

  async embed(texts: readonly string[]): Promise<readonly EmbeddingVector[]> {
    if (texts.length === 0) return []
    const doFetch = this.opts.fetchImpl ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.opts.timeoutMs ?? 10_000)
    try {
      const res = await doFetch(`${this.opts.baseURL}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.opts.model, input: texts }),
        signal: controller.signal,
      })
      if (!res.ok) throw new Error(`ollama embed HTTP ${res.status}`)
      const body = (await res.json()) as OllamaEmbedResponse
      if (!body.embeddings) throw new Error(body.error ?? '响应缺少 embeddings')
      return body.embeddings
    } finally {
      clearTimeout(timer)
    }
  }
}
