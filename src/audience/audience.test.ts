import assert from 'node:assert/strict'
import { test } from 'node:test'
import { run } from '../storage/db.ts'
import { makeTmpDb } from '../testing/helpers.ts'
import { ViewerIdentity } from './identity.ts'
import { ProfileStore } from './profile-store.ts'
import { DeletionService } from './deletion.ts'

test('身份键：同一 platform+room+userId 恒等；昵称变化不换身份；同名不同平台不合并', () => {
  const t = makeTmpDb()
  try {
    const identity = new ViewerIdentity(t.db, { fixedKey: 'unit-test-key' })
    const a1 = identity.resolve({ platform: 'douyin', roomScope: 'room-1', platformUserId: 'u123', nickname: '小鱼' })
    const a2 = identity.resolve({ platform: 'douyin', roomScope: 'room-1', platformUserId: 'u123', nickname: '大鱼' })
    assert.equal(a1.viewerKey, a2.viewerKey)
    assert.equal(a2.created, false)
    assert.equal(a2.nicknameChanged, true)

    const otherPlatform = identity.resolve({ platform: 'kuaishou', roomScope: 'room-1', platformUserId: 'u123', nickname: '小鱼' })
    assert.notEqual(a1.viewerKey, otherPlatform.viewerKey)

    const sameNameOtherId = identity.resolve({ platform: 'douyin', roomScope: 'room-1', platformUserId: 'u999', nickname: '小鱼' })
    assert.notEqual(a1.viewerKey, sameNameOtherId.viewerKey)
  } finally {
    t.cleanup()
  }
})

test('字段版本链：更新写新版本；viewer_stated 覆盖 inferred 且审计保留', () => {
  const t = makeTmpDb()
  try {
    const profiles = new ProfileStore(t.db)
    profiles.setField({
      viewerKey: 'vw_x',
      fieldName: 'preferred_topic',
      value: '"种田"',
      confidenceKind: 'inferred',
      purpose: 'personalization',
      sourceEventIds: ['e1'],
    })
    const corrected = profiles.viewerCorrection({
      viewerKey: 'vw_x',
      fieldName: 'preferred_topic',
      value: '"钓鱼"',
      sourceEventIds: ['e2'],
    })
    assert.equal(corrected.confidenceKind, 'viewer_stated')
    const current = profiles.currentFields('vw_x')
    assert.equal(current.length, 1)
    assert.equal(current[0]?.value, '"钓鱼"')
    // 审计链：旧版本仍在（superseded_by 指向新版本）
    const history = t.db
      .prepare(`SELECT COUNT(*) AS n FROM profile_fields WHERE viewer_key = 'vw_x' AND field_name = 'preferred_topic'`)
      .get() as { n: number }
    assert.equal(history.n, 2)
  } finally {
    t.cleanup()
  }
})

test('画像隔离：A 的字段不出现在 B 的查询；聚合按 viewerKey 过滤', () => {
  const t = makeTmpDb()
  try {
    const profiles = new ProfileStore(t.db)
    profiles.setField({ viewerKey: 'vw_a', fieldName: 'secret_note', value: '"A 私有"' })
    assert.equal(profiles.currentFields('vw_b').length, 0)

    // 事件聚合同样按 viewer 过滤
    run(
      t.db,
      `INSERT INTO events (event_id, source, source_event_id, room_id, session_id, viewer_key, type, occurred_at, received_at, provenance, payload_ref)
       VALUES ('e1','douyin','s1','r','sess','vw_a','danmaku','2026-11-11T04:00:00Z','2026-11-11T04:00:00Z','platform_verified','p')`,
    )
    const aCounts = profiles.aggregateInteractionCounts('vw_a')
    const bCounts = profiles.aggregateInteractionCounts('vw_b')
    assert.equal(aCounts['danmaku'], 1)
    assert.equal(bCounts['danmaku'], undefined)
  } finally {
    t.cleanup()
  }
})

test('删除全流程：验证通过 → 墓碑 + profile 标记；查询即时为空；传播状态如实', () => {
  const t = makeTmpDb()
  try {
    const identity = new ViewerIdentity(t.db, { fixedKey: 'k' })
    const profiles = new ProfileStore(t.db)
    const deletion = new DeletionService(t.db)
    const { viewerKey } = identity.resolve({ platform: 'douyin', roomScope: 'r', platformUserId: 'u1' })
    profiles.setField({ viewerKey, fieldName: 'preferred_topic', value: '"种田"' })

    const requestId = deletion.submitRequest(viewerKey, 'deletion')
    // 未验证 → 不执行（未完成身份验证不返回他人画像/不删除）
    assert.equal(deletion.executeDeletion(requestId, { verificationPassed: false, viewerKey }), null)
    assert.equal(profiles.isDeleted(viewerKey), false)

    const receipt = deletion.executeDeletion(requestId, { verificationPassed: true, viewerKey })
    assert.ok(receipt)
    assert.equal(profiles.isDeleted(viewerKey), true)
    assert.equal(profiles.currentFields(viewerKey).length, 0)
    assert.equal(profiles.profileSummary(viewerKey).deleted, true)
    // 传播状态如实：未建成的系统标注 not_applicable（不虚报完成）
    assert.equal(receipt.propagation.profiles, 'done')
    assert.equal(receipt.propagation.vectors, 'not_applicable_phase_c')
    assert.equal(receipt.propagation.training_candidates, 'not_applicable_phase_d')
    // 墓碑可重放（恢复流程使用）
    assert.equal(deletion.tombstones().length, 1)
  } finally {
    t.cleanup()
  }
})

test('退出个性化：字段保留但 purpose 过滤生效', () => {
  const t = makeTmpDb()
  try {
    const identity = new ViewerIdentity(t.db, { fixedKey: 'k' })
    const profiles = new ProfileStore(t.db)
    const deletion = new DeletionService(t.db)
    const { viewerKey } = identity.resolve({ platform: 'douyin', roomScope: 'r', platformUserId: 'u2' })
    profiles.setField({ viewerKey, fieldName: 'preferred_topic', value: '"种田"', purpose: 'personalization' })

    deletion.personalizationOff(viewerKey)
    const allFields = profiles.currentFields(viewerKey)
    assert.equal(allFields.length, 1) // 服务与安全事件仍保留
    const filtered = profiles.currentFields(viewerKey, { purposeExclude: ['service_no_personalization'] })
    assert.equal(filtered.length, 0) // 个性化用途被过滤
  } finally {
    t.cleanup()
  }
})
