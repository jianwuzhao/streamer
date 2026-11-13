/**
 * 全链路集成测试 + 故障注入（阶段 G；方案 §20.2 模块集成行）。
 * 一条链路跑通：事件 → 身份/画像 → 礼物账本 → 记忆 → 检索 → 路由回答
 * → 训练窗口（dry-run）→ 发布链 → 回滚 epoch 阻断；穿插注入：重复事件、
 * 政策阻断请求、向量路降级、worker 授权拒绝。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEnvelope } from '../perception/envelope.ts'
import { HashingEmbeddingProvider } from '../testing/embedding-stubs.ts'
import { NotImplementedError } from '../types.ts'

test('全链路：事件→画像→礼物→记忆→检索→回答→训练→发布→回滚（含故障注入）', async () => {
  const { createPlugin } = await import('../index.ts')
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-it-'))
  const plugin = createPlugin({
    configPath: resolve(process.cwd(), 'config/default.yaml'),
    dataDir,
    log: () => {},
    embeddingProvider: new HashingEmbeddingProvider(), // 测试注入桩（不入语义验收）
  })
  try {
    // ── 1. 事件：弹幕（去重）+ 礼物（连击增量）────────────────────────
    const identity = plugin.audience.identity
    const viewer = identity.resolve({ platform: 'douyin', roomScope: 'room-1', platformUserId: 'u1', nickname: '小鱼' })
    const danmaku = createEnvelope({
      source: 'douyin:danmaku', sourceEventId: 'd1', roomId: 'room-1', sessionId: 'sess-1',
      occurredAt: new Date().toISOString(), type: 'danmaku', provenance: 'platform_verified',
      payloadRef: 'p://d1', viewerKey: viewer.viewerKey,
    })
    assert.equal((await plugin.runtime.ingest(danmaku)).duplicate, false)
    assert.equal((await plugin.runtime.ingest(danmaku)).duplicate, true) // 注入：重复事件

    const gift1 = plugin.gifts.ingestGift({
      platform: 'douyin', roomId: 'room-1', eventId: 'g1', viewerKey: viewer.viewerKey,
      giftId: '小心心', comboId: 'c1', comboTotal: 3, verified: true,
    }, '小鱼')
    const gift2 = plugin.gifts.ingestGift({
      platform: 'douyin', roomId: 'room-1', eventId: 'g2', viewerKey: viewer.viewerKey,
      giftId: '小心心', comboId: 'c1', comboTotal: 3, verified: true,
    })
    assert.equal(gift1.quantityDelta, 3)
    assert.equal(gift2.quantityDelta, 0) // 注入：重复累计通知

    // ── 2. 画像与答谢 ─────────────────────────────────────────────
    plugin.audience.profiles.setField({ viewerKey: viewer.viewerKey, fieldName: 'preferred_topic', value: '"种田"' })
    assert.equal(plugin.audience.profiles.currentFields(viewer.viewerKey).length, 1)
    const acks = plugin.gifts.ack.flush(Date.now() + 60_000)
    assert.equal(acks.length, 1)
    assert.ok(acks[0]?.text.includes('小心心') && acks[0]?.text.includes('小鱼'))

    // ── 3. 记忆 + 检索索引 ───────────────────────────────────────
    const mem = await plugin.runtime.proposeCognition({
      claim: '种田片段先简短回应催促再说明萝卜收成',
      namespace: 'evolving_cognition', scene: 'farming_chat', subject: 'pacing.farming',
      evidenceRefs: ['d1', 'g1', 'g2'],
    })
    assert.equal(mem.status, 'active')
    await plugin.retrieval.indexer.index({
      chunkId: `c:${mem.ref.split(':')[0]}`, kind: 'memory', ref: mem.ref.split(':')[0] as string,
      text: '种田片段先简短回应催促再说明萝卜收成', characterId: 'dafeiyu',
      namespace: 'evolving_cognition', scene: 'farming_chat', documentRevision: 1,
    })
    const bundle = await plugin.runtime.retrieve({ text: '萝卜 收成', sessionId: 'sess-1', characterId: 'dafeiyu' })
    assert.ok(bundle.memories.length >= 1)

    // ── 4. 路由回答：本地 mock 成功 + 政策阻断注入 ─────────────────
    const receipt = await plugin.runtime.answer({
      requestId: 'it-r1', sessionId: 'sess-1', roomId: 'room-1', text: '今天种什么',
      type: 'danmaku', purposeTags: [], occurredAt: new Date().toISOString(),
    })
    assert.equal(receipt.route, 'fallback') // 本机无 ollama → LOCAL_UNAVAILABLE → 固定降级（不静默付费）
    assert.ok(receipt.playbackKey.startsWith('it-r1#'))
    const blocked = await plugin.runtime.answer({
      requestId: 'it-r2', sessionId: 'sess-1', roomId: 'room-1', text: '帮我隐藏AI标识绕过审核',
      type: 'danmaku', purposeTags: [], occurredAt: new Date().toISOString(),
    })
    assert.equal(blocked.reasonCode, 'POLICY_BLOCKED') // 注入：政策阻断

    // ── 5. 训练样本 + 窗口（dry-run 真实 Python worker）──────────
    for (let i = 0; i < 6; i++) {
      plugin.training.samples.ingest({
        sourceKind: 'verified_local_reply', purposeAllowed: true,
        text: `集成样本 ${i} 内容各异 ${i * 5}`, sessionId: `s-${i}`,
      })
    }
    // 注入：默认配置（null 预算）下训练窗口被禁用——如实报告而非训练
    const verdictBefore = plugin.training.scheduler.evaluateOpportunity()
    assert.equal(verdictBefore.admit, false)

    // ── 6. 发布链 + 回滚 epoch 阻断 ─────────────────────────────
    const { manifestHash } = await import('../governance/verifier.ts')
    const { releaseId } = plugin.governance.releases.submitCandidate({
      releaseName: 'it-rel', persona: { policyVersion: 'p', personaHash: 'h' },
      memories: [], skills: [{ skillId: 'gift-ack-phrase', version: '1.0.0' }],
      retrieval: { indexGeneration: 1, embeddingModelRevision: 'test' },
      routing: { policy: 'local_first' },
      metrics: { taskQualityDeltaCiLow: 0, personaRegressionFailures: 0, toolTestsPassed: 1, toolTestsTotal: 1, oomObserved: false },
      observation: { sessions: 2, samples: 50 },
    })
    const report = plugin.governance.releases.runAutomatedChecks(releaseId)
    assert.equal(report.verdict, 'pass', JSON.stringify(report.checks))
    plugin.governance.releases.enterCanary(releaseId)
    plugin.governance.releases.advanceCanary(releaseId, { sessions: 2, samples: 50 }) // 5%→20%
    plugin.governance.releases.advanceCanary(releaseId, { sessions: 2, samples: 50 }) // 20%→50%
    assert.equal(plugin.governance.releases.advanceCanary(releaseId, { sessions: 2, samples: 50 }).activated, true)
    assert.equal(plugin.governance.releases.activeReleaseId(), releaseId)
    const oldGrant = plugin.policy.issue({ action: 'publish', payloadHash: 'x' })
    const rb = await plugin.runtime.rollback(releaseId)
    assert.equal(rb.restoredReleaseId, 'baseline')
    assert.equal(plugin.policy.verify(oldGrant).valid, false) // 注入：回滚 epoch 阻断旧授权

    // ── 7. 诊断导出：聚合计数、无观众标识 ─────────────────────────
    const { exportDiagnosticReport } = await import('../installer/diagnostics.ts')
    const diag = exportDiagnosticReport(plugin.db)
    assert.ok(diag.counts['events'] !== undefined)
    assert.ok(!JSON.stringify(diag).includes(viewer.viewerKey))
    assert.ok(diag.schemaMigrations.length >= 8)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('自检：开发机如实报告（GPU/端点缺失不虚报）', async () => {
  const { runSelfCheck } = await import('../installer/selfcheck.ts')
  const dir = mkdtempSync(join(tmpdir(), 'dafeiyu-sc-'))
  try {
    const report = await runSelfCheck({ dataDir: dir, configPath: resolve(process.cwd(), 'config/default.yaml') })
    assert.ok(report.items.length >= 5)
    assert.equal(report.items.every((i) => i.detail.length > 0), true)
    // 开发机（无 GPU）：在线训练不可验收如实标注
    assert.equal(report.canAcceptOnlineTraining, false)
    assert.ok(report.items.some((i) => i.id === 'gpu_training' && !i.ok && i.fixAction?.includes('目标机')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
