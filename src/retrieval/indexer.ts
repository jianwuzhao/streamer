/**
 * 索引器与 generation 迁移（方案 §8.3）。
 *
 * - 写入事务生成索引 outbox，异步生成 embedding 与图谱更新；重复消费幂等；
 * - 记录 embedding_model_revision / index_generation；
 * - 模型/维度变化 ⇒ 构建新一代（building），旧代继续服务；新代追平游标
 *   并通过评测后切换 active；切换即原子；
 * - 索引损坏 ⇒ 回退健康关键词检索并报警（不能把降级误报为三路正常）。
 */
import { all, get, run, type DB } from '../storage/db.ts'
import type { EmbeddingProvider } from './embedding.ts'
import type { GraphNodeKind, GraphRelation, GraphStore } from './graph.ts'
import type { VectorStore } from './vector-store.ts'

export interface IndexDocument {
  readonly chunkId: string
  readonly kind: 'memory' | 'skill'
  readonly ref: string
  readonly text: string
  readonly characterId: string
  readonly namespace: string
  readonly scene: string
  readonly viewerKey?: string
  readonly documentRevision: number
  readonly expiresAt?: string
  /** 图谱种子边（如 memory→scene 的 applies_to） */
  readonly graph?: readonly { readonly relation: GraphRelation; readonly targetKind: GraphNodeKind; readonly targetId: string; readonly label?: string }[]
}

export class RetrievalIndexer {
  private readonly db: DB
  private readonly vector: VectorStore
  private readonly graph: GraphStore
  private readonly embedder: EmbeddingProvider

  constructor(
    db: DB,
    vector: VectorStore,
    graph: GraphStore,
    embedder: EmbeddingProvider,
  ) {
    this.db = db
    this.vector = vector
    this.graph = graph
    this.embedder = embedder
  }

  get activeGeneration(): number {
    const row = get<{ generation: number }>(
      this.db,
      `SELECT generation FROM index_generations WHERE status = 'active' ORDER BY generation DESC LIMIT 1`,
    )
    return row?.generation ?? 0
  }

  /** 确保存在一代可用索引：首次调用创建 generation 1 并激活。 */
  ensureGeneration(): number {
    const existing = get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM index_generations')
    if ((existing?.n ?? 0) === 0) {
      run(
        this.db,
        `INSERT INTO index_generations (generation, embedding_model_revision, status, activated_at)
         VALUES (1, ?, 'active', CURRENT_TIMESTAMP)`,
        this.embedder.modelRevision,
      )
      return 1
    }
    return this.activeGeneration
  }

  /**
   * 模型修订变化 ⇒ 构建新一代（building）：旧代继续服务；
   * 新代重建完成后由 activateGeneration 切换。
   */
  buildNewGeneration(): number {
    const current = this.activeGeneration
    const next = (get<{ m: number }>(this.db, 'SELECT MAX(generation) AS m FROM index_generations')?.m ?? 0) + 1
    run(
      this.db,
      `INSERT INTO index_generations (generation, embedding_model_revision, status) VALUES (?, ?, 'building')`,
      next,
      this.embedder.modelRevision,
    )
    return next
  }

  /** 新代追平并通过评测后切换：原子换 active，旧代 retired。 */
  activateGeneration(generation: number): void {
    const row = get<{ status: string }>(this.db, 'SELECT status FROM index_generations WHERE generation = ?', generation)
    if (!row) throw new Error(`索引代不存在: ${generation}`)
    if (row.status !== 'building') throw new Error(`仅 building 状态可激活（当前 ${row.status}）`)
    run(this.db, `UPDATE index_generations SET status = 'active', activated_at = CURRENT_TIMESTAMP WHERE generation = ?`, generation)
    run(
      this.db,
      `UPDATE index_generations SET status = 'retired', retired_at = CURRENT_TIMESTAMP
       WHERE status = 'active' AND generation < ?`,
      generation,
    )
  }

  /** 索引 outbox：登记 upsert/delete（写入事务内调用，消费幂等）。 */
  enqueue(op: 'upsert' | 'delete', doc: { kind: 'memory' | 'skill'; ref: string }): void {
    const generation = this.latestGenerationForWrite()
    run(
      this.db,
      `INSERT INTO index_outbox (generation, op, kind, ref) VALUES (?, ?, ?, ?)`,
      generation,
      op,
      doc.kind,
      doc.ref,
    )
  }

