import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEnvelope, type EnvelopeInput } from './envelope.ts'
import { EventDedup } from './dedup.ts'
import { makeTmpDb } from '../testing/helpers.ts'

function env(over: Partial<EnvelopeInput> = {}, seq = 0) {
  return createEnvelope({
    source: 'douyin:danmaku',
    sourceEventId: `srv-${seq}`,
    roomId: 'room-1',
    sessionId: 'sess-1',
    occurredAt: '2026-11-11T03:00:00.000Z',
    type: 'danmaku',
    provenance: 'platform_verified',
    payloadRef: `payload://${seq}`,
    ...over,
  })
}

test('重复 (source, source_event_id) 事件被丢弃', () => {
  const t = makeTmpDb()
  try {
    const dedup = new EventDedup(t.db)
    const e = env()
    const r1 = dedup.ingest(e)
    assert.equal(r1.duplicate, false)
    assert.equal(r1.processed, true)
    // 同源同 ID（不同 eventId）再次到达
    const r2 = dedup.ingest(env())
    assert.equal(r2.duplicate, true)
    assert.equal(r2.processed, false)
  } finally {
    t.cleanup()
  }
})

test('接收游标 + 迟到窗口：窗口内处理，窗口外只记录', () => {
  const t = makeTmpDb()
  try {
    const dedup = new EventDedup(t.db, { lateWindowMs: 60_000 })
    // 先到 receivedAt=T0
    dedup.ingest(env({ sourceEventId: 'a', occurredAt: '2026-11-11T03:00:00.000Z', receivedAt: '2026-11-11T03:00:00.100Z' }, 1))
    // 迟到 30s（窗口内）→ 处理
    const inWindow = dedup.ingest(
      env({ sourceEventId: 'b', occurredAt: '2026-11-11T02:59:30.000Z', receivedAt: '2026-11-11T03:00:00.200Z' }, 2),
    )
    assert.equal(inWindow.late, false)
    assert.equal(inWindow.processed, true)
    // 迟到 5min（窗口外）→ 记录但不处理
    const outWindow = dedup.ingest(
      env({ sourceEventId: 'c', occurredAt: '2026-11-11T02:55:00.000Z', receivedAt: '2026-11-11T03:00:00.300Z' }, 3),
    )
    assert.equal(outWindow.late, true)
    assert.equal(outWindow.processed, false)
    // 窗口外事件仍入库（可追溯），但 events 总数 = 3
    const count = t.db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }
    assert.equal(count.n, 3)
  } finally {
    t.cleanup()
  }
})

test('游标按来源隔离：另一来源不受影响', () => {
  const t = makeTmpDb()
  try {
    const dedup = new EventDedup(t.db, { lateWindowMs: 60_000 })
    dedup.ingest(env({ source: 'douyin:gift', receivedAt: '2026-11-11T03:00:00.000Z' }, 1))
    const other = dedup.ingest(
      env({ source: 'operator', occurredAt: '2026-11-11T02:00:00.000Z', receivedAt: '2026-11-11T03:00:00.000Z' }, 2),
    )
    assert.equal(other.processed, true)
  } finally {
    t.cleanup()
  }
})
