import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { loadConfig, type DafeiyuConfigType } from '../config.ts'
import { MemoryStore } from '../memory/l2-store.ts'
import { SkillRegistry, SKILL_LIFECYCLE } from '../skills/registry.ts'
import { makeTmpDb, type TmpDb } from '../testing/helpers.ts'
import { StubSemanticEmbeddingProvider } from '../testing/embedding-stubs.ts'
import { GraphStore } from './graph.ts'
import { RetrievalIndexer } from './indexer.ts'
import { RetrievalService } from './retrieval.ts'
import { VectorStore } from './vector-store.ts'

interface Fixture {
  readonly t: TmpDb
  readonly memory: MemoryStore
  readonly registry: SkillRegistry
  readonly indexer: RetrievalIndexer
  readonly service: RetrievalService
  readonly graph: GraphStore
  readonly vector: VectorStore
  readonly config: DafeiyuConfigType
  readonly embedder: StubSemanticEmbeddingProvider
}

async function makeFixture(configOver?: (c: DafeiyuConfigType) => void): Promise<Fixture> {
  const t = makeTmpDb()
  const config = loadConfig(resolve(process.cwd(), 'config/default.yaml'))
  configOver?.(config)
  const embedder = new StubSemanticEmbeddingProvider()
  // 语义簇：同义词共享向量（钓鱼/垂钓；种田/务农/种地）
  embedder.defineCluster('fishing', ['钓鱼', '垂钓', '鱼竿', '渔获'])
  embedder.defineCluster('farming', ['种田', '务农', '种地', '萝卜', '农田'])
  const vector = new VectorStore(t.db)
  const graph = new GraphStore(t.db)
  const indexer = new RetrievalIndexer(t.db, vector, graph, embedder)
  indexer.ensureGeneration()
  const service = new RetrievalService({ db: t.db, vector, graph, embedder, config })
  const memory = new MemoryStore(t.db, { characterId: 'dafeiyu', clock: () => '2026-11-11T04:00:00.000Z' })
  const registry = new SkillRegistry(t.db, { grantedPermissions: [] })
  return { t, memory, registry, indexer, service, graph, vector, config, embedder }
}

async function indexMemory(
  f: Fixture,
  claim: string,
  opts: { subject?: string; viewerKey?: string; scene?: string } = {},
): Promise<string> {
  const result = f.memory.propose({
    claim,
    namespace: 'evolving_cognition',
    scene: opts.scene ?? 'farming_chat',
    ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
    evidence: [
      { eventId: `e-${claim.length}-a`, ...(opts.viewerKey !== undefined ? { viewerKey: opts.viewerKey } : {}) },
      { eventId: `e-${claim.length}-b` },
    ],
  })
  await f.indexer.index({
    chunkId: `c:${result.entry.id}`,
    kind: 'memory',
    ref: result.entry.id,
    text: claim,
    characterId: 'dafeiyu',
    namespace: 'evolving_cognition',
    scene: opts.scene ?? 'farming_chat',
    documentRevision: result.entry.revision,
    // 画像类/观众私有内容：chunk 层 viewerKey（ACL 前置过滤依据）
    ...(opts.viewerKey !== undefined ? { viewerKey: opts.viewerKey } : {}),
    graph: [{ relation: 'applies_to', targetKind: 'scene', targetId: `scene:${opts.scene ?? 'farming_chat'}` }],
  })
  return result.entry.id
}

async function indexSkill(f: Fixture, skillId: string, description: string): Promise<void> {
  f.registry.register({
    skillId,
    version: '1.0.0',
    kind: 'expression',
    description,
    permissions: [],
    timeoutMs: 1000,
    handler: 'gift-ack-template',
  })
  const lifecycle = SKILL_LIFECYCLE
  for (let i = 1; i < lifecycle.length; i++) {
    f.registry.setStatus(skillId, '1.0.0', lifecycle[i] as (typeof lifecycle)[number])
  }
  await f.indexer.index({
    chunkId: `c:skill:${skillId}`,
    kind: 'skill',
    ref: skillId,
    text: description,
    characterId: 'dafeiyu',
    namespace: 'skills',
    scene: 'farming_chat',
    documentRevision: 1,
  })
}

// ---------------------------------------------------------------------------