  /** 消费 pending：upsert ⇒ 嵌入+向量+图谱种子；delete ⇒ 即时撤销。 */
  async drain(): Promise<{ processed: number; failed: number }> {
    const pending = all<{ op_id: number; generation: number; op: 'upsert' | 'delete'; kind: string; ref: string }>(
      this.db,
      `SELECT * FROM index_outbox WHERE status = 'pending' ORDER BY op_id LIMIT 200`,
    )
    let processed = 0
    let failed = 0
    for (const row of pending) {
      try {
        if (row.op === 'delete') {
          this.vector.revoke(row.ref)
        } else {
          const doc = this.pendingDocCache.get(row.ref)
          if (doc !== undefined) {
            await this.indexDocument(doc, row.generation)
            this.pendingDocCache.delete(row.ref)
          } else {
            // 无正文附带的 upsert：标记失败（不可静默丢失 §8.3 幂等消费）
            throw new Error(`upsert 缺少文档正文: ${row.ref}`)
          }
        }
        run(this.db, `UPDATE index_outbox SET status = 'done', processed_at = CURRENT_TIMESTAMP WHERE op_id = ?`, row.op_id)
        processed += 1
      } catch (err) {
        run(
          this.db,
          `UPDATE index_outbox SET status = 'failed', processed_at = CURRENT_TIMESTAMP WHERE op_id = ?`,
          row.op_id,
        )
        failed += 1
        this.lastError = (err as Error).message
      }
    }
    return { processed, failed }
  }

  get lastDrainError(): string | undefined {
    return this.lastError
  }

  /** 直写路径（测试/初始化）：登记 outbox + 附带正文缓存后立即消费。 */
  async index(doc: IndexDocument): Promise<void> {
    this.pendingDocCache.set(doc.ref, doc)
    this.enqueue('upsert', { kind: doc.kind, ref: doc.ref })
    const res = await this.drain()
    if (res.failed > 0) throw new Error(`索引写入失败: ${this.lastError}`)
  }

  async remove(kind: 'memory' | 'skill', ref: string): Promise<void> {
    this.enqueue('delete', { kind, ref })
    await this.drain()
  }

  private async indexDocument(doc: IndexDocument, generation: number): Promise<void> {
    const [vec] = await this.embedder.embed([doc.text])
    if (vec === undefined) throw new Error('embedding 返回为空')
    this.vector.upsert({
      chunkId: doc.chunkId,
      kind: doc.kind,
      ref: doc.ref,
      text: doc.text,
      characterId: doc.characterId,
      namespace: doc.namespace,
      scene: doc.scene,
      ...(doc.viewerKey !== undefined ? { viewerKey: doc.viewerKey } : {}),
      embedding: vec,
      modelRevision: this.embedder.modelRevision,
      generation,
      documentRevision: doc.documentRevision,
      ...(doc.expiresAt !== undefined ? { expiresAt: doc.expiresAt } : {}),
    })
    this.graph.upsertNode({
      nodeId: `g:${doc.kind}:${doc.ref}`,
      kind: doc.kind === 'memory' ? 'memory' : 'skill',
      ref: doc.ref,
      characterId: doc.characterId,
      scene: doc.scene,
      ...(doc.viewerKey !== undefined ? { viewerKey: doc.viewerKey } : {}),
      label: doc.text.slice(0, 40),
    })
    for (const edge of doc.graph ?? []) {
      this.graph.upsertNode({
        nodeId: edge.targetId,
        kind: edge.targetKind,
        characterId: doc.characterId,
        scene: doc.scene,
        label: edge.label ?? edge.targetId,
      })
      this.graph.addEdge({
        src: `g:${doc.kind}:${doc.ref}`,
        dst: edge.targetId,
        relation: edge.relation,
        extractor: 'indexer:v1',
        reviewStatus: 'verified', // 确定性种子边（memory→scene）直接 verified
      })
    }
  }

  private latestGenerationForWrite(): number {
    const row = get<{ m: number }>(this.db, 'SELECT MAX(generation) AS m FROM index_generations')
    return row?.m ?? this.ensureGeneration()
  }

  private pendingDocCache = new Map<string, IndexDocument>()
  private lastError: string | undefined
}
