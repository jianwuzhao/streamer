/**
 * BM25 关键词检索（方案 §8.1 词法路）。
 *
 * 中文以字符二元组（bigram）为词项，拉丁/数字串整词处理；
 * BM25 参数 k1=1.5、b=0.75。纯内存实现（语料规模阶段 C 足够；
 * FAISS/外部引擎切换由索引 generation 迁移覆盖 §8.3）。
 */
export function tokenize(text: string): readonly string[] {
  const tokens: string[] = []
  const latin = text.match(/[A-Za-z0-9_]+/g) ?? []
  tokens.push(...latin.map((t) => t.toLowerCase()))
  // 连续中文段 → bigram（单字段退化为单字）
  const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      tokens.push(run)
      continue
    }
    for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2))
  }
  return tokens
}

export interface Bm25Doc {
  readonly id: string
  readonly text: string
}

interface IndexedDoc {
  readonly id: string
  readonly tf: ReadonlyMap<string, number>
  readonly length: number
}

export class Bm25Index {
  private docs: IndexedDoc[] = []
  private df = new Map<string, number>()
  private totalLength = 0
  private readonly opts: { k1?: number; b?: number }

  constructor(opts: { k1?: number; b?: number } = {}) {
    this.opts = opts
  }

  rebuild(docs: readonly Bm25Doc[]): void {
    this.docs = []
    this.df = new Map()
    this.totalLength = 0
    for (const d of docs) this.add(d)
  }

  add(doc: Bm25Doc): void {
    const tokens = tokenize(doc.text)
    const tf = new Map<string, number>()
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
    this.docs.push({ id: doc.id, tf, length: tokens.length })
    this.totalLength += tokens.length
    for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1)
  }

  remove(id: string): void {
    // 阶段 C 简化：由上层 rebuild（语料小）；tombstone 过滤在候选层完成
    const idx = this.docs.findIndex((d) => d.id === id)
    if (idx >= 0) {
      const removed = this.docs[idx]
      if (removed) {
        this.totalLength -= removed.length
        for (const t of removed.tf.keys()) {
          const cur = this.df.get(t) ?? 1
          if (cur <= 1) this.df.delete(t)
          else this.df.set(t, cur - 1)
        }
      }
      this.docs.splice(idx, 1)
    }
  }

  get size(): number {
    return this.docs.length
  }

  /** 返回按 BM25 降序的 top-K（id, score）。 */
  search(query: string, topK: number): readonly { id: string; score: number }[] {
    if (this.docs.length === 0) return []
    const k1 = this.opts.k1 ?? 1.5
    const b = this.opts.b ?? 0.75
    const avgLen = this.totalLength / this.docs.length
    const queryTokens = new Set(tokenize(query))
    const scores: { id: string; score: number }[] = []
    for (const doc of this.docs) {
      let score = 0
      for (const t of queryTokens) {
        const f = doc.tf.get(t)
        if (f === undefined) continue
        const n = this.df.get(t) ?? 0
        const idf = Math.log(1 + (this.docs.length - n + 0.5) / (n + 0.5))
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avgLen)))
      }
      if (score > 0) scores.push({ id: doc.id, score })
    }
    scores.sort((a, z) => z.score - a.score)
    return scores.slice(0, topK)
  }
}
