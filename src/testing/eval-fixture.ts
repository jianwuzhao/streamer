/**
 * 评测夹具：构建带同义簇的小型语料（§8.4 标注查询集的最小实现）。
 * 语料覆盖中文口语/别名/短弹幕场景；ref 由调用方作为相关性标注使用。
 */
import { resolve } from 'node:path'
import { loadConfig } from '../config.ts'
import { MemoryStore } from '../memory/l2-store.ts'
import { SKILL_LIFECYCLE, SkillRegistry } from '../skills/registry.ts'
import { makeTmpDb } from './helpers.ts'
import { StubSemanticEmbeddingProvider } from './embedding-stubs.ts'
import { GraphStore } from '../retrieval/graph.ts'
import { RetrievalIndexer } from '../retrieval/indexer.ts'
import { RetrievalService } from '../retrieval/retrieval.ts'
import { VectorStore } from '../retrieval/vector-store.ts'

export async function makeFixtureEval(): Promise<{
  t: ReturnType<typeof makeTmpDb>
  service: RetrievalService
  refs: { readonly fishing: string; readonly farming: string; readonly skillAck: string }
}> {
  const t = makeTmpDb()
  const config = loadConfig(resolve(process.cwd(), 'config/default.yaml'))
  const embedder = new StubSemanticEmbeddingProvider()
  embedder.defineCluster('fishing', ['钓鱼', '垂钓', '鱼竿', '渔获', '鱼'])
  embedder.defineCluster('farming', ['种田', '务农', '种地', '萝卜', '农田', '收成'])
  embedder.defineCluster('ack', ['答谢', '感谢', '礼物', '谢谢'])
  const vector = new VectorStore(t.db)
  const graph = new GraphStore(t.db)
  const indexer = new RetrievalIndexer(t.db, vector, graph, embedder)
  indexer.ensureGeneration()
  const service = new RetrievalService({ db: t.db, vector, graph, embedder, config })
  const memory = new MemoryStore(t.db, { characterId: 'dafeiyu', clock: () => '2026-11-11T04:00:00.000Z' })
  const registry = new SkillRegistry(t.db, { grantedPermissions: [] })

  const refs = {
    fishing: '',
    farming: '',
    skillAck: 'ack-skill',
  }

  const addMemory = async (claim: string, key: 'fishing' | 'farming'): Promise<void> => {
    const created = memory.propose({
      claim,
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [{ eventId: `${claim.length}-a` }, { eventId: `${claim.length}-b` }],
    })
    refs[key] = created.entry.id
    await indexer.index({
      chunkId: `c:${created.entry.id}`,
      kind: 'memory',
      ref: created.entry.id,
      text: claim,
      characterId: 'dafeiyu',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      documentRevision: 1,
    })
  }
  await addMemory('钓鱼片段适合慢慢聊渔获和鱼竿', 'fishing')
  await addMemory('种田片段先回应催促再说明萝卜收成', 'farming')

  registry.register({
    skillId: 'ack-skill',
    version: '1.0.0',
    kind: 'expression',
    description: '礼物答谢感谢短语模板技能',
    permissions: [],
    timeoutMs: 1000,
    handler: 'gift-ack-template',
  })
  const lifecycle = SKILL_LIFECYCLE
  for (let i = 1; i < lifecycle.length; i++) {
    registry.setStatus('ack-skill', '1.0.0', lifecycle[i] as (typeof lifecycle)[number])
  }
  await indexer.index({
    chunkId: 'c:skill:ack-skill',
    kind: 'skill',
    ref: 'ack-skill',
    text: '礼物答谢感谢短语模板技能',
    characterId: 'dafeiyu',
    namespace: 'skills',
    scene: 'farming_chat',
    documentRevision: 1,
  })

  return { t, service, refs }
}
