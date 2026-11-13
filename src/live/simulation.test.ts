import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTmpDb } from '../testing/helpers.ts'
import { SettingsStore } from '../settings/store.ts'
import { SimulationError, SimulationService, type SimulationAnswer } from './simulation.ts'
import { all } from '../storage/db.ts'
import type { LiveEnvelope } from '../types.ts'

/** 可控回答器：默认如实降级（route=fallback），也可模拟本地成功。 */
function makeService(opts: { answer?: SimulationAnswer; ingest?: (env: LiveEnvelope) => void } = {}) {
  const t = makeTmpDb()
  const settings = new SettingsStore(t.db)
  const ingested: LiveEnvelope[] = []
  const service = new SimulationService({
    db: t.db,
    settings,
    answer:
      opts.answer ??
      (async () => ({ text: '固定降级模板', route: 'fallback' as const, latencyMs: 1 })),
    ingest: async (env) => {
      ingested.push(env)
      opts.ingest?.(env)
      return { eventId: env.eventId, duplicate: false, late: false, processed: true }
    },
  })
  return { ...t, settings, service, ingested }
}

test('simulation：初始态 idle、无报告；桌宠为默认形象', () => {
  const t = makeService()
  try {
    const s = t.service.state()
    assert.equal(s.status, 'idle')
    assert.equal(s.runNo, 0)
    assert.equal(s.firstCompleted, false)
    assert.equal(s.report, null)
    assert.equal(s.persona.avatarId, 'fish-deskpet')
    assert.equal(s.persona.voiceInteractionEnabled, true)
    assert.equal(s.catalogs.avatars[0]?.style, 'deskpet')
    // 角色档案（主播信息）：默认 dsh-pet 插件中档案，目录含鹅次元角色
    assert.equal(s.profile.id, 'dsh-pet')
    assert.equal(s.profile.source, 'plugin')
    assert.equal(s.persona.name, '大肥鱼')
    assert.equal(s.catalogs.profiles.length, 5)
    assert.ok(s.persona.aiLabelText.length > 0)
    assert.equal(t.service.report(), null)
  } finally {
    t.cleanup()
  }
})

test('simulation：start 幂等、stop 收尾，AI 标识与桌宠主题随设置', async () => {
  const t = makeService()
  try {
    await t.service.start()
    const a = t.service.state()
    assert.equal(a.status, 'running')
    assert.equal(a.runNo, 1)
    assert.ok(a.events.length >= 1) // 开场白
    assert.equal(a.events[0]?.kind, 'system')
    assert.equal(a.persona.theme.primary, '#0f5e57')

    // 幂等：重复 start 不新增场次
    await t.service.start()
    assert.equal(t.service.state().runNo, 1)

    await t.service.stop()
    const b = t.service.state()
    assert.equal(b.status, 'ended')
    assert.equal(b.firstCompleted, true)
    assert.ok(b.endedAt !== null)
    assert.ok(b.report !== null)
    assert.equal(b.report?.runNo, 1)
    assert.equal(b.report?.isFirst, true)
    assert.ok(b.report?.notes.some((n) => n.includes('未推流')))
    assert.ok(b.report?.notes.some((n) => n.includes('AI 标识')))
    assert.equal(b.report?.profileName, '大肥鱼') // 演练报告带出角色档案中文名

    // 第二场 isFirst=false
    await t.service.start()
    const c = t.service.state()
    assert.equal(c.runNo, 2)
    assert.equal(c.report?.isFirst, false)
    assert.equal(c.status, 'running')
  } finally {
    t.cleanup()
  }
})

test('simulation：run_no 恒等于第几场（清理历史后仍从 1 开始，state 与报告一致）', async () => {
  const t = makeService()
  try {
    await t.service.runScript()
    assert.equal(t.service.state().runNo, 1)
    assert.equal(t.service.report()?.runNo, 1)
    assert.equal(t.service.report()?.isFirst, true)
    // 模拟运维清理演练留痕（不删生产数据）：序号按现存最大 +1，不复用旧序列
    t.db.exec('DELETE FROM simulation_events; DELETE FROM simulation_runs;')
    assert.equal(t.service.state().status, 'idle')
    await t.service.runScript()
    assert.equal(t.service.state().runNo, 1)
    assert.equal(t.service.report()?.runNo, 1)
    assert.equal(t.service.report()?.isFirst, true)
    await t.service.runScript()
    assert.equal(t.service.state().runNo, 2)
    assert.equal(t.service.report()?.runNo, 2)
    assert.equal(t.service.report()?.isFirst, false)
  } finally {
    t.cleanup()
  }
})

test('simulation：无场次投递事件被拒（400 语义），不写留痕', async () => {
  const t = makeService()
  try {
    await assert.rejects(() => t.service.emit('danmaku', '在吗'), SimulationError)
    assert.equal(all(t.db, 'SELECT * FROM simulation_events').length, 0)
  } finally {
    t.cleanup()
  }
})

