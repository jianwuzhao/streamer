/**
 * 测试专用 embedding 桩（仅测试引用，禁止进入生产路径）。
 *
 * - HashingEmbeddingProvider：token 哈希伪向量，验证索引/融合的管道逻辑；
 * - StubSemanticEmbeddingProvider：按关键词簇构造确定向量，验证
 *   「向量路召回同义/别名而词法路不命中」的融合逻辑。
 *
 * 哈希向量不得替代语义模型用于验收（§8.1）。
 */
import { tokenize } from '../retrieval/bm25.ts'
import type { EmbeddingProvider, EmbeddingVector } from '../retrieval/embedding.ts'

/** token 哈希伪向量。**不得用于语义验收**（§8.1：不以哈希向量替代语义模型）。 */
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

/** 语义映射桩——同簇词共享基础向量（加少量个体扰动仍高相似）。 */
export class StubSemanticEmbeddingProvider implements EmbeddingProvider {
  readonly modelRevision = 'test:stub-semantic'
  readonly dimensions = 32
  private readonly clusters = new Map<string, number[]>()

  /** 注册同义簇：同一簇的词共享基础向量。 */
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
