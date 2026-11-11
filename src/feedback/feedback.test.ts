import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTmpDb } from '../testing/helpers.ts'
import { FeedbackStore } from './feedback-store.ts'

test('反馈记录：有目标归因正常；无目标 → 片段级（不强行归因）', () => {
  const t = makeTmpDb()
  try {
    const store = new FeedbackStore(t.db)
    const attributed = store.record({
      actorKind: 'viewer',
      viewerKey: 'vw_a',
      targetReplyId: 'reply-9',
      label: 'wrong',
      correction: '应该回答萝卜价格',
    })
    assert.equal(attributed.fragment, false)

    const fragment = store.record({ actorKind: 'viewer', viewerKey: 'vw_b', label: 'useful' })
    assert.equal(fragment.fragment, true)
    assert.equal(fragment.targetReplyId, null)
  } finally {
    t.cleanup()
  }
})

test('纠错状态机：received→verifying→resolved；非法迁移拒绝', () => {
  const t = makeTmpDb()
  try {
    const store = new FeedbackStore(t.db)
    const fb = store.record({ actorKind: 'operator', targetSkillRunId: 'run-1', label: 'wrong' })
    assert.equal(store.advance(fb.feedbackId, 'verifying').status, 'verifying')
    assert.equal(store.advance(fb.feedbackId, 'resolved', '已修正技能').status, 'resolved')
    assert.throws(() => store.advance(fb.feedbackId, 'verifying'), /不可/)
  } finally {
    t.cleanup()
  }
})

test('证据不足：如实标 insufficient_evidence，不虚构修复', () => {
  const t = makeTmpDb()
  try {
    const store = new FeedbackStore(t.db)
    const fb = store.record({ actorKind: 'viewer', viewerKey: 'vw_a', label: 'too_slow' })
    assert.equal(store.advance(fb.feedbackId, 'insufficient_evidence').status, 'insufficient_evidence')
  } finally {
    t.cleanup()
  }
})

test('隐私/越权投诉：立即升级 resolved 并留审计', () => {
  const t = makeTmpDb()
  try {
    const store = new FeedbackStore(t.db)
    const fb = store.record({ actorKind: 'viewer', viewerKey: 'vw_a', targetReplyId: 'reply-1', label: 'privacy' })
    assert.equal(store.escalate(fb.feedbackId).status, 'resolved')
    const audit = t.db
      .prepare(`SELECT COUNT(*) AS n FROM audit WHERE action = 'feedback_escalation'`)
      .get() as { n: number }
    assert.equal(audit.n, 1)
  } finally {
    t.cleanup()
  }
})

test('按回复定位反馈（管理员纠错入口）', () => {
  const t = makeTmpDb()
  try {
    const store = new FeedbackStore(t.db)
    store.record({ actorKind: 'viewer', viewerKey: 'vw_a', targetReplyId: 'reply-1', label: 'useful' })
    store.record({ actorKind: 'viewer', viewerKey: 'vw_b', targetReplyId: 'reply-1', label: 'wrong' })
    store.record({ actorKind: 'viewer', viewerKey: 'vw_c', targetReplyId: 'reply-2', label: 'useful' })
    assert.equal(store.byTargetReply('reply-1').length, 2)
    assert.equal(store.pendingQueue().length, 3)
  } finally {
    t.cleanup()
  }
})
