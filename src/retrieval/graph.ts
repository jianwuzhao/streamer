/**
 * 关系图谱（方案 §8.2）。
 *
 * - 节点：memory/skill/scene/game/event/viewer_profile/claim；
 * - 边：supports/contradicts/derived_from/supersedes/applies_to/used_in/preference_for；
 * - 模型提出的边先入 candidate，确定性验证通过才进生产图（只遍历 verified）；
 * - 遍历每一跳校验作用域（角色/场景/观众），不能一条合法边带出另一观众的
 *   私有资料；默认最大两跳、最多 50 个扩展节点、限制高出度节点。
 */
import { all, get, run, type DB } from '../storage/db.ts'

export type GraphNodeKind =
  | 'memory'
  | 'skill'
  | 'scene'
  | 'game'
  | 'event'
  | 'viewer_profile'
  | 'claim'

export type GraphRelation =
  | 'supports'
  | 'contradicts'
  | 'derived_from'
  | 'supersedes'
  | 'applies_to'
  | 'used_in'
  | 'preference_for'

export interface GraphNode {
  readonly node_id: string
  readonly kind: GraphNodeKind
  readonly ref: string
  readonly character_id: string
  readonly scene: string
  readonly viewer_key: string | null
  readonly label: string
}

export interface TraversalScope {
  readonly characterId: string
  readonly viewerKey?: string
  readonly maxHops: number
  readonly maxExpandedNodes: number
  /** 高出度节点截断阈值（热门话题防淹没 §8.2） */
  readonly maxDegreePerNode: number
}

interface EdgeRow {
  readonly edge_id: number
  readonly src: string
  readonly dst: string
  readonly relation: GraphRelation
  readonly weight: number
  readonly valid_until: string | null
  readonly review_status: 'candidate' | 'verified'
}

export class GraphStore {
  private readonly db: DB

  constructor(db: DB) {
    this.db = db
  }

  upsertNode(input: {
    nodeId: string
    kind: GraphNodeKind
    ref?: string
    characterId: string
    scene?: string
    viewerKey?: string
    label?: string
  }): void {
    run(
      this.db,
      `INSERT INTO graph_nodes (node_id, kind, ref, character_id, scene, viewer_key, label)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET label = excluded.label, scene = excluded.scene`,
      input.nodeId,
      input.kind,
      input.ref ?? '',
      input.characterId,
      input.scene ?? '',
      input.viewerKey ?? null,
      input.label ?? '',
    )
  }

  /** 加边：模型提名 candidate，确定性验证后 verify 才进生产遍历。 */
  addEdge(input: {
    src: string
    dst: string
    relation: GraphRelation
    weight?: number
    extractor?: string
    reviewStatus?: 'candidate' | 'verified'
  }): void {
    run(
      this.db,
      `INSERT INTO graph_edges (src, dst, relation, weight, extractor, review_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      input.src,
      input.dst,
      input.relation,
      input.weight ?? 1,
      input.extractor ?? '',
      input.reviewStatus ?? 'candidate',
    )
  }

  verifyEdge(edgeId: number): void {
    run(this.db, `UPDATE graph_edges SET review_status = 'verified' WHERE edge_id = ?`, edgeId)
  }

  node(nodeId: string): GraphNode | undefined {
    return get<GraphNode>(this.db, 'SELECT * FROM graph_nodes WHERE node_id = ?', nodeId)
  }

  /**
   * 从种子节点出发的受控扩展（仅 verified 边）：
   * - 每一跳对端节点都必须满足作用域（characterId 相同；带 viewer_key 的
   *   节点要求 scope.viewerKey 匹配，否则该跳被拒绝并计入 violations）；
   * - 高出度节点按 weight 截断，总扩展节点不超过 maxExpandedNodes。
   */
  expand(seeds: readonly string[], scope: TraversalScope, now: string): {
    reached: readonly GraphNode[]
    violations: number
  } {
    const visited = new Set<string>(seeds)
    let frontier = [...seeds]
    let violations = 0
    let expanded = 0
    const reached: GraphNode[] = []

    for (const seed of seeds) {
      const node = this.node(seed)
      if (node && this.inScope(node, scope)) reached.push(node)
    }

    for (let hop = 0; hop < scope.maxHops && frontier.length > 0; hop++) {
      const nextFrontier: string[] = []
      for (const nodeId of frontier) {
        if (expanded >= scope.maxExpandedNodes) break
        const edges = all<EdgeRow>(
          this.db,
          `SELECT * FROM graph_edges
           WHERE (src = ? OR dst = ?) AND review_status = 'verified'
             AND (valid_until IS NULL OR valid_until > ?)
           ORDER BY weight DESC LIMIT ?`,
          nodeId,
          nodeId,
          now,
          scope.maxDegreePerNode,
        )
        for (const edge of edges) {
          const other = edge.src === nodeId ? edge.dst : edge.src
          if (visited.has(other)) continue
          const node = this.node(other)
          if (!node) continue
          if (!this.inScope(node, scope)) {
            violations += 1 // 越界跳：拒绝并报警（不能仅在输出过滤 §21）
            continue
          }
          visited.add(other)
          reached.push(node)
          expanded += 1
          if (expanded >= scope.maxExpandedNodes) break
          nextFrontier.push(other)
        }
      }
      frontier = nextFrontier
    }
    return { reached, violations }
  }

  private inScope(node: GraphNode, scope: TraversalScope): boolean {
    if (node.character_id !== scope.characterId) return false
    if (node.viewer_key !== null && node.viewer_key !== scope.viewerKey) return false
    return true
  }
}