test('三路融合：别名查询经向量路命中（词法未命中）', async () => {
  const f = await makeFixture()
  try {
    await indexMemory(f, '钓鱼片段适合慢慢聊渔获')
    await indexMemory(f, '种田片段先回应催促')
    const result = await f.service.retrieve({ text: '垂钓的时候聊什么', characterId: 'dafeiyu' })
    assert.ok(result.memories.length >= 1)
    assert.ok(result.memories.some((m) => m.text.includes('钓鱼')), JSON.stringify(result.memories))
  } finally {
    f.t.cleanup()
  }
})

test('跨观众隔离：A 的私有记忆不出现在 B 的检索；越权召回数为 0', async () => {
  const f = await makeFixture()
  try {
    await indexMemory(f, '观众A 私有：喜欢夜钓', { viewerKey: 'vw_a' })
    await indexMemory(f, '通用偏好：喜欢短回复')
    const asA = await f.service.retrieve({ text: '喜欢什么', characterId: 'dafeiyu', viewerKey: 'vw_a' })
    assert.ok(asA.memories.some((m) => m.text.includes('观众A 私有')))
    const asB = await f.service.retrieve({ text: '喜欢什么', characterId: 'dafeiyu', viewerKey: 'vw_b' })
    assert.equal(asB.memories.filter((m) => m.text.includes('观众A 私有')).length, 0)
    // 无观众上下文的检索同样拿不到私有内容
    const anonymous = await f.service.retrieve({ text: '喜欢什么', characterId: 'dafeiyu' })
    assert.equal(anonymous.memories.filter((m) => m.text.includes('观众A 私有')).length, 0)
  } finally {
    f.t.cleanup()
  }
})

test('图谱逐跳作用域：跨观众边被拒绝并计数（不能一条合法边带出另一观众资料）', async () => {
  const f = await makeFixture()
  try {
    const pubId = await indexMemory(f, '通用记忆节点')
    f.graph.upsertNode({ nodeId: 'g:viewer:vw_a_private', kind: 'viewer_profile', characterId: 'dafeiyu', viewerKey: 'vw_a', label: 'A 私有' })
    f.graph.addEdge({ src: `g:memory:${pubId}`, dst: 'g:viewer:vw_a_private', relation: 'preference_for', reviewStatus: 'verified' })
    const result = await f.service.retrieve({ text: '通用记忆', characterId: 'dafeiyu', viewerKey: 'vw_b' })
    assert.ok(result.meta.graphViolations >= 1)
    assert.ok(!JSON.stringify(result).includes('A 私有'))
  } finally {
    f.t.cleanup()
  }
})

test('删除墓碑即时过滤：remove 后不再召回', async () => {
  const f = await makeFixture()
  try {
    const id = await indexMemory(f, '待删除的记忆内容独特关键词')
    await f.service.retrieve({ text: '独特关键词', characterId: 'dafeiyu' })
    await f.indexer.remove('memory', id)
    const after = await f.service.retrieve({ text: '独特关键词', characterId: 'dafeiyu' })
    assert.equal(after.memories.filter((m) => m.ref === id).length, 0)
  } finally {
    f.t.cleanup()
  }
})

test('实时复检：索引后记忆被 challenged/过期 ⇒ 不再注入（索引滞后不污染上下文）', async () => {
  const f = await makeFixture()
  try {
    const id = await indexMemory(f, '复检测试记忆独特内容')
    f.memory.transition(id, 'challenged', ['e_counter'])
    const result = await f.service.retrieve({ text: '复检测试记忆', characterId: 'dafeiyu' })
    assert.equal(result.memories.filter((m) => m.ref === id).length, 0)
  } finally {
    f.t.cleanup()
  }
})

