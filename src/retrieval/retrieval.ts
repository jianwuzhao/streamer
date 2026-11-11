/**
 * 三路检索服务（方案 §8.1 管线）。
 *
 * 权限/作用域/TTL 前置过滤 → BM25 top-20 + 向量 top-20 + 图谱 top-20
 * → 统一 ID 去重 + RRF 融合 → 证据质量/多样性重排 → 实时复检授权与撤销
 * → 记忆 top-3 + 技能 top-2 → 总上下文 token 预算截断。
 *
 * 降级语义：向量路失败 ⇒ 词法路继续并显式标记 degraded（不把降级误报
 * 为三路正常 §8.3）；支持按路关闭（消融评测用）。
 */
import { get, type DB } from '../storage/db.ts'
import type { DafeiyuConfigType } from '../config.ts'
import type { ContextBundle } from '../types.ts'
import { Bm25Index } from './bm25.ts'
import type { EmbeddingProvider } from './embedding.ts'
import type { GraphStore } from './graph.ts'
import type { VectorStore } from './vector-store.ts'

export interface RetrievalQuery {
  readonly text: string
  readonly characterId: string
  readonly namespaces?: readonly string[]
  readonly viewerKey?: string
  readonly scene?: string
}

export interface RetrievalMeta {
  readonly latencyMs: number
  readonly routes: { readonly lexical: number; readonly vector: number; readonly graph: number }
  readonly degraded: 'none' | 'vector'
  readonly graphViolations: number
  readonly truncated: boolean
}

export interface RetrievalResult extends ContextBundle {
  readonly meta: RetrievalMeta
}

export interface RouteToggle {
  readonly lexical?: boolean
  readonly vector?: boolean
  readonly graph?: boolean
}

interface Candidate {
  readonly kind: 'memory' | 'skill'
  readonly ref: string
  readonly text: string
  readonly rrf: number
}

const RRF_K = 60

export class RetrievalService {
  private readonly db: DB
  private readonly vector: VectorStore
  private readonly graph: GraphStore
  private readonly embedder: EmbeddingProvider
  private readonly config: DafeiyuConfigType
  private readonly clock: () => string

  constructor(deps: {
    db: DB
    vector: VectorStore
    graph: GraphStore
    embedder: EmbeddingProvider
    config: DafeiyuConfigType
    clock?: () => string
  }) {
    this.db = deps.db
    this.vector = deps.vector
    this.graph = deps.graph
    this.embedder = deps.embedder
    this.config = deps.config
    this.clock = deps.clock ?? (() => new Date().toISOString())
  }

  async retrieve(query: RetrievalQuery, opts: { routes?: RouteToggle } = {}): Promise<RetrievalResult> {
    const started = Date.now()
    const cfg = this.config.retrieval
    const now = this.clock()
    const routes = { lexical: true, vector: true, graph: true, ...opts.routes }
    const generation = this.activeGeneration()

    const scope = {
      characterId: query.characterId,
      ...(query.namespaces !== undefined ? { namespaces: query.namespaces } : {}),
      ...(query.viewerKey !== undefined ? { viewerKey: query.viewerKey } : {}),
      now,
      generation,
    }

    // 作用域前置过滤后的语料（未过 ACL 的正文仅此层可见，不进相似度/日志 §8.1）
    const corpus = this.vector.corpus(scope)
    const textByKey = new Map(corpus.map((c) => [`${c.kind}:${c.ref}`, c.text]))

    // 路 1：BM25 词法
    const lexicalHits: string[] = []
    if (routes.lexical) {
      const bm25 = new Bm25Index()
      bm25.rebuild(corpus.map((c) => ({ id: `${c.kind}:${c.ref}`, text: c.text })))
      lexicalHits.push(...bm25.search(query.text, cfg.candidatesPerRoute).map((h) => h.id))
    }

    // 路 2：向量（失败 ⇒ 降级，不中断）
    let vectorHits: string[] = []
    let degraded: RetrievalMeta['degraded'] = 'none'
    if (routes.vector) {
      try {
        const [qv] = await this.embedder.embed([query.text])
        if (qv !== undefined) {
          vectorHits = this.vector.search(qv, scope, cfg.candidatesPerRoute).map((h) => h.id)
        }
      } catch {
        degraded = 'vector' // 索引损坏/模型不可用：回退健康词法检索并报警（§8.3）
      }
    }

    // 路 3：图谱（种子 = 前两路命中节点，受控扩展；逐跳作用域校验）
    let graphHits: string[] = []
    let graphViolations = 0
    if (routes.graph) {
      const seeds = [...new Set([...lexicalHits, ...vectorHits])]
        .slice(0, 8)
        .map((key) => `g:${key}`)
        .filter((nodeId) => this.graph.node(nodeId) !== undefined)
      if (seeds.length > 0) {
        const { reached, violations } = this.graph.expand(
          seeds,
          {
            characterId: query.characterId,
            ...(query.viewerKey !== undefined ? { viewerKey: query.viewerKey } : {}),
            maxHops: cfg.graphMaxHops,
            maxExpandedNodes: cfg.graphMaxExpandedNodes,
            maxDegreePerNode: 10,
          },
          now,
        )
        graphViolations = violations
        graphHits = reached
          .filter((n) => n.kind === 'memory' || n.kind === 'skill')
          .map((n) => `${n.kind}:${n.ref}`)
      }
    }

    // 统一 ID 去重 + RRF 融合 + 正文回填
    const fused = fuse({ lexical: lexicalHits, vector: vectorHits, graph: graphHits })
      .map((c) => ({ ...c, text: textByKey.get(`${c.kind}:${c.ref}`) ?? '' }))
      .filter((c) => c.text !== '')

    // 重排（证据质量 + 多样性）→ 实时复检 → 组装与截断
    const reranked = this.rerank(fused)
    const verified = reranked.filter((c) => this.reverify(c))
    return this.assemble(verified, {
      latencyMs: Date.now() - started,
      routes: { lexical: lexicalHits.length, vector: vectorHits.length, graph: graphHits.length },
      degraded,
      graphViolations,
    })
  }

