import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from './index.ts'
import { createEnvelope } from './perception/envelope.ts'
import { NotImplementedError } from './types.ts'

test('插件装配：配置加载 → 迁移 → 恢复 → 各组件就绪', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-plugin-'))
  const logs: string[] = []
  const plugin = createPlugin({
    configPath: join(process.cwd(), 'config/default.yaml'),
    dataDir,
    log: (m) => logs.push(m),
  })
  try {
    assert.equal(plugin.config.mode, 'shadow')
    assert.equal(plugin.featureGates.cloudCallsEnabled, false) // null 预算 → 云端禁用
    // ingest 去重生效
    const env = createEnvelope({
      source: 'douyin:danmaku',
      sourceEventId: 's-1',
      roomId: 'room-1',
      sessionId: 'sess-1',
      occurredAt: new Date().toISOString(),
      type: 'danmaku',
      provenance: 'platform_verified',
      payloadRef: 'payload://s-1',
    })
    const r1 = plugin.runtime.ingest(env)
    const r2 = plugin.runtime.ingest(env)
    assert.equal((await r1).duplicate, false)
    assert.equal((await r2).duplicate, true)
    // 阶段 C 起已实装的接口正常工作；D/E 接口仍显式声明边界
    assert.throws(() => plugin.runtime.trainSlice({ runId: 'r', decision: null as never }), NotImplementedError)
    const bundle = await plugin.runtime.retrieve({ text: '种田', sessionId: 'sess-1', characterId: 'dafeiyu' })
    assert.ok(Array.isArray(bundle.memories))
    assert.equal(bundle.injectedTokens, 0)
    // 阶段 E：发布控制器与固化服务上句柄；无 active 版本时为 null
    assert.ok(plugin.governance.releases.activeReleaseId() === null || typeof plugin.governance.releases.activeReleaseId() === 'string')
    assert.ok(plugin.governance.consolidation.evaluateEligibility('nonexistent').blockers.length > 0)
    assert.ok(plugin.training.samples.eligibleNewCount() === 0)

    // 政策服务与黑板可用
    const dec = plugin.policy.issue({ action: 'memory_write', payloadHash: 'h1' })
    assert.equal(plugin.policy.verify(dec).valid, true)
    plugin.blackboard.write('sess-1', 0, {
      topic: '种田',
      pendingTasks: [],
      recentEventIds: [env.eventId],
      activeReleaseId: 'rel-baseline',
      policyVersion: 'p1',
    })
    assert.ok(plugin.blackboard.readActive('sess-1') !== undefined)

    // 阶段 B：记忆（含矛盾→challenged）
    const weak = await plugin.runtime.proposeCognition({
      claim: '假设A',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      evidenceRefs: ['e1'],
    })
    assert.equal(weak.status, 'proposed')
    const conflicted = await plugin.runtime.proposeCognition({
      claim: '先短后长',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      subject: 'pacing',
      evidenceRefs: ['e1', 'e2', 'e3'],
    })
    assert.equal(conflicted.status, 'active')
    const contradiction = await plugin.runtime.proposeCognition({
      claim: '先长后短',
      namespace: 'evolving_cognition',
      scene: 'farming_chat',
      subject: 'pacing',
      evidenceRefs: ['e4', 'e5', 'e6'],
    })
    assert.equal(contradiction.status, 'challenged')

    // 阶段 B：身份 + 画像隔离 + 删除
    const v1 = plugin.audience.identity.resolve({ platform: 'douyin', roomScope: 'room-1', platformUserId: 'u1' })
    plugin.audience.profiles.setField({ viewerKey: v1.viewerKey, fieldName: 'preferred_topic', value: '"种田"' })
    assert.equal(plugin.audience.profiles.currentFields('vw_other').length, 0)
    const req = plugin.audience.deletion.submitRequest(v1.viewerKey, 'deletion')
    const receipt = plugin.audience.deletion.executeDeletion(req, { verificationPassed: true, viewerKey: v1.viewerKey })
    assert.ok(receipt)
    assert.equal(plugin.audience.profiles.currentFields(v1.viewerKey).length, 0)

    // 阶段 B：内置技能包播种 → active，可执行且幂等
    const activeSkills = plugin.skills.registry.activeSkills()
    assert.ok(activeSkills.some((s) => s.skillId === 'gift-ack-phrase'))
    const skillRun = await plugin.skills.executor.execute({
      requestId: 'req-gift-1',
      skillId: 'gift-ack-phrase',
      version: '1.0.0',
      arguments: { viewerNickname: '小鱼', giftName: '小心心' },
    })
    assert.equal(skillRun.outcome, 'succeeded')
    const rerun = await plugin.skills.executor.execute({
      requestId: 'req-gift-1',
      skillId: 'gift-ack-phrase',
      version: '1.0.0',
      arguments: { viewerNickname: '小鱼', giftName: '小心心' },
    })
    assert.equal(rerun.duplicate, true)

    // 阶段 B：礼物入账 + 答谢入队
    const gift = plugin.gifts.ingestGift({
      platform: 'douyin',
      roomId: 'room-1',
      eventId: 'gift-e1',
      viewerKey: v1.viewerKey,
      giftId: '小心心',
      quantity: 2,
      verified: true,
    })
    assert.equal(gift.quantityDelta, 2)
    assert.equal(plugin.gifts.ledger.totals().receivedQty, 2)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
