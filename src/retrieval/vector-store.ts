/**
 * SQLite 向量块存取（方案 §8.1 / §8.3）。
 *
 * - 同一分区只启用一个向量引擎（§8.1）：阶段 C 为 SQLite 内余弦检索；
 * - 查询先做权限/作用域/撤销/过期**前置过滤**，未通过 ACL 的正文
 *   不进入相似度计算、不进入日志；
 * - 删除 tombstone 即时参与过滤（revoked），不等待新索引建成。
 */
import { all, run, type DB } from '../storage/db.ts'
import type { EmbeddingVector } from './embedding.ts'

export interface VectorChunkMeta {
  readonly chunk_id: string
  readonly kind: 'memory' | 'skill'
  readonly ref: string
  readonly text: string
  readonly character_id: string
  readonly namespace: string
  readonly scene: string
  readonly viewer_key: string | null
  readonly embedding: string
  readonly embedding_model_revision: string
  readonly index_generation: number
  readonly document_revision: number
  readonly expires_at: string | null
  readonly revoked: number
}

export interface UpsertChunkInput {
  readonly chunkId: string
  readonly kind: 'memory' | 'skill'
  readonly ref: string
  readonly text: string
  readonly characterId: string
  readonly namespace: string
  readonly scene: string
  /** 非空 ⇒ 仅该观众可召回（画像类内容） */
  readonly viewerKey?: string
  readonly embedding: EmbeddingVector
  readonly modelRevision: string
  readonly generation: number
  readonly documentRevision: number
  readonly expiresAt?: string
}

export interface VectorQueryScope {
  readonly characterId: string
  readonly namespaces?: readonly string[]
  readonly viewerKey?: string
  readonly now: string
  readonly generation: number
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    na += (a[i] ?? 0) ** 2
    nb += (b[i] ?? 0) ** 2
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export class VectorStore {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  upsert(input: UpsertChunkInput): void {
    run(
      this.db,
      `INSERT INTO vector_chunks
         (chunk_id, kind, ref, text, character_id, namespace, scene, viewer_key,
          embedding, embedding_model_revision, index_generation, document_revision, expires_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(chunk_id) DO UPDATE SET
         text = excluded.text, embedding = excluded.embedding,
         embedding_model_revision = excluded.embedding_model_revision,
         index_generation = excluded.index_generation,
         document_revision = excluded.document_revision,
         expires_at = excluded.expires_at, revoked = 0, updated_at = CURRENT_TIMESTAMP`,
      input.chunkId,
      input.kind,
      input.ref,
      input.text,
      input.characterId,
      input.namespace,
      input.scene,
      input.viewerKey ?? null,
      JSON.stringify(input.embedding),
      input.modelRevision,
      input.generation,
      input.documentRevision,
      input.expiresAt ?? null,
    )
  }

  /** tombstone/撤销：即时生效（查询过滤 + 行标记）。 */
  revoke(ref: string): void {
    run(this.db, `UPDATE vector_chunks SET revoked = 1, updated_at = CURRENT_TIMESTAMP WHERE ref = ?`, ref)
  }

  /** 作用域前置过滤后的全部候选（正文仅此层可见）。 */
  private scopedChunks(scope: VectorQueryScope): VectorChunkMeta[] {
    const namespaceFilter =
      scope.namespaces !== undefined && scope.namespaces.length > 0
        ? `AND namespace IN (${scope.namespaces.map(() => '?').join(',')})`
        : ''
    const rows = all<VectorChunkMeta>(
      this.db,
      `SELECT * FROM vector_chunks
       WHERE character_id = ? AND revoked = 0 AND index_generation = ?
         AND (expires_at IS NULL OR expires_at > ?)
         AND (viewer_key IS NULL ${scope.viewerKey !== undefined ? 'OR viewer_key = ?' : ''})
         ${namespaceFilter}`,
      ...[scope.characterId, scope.generation, scope.now, ...(scope.viewerKey !== undefined ? [scope.viewerKey] : []), ...(scope.namespaces ?? [])],
    )
    return rows
  }

  /** top-K 余弦检索（作用域前置过滤后计算）。 */
  search(
    queryEmbedding: EmbeddingVector,
    scope: VectorQueryScope,
    topK: number,
  ): readonly { id: string; ref: string; score: number }[] {
    const chunks = this.scopedChunks(scope)
    const scored: { id: string; ref: string; score: number }[] = []
    for (const c of chunks) {
      let vec: number[]
      try {
        vec = JSON.parse(c.embedding) as number[]
      } catch {
        continue // 坏向量跳过（损坏由索引层降级处理）
      }
      const score = cosineSimilarity(queryEmbedding, vec)
      if (score > 0) scored.push({ id: c.chunk_id, ref: c.ref, score })
    }
    scored.sort((a, z) => z.score - a.score)
    return scored.slice(0, topK)
  }

  /** 词法路语料（同样作用域过滤；供 BM25 使用）。 */
  corpus(scope: VectorQueryScope): readonly { id: string; ref: string; kind: 'memory' | 'skill'; text: string }[] {
    return this.scopedChunks(scope).map((c) => ({ id: c.chunk_id, ref: c.ref, kind: c.kind, text: c.text }))
  }

  count(scope: Pick<VectorQueryScope, 'characterId' | 'generation'>): number {
    const rows = all<{ n: number }>(
      this.db,
      'SELECT COUNT(*) AS n FROM vector_chunks WHERE character_id = ? AND index_generation = ? AND revoked = 0',
      scope.characterId,
      scope.generation,
    )
    return rows[0]?.n ?? 0
  }
}