test('simulation：语音/弹幕/礼物事件留痕，fallback 如实标注且用桌宠口吻', async () => {
  const t = makeService()
  try {
    await t.service.start()
    const voice = await t.service.emit('voice', '你好呀，能听到我说话吗？', '语音观众')
    assert.equal(voice.kind, 'voice')
    assert.equal(voice.route, 'fallback')
    assert.ok(voice.replyText.includes('听见啦'))
    assert.equal(voice.ttsText, voice.replyText)

    const gift = await t.service.emit('gift', '送出一个小心心')
    assert.ok(gift.replyText.includes('谢谢'))

    const danmaku = await t.service.emit('danmaku', '大肥鱼今天种什么？')
    assert.ok(danmaku.replyText.includes('种'))

    const s = t.service.state()
    assert.ok(s.events.some((e) => e.kind === 'voice' && e.actor === '语音观众'))
    assert.ok(s.events.every((e) => e.replyText.length > 0))
    assert.equal(s.report?.voiceCount, 1)
    assert.equal(s.report?.routeCounts.fallback, 4) // 开场 + 3 事件

    // 感知层 replay 留痕：source=simulation、replay=1，不触发生产动作
    assert.ok(t.ingested.length >= 4)
    assert.ok(t.ingested.every((e) => e.source === 'simulation' && e.replay === true))
    assert.ok(t.ingested.every((e) => e.purposeTags.includes('simulation')))

    // 不污染生产表
    assert.equal(all(t.db, 'SELECT * FROM reply_log').length, 0)
    assert.equal(all(t.db, 'SELECT * FROM gift_ledger').length, 0)
    assert.equal(all(t.db, 'SELECT * FROM training_samples').length, 0)
    assert.equal(all(t.db, 'SELECT * FROM viewer_profiles').length, 0)
  } finally {
    t.cleanup()
  }
})

test('simulation：本地模型成功时如实记 local_gpu，不套用桌宠模板', async () => {
  const t = makeService({
    answer: async () => ({ text: '模型生成的回答', route: 'local_gpu' as const, latencyMs: 7 }),
  })
  try {
    await t.service.start()
    const r = await t.service.emit('danmaku', '讲讲今天的安排')
    assert.equal(r.route, 'local_gpu')
    assert.equal(r.replyText, '模型生成的回答')
    assert.equal(t.service.report()?.routeCounts.local_gpu, 1)
  } finally {
    t.cleanup()
  }
})

test('simulation：路由异常不中断演练，降级 fallback 并留痕', async () => {
  const t = makeService({
    answer: async () => {
      throw new Error('本地推理不可用')
    },
  })
  try {
    await t.service.start()
    const r = await t.service.emit('voice', '在吗')
    assert.equal(r.route, 'fallback')
    assert.ok(r.replyText.length > 0)
  } finally {
    t.cleanup()
  }
})

test('simulation：一键首播脚本自动开场+跑完+收尾，报告聚合正确', async () => {
  const t = makeService()
  try {
    const { steps, report } = await t.service.runScript()
    assert.equal(steps.length, 4)
    assert.equal(steps[0]?.kind, 'danmaku')
    assert.ok(steps.some((s) => s.kind === 'voice'))
    assert.ok(steps.some((s) => s.kind === 'gift'))
    assert.equal(t.service.state().status, 'ended')
    assert.equal(t.service.state().firstCompleted, true)
    assert.ok(report !== null)
    assert.equal(report?.isFirst, true)
    assert.equal(report?.eventCount, 6) // 开场 1 + 脚本 4 + 收尾 1
    assert.equal(report?.voiceCount, 1)

    // 再跑一场：场次递增、报告 isFirst=false
    const second = await t.service.runScript()
    assert.equal(second.report?.runNo, 2)
    assert.equal(second.report?.isFirst, false)
    assert.equal(t.service.state().runNo, 2)
  } finally {
    t.cleanup()
  }
})

test('simulation：空文本被拒、超长文本截断，事件列表最多 50 条', async () => {
  const t = makeService()
  try {
    await t.service.start()
    await assert.rejects(() => t.service.emit('danmaku', '   '), /事件文本不能为空/)
    const long = await t.service.emit('danmaku', '啊'.repeat(500))
    assert.equal(long.text.length, 200)
    for (let i = 0; i < 60; i++) await t.service.emit('danmaku', `第 ${i} 条弹幕`)
    assert.equal(t.service.state().events.length, 50)
  } finally {
    t.cleanup()
  }
})

test('simulation：语音互动开关关闭仅影响客户端能力，服务仍接受转写文本', async () => {
  const t = makeService()
  try {
    t.settings.savePersona({ voiceInteractionEnabled: false })
    assert.equal(t.service.state().persona.voiceInteractionEnabled, false)
    await t.service.start()
    const r = await t.service.emit('voice', '转写兜底文本')
    assert.equal(r.kind, 'voice')
  } finally {
    t.cleanup()
  }
})
