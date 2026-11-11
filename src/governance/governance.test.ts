import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../storage/db.ts'
import { makeTmpDb, type TmpDb } from '../testing/helpers.ts'
import { MemoryStore } from '../memory/l2-store.ts'
import { SKILL_LIFECYCLE, SkillRegistry } from '../skills/registry.ts'
import { PolicyService } from './policy-decision.ts'
import { ReleaseController } from './release.ts'
import { ConsolidationService } from './consolidation.ts'
import { manifestHash, Verifier, type ReleaseManifest } from './verifier.ts'

// ---------------------------------------------------------------------------

function setup(clockNow: () => string = () => '2026-11-11T04:00:00.000Z') {
  const t = makeTmpDb()
  const policy = new PolicyService(t.db, { policyVersion: 'pv-e', clock: clockNow })
  const memory = new MemoryStore(t.db, { characterId: 'dafeiyu', clock: clockNow })
  const registry = new SkillRegistry(t.db, { grantedPermissions: [] })
  registry.register({
    skillId: 'ack-skill', version: '1.0.0', kind: 'expression',
    description: '答谢技能', permissions: [], timeoutMs: 1000, handler: 'gift-ack-template',
  })
  const lc = SKILL_LIFECYCLE
  for (let i = 1; i < lc.length; i++) registry.setStatus('ack-skill', '1.0.0', lc[i] as (typeof lc)[number])
  const releases = new ReleaseController(t.db, policy, { clock: clockNow })
  const consolidation = new ConsolidationService(t.db, policy, memory, { clock: clockNow })
  return { t, policy, memory, registry, releases, consolidation, clockNow }
}

function makeManifest(memories: readonly { id: string; revision: number }[] = [], over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    releaseName: 'r',
    persona: { policyVersion: 'p1', personaHash: 'h1' },
    memories,
    skills: [{ skillId: 'ack-skill', version: '1.0.0' }],
    retrieval: { indexGeneration: 1, embeddingModelRevision: 'test:stub' },
    routing: { policy: 'local_first' },
    metrics: {
      taskQualityDeltaCiLow: 0.01,
      personaRegressionFailures: 0,
      toolTestsPassed: 5,
      toolTestsTotal: 5,
      oomObserved: false,
    },
    observation: { sessions: 3, samples: 120 },
    ...over,
  }
}

// ---------------------------------------------------------------------------
// 验证器（§12.2）

test('验证器：合格清单 → pass 且报告落库', () => {
  const t = makeTmpDb()
  try {
    // 清单引用的技能须真实注册且 active（数据证据门）
    const registry = new SkillRegistry(t.db, { grantedPermissions: [] })
    registry.register({
      skillId: 'ack-skill', version: '1.0.0', kind: 'expression',
      description: '答谢技能', permissions: [], timeoutMs: 1000, handler: 'gift-ack-template',
    })
    const lc = SKILL_LIFECYCLE
    for (let i = 1; i < lc.length; i++) registry.setStatus('ack-skill', '1.0.0', lc[i] as (typeof lc)[number])
    const verifier = new Verifier(t.db)
    const manifest = makeManifest()
    const report = verifier.verify({ manifest, candidateHash: manifestHash(manifest), baselineReleaseId: 'baseline' })
    assert.equal(report.verdict, 'pass')
    assert.ok(report.checks.every((c) => c.verdict === 'pass'))
    const persisted = t.db.prepare('SELECT COUNT(*) AS n FROM verification_reports').get() as { n: number }
    assert.equal(persisted.n, 1)
  } finally {
    t.cleanup()
  }
})

test('验证器：哈希不符 → 完整性 fail；引用已撤销记忆 → 数据门 fail', () => {
  const t = makeTmpDb()
  try {
    const verifier = new Verifier(t.db)
    const manifest = makeManifest()
    const bad = verifier.verify({ manifest, candidateHash: 'tampered', baselineReleaseId: 'b' })
    assert.equal(bad.verdict, 'fail')
    assert.ok(bad.checks.some((c) => c.id === 'integrity_hash' && c.verdict === 'fail'))

    // 撤销记忆后引用 → data_evidence fail
    const memory = new MemoryStore(t.db, { characterId: 'dafeiyu', clock: () => '2026-11-11T04:00:00.000Z' })
    const created = memory.propose({
      claim: '被撤销的记忆', namespace: 'ns', scene: 's',
      evidence: [{ eventId: 'e1' }, { eventId: 'e2' }],
    })
    memory.transition(created.entry.id, 'challenged')
    const withRevoked = verifier.verify({
      manifest: makeManifest([{ id: created.entry.id, revision: 1 }]),
      candidateHash: manifestHash(makeManifest([{ id: created.entry.id, revision: 1 }])),
      baselineReleaseId: 'b',
    })
    assert.equal(withRevoked.verdict, 'fail')
    assert.ok(withRevoked.checks.some((c) => c.id === 'data_evidence_revoked' && c.verdict === 'fail'))
  } finally {
    t.cleanup()
  }
})