test('向量路失败 ⇒ 降级词法检索并显式标记（不误报三路正常）', async () => {
  const t = makeTmpDb()
  try {
    const config = loadConfig(resolve(process.cwd(), 'config/default.yaml'))
    const broken: StubSemanticEmbeddingProvider = new (class extends StubSemanticEmbeddingProvider {
      public override async embed(): Promise<never> {
        throw new Error('embedding service down')
      }
    })()
    const vector = new VectorStore(t.db)
    const graph = new GraphStore(t.db)
    const indexer = new RetrievalIndexer(t.db, vector, graph, broken)
    indexer.ensureGeneration()
    // 用可用 provider 先建索引
    const good = new StubSemanticEmbeddingProvider()
    const goodIndexer = new RetrievalIndexer(t.db, vector, graph, good)
    const memory = new MemoryStore(t.db, { characterId: 'dafeiyu', clock: () => '2026-11-11T04:00:00.000Z' })
    const created = memory.propose({
      claim: '降级测试词法命中内容',
      namespace: 'evolving_cognition',
      scene: 's',
      evidence: [{ eventId: 'e1' }, { eventId: 'e2' }],
    })
    await goodIndexer.index({
      chunkId: `c:${created.entry.id}`,
      kind: 'memory',
      ref: created.entry.id,
      text: '降级测试词法命中内容',
      characterId: 'dafeiyu',
      namespace: 'evolving_cognition',
      scene: 's',
      documentRevision: 1,
    })
    const service = new RetrievalService({ db: t.db, vector, graph, embedder: broken, config })
    const result = await service.retrieve({ text: '降级测试词法', characterId: 'dafeiyu' })
    assert.equal(result.meta.degraded, 'vector')
    assert.ok(result.memories.length >= 1)
  } finally {
    t.cleanup()
  }
})

test('索引 generation 迁移：旧代服务 → 新代重建 → 激活切换', async () => {
  const f = await makeFixture()
  try {
    const firstId = await indexMemory(f, '第一代索引内容萝卜甲')
    const nextGen = f.indexer.buildNewGeneration()
    // 新代 building：查询仍由旧代（active）服务
    const duringBuild = await f.service.retrieve({ text: '萝卜甲', characterId: 'dafeiyu' })
    assert.ok(duringBuild.memories.some((m) => m.ref === firstId))
    // 新代重建（同文档在新代重嵌入）
    f.memory.propose({
      claim: '第二代新内容渔获乙',
      namespace: 'evolving_cognition',
      scene: 's',
      evidence: [{ eventId: 'g1' }, { eventId: 'g2' }],
    })
    f.t.db
      .prepare(`UPDATE memory_candidates SET id = 'gen2-doc' WHERE claim = '第二代新内容渔获乙'`)
      .run()
    await f.indexer.index({
      chunkId: 'c:gen2-doc',
      kind: 'memory',
      ref: 'gen2-doc',
      text: '第二代新内容渔获乙',
      characterId: 'dafeiyu',
      namespace: 'evolving_cognition',
      scene: 's',
      documentRevision: 1,
    })
    f.indexer.activateGeneration(nextGen)
    const after = await f.service.retrieve({ text: '渔获乙', characterId: 'dafeiyu' })
    assert.equal(after.meta.degraded, 'none')
    assert.ok(after.memories.some((m) => m.ref === 'gen2-doc'))
    // 旧代内容在新代未重建 ⇒ 切换后旧 ref 不再注入（代际隔离）
    const oldDoc = await f.service.retrieve({ text: '萝卜甲', characterId: 'dafeiyu' })
    assert.ok(!oldDoc.memories.some((m) => m.ref === firstId), JSON.stringify(oldDoc.memories))
  } finally {
    f.t.cleanup()
  }
})

test('token 预算截断：超限裁剪低位次条目', async () => {
  const f = await makeFixture((c) => {
    c.retrieval.combinedInjectedTokenLimit = 40
  })
  try {
    await indexMemory(f, '这条记忆非常长'.repeat(8) + '独特记忆词')
    await indexSkill(f, 'demo-skill', '这个技能描述也很长很长很长很长很长很长'.repeat(2))
    const result = await f.service.retrieve({ text: '独特记忆词 技能', characterId: 'dafeiyu' })
    assert.ok(result.injectedTokens <= 40, `tokens=${result.injectedTokens}`)
    assert.equal(result.memories.length + result.skills.length, 1) // 只留最高位次一条
  } finally {
    f.t.cleanup()
  }
})

test('技能召回：描述命中进入 skills top-K', async () => {
  const f = await makeFixture()
  try {
    await indexSkill(f, 'gift-ack-skill', '礼物答谢短语生成技能')
    const result = await f.service.retrieve({ text: '答谢', characterId: 'dafeiyu' })
    assert.ok(result.skills.some((s) => s.ref === 'gift-ack-skill'))
  } finally {
    f.t.cleanup()
  }
})
