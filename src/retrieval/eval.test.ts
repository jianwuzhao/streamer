import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { loadConfig } from '../config.ts'
import { makeTmpDb } from '../testing/helpers.ts'
import { OllamaEmbeddingProvider } from './embedding.ts'
import { Bm25Index, tokenize } from './bm25.ts'
import { ablation, runRetrievalEval, type EvalQueryCase } from './eval.ts'

// ---------------------------------------------------------------------------

test('BM25：中文 bigram 分词与关键词命中', () => {
  assert.deepEqual(tokenize('种田'), ['种田'])
  assert.deepEqual([...tokenize('今天种萝卜')], ['今天', '天种', '种萝', '萝卜'])
  const idx = new Bm25Index()
  idx.rebuild([
    { id: 'a', text: '种田片段先简短回应催促' },
    { id: 'b', text: '钓鱼片段聊渔获' },
    { id: 'c', text: '答谢用固定模板' },
  ])
  const hits = idx.search('种田 催促', 3)
  assert.equal(hits[0]?.id, 'a')
  assert.ok(!hits.some((h) => h.id === 'c'))
})

test('OllamaEmbeddingProvider：/api/embed 调用与响应解析', async () => {
  await new Promise<void>((resolveTest, reject) => {
    const server: Server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        const body = JSON.parse(data) as { model?: string; input?: string[] }
        assert.equal(body.model, 'Qwen/Qwen3-Embedding-0.6B')
        assert.deepEqual(body.input, ['你好', '种田'])
        res.end(JSON.stringify({ embeddings: [[0.1, 0.2], [0.3, 0.4]] }))
      })
    })
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'))
        return
      }
      const provider = new OllamaEmbeddingProvider({
        baseURL: `http://127.0.0.1:${addr.port}`,
        model: 'Qwen/Qwen3-Embedding-0.6B',
      })
      try {
        const vecs = await provider.embed(['你好', '种田'])
        assert.equal(vecs.length, 2)
        assert.deepEqual([...(vecs[0] ?? [])], [0.1, 0.2])
        assert.equal(provider.modelRevision, 'ollama:Qwen/Qwen3-Embedding-0.6B')
        resolveTest()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
})

// ---------------------------------------------------------------------------
// 保留集与消融（§8.4）：融合须优于单路

test('消融评测：三路融合 Recall@5 不低于任一单路', async () => {
  const { makeFixtureEval } = await import('./eval-fixture.ts')
  const f = await makeFixtureEval()
  try {
    const dataset: readonly EvalQueryCase[] = [
      { queryId: 'q1', text: '垂钓的时候聊什么', characterId: 'dafeiyu', relevantRefs: [f.refs.fishing] },
      { queryId: 'q2', text: '种地片段怎么回应催促', characterId: 'dafeiyu', relevantRefs: [f.refs.farming] },
      { queryId: 'q3', text: '答谢', characterId: 'dafeiyu', relevantRefs: [f.refs.skillAck] },
      { queryId: 'q4', text: '萝卜什么时候收', characterId: 'dafeiyu', relevantRefs: [f.refs.farming] },
      { queryId: 'q5', text: '鱼竿保养', characterId: 'dafeiyu', relevantRefs: [f.refs.fishing] },
    ]
    const reports = await ablation(f.service, dataset)
    const fusion = reports.fusion as { recallAt5: number }
    const lexical = reports.lexical_only as { recallAt5: number }
    const vector = reports.vector_only as { recallAt5: number }
    assert.ok(fusion.recallAt5 >= lexical.recallAt5, `fusion=${fusion.recallAt5} < lexical=${lexical.recallAt5}`)
    assert.ok(fusion.recallAt5 >= vector.recallAt5, `fusion=${fusion.recallAt5} < vector=${vector.recallAt5}`)
    assert.ok(fusion.recallAt5 > 0.5)
    // 报告含延迟分位（p95 ≤ 250ms 预算为实机目标；本地仅验证字段存在）
    const full = await runRetrievalEval(f.service, dataset)
    assert.ok(full.latencyP95Ms >= 0)
    assert.ok(full.cases.length === dataset.length)
  } finally {
    f.t.cleanup()
  }
})