test('验证器：指标缺失 ⇒ inconclusive（禁止当作通过）', () => {
  const t = makeTmpDb()
  try {
    const verifier = new Verifier(t.db)
    const manifest: ReleaseManifest = {
      releaseName: 'r',
      persona: { policyVersion: 'p1', personaHash: 'h1' },
      memories: [],
      skills: [],
      retrieval: { indexGeneration: 1, embeddingModelRevision: 'x' },
      routing: { policy: 'local_first' },
      metrics: {},
    }
    const report = verifier.verify({ manifest, candidateHash: manifestHash(manifest), baselineReleaseId: 'b' })
    assert.equal(report.verdict, 'inconclusive')
    assert.ok(report.checks.some((c) => c.verdict === 'inconclusive'))
  } finally {
    t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 发布状态链与回滚（§12.1–§12.4）

function fullActivate(env: ReturnType<typeof setup>, manifest: ReleaseManifest): string {
  const { releaseId } = env.releases.submitCandidate(manifest)
  const report = env.releases.runAutomatedChecks(releaseId)
  assert.equal(report.verdict, 'pass')
  env.releases.enterCanary(releaseId)
  const r1 = env.releases.advanceCanary(releaseId, { sessions: 3, samples: 100 })
  assert.equal(r1.fraction, 0.2)
  env.releases.advanceCanary(releaseId, { sessions: 4, samples: 200 })
  const r3 = env.releases.advanceCanary(releaseId, { sessions: 5, samples: 300 })
  assert.equal(r3.activated, true)
  return releaseId
}

test('发布链：candidate→staged→canary→active；观察不足停留；每阶段至少两场次', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const env = setup(() => now)
  try {
    const { releaseId } = env.releases.submitCandidate(makeManifest())
    const report = env.releases.runAutomatedChecks(releaseId)
    assert.equal(report.verdict, 'pass')
    assert.equal(env.releases.get(releaseId)?.status, 'staged')

    env.releases.enterCanary(releaseId)
    assert.equal(env.releases.get(releaseId)?.canary_fraction, 0.05)
    // 场次不足（1 < 2）⇒ 停留 5%
    const stay = env.releases.advanceCanary(releaseId, { sessions: 1, samples: 10 })
    assert.equal(stay.activated, false)
    assert.equal(env.releases.get(releaseId)?.canary_fraction, 0.05)
    // 场次充足 ⇒ 逐级 20% → 50% → 100% 激活
    assert.equal(env.releases.advanceCanary(releaseId, { sessions: 3, samples: 100 }).fraction, 0.2)
    assert.equal(env.releases.advanceCanary(releaseId, { sessions: 4, samples: 200 }).fraction, 0.5)
    const done = env.releases.advanceCanary(releaseId, { sessions: 5, samples: 300 })
    assert.equal(done.activated, true)
    assert.equal(env.releases.get(releaseId)?.status, 'active')
    assert.equal(env.releases.activeReleaseId(), releaseId)
  } finally {
    env.t.cleanup()
  }
})

test('每日最多一次模型晋级（§12.3）；回滚恢复上一版本并抬高治理 epoch（§12.4）', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const env = setup(() => now)
  try {
    const a = fullActivate(env, makeManifest([], { releaseName: 'A' }))
    assert.equal(env.releases.activeReleaseId(), a)

    // 同日第二次晋级被拒绝
    const { releaseId: bSameDay } = env.releases.submitCandidate(makeManifest([], { releaseName: 'B1' }))
    env.releases.runAutomatedChecks(bSameDay)
    env.releases.enterCanary(bSameDay)
    env.releases.advanceCanary(bSameDay, { sessions: 3, samples: 100 })
    env.releases.advanceCanary(bSameDay, { sessions: 4, samples: 200 })
    assert.throws(() => env.releases.advanceCanary(bSameDay, { sessions: 5, samples: 300 }), /每日最多一次/)

    // 次日晋级 B
    now = '2026-11-12T04:00:00.000Z'
    const b = fullActivate(env, makeManifest([], { releaseName: 'B' }))
    assert.equal(env.releases.get(a)?.status, 'retired')
    assert.equal(env.releases.activeReleaseId(), b)

    // 回滚：epoch+1、恢复 A、B 标记 rolled_back
    const oldGrant = env.policy.issue({ action: 'publish', payloadHash: 'x' })
    const receipt = env.releases.rollback(b)
    assert.equal(receipt.restoredReleaseId, a)
    assert.equal(env.releases.activeReleaseId(), a)
    assert.equal(env.releases.get(b)?.status, 'rolled_back')
    // 旧授权因 epoch 抬高即刻失效（5 秒内阻断 §12.4 的机制基础）
    assert.equal(env.policy.verify(oldGrant).valid, false)
  } finally {
    env.t.cleanup()
  }
})

test('inconclusive 候选：保持 candidate 继续观察，不放宽不跳过', () => {
  const env = setup()
  try {
    const manifest = makeManifest([], { metrics: {} as ReleaseManifest['metrics'] })
    const { releaseId } = env.releases.submitCandidate(manifest)
    const report = env.releases.runAutomatedChecks(releaseId)
    assert.equal(report.verdict, 'inconclusive')
    assert.equal(env.releases.get(releaseId)?.status, 'candidate')
  } finally {
    env.t.cleanup()
  }
})

// ---------------------------------------------------------------------------
// 自动固化（§13）

function seedMatureMemory(env: ReturnType<typeof setup>, eventCount = 5): string {
  // 跨 3+ 场次的独立证据事件
  for (let i = 0; i < eventCount; i++) {
    run(
      env.t.db,
      `INSERT INTO events (event_id, source, source_event_id, room_id, session_id, type, occurred_at, received_at, provenance, payload_ref)
       VALUES (?, 'douyin', ?, 'room-1', ?, 'danmaku', '2026-11-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z', 'platform_verified', 'p')`,
      `e${i}`, `s${i}`, `sess-${i % 3}`,
    )
  }
  const created = env.memory.propose({
    claim: '种田片段先回应催促更适合长期表达',
    namespace: 'evolving_cognition',
    scene: 'farming_chat',
    evidence: Array.from({ length: eventCount }, (_, i) => ({ eventId: `e${i}` })),
  })
  return created.entry.id
}

test('固化条件门：观察不足/证据不足如实阻断', () => {
  let now = '2026-11-02T04:00:00.000Z' // 创建后 1 天
  const env = setup(() => now)
  try {
    const id = seedMatureMemory(env, 3) // 仅 3 证据、观察 1 天
    const report = env.consolidation.evaluateEligibility(id)
    assert.equal(report.eligible, false)
    assert.ok(report.blockers.some((b) => b.includes('观察')))
    assert.ok(report.blockers.some((b) => b.includes('独立证据')))
    const grant = env.policy.issue({ action: 'consolidate', payloadHash: `memory:${id}` })
    assert.throws(() => env.consolidation.consolidate(grant, id), /条件不满足/)
  } finally {
    env.t.cleanup()
  }
})

test('固化全链：条件满足 → learned_stable；去重键防重复；反例撤回后注入过滤', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const env = setup(() => now)
  try {
    const id = seedMatureMemory(env, 5) // 5 证据跨 3 场次
    now = '2026-11-20T04:00:00.000Z' // 观察 9 天
    const report = env.consolidation.evaluateEligibility(id)
    assert.equal(report.eligible, true, JSON.stringify(report.blockers))

    const grant = env.policy.issue({ action: 'consolidate', payloadHash: `memory:${id}` })
    const { stableRevision } = env.consolidation.consolidate(grant, id)
    assert.equal(stableRevision, 1)
    assert.equal(env.consolidation.activeStable('dafeiyu/').length, 1)

    // 同 claim 去重：重复固化拒绝
    assert.throws(() => env.consolidation.consolidate(
      env.policy.issue({ action: 'consolidate', payloadHash: `memory:${id}` }), id), /已存在/)

    // 反例 → challenged + 撤销 → 注入过滤 + 审计
    const stableId = (env.t.db.prepare('SELECT id FROM learned_stable LIMIT 1').get() as { id: string }).id
    env.consolidation.counterExample(stableId, 'e_counter')
    env.consolidation.revoke(stableId)
    assert.equal(env.consolidation.activeStable('dafeiyu/').length, 0)
    const audit = env.t.db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE action='consolidation_challenged'`).get() as { n: number }
    assert.equal(audit.n, 1)

    // 30 天复核到期可见
    now = '2026-12-25T04:00:00.000Z'
    // 撤销条目不进复核；此处应为 0（已撤销）
    assert.equal(env.consolidation.reviewDue().length, 0)
  } finally {
    env.t.cleanup()
  }
})

test('固化内容边界：含观众伪名/权限表述的 claim 不得固化', () => {
  let now = '2026-11-11T04:00:00.000Z'
  const env = setup(() => now)
  try {
    for (let i = 0; i < 5; i++) {
      run(
        env.t.db,
        `INSERT INTO events (event_id, source, source_event_id, room_id, session_id, type, occurred_at, received_at, provenance, payload_ref)
         VALUES (?, 'douyin', ?, 'r', ?, 'danmaku', '2026-11-01T04:00:00.000Z', '2026-11-01T04:00:00.000Z', 'platform_verified', 'p')`,
        `ev${i}`, `sv${i}`, `sess-${i}`,
      )
    }
    const created = env.memory.propose({
      claim: '观众 vw_aabbccddeeff1122 的偏好要记住并允许写入档案',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidence: Array.from({ length: 5 }, (_, i) => ({ eventId: `ev${i}` })),
    })
    now = '2026-11-20T04:00:00.000Z'
    const report = env.consolidation.evaluateEligibility(created.entry.id)
    assert.equal(report.eligible, false)
    assert.ok(report.blockers.some((b) => b.includes('观众伪名') || b.includes('权限')))
  } finally {
    env.t.cleanup()
  }
})