  // -------------------------------------------------------------------------

  private activeGeneration(): number {
    const row = get<{ generation: number }>(
      this.db,
      `SELECT generation FROM index_generations WHERE status = 'active' ORDER BY generation DESC LIMIT 1`,
    )
    return row?.generation ?? 0
  }

  /** 重排：证据质量加权（独立证据多者优先）+ 逐主题多样性上限。 */
  private rerank(candidates: readonly Candidate[]): Candidate[] {
    const withEvidence = candidates.map((c) => ({ c, evidence: this.evidenceCount(c) }))
    withEvidence.sort((a, z) => z.c.rrf + 0.01 * z.evidence - (a.c.rrf + 0.01 * a.evidence))
    // 多样性：同主题（ref 首段）最多 2 条，防止单一话题淹没（§8.1）
    const perTopic = new Map<string, number>()
    const out: Candidate[] = []
    for (const { c } of withEvidence) {
      const topic = c.ref.split('.')[0] ?? 'topic'
      const count = perTopic.get(topic) ?? 0
      if (count >= 2) continue
      perTopic.set(topic, count + 1)
      out.push(c)
    }
    return out
  }

  private evidenceCount(c: Candidate): number {
    if (c.kind !== 'memory') return 0
    const row = get<{ supporting_evidence: string }>(
      this.db,
      `SELECT supporting_evidence FROM memory_candidates WHERE id = ? ORDER BY revision DESC LIMIT 1`,
      c.ref,
    )
    if (!row) return 0
    try {
      const arr = JSON.parse(row.supporting_evidence) as unknown
      return Array.isArray(arr) ? arr.length : 0
    } catch {
      return 0
    }
  }

  /** 实时复检（§8.1 最后一道）：记忆最新 revision 须 active 未过期；技能须 active。 */
  private reverify(c: Candidate): boolean {
    if (c.kind === 'memory') {
      const row = get<{ status: string; expires_at: string }>(
        this.db,
        `SELECT status, expires_at FROM memory_candidates WHERE id = ? ORDER BY revision DESC LIMIT 1`,
        c.ref,
      )
      if (!row || row.status !== 'active') return false
      return Date.parse(row.expires_at) > Date.parse(this.clock())
    }
    const skill = get<{ status: string }>(
      this.db,
      `SELECT status FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC LIMIT 1`,
      c.ref,
    )
    return skill?.status === 'active'
  }

  private assemble(candidates: readonly Candidate[], meta: Omit<RetrievalMeta, 'truncated'>): RetrievalResult {
    const cfg = this.config.retrieval
    const memories: { ref: string; text: string }[] = []
    const skills: { ref: string; text: string }[] = []
    for (const c of candidates) {
      if (c.kind === 'memory' && memories.length < cfg.memoryTopK) memories.push({ ref: c.ref, text: c.text })
      if (c.kind === 'skill' && skills.length < cfg.skillTopK) skills.push({ ref: c.ref, text: c.text })
    }
    const measure = (): number => estimateTokens([...memories, ...skills].map((x) => x.text).join('\n'))
    // 总上下文预算截断：从低位次裁剪
    let tokens = measure()
    while (tokens > cfg.combinedInjectedTokenLimit && memories.length + skills.length > 0) {
      if (skills.length >= memories.length && skills.length > 0) skills.pop()
      else if (memories.length > 0) memories.pop()
      tokens = measure()
    }
    return {
      memories,
      skills,
      injectedTokens: tokens,
      meta: { ...meta, truncated: tokens >= cfg.combinedInjectedTokenLimit && (memories.length + skills.length > 0) },
    }
  }
}

/** RRF 融合：score = Σ_routes 1/(k + rank)。 */
function fuse(routes: {
  lexical: readonly string[]
  vector: readonly string[]
  graph: readonly string[]
}): Candidate[] {
  const scores = new Map<string, Candidate>()
  for (const hits of [routes.lexical, routes.vector, routes.graph]) {
    hits.forEach((key, idx) => {
      const kindIdx = key.indexOf(':')
      const kind = key.slice(0, kindIdx) === 'skill' ? ('skill' as const) : ('memory' as const)
      const ref = key.slice(kindIdx + 1)
      const contribution = 1 / (RRF_K + (idx + 1))
      const existing = scores.get(key)
      if (existing) scores.set(key, { ...existing, rrf: existing.rrf + contribution })
      else scores.set(key, { kind, ref, text: '', rrf: contribution })
    })
  }
  return [...scores.values()].sort((a, z) => z.rrf - a.rrf)
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.7)
}
