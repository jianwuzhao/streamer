/**
 * Embedding 提供方（方案 §8.1）。
 *
 * - 生产路径：OllamaEmbeddingProvider（Qwen3-Embedding-0.6B，CPU 部署，
 *   经 /api/embed；目标机验收）；
 * - 测试桩：HashingEmbeddingProvider 与 StubSemanticEmbeddingProvider
 *   仅供开发/测试——哈希向量不得替代语义模型用于验收（§8.1）。
 */
import { tokenize } from './bm25.ts'

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

/**
 * 测试/开发专用：token 哈希伪向量。**不得用于语义验收**（§8.1：
 * 不以哈希向量替代语义模型）。
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly modelRevision = 'test:hashing'
  readonly dimensions: number

  constructor(dimensions = 256) {
    this.dimensions = dimensions
  }

  async embed(texts: readonly string[]): Promise<readonly EmbeddingVector[]> {
    return texts.map((t) => this.hashEmbed(t))
  }

  private hashEmbed(text: string): EmbeddingVector {
    const vec: number[] = new Array<number>(this.dimensions).fill(0)
    for (const tok of tokenize(text)) {
      const h = hash31(tok)
      const i1 = h % this.dimensions
      const i2 = (h >>> 8) % this.dimensions
      vec[i1] = (vec[i1] ?? 0) + 1
      vec[i2] = (vec[i2] ?? 0) + 0.5
    }
    return normalize(vec)
  }
}

/**
 * 测试专用：语义映射桩——按关键词簇构造确定向量，用于验证
 * 「向量路召回同义/别名而词法路不命中」的融合逻辑。
 */
export class StubSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly modelRevision = 'test:stub-semantic'
  readonly dimensions = 32
  private readonly clusters = new Map<string, number[]>()

  /** 注册同义簇：同一簇的词共享基础向量（加少量个体扰动仍高相似） */
  defineCluster(clusterKey: string, words: readonly string[]): void {
    if (!this.clusters.has(clusterKey)) {
      const base: number[] = new Array<number>(this.dimensions).fill(0)
      for (let i = 0; i < this.dimensions; i++) {
        base[i] = hash31(`${clusterKey}:${i}`) % 7 === 0 ? 1 : 0
      }
      this.clusters.set(clusterKey, [...normalize(base)])
    }
    const base = this.clusters.get(clusterKey)
    if (base === undefined) return
    for (const w of words) this.clusters.set(`w:${w}`, [...base])
  }

  async embed(texts: readonly string[]): Promise<readonly EmbeddingVector[]> {
    return texts.map((t) => this.embedOne(t))
  }

  private embedOne(text: string): EmbeddingVector {
    const toks = tokenize(text)
    const acc: number[] = new Array<number>(this.dimensions).fill(0)
    for (const tok of toks) {
      const v = this.clusters.get(`w:${tok}`)
      if (v !== undefined) {
        for (let i = 0; i < this.dimensions; i++) acc[i] = (acc[i] ?? 0) + (v[i] ?? 0)
      }
    }
    return normalize(acc)
  }
}


function hash31(s: string): number {
  let h = 7
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0
  }
  return h >>> 0
}

function normalize(vec: readonly number[]): EmbeddingVector {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
  if (norm === 0) return vec
  return vec.map((v) => v / norm)
}
