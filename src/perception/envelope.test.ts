import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvelope, validateEnvelope } from './envelope.ts'

const baseInput = {
  source: 'douyin:danmaku',
  sourceEventId: 'srv-1001',
  roomId: 'room-1',
  sessionId: 'sess-1',
  occurredAt: '2026-11-11T03:00:00.000Z',
  type: 'danmaku',
  provenance: 'platform_verified' as const,
  payloadRef: 'payload://evt/srv-1001',
}

test('createEnvelope 补全缺省字段并生成 eventId', () => {
  const env = createEnvelope(baseInput)
  assert.ok(env.eventId.startsWith('evt_'))
  assert.equal(env.schemaVersion, 1)
  assert.ok(env.receivedAt.length > 0)
  assert.deepEqual(env.causalEventIds, [])
  assert.deepEqual(env.purposeTags, [])
  assert.equal(env.replay, false)
})

test('createEnvelope 保留传入字段', () => {
  const env = createEnvelope({
    ...baseInput,
    viewerKey: 'viewer-9',
    causalEventIds: ['evt_a', 'evt_b'],
    purposeTags: ['live_interaction'],
    correlationId: 'corr-1',
    replay: true,
  })
  assert.equal(env.viewerKey, 'viewer-9')
  assert.deepEqual(env.causalEventIds, ['evt_a', 'evt_b'])
  assert.deepEqual(env.purposeTags, ['live_interaction'])
  assert.equal(env.replay, true)
})

test('validateEnvelope：坏数据报出字段路径', () => {
  const bad = { ...createEnvelope(baseInput), provenance: 'guessed' }
  const res = validateEnvelope(bad)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.ok(res.issues.some((i) => i.startsWith('provenance')), res.issues.join('; '))
  }
})

test('validateEnvelope：合法 envelope 通过', () => {
  const env = createEnvelope(baseInput)
  const res = validateEnvelope(env)
  assert.equal(res.ok, true)
})
