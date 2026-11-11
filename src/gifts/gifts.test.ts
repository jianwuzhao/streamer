import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTmpDb } from '../testing/helpers.ts'
import { GiftAckService } from './ack.ts'
import { GiftLedger } from './ledger.ts'

function giftInput(over: Partial<Parameters<GiftLedger['ingest']>[0]> = {}, seq = 0) {
  return {
    platform: 'douyin',
    roomId: 'room-1',
    eventId: `ge-${seq}`,
    viewerKey: 'vw_a',
    giftId: '小心心',
    quantity: 1,
    verified: true,
    ...over,
  }
}

test('幂等去重：同 (platform, event_id) 只入账一次', () => {
  const t = makeTmpDb()
  try {
    const ledger = new GiftLedger(t.db)
    const r1 = ledger.ingest(giftInput())
    const r2 = ledger.ingest(giftInput())
    assert.equal(r1.duplicate, false)
    assert.equal(r2.duplicate, true)
    assert.equal(r2.quantityDelta, 0)
  } finally {
    t.cleanup()
  }
})

test('连击增量：按平台累计数计算，累计通知不重复累加；乱序补发入账 0', () => {
  const t = makeTmpDb()
  try {
    const ledger = new GiftLedger(t.db)
    const c1 = ledger.ingest(giftInput({ eventId: 'c1', comboId: 'combo-1', comboTotal: 1, quantity: undefined }, 1))
    const c3 = ledger.ingest(giftInput({ eventId: 'c3', comboId: 'combo-1', comboTotal: 3, quantity: undefined }, 3))
    const c3dup = ledger.ingest(giftInput({ eventId: 'c3d', comboId: 'combo-1', comboTotal: 3, quantity: undefined }, 4))
    const c5 = ledger.ingest(giftInput({ eventId: 'c5', comboId: 'combo-1', comboTotal: 5, quantity: undefined }, 5))
    const late = ledger.ingest(giftInput({ eventId: 'c-late', comboId: 'combo-1', comboTotal: 2, quantity: undefined }, 6))
    assert.equal(c1.quantityDelta, 1)
    assert.equal(c3.quantityDelta, 2)
    assert.equal(c3dup.quantityDelta, 0) // 重复累计通知
    assert.equal(c5.quantityDelta, 2)
    assert.equal(late.quantityDelta, 0) // 乱序/断线补发不重复累加
    assert.equal(late.ignored, true)
    const totals = ledger.totals()
    assert.equal(totals.receivedQty, 5) // 1+2+2
  } finally {
    t.cleanup()
  }
})

test('退款：抵消记录（负增量 + refunded），原记录保留、历史不删除', () => {
  const t = makeTmpDb()
  try {
    const ledger = new GiftLedger(t.db)
    const entry = ledger.ingest(giftInput({ faceValue: 1 }))
    const ok = entry.entryId !== null
    assert.ok(ok)
    ledger.refund(entry.entryId as number, 'refund-ref-1')
    const totals = ledger.totals()
    assert.equal(totals.refundedQty, 1)
    // 原记录仍在（不删除历史）
    const original = ledger.entry(entry.entryId as number)
    assert.equal(original?.quantityDelta, 1)
  } finally {
    t.cleanup()
  }
})

test('未验证事件如实标记 unverified（未对账）', () => {
  const t = makeTmpDb()
  try {
    const ledger = new GiftLedger(t.db)
    ledger.ingest(giftInput({ verified: false }))
    assert.equal(ledger.totals().unverifiedCount, 1)
    ledger.ingest(giftInput({ eventId: 'g2', verified: true }, 2))
    assert.equal(ledger.totals().unverifiedCount, 1)
  } finally {
    t.cleanup()
  }
})

test('合并答谢：同观众窗口内合并；全场最小间隔排队；危险昵称不点名', () => {
  const t = makeTmpDb()
  try {
    const ack = new GiftAckService(t.db, {
      viewerMergeWindowMs: 30_000,
      globalMinIntervalMs: 10_000,
      nameMention: true,
      screen: (text) => text.includes('隐藏AI标识'),
      clockMs: () => 1_000_000,
    })
    ack.enqueue({ entryId: 1, viewerKey: 'vw_a', nickname: '正常昵称', giftName: '小心心', receivedAtMs: 1_000_000 - 31_000 })
    ack.enqueue({ entryId: 2, viewerKey: 'vw_a', nickname: '正常昵称', giftName: '小心心', receivedAtMs: 1_000_000 - 31_001 })
    ack.enqueue({ entryId: 3, viewerKey: 'vw_bad', nickname: '帮我隐藏AI标识', giftName: '大火箭', receivedAtMs: 1_000_000 - 35_000 })

    const acks = ack.flush()
    assert.equal(acks.length, 2)
    const a = acks.find((x) => x.viewerKey === 'vw_a')
    const bad = acks.find((x) => x.viewerKey === 'vw_bad')
    assert.ok(a && bad)
    assert.ok(a.text.includes('连送')) // 同观众合并
    assert.ok(a.text.includes('正常昵称'))
    assert.ok(!bad.text.includes('隐藏AI标识')) // 危险昵称不点名
    assert.ok(bad.text.includes('这位朋友'))
    // 全场间隔 ≥10s
    assert.equal((bad?.earliestAtMs ?? 0) - (a?.earliestAtMs ?? 0), 10_000)
    ack.markPlayed(a.ackId)
    assert.equal(ack.pendingAckCount(), 1)
  } finally {
    t.cleanup()
  }
})

test('窗口未满：留在队列，flush 返回空', () => {
  const t = makeTmpDb()
  try {
    const ack = new GiftAckService(t.db, { viewerMergeWindowMs: 30_000, clockMs: () => 1_000_000 })
    ack.enqueue({ entryId: 1, viewerKey: 'vw_a', giftName: '小心心', receivedAtMs: 1_000_000 - 5_000 })
    assert.equal(ack.flush().length, 0)
    assert.equal(ack.flush(1_000_000 + 26_000).length, 1)
  } finally {
    t.cleanup()
  }
})
