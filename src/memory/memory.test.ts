import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTmpDb } from '../testing/helpers.ts'
import { countIndependentEvidence, type EvidenceRef } from './evidence.ts'
import { MemoryStore } from './l2-store.ts'

function ev(eventId: string, over: Partial<EvidenceRef> = {}): EvidenceRef {
  return { eventId, ...over }
}

function makeStore(clock: () => string) {
  const t = makeTmpDb()
  const store = new MemoryStore(t.db, { characterId: 'dafeiyu', clock })
  return { t, store }
}

test('独立证据：不同观众/不同簇各计一次，同账号刷屏与同源派生不算', () => {
  const verdict = countIndependentEvidence([
    ev('e1', { viewerKey: 'vw_a' }),
    ev('e2', { viewerKey: 'vw_a' }), // 同账号刷屏 → 拒
    ev('e3', { clusterId: 'c1' }),
    ev('e4', { clusterId: 'c1' }), // 同簇 → 拒
    ev('e5', { derivedFrom: 'e1' }), // 同源派生 → 拒
    ev('e6', { viewerKey: 'vw_b' }),
  ])
  assert.equal(verdict.independent.length, 3)
  assert.equal(verdict.rejected.length, 3)
})

test('L2 生命周期：证据不足 → proposed；两个独立证据 → 直接 active', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    const weak = store.propose({
      claim: '假设：观众喜欢短回复',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_a' })],
    })
    assert.equal(weak.entry.status, 'proposed') // 同账号只算 1 独立证据

    const strong = store.propose({
      claim: '种田片段先简短回应催促再说明动作',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [ev('e10', { viewerKey: 'vw_a' }), ev('e11', { viewerKey: 'vw_b' })],
    })
    assert.equal(strong.entry.status, 'active')
    assert.equal(strong.independentEvidence, 2)
    assert.deepEqual(store.activeFor('farming_chat').map((e) => e.id), [strong.entry.id])
  } finally {
    t.cleanup()
  }
})

test('矛盾：同主体同场景不同 claim → 双方 challenged，检索不呈现任何一方', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    const first = store.propose({
      claim: '种田片段适合先简短回应',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      subject: 'game_pacing.farming',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_b' })],
    })
    assert.equal(first.entry.status, 'active')

    const second = store.propose({
      claim: '种田片段适合长篇讲解背景',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      subject: 'game_pacing.farming',
      evidence: [ev('e3', { viewerKey: 'vw_c' }), ev('e4', { viewerKey: 'vw_d' })],
    })
    assert.equal(second.entry.status, 'challenged')
    assert.equal(second.challenged.length, 1) // 既有条目被标记
    assert.equal(store.latest(first.entry.id)?.status, 'challenged')
    // 检索不把任何一方呈现为确定事实（active 为空）
    assert.equal(store.activeFor('farming_chat', { subject: 'game_pacing.farming' }).length, 0)
  } finally {
    t.cleanup()
  }
})

test('过期在查询时立即生效（不依赖后台清理）', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    const created = store.propose({
      claim: '观众在意收获进度',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_b' })],
    })
    assert.equal(store.activeFor('farming_chat').length, 1)
    now = new Date(Date.parse(created.entry.expiresAt) + 1).toISOString()
    assert.equal(store.activeFor('farming_chat').length, 0)
  } finally {
    t.cleanup()
  }
})

test('修订保留血缘：supersede 写新 revision，链完整、旧 claim 可追溯', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    const created = store.propose({
      claim: '第一版说法',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_b' })],
    })
    const revised = store.supersede(created.entry.id, '修订后的说法', [
      ev('e1', { viewerKey: 'vw_a' }),
      ev('e3', { viewerKey: 'vw_c' }),
    ])
    assert.equal(revised?.revision, 2)
    assert.equal(revised?.claim, '修订后的说法')
    assert.equal(revised?.supersedes, `${created.entry.id}:1`)
    const chain = store.lineage(created.entry.id)
    assert.equal(chain.length, 2)
    assert.equal(chain[0]?.claim, '第一版说法')
  } finally {
    t.cleanup()
  }
})

test('反例证据：新 revision 转 challenged', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    const created = store.propose({
      claim: '晚上观众更多',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_b' })],
    })
    const challenged = store.addCounterEvidence(created.entry.id, 'e_counter')
    assert.equal(challenged?.status, 'challenged')
    assert.deepEqual(challenged?.counterEvidence, ['e_counter'])
  } finally {
    t.cleanup()
  }
})

test('L4：经验条目默认更长 TTL；到期复核列表', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const { t, store } = makeStore(() => now)
  try {
    store.propose({
      claim: '答谢合并后互动更顺',
      namespace: 'evolving_cognition',
      scene: 'gift',
      layer: 'L4',
      evidence: [ev('e1', { viewerKey: 'vw_a' }), ev('e2', { viewerKey: 'vw_b' })],
    })
    // review_after 默认 2 天（L2）或 TTL/2；L4 TTL 14 天 → 7 天后复核
    assert.equal(store.reviewDue().length, 0)
    now = '2026-11-20T04:00:00.000Z'
    assert.equal(store.reviewDue().length, 1)
  } finally {
    t.cleanup()
  }
})
