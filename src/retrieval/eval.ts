/**
 * 检索评测（方案 §8.4）：标注查询集 + Recall@K / nDCG@K / 延迟分位。
 * 用于调参集/保留集与三路消融——仅调权重不算完成，必须跑保留集。
 */
import type { RetrievalResult, RetrievalService, RouteToggle } from './retrieval.ts'

export interface EvalQueryCase {
  readonly queryId: string
  readonly text: string
  readonly characterId: string
  readonly relevantRefs: readonly string[]
  readonly viewerKey?: string
}

export interface EvalQueryResult {
  readonly queryId: string
  readonly returned: readonly string[]
  readonly relevant: readonly string[]
  readonly recallAt5: number
  readonly ndcgAt5: number
  readonly latencyMs: number
}

export interface EvalReport {
  readonly cases: readonly EvalQueryResult[]
  readonly recallAt5: number
  readonly ndcgAt5: number
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
}

export async function runRetrievalEval(
  service: RetrievalService,
  dataset: readonly EvalQueryCase[],
  opts: { routes?: RouteToggle } = {},
): Promise<EvalReport> {
  const cases: EvalQueryResult[] = []
  for (const q of dataset) {
    const result: RetrievalResult = await service.retrieve(
      {
        text: q.text,
        characterId: q.characterId,
        ...(q.viewerKey !== undefined ? { viewerKey: q.viewerKey } : {}),
      },
      opts.routes !== undefined ? { routes: opts.routes } : {},
    )
    const returned = [...result.memories.map((m) => m.ref), ...result.skills.map((s) => s.ref)]
    const relevantSet = new Set(q.relevantRefs)
    const hitsAt5 = returned.slice(0, 5).filter((r) => relevantSet.has(r)).length
    const recallAt5 = q.relevantRefs.length === 0 ? 0 : hitsAt5 / q.relevantRefs.length
    // nDCG@5（二元相关）
    let dcg = 0
    returned.slice(0, 5).forEach((r, i) => {
      if (relevantSet.has(r)) dcg += 1 / Math.log2(i + 2)
    })
    const idealHits = Math.min(q.relevantRefs.length, 5)
    let idcg = 0
    for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2)
    cases.push({
      queryId: q.queryId,
      returned,
      relevant: q.relevantRefs,
      recallAt5,
      ndcgAt5: idcg === 0 ? 0 : dcg / idcg,
      latencyMs: result.meta.latencyMs,
    })
  }
  const avg = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length)
  const percentile = (xs: readonly number[], p: number): number => {
    if (xs.length === 0) return 0
    const sorted = [...xs].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    return sorted[idx] ?? 0
  }
  const latencies = cases.map((c) => c.latencyMs)
  return {
    cases,
    recallAt5: avg(cases.map((c) => c.recallAt5)),
    ndcgAt5: avg(cases.map((c) => c.ndcgAt5)),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
  }
}

/** 消融对比：三路 vs 单路。 */
export async function ablation(
  service: RetrievalService,
  dataset: readonly EvalQueryCase[],
): Promise<Record<string, EvalReport>> {
  return {
    fusion: await runRetrievalEval(service, dataset),
    lexical_only: await runRetrievalEval(service, dataset, { routes: { lexical: true, vector: false, graph: false } }),
    vector_only: await runRetrievalEval(service, dataset, { routes: { lexical: false, vector: true, graph: false } }),
  }
}
