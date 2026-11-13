import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from './index.ts'
import { buildStatus, createRequestHandler } from './host-api.ts'

function makeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

function makeReq(method: string, url: string, body = ''): { method: string; url: string } & { on(e: string, cb: (c: Buffer) => void): void } {
  const chunks = body === '' ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    on(event: string, cb: (c: Buffer) => void) {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') queueMicrotask(() => cb(Buffer.from('')))
    },
  }
}

async function call(handler: ReturnType<typeof createRequestHandler>, method: string, url: string, body?: unknown) {
  const res = makeRes()
  await handler(makeReq(method, url, body === undefined ? '' : JSON.stringify(body)), res, async () => {})
  return { code: res.statusCode, payload: JSON.parse(res.body) as Record<string, any> }
}

async function configureWizardBasics(handler: ReturnType<typeof createRequestHandler>) {
  await call(handler, 'POST', '/api/dafeiyu/settings/persona', { usageRightConfirmed: true })
  await call(handler, 'POST', '/api/dafeiyu/settings/platform', { operatorLoginConfirmedAt: '2026-11-12T10:00:00Z' })
}

test('host-api：状态/四主操作/紧急停止路由；非本插件路径放行；未配置开播给单一原因', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)

    // 非 /api/dafeiyu/ 前缀 → next() 放行
    let passed = false
    await handler(makeReq('GET', '/api/other'), makeRes(), async () => { passed = true })
    assert.equal(passed, true)

    // 状态（新字段：设置就绪/预览/费用/待处理问题）
    const s0 = await call(handler, 'GET', '/api/dafeiyu/status')
    assert.equal(s0.payload.ok, true)
    assert.equal(s0.payload.status.liveDisplay, '未配置')
    assert.equal(s0.payload.status.mode, 'shadow')
    assert.equal(s0.payload.status.personaReady, false)
    assert.ok(s0.payload.status.personaReadyReason.includes('主播形象未配置'))
    assert.equal(s0.payload.status.platformReady, false)
    assert.equal(s0.payload.status.previewActive, false)
    assert.equal(s0.payload.status.todayCostCny, 0)

    // 未完成向导输入时开播：recoverable_fault + 单一可操作原因（不进入等待平台确认）
    const start0 = await call(handler, 'POST', '/api/dafeiyu/live/start', { idempotencyKey: 'w0' })
    assert.equal(start0.payload.status.liveStatus, 'recoverable_fault')
    assert.ok(start0.payload.result.reason.includes('主播形象未配置'))

    // 预览：形象未配置同样拒绝（400 + 原因）
    const pv0 = await call(handler, 'POST', '/api/dafeiyu/preview/start')
    assert.equal(pv0.code, 400)
    assert.ok(pv0.payload.error.includes('主播形象未配置'))

    // 配置向导输入（形象授权 + 官方客户端登录声明）
    await configureWizardBasics(handler)
    const s1 = await call(handler, 'GET', '/api/dafeiyu/status')
    assert.equal(s1.payload.status.personaReady, true)
    assert.equal(s1.payload.status.platformReady, true)

    // 进入本地预览 → local_preview；查询预览描述符；退出
    const pv1 = await call(handler, 'POST', '/api/dafeiyu/preview/start')
    assert.equal(pv1.payload.status.liveStatus, 'local_preview')
    const pvGet = await call(handler, 'GET', '/api/dafeiyu/preview')
    assert.equal(pvGet.payload.preview.previewActive, true)
    assert.equal(pvGet.payload.preview.persona.name, '大肥鱼')
    assert.equal(pvGet.payload.preview.persona.profileId, 'dsh-pet')
    assert.equal(pvGet.payload.preview.persona.enName, 'DSH-PET')
    assert.ok(pvGet.payload.preview.persona.tagline.length > 0)
    assert.equal(pvGet.payload.preview.persona.aiLabelText, 'AI 生成内容')
    assert.equal(typeof pvGet.payload.preview.officialClientUrl, 'string')
    const pvStop = await call(handler, 'POST', '/api/dafeiyu/preview/stop')
    assert.equal(pvStop.payload.status.liveStatus, 'stopped')

    // 开播（政策包齐备 + 已配置 → 等待平台确认；平台未确认不显示直播中）
    const p2 = await call(handler, 'POST', '/api/dafeiyu/live/start', { idempotencyKey: 't1' })
    assert.equal(p2.payload.status.liveStatus, 'awaiting_platform')

    // 操作员确认 → 直播中
    const p3 = await call(handler, 'POST', '/api/dafeiyu/live/operator-confirm')
    assert.equal(p3.payload.status.liveDisplay, '直播中')

    // 紧急停止 → 安全场景
    const p4 = await call(handler, 'POST', '/api/dafeiyu/live/emergency-stop')
    assert.equal(p4.payload.status.liveStatus, 'safe_scene')

    // 训练一次（null 预算 → learning gate 如实报告）
    const p5 = await call(handler, 'POST', '/api/dafeiyu/training/train-once')
    assert.equal(p5.payload.ok, true)
    assert.equal(p5.payload.result.status, 'waiting_resource')

    // 暂停学习 → 状态翻转
    const p6 = await call(handler, 'POST', '/api/dafeiyu/learning/pause')
    assert.equal(p6.payload.status.learningPaused, true)

    // 未知路径 404
    const p7 = await call(handler, 'POST', '/api/dafeiyu/nope')
    assert.equal(p7.code, 404)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：settings 读写/目录/AI 标识不可关闭（400 + issues）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)

    const got = await call(handler, 'GET', '/api/dafeiyu/settings')
    assert.equal(got.payload.ok, true)
    assert.ok(got.payload.settings.catalogs.avatars.length >= 3)
    assert.ok(got.payload.settings.catalogs.voices.length >= 4)
    // 角色档案（主播信息）目录：鹅次元角色 + dsh-pet 插件中档案
    assert.equal(got.payload.settings.catalogs.profiles.length, 5)
    assert.ok(got.payload.settings.catalogs.profiles.some((p: { id: string; source: string }) => p.id === 'dsh-pet' && p.source === 'plugin'))
    assert.equal(got.payload.settings.profile.id, 'dsh-pet')
    assert.equal(got.payload.settings.profile.name, '大肥鱼')
    assert.equal(got.payload.settings.persona.personaName, '大肥鱼')
    assert.ok(got.payload.settings.notes.length >= 3)

    // AI 标识写 false → 400 + 中文单一原因
    const denied = await call(handler, 'POST', '/api/dafeiyu/settings/persona', { aiLabelVisible: false })
    assert.equal(denied.code, 400)
    assert.ok(denied.payload.issues.some((i: string) => i.includes('AI 标识不可关闭')))

    // 正常部分更新 + readiness 联动
    const saved = await call(handler, 'POST', '/api/dafeiyu/settings/scene', { title: '今晚种田', background: 'night' })
    assert.equal(saved.payload.value.title, '今晚种田')
    assert.equal(saved.payload.value.resolution, '1280x720') // 部分更新保持其余字段

    // 试听语句端点（本地返回，不调模型）
    const voice = await call(handler, 'POST', '/api/dafeiyu/preview/voice-test')
    assert.equal(voice.payload.ok, true)
    assert.ok(voice.payload.result.phrase.length > 0)
    assert.equal(voice.payload.result.voice.lang, 'zh-CN')
    assert.ok(voice.payload.result.note.includes('浏览器语音'))

    // 切换角色档案后，settings.profile 跟随选中档案（主播信息来源）
    const switched = await call(handler, 'POST', '/api/dafeiyu/settings/persona', { profileId: 'lubai' })
    assert.equal(switched.payload.value.profileId, 'lubai')
    const got2 = await call(handler, 'GET', '/api/dafeiyu/settings')
    assert.equal(got2.payload.settings.profile.id, 'lubai')
    assert.equal(got2.payload.settings.profile.name, '沈露白')
    assert.equal(got2.payload.settings.profile.enName, 'LUBAI')
    assert.equal(got2.payload.settings.profile.source, 'eciyuan')
    // 非法档案 id → 400
    const badProfile = await call(handler, 'POST', '/api/dafeiyu/settings/persona', { profileId: 'nope' })
    assert.equal(badProfile.code, 400)

    // 场景校验失败 → 400
    const bad = await call(handler, 'POST', '/api/dafeiyu/settings/scene', { resolution: '4k' })
    assert.equal(bad.code, 400)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：最近回复 + 反馈归因/列表 + 账本汇总 + 训练进度 + 费用 + 诊断', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)

    // 造一条播出留痕（reply_log 经 runtime.answer 写入；此处直接插入等价行）
    plugin.db
      .prepare(
        `INSERT INTO reply_log (request_id, session_id, question_text, reply_text, route) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('req-1', 'sess-1', '今天种什么', '先把日子过好，咱们接着种田。', 'fallback')

    const replies = await call(handler, 'GET', '/api/dafeiyu/replies')
    assert.equal(replies.payload.replies.length, 1)
    assert.equal(replies.payload.replies[0].question, '今天种什么')
    assert.deepEqual(replies.payload.replies[0].feedback, [])

    // 提交反馈（答错 + 纠正说法）→ 归因到该回复
    const fb = await call(handler, 'POST', '/api/dafeiyu/feedback', {
      targetReplyId: 'req-1',
      label: 'wrong',
      correction: '应该回答先浇水',
    })
    assert.equal(fb.payload.ok, true)
    assert.equal(fb.payload.result.status, 'received')

    const fbList = await call(handler, 'GET', '/api/dafeiyu/feedback')
    assert.equal(fbList.payload.feedback.length, 1)
    assert.equal(fbList.payload.feedback[0].targetReplyId, 'req-1')

    const replies2 = await call(handler, 'GET', '/api/dafeiyu/replies')
    assert.deepEqual(replies2.payload.replies[0].feedback, [{ label: 'wrong', status: 'received' }])
    // 待处理问题数联动
    const st = await call(handler, 'GET', '/api/dafeiyu/status')
    assert.equal(st.payload.status.pendingIssues, 1)

    // 非法 label → 400
    const fbBad = await call(handler, 'POST', '/api/dafeiyu/feedback', { label: 'great' })
    assert.equal(fbBad.code, 400)

    // 反馈推进：received → verifying → resolved；非法迁移 400
    const fbId = fb.payload.result.feedbackId as string
    const adv0 = await call(handler, 'POST', '/api/dafeiyu/feedback/advance', { feedbackId: fbId, next: 'resolved' })
    assert.equal(adv0.payload.result.status, 'resolved')
    const advBad = await call(handler, 'POST', '/api/dafeiyu/feedback/advance', { feedbackId: fbId, next: 'verifying' })
    assert.equal(advBad.code, 400)

    // 礼物账本：入账两笔（一笔已验证、一笔未验证）
    plugin.gifts.ledger.ingest({
      platform: 'douyin',
      roomId: 'room-1',
      eventId: 'gift-1',
      viewerKey: 'vw_1',
      giftId: '小红花',
      quantity: 2,
      verified: true,
    })
    plugin.gifts.ledger.ingest({
      platform: 'douyin',
      roomId: 'room-1',
      eventId: 'gift-2',
      viewerKey: 'vw_2',
      giftId: '飞机',
      quantity: 1,
      verified: false,
    })
    const gifts = await call(handler, 'GET', '/api/dafeiyu/gifts/summary')
    assert.equal(gifts.payload.totals.receivedQty, 3)
    assert.equal(gifts.payload.totals.unverifiedCount, 1)
    assert.equal(gifts.payload.entries.length, 2)
    assert.equal(gifts.payload.ackSettings.nameMention, true)

    // 训练进度：无记录时如实为空
    const tp = await call(handler, 'GET', '/api/dafeiyu/training/progress')
    assert.equal(tp.payload.ok, true)
    assert.equal(tp.payload.lastEntry, null)
    assert.equal(tp.payload.latestRun, null)
    assert.equal(typeof tp.payload.opportunity.admit, 'boolean')

    // 训练一次后进度可查（waiting_resource 也会记录）
    await call(handler, 'POST', '/api/dafeiyu/training/train-once')
    const tp2 = await call(handler, 'GET', '/api/dafeiyu/training/progress')
    assert.equal(tp2.payload.lastEntry.status, 'waiting_resource')

    // 费用（无云端配置 → 禁用原因如实）
    const costs = await call(handler, 'GET', '/api/dafeiyu/costs')
    assert.equal(costs.payload.todayCostCny, 0)
    assert.equal(costs.payload.cloudEnabled, false)
    assert.ok(costs.payload.disabledReasons.length >= 1)

    // 自检：逐项报告（Ollama 不可达如实 ok:false；不伪造）
    const sc = await call(handler, 'GET', '/api/dafeiyu/selfcheck')
    assert.equal(sc.payload.ok, true)
    const items = sc.payload.report.items as Array<{ id: string; ok: boolean; detail: string }>
    assert.ok(items.some((i) => i.id === 'node_version'))
    assert.ok(items.some((i) => i.id === 'config_valid'))

    // 诊断：聚合计数 + 披露说明（不含观众标识/正文/凭据）
    const diag = await call(handler, 'GET', '/api/dafeiyu/diagnostics')
    assert.equal(diag.payload.ok, true)
    assert.ok(diag.payload.report.counts.gift_ledger >= 2)
    assert.ok(diag.payload.disclosure.some((d: string) => d.includes('不含观众标识')))
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：观众画像管理（列表/详情/纠错/退出个性化/删除两步流）与治理面板', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)

    // 建档：伪名化身份（昵称变化不换身份）
    const resolved = plugin.audience.identity.resolve({
      platform: 'douyin',
      roomScope: 'room-1',
      platformUserId: 'user-9',
      nickname: '小鱼干',
    })
    const vk = resolved.viewerKey
    plugin.audience.profiles.setField({
      viewerKey: vk,
      fieldName: 'favorite_topic',
      value: '种田游戏（推测）',
      confidenceKind: 'inferred',
    })

    // 概览：伪名键 + 昵称；无墓碑
    const ov = await call(handler, 'GET', '/api/dafeiyu/audience/overview')
    assert.equal(ov.payload.viewers.length, 1)
    assert.equal(ov.payload.viewers[0].nickname, '小鱼干')
    assert.equal(ov.payload.viewers[0].deletionStatus, 'active')
    assert.equal(ov.payload.tombstoneCount, 0)

    // 详情：隔离读取，推测字段可见
    const pv = await call(handler, 'GET', '/api/dafeiyu/audience/profile?viewer=' + encodeURIComponent(vk))
    assert.equal(pv.payload.summary.viewerKey, vk)
    assert.equal(pv.payload.fields.length, 1)
    assert.equal(pv.payload.fields[0].confidenceKind, 'inferred')

    // 观众纠错：viewer_stated 覆盖推测（保留审计链）
    const corr = await call(handler, 'POST', '/api/dafeiyu/audience/correction', {
      viewerKey: vk,
      fieldName: 'favorite_topic',
      value: '钓鱼',
    })
    assert.equal(corr.payload.result.confidenceKind, 'viewer_stated')
    const pv2 = await call(handler, 'GET', '/api/dafeiyu/audience/profile?viewer=' + encodeURIComponent(vk))
    assert.equal(pv2.payload.fields[0].value, '钓鱼')

    // 退出个性化：字段保留但 purpose 过滤生效
    const poff = await call(handler, 'POST', '/api/dafeiyu/audience/personalization-off', { viewerKey: vk })
    assert.ok((poff.payload.result.requestId as string).startsWith('pr_'))
    const pv3 = await call(handler, 'GET', '/api/dafeiyu/audience/profile?viewer=' + encodeURIComponent(vk))
    assert.equal(pv3.payload.fields[0].purpose, 'service_no_personalization')

    // 删除两步流：申请（received）→ 未验证执行被拒（400，请求保持）→ 验证通过落墓碑
    const del1 = await call(handler, 'POST', '/api/dafeiyu/audience/deletion-request', { viewerKey: vk })
    const requestId = del1.payload.result.requestId as string
    const ex0 = await call(handler, 'POST', '/api/dafeiyu/audience/deletion-execute', {
      requestId,
      viewerKey: vk,
      verificationPassed: false,
    })
    assert.equal(ex0.code, 400)
    const ex1 = await call(handler, 'POST', '/api/dafeiyu/audience/deletion-execute', {
      requestId,
      viewerKey: vk,
      verificationPassed: true,
    })
    assert.ok((ex1.payload.result.tombstoneId as string).startsWith('tomb_'))
    // 墓碑优先于任何读取：详情标记已删除、字段为空；概览墓碑计数 1
    const pv4 = await call(handler, 'GET', '/api/dafeiyu/audience/profile?viewer=' + encodeURIComponent(vk))
    assert.equal(pv4.payload.summary.deleted, true)
    assert.equal(pv4.payload.fields.length, 0)
    const ov2 = await call(handler, 'GET', '/api/dafeiyu/audience/overview')
    assert.equal(ov2.payload.tombstoneCount, 1)
    assert.equal(ov2.payload.viewers[0].deletionStatus, 'deleted')
    // 他人不匹配：requestId 配错 viewerKey → 400
    const exBad = await call(handler, 'POST', '/api/dafeiyu/audience/deletion-execute', {
      requestId,
      viewerKey: 'vw_someoneelse',
      verificationPassed: true,
    })
    assert.equal(exBad.code, 400)

    // 治理：技能（播种包出现）、记忆、发布、审计
    const skills = await call(handler, 'GET', '/api/dafeiyu/governance/skills')
    assert.ok(skills.payload.skills.some((s: { skillId: string; status: string }) => s.skillId.includes('gift-ack')))
    const mem = await call(handler, 'GET', '/api/dafeiyu/governance/memory')
    assert.deepEqual(mem.payload.memories, [])
    assert.ok(mem.payload.notes.length >= 1)
    const rel = await call(handler, 'GET', '/api/dafeiyu/governance/releases')
    assert.equal(rel.payload.activeReleaseId, null)
    assert.deepEqual(rel.payload.releases, [])
    const aud = await call(handler, 'GET', '/api/dafeiyu/governance/audit')
    assert.ok(aud.payload.audits.some((a: { action: string }) => a.action === 'profile_deletion'))
    assert.ok(aud.payload.notes.length >= 1)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
