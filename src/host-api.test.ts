import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { createPlugin, packageDir } from './index.ts'
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
    assert.equal(pvGet.payload.preview.persona.name, 'DSH 蓝发女仆')
    assert.equal(pvGet.payload.preview.persona.profileId, 'dsh-pet')
    assert.equal(pvGet.payload.preview.persona.enName, 'DSH PET')
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
    assert.equal((await call(handler, 'POST', '/api/dafeiyu/preview/start')).code, 409)
    assert.equal((await call(handler, 'POST', '/api/dafeiyu/preview/start', { resume: true })).payload.status.liveStatus, 'local_preview')

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
    assert.deepEqual(got.payload.settings.catalogs.avatars.map((avatar: { id: string }) => avatar.id), ['dsh-pet'])
    assert.ok(got.payload.settings.catalogs.voices.length >= 4)
    assert.equal(got.payload.settings.catalogs.profiles.length, 6)
    assert.ok(got.payload.settings.catalogs.profiles.some((p: { id: string; source: string }) => p.id === 'dsh-pet' && p.source === 'plugin'))
    assert.ok(got.payload.settings.catalogs.profiles.some((p: { id: string; name: string }) => p.id === 'xiaxia-3d' && p.name === '夏夏 · 重构版'))
    assert.equal(got.payload.settings.profile.id, 'dsh-pet')
    assert.equal(got.payload.settings.profile.name, 'DSH 蓝发女仆')
    assert.equal(got.payload.settings.persona.personaName, 'DSH 蓝发女仆')
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

test('host-api：Live2D 桌宠资产路由（catalog/vendor/model-file 与安全防护）', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-avatar-api-'))
  // 临时模型包与 vendor 目录（不依赖仓库内真实资产）
  const modelsDir = join(dataDir, 'models')
  const vendorDir = join(dataDir, 'vendor')
  mkdirSync(join(modelsDir, 'custom-avatar'), { recursive: true })
  mkdirSync(vendorDir, { recursive: true })
  writeFileSync(join(modelsDir, 'custom-avatar', 'custom-avatar.model3.json'), JSON.stringify({ Version: 3, FileReferences: { Moc: 'custom-avatar.moc3' } }))
  writeFileSync(join(modelsDir, 'custom-avatar', 'custom-avatar.moc3'), 'MOC3FAKE')
  writeFileSync(join(vendorDir, 'live2dcubismcore.min.js'), '// core')
  writeFileSync(join(vendorDir, 'pixi.min.js'), '// pixi')
  writeFileSync(join(vendorDir, 'pixi-live2d-display.min.js'), '// ext')
  process.env.DAFEIYU_VENDOR_DIR = vendorDir
  try {
    const plugin = createPlugin({ dataDir, log: () => {} })
    const handler = createRequestHandler(plugin)

    const cat = await call(handler, 'GET', '/api/dafeiyu/avatar/catalog')
    assert.equal(cat.payload.ok, true)
    assert.deepEqual(cat.payload.catalog.vendors, { core: true, pixi: true, extension: true })
    assert.equal(cat.payload.catalog.models.length, 1)
    assert.equal(cat.payload.catalog.models[0].entry, 'custom-avatar.model3.json')

    const v = await call(handler, 'GET', '/api/dafeiyu/avatar/vendor?name=core')
    assert.equal(v.payload.ok, true)
    assert.equal(v.payload.vendor.text, '// core')
    const bad = await call(handler, 'GET', '/api/dafeiyu/avatar/vendor?name=evil')
    assert.equal(bad.code, 400)

    const f = await call(handler, 'GET', '/api/dafeiyu/avatar/model-file?id=custom-avatar&path=custom-avatar.moc3')
    assert.equal(f.payload.ok, true)
    assert.equal(Buffer.from(f.payload.file.base64, 'base64').toString(), 'MOC3FAKE')
    const escape = await call(handler, 'GET', '/api/dafeiyu/avatar/model-file?id=custom-avatar&path=../vendor/pixi.min.js')
    assert.equal(escape.code, 400)
  } finally {
    delete process.env.DAFEIYU_VENDOR_DIR
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：夏夏重构版资源以固定白名单提供，GLB 含连续手臂蒙皮和眨眼形状目标', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-rigged-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    const path = '/api/dafeiyu/avatar/rigged'
    const response = makeRes()
    await handler(makeReq('GET', path + '?id=xiaxia-3d&asset=model'), response, async () => {})
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'model/gltf-binary')
    const glb = Buffer.from(response.body)
    assert.equal(glb.toString('ascii', 0, 4), 'glTF')
    const model = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)))
    assert.ok(model.skins.some((skin: { joints: number[] }) => skin.joints.length >= 25))
    const targets = (name: string) => {
      const node = model.nodes.find((entry: { name?: string }) => entry.name === name)
      return model.meshes[node?.mesh]?.extras?.targetNames
    }
    assert.deepEqual(targets('PhotoFace'), ['blinkLeft', 'blinkRight'])
    for (const side of ['L', 'R']) {
      for (const name of ['PhotoSleeve' + side, 'Hand' + side]) {
        const part = model.nodes.find((node: { name?: string }) => node.name === name)
        assert.equal(typeof part?.skin, 'number')
        const [surface] = model.meshes[part.mesh].primitives
        assert.equal(typeof surface.indices, 'number')
        assert.equal(typeof surface.attributes.JOINTS_0, 'number')
        if (name.startsWith('Hand')) {
          assert.equal(surface.attributes.TEXCOORD_0, undefined)
          assert.equal(surface.targets, undefined)
        } else {
          assert.equal(typeof surface.attributes.TEXCOORD_0, 'number')
          assert.deepEqual(targets(name), ['cuffFit'])
          assert.equal(typeof surface.targets[0].POSITION, 'number')
        }
      }
      const nodes = model.nodes as { name?: string; children?: number[] }[]
      const wrist = nodes.find((node) => node.name === 'Wrist' + side)
      assert.ok(wrist)
      assert.equal(wrist.children?.filter((index) => nodes[index]?.name?.startsWith('metacarpal')).length, 4)
      for (let digit = 0; digit < 5; digit++) {
        const finger = nodes.find((node) => node.name === 'Finger' + side + digit)
        const middle = finger?.children?.map((index) => nodes[index]).find((node) => node?.name === 'Tip' + side + digit)
        assert.ok(middle?.children?.some((index) => nodes[index]?.name === 'Distal' + side + digit))
      }
    }
    for (const query of ['?id=xiaxia-3d&asset=../index.js', '?id=eciyuan-xiaxia&asset=model']) {
      assert.equal((await call(handler, 'GET', path + query)).code, 404)
    }
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('本地预览对话仅在预览期间有效，不登记直播回复，晚到的回复被丢弃', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-preview-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    const path = '/api/dafeiyu/preview/chat'
    const message = { text: '  大肥鱼你好  ' }
    const originalRoute = plugin.router.route.bind(plugin.router)
    let finishRoute: (() => void) | undefined
    plugin.router.route = async (request, context) => {
      assert.equal(request.text, '大肥鱼你好')
      assert.equal(context.localOnly, true)
      assert.equal(context.hostConversation?.mode, 'preview')
      assert.equal(context.hostProfile?.name, 'DSH 蓝发女仆')
      await new Promise<void>((resolve) => { finishRoute = resolve })
      return { requestId: request.requestId, playbackKey: request.requestId, text: '你好！',
        route: 'local_gpu', latencyMs: 0, usageId: null }
    }

    assert.equal((await call(handler, 'POST', path, message)).code, 409)
    await configureWizardBasics(handler)
    await call(handler, 'POST', '/api/dafeiyu/preview/start')
    assert.equal((await call(handler, 'POST', path, { text: ' '.repeat(2) })).code, 400)
    assert.equal((await call(handler, 'POST', path, { text: '中'.repeat(501) })).code, 400)
    assert.equal((await call(handler, 'POST', path, { text: '中'.repeat(3000) })).code, 413)
    const valid = call(handler, 'POST', path, message)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await call(handler, 'POST', path, message)).code, 409)
    assert.ok(finishRoute)
    finishRoute()
    assert.equal((await valid).payload.result.text, '你好！')
    assert.equal(plugin.db.prepare('SELECT COUNT(*) AS count FROM reply_log').get()?.count, 0)

    const late = call(handler, 'POST', path, message)
    await new Promise((resolve) => setImmediate(resolve))
    await call(handler, 'POST', '/api/dafeiyu/preview/stop')
    await call(handler, 'POST', '/api/dafeiyu/preview/start')
    finishRoute()
    assert.equal((await late).code, 409)
    plugin.router.route = originalRoute
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('本地预览描述符保留旧设置，并回传保存的桌宠模型与朗读风格', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-preview-model-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    const path = '/api/dafeiyu/preview'
    assert.equal((await call(handler, 'GET', path)).payload.preview.persona.live2dModelId, undefined)
    for (const id of ['custom-avatar', 'Hiyori', null]) {
      assert.equal((await call(handler, 'POST', '/api/dafeiyu/settings/persona',
        { live2dModelId: id, voiceId: 'tong-qu' })).code, 200)
      const { persona } = (await call(handler, 'GET', path)).payload.preview
      assert.equal(persona.live2dModelId, id === 'Hiyori' ? null : id)
      assert.equal(persona.voiceId, 'tong-qu')
    }
    assert.equal((await call(handler, 'POST', '/api/dafeiyu/settings/persona', { live2dModelId: '../x' })).code, 400)
    const audition = await call(handler, 'POST', path + '/voice-test', { phrase: '  测试你好  ', voiceId: 'chen-lang' })
    assert.equal(audition.payload.result.phrase, '测试你好')
    assert.equal(audition.payload.result.voice.id, 'chen-lang')
    assert.equal(plugin.settings.getPersona().voiceId, 'tong-qu')
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('四位鹅次元角色分别暴露官方立绘、试听和本地模型目录', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-preview-roles-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    const preview = '/api/dafeiyu/preview'
    assert.equal((await call(handler, 'GET', preview)).payload.preview.persona.media.modelId, 'dsh-pet')
    const pet = await call(handler, 'GET', '/api/dafeiyu/avatar/prototype?id=dsh-pet')
    assert.equal(pet.payload.ok, true)
    assert.ok(Buffer.from(pet.payload.image, 'base64').length > 1000)
    for (const [id, slug, name] of [
      ['xiaxia', 'xiaxia', '夏夏'],
      ['lubai', 'shenlubai', '沈露白'],
      ['guyu', 'guyu', '谷雨'],
      ['beila', 'beila', '贝拉'],
    ]) {
      const saved = await call(handler, 'POST', '/api/dafeiyu/settings/persona', { profileId: id })
      assert.equal(saved.code, 200)
      const { persona } = (await call(handler, 'GET', preview)).payload.preview
      assert.equal(persona.name, name)
      assert.equal(persona.media.modelId, `eciyuan-${id}`)
      assert.ok(persona.media.portraitUrl.endsWith(`/images/roles/${slug}/pc-cover.jpg`))
      assert.ok(persona.media.sampleAudioUrl.endsWith(`/audio/${slug}.wav`))
    }
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('角色动态形象通过本地目录和受限视频接口提供，支持浏览器范围请求', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-scene-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const dir = join(dataDir, 'models', 'eciyuan-xiaxia')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'scene.mp4'), '0123456789')
    const handler = createRequestHandler(plugin)
    const catalog = await call(handler, 'GET', '/api/dafeiyu/avatar/catalog')
    assert.deepEqual(catalog.payload.catalog.scenes, ['eciyuan-xiaxia'])
    assert.deepEqual(catalog.payload.catalog.models, [])
    const path = '/api/dafeiyu/avatar/scene?id=eciyuan-xiaxia'
    const res = makeRes()
    await handler({ ...makeReq('GET', path), headers: { range: 'bytes=2-5' } }, res, async () => {})
    assert.equal(res.statusCode, 206)
    assert.equal(res.headers['content-type'], 'video/mp4')
    assert.equal(res.headers['content-range'], 'bytes 2-5/10')
    assert.equal(String(res.body), '2345')
    const invalid = makeRes()
    await handler({ ...makeReq('GET', path), headers: { range: 'bytes=20-' } }, invalid, async () => {})
    assert.equal(invalid.statusCode, 416)
    assert.equal((await call(handler, 'GET', '/api/dafeiyu/avatar/scene?id=../outside')).code, 404)
    assert.equal((await call(handler, 'GET', '/api/dafeiyu/avatar/model-file?id=eciyuan-xiaxia&path=scene.mp4')).code, 400)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('角色语音请求校验授权、当前角色与文本边界', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-role-voice-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    const path = '/api/dafeiyu/preview/role-speech'
    assert.equal((await call(handler, 'POST', path, { profileId: 'xiaxia', text: '你好' })).code, 400)
    plugin.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true })
    assert.equal((await call(handler, 'POST', path, { profileId: 'beila', text: '你好' })).code, 409)
    assert.equal((await call(handler, 'POST', path, { profileId: 'xiaxia', text: '你'.repeat(501) })).code, 400)
    assert.equal((await call(handler, 'POST', path, { profileId: 'xiaxia', text: '你'.repeat(3000) })).code, 413)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('流式角色语音先下发音频分块，再结束响应', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-role-stream-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    plugin.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true })
    const chunks: string[] = []
    let finish!: () => void
    plugin.referenceVoiceStream.speak = async (profile, text, receive) => {
      assert.equal(profile, 'xiaxia')
      assert.equal(text, '你好')
      receive({ sampleRate: 24000, pcm: 'AAABAA==' })
      await new Promise<void>((resolve) => { finish = resolve })
      return true
    }
    const response = Object.assign(makeRes(), { write(chunk: string) { chunks.push(chunk) } })
    const handler = createRequestHandler(plugin)
    const request = handler(makeReq('POST', '/api/dafeiyu/preview/role-speech',
      JSON.stringify({ profileId: 'xiaxia', text: '你好', stream: true })), response, async () => {})
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(response.headers['content-type'], 'application/x-ndjson; charset=utf-8')
    assert.equal(JSON.parse(chunks[0]!).type, 'audio')
    assert.equal(response.body, '')
    finish()
    await request
    assert.equal(JSON.parse(response.body).type, 'end')
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：云端密钥界面维护——明文永不回传，env 优先展示', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-key-'))
  const previous = process.env.DAFEIYU_CLOUD_API_KEY
  delete process.env.DAFEIYU_CLOUD_API_KEY
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)
    // 空密钥被拒
    const bad = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/key', { apiKey: '   ' })
    assert.equal(bad.code, 400)
    // 保存 → 只回掩码状态
    const saved = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/key', { apiKey: 'sk-panel-abcd9999' })
    assert.equal(saved.payload.ok, true)
    assert.equal(saved.payload.cloudKey.source, 'ui')
    assert.equal(saved.payload.cloudKey.masked, 'sk-••••9999')
    // settings GET 带 cloudKey 状态且不含明文
    const settings = await call(handler, 'GET', '/api/dafeiyu/settings')
    const raw = JSON.stringify(settings.payload)
    assert.ok(!raw.includes('sk-panel-abcd9999'), 'settings 响应不得包含密钥明文')
    assert.equal(settings.payload.settings.cloudKey.masked, 'sk-••••9999')
    // 环境变量优先
    process.env.DAFEIYU_CLOUD_API_KEY = 'env-aaaaaaaaaa'
    const envFirst = await call(handler, 'GET', '/api/dafeiyu/settings')
    assert.equal(envFirst.payload.settings.cloudKey.source, 'env')
    // 清除只清界面值
    const cleared = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/key', { clear: true })
    assert.equal(cleared.payload.cloudKey.source, 'env')
    delete process.env.DAFEIYU_CLOUD_API_KEY
    const afterClear = await call(handler, 'GET', '/api/dafeiyu/settings')
    assert.equal(afterClear.payload.settings.cloudKey.source, 'none')
  } finally {
    if (previous === undefined) delete process.env.DAFEIYU_CLOUD_API_KEY
    else process.env.DAFEIYU_CLOUD_API_KEY = previous
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：云端配置连接测试——成功/密钥无效/端点缺失（不写入设置）', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-cloudtest-'))
  const previous = { ...process.env }
  delete process.env.DAFEIYU_CLOUD_API_KEY
  delete process.env.DAFEIYU_CLOUD_BASE_URL
  const plugin = createPlugin({ dataDir, log: () => {} })
  const handler = createRequestHandler(plugin)
  try {
    // 自定义服务商且无环境端点 → 400（表单可直接显示原因）
    const noBase = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/test', { provider: 'my-gw', model: 'm' })
    assert.equal(noBase.code, 400)
    // 缺密钥 → 400
    const noKey = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/test', { provider: 'deepseek', model: 'deepseek-chat' })
    assert.equal(noKey.code, 400)
    assert.ok(noKey.payload.error.includes('API Key'))
    // 服务商 401 → ok:false 带状态提示
    t.mock.method(globalThis, 'fetch', async () => new Response('unauthorized', { status: 401 }))
    const denied = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/test', {
      provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-bad',
    })
    assert.equal(denied.code, 200)
    assert.equal(denied.payload.ok, false)
    assert.ok(String(denied.payload.error).includes('401'))
    assert.ok(String(denied.payload.error).includes('密钥无效'))
    assert.equal(denied.payload.keySource, 'form')
    // 成功 → ok:true + 模型回复摘要；不写入任何设置
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ choices: [{ message: { content: '连接成功' } }] }))
    const ok = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/test', {
      provider: 'deepseek', model: 'deepseek-chat', apiKey: 'sk-good',
    })
    assert.equal(ok.payload.ok, true)
    assert.equal(ok.payload.detail, '连接成功')
    assert.equal(ok.payload.baseURL, 'https://api.deepseek.com/v1')
    const settings = await call(handler, 'GET', '/api/dafeiyu/settings')
    assert.ok(!JSON.stringify(settings.payload).includes('sk-good'), '测试不得写入密钥')
    assert.equal(settings.payload.settings.cloud.provider, '')
  } finally {
    for (const key of ['DAFEIYU_CLOUD_API_KEY', 'DAFEIYU_CLOUD_BASE_URL']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：模型额度查询——DeepSeek 余额 / billing 风格 / 未配置与不支持', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-quota-'))
  const previous = { ...process.env }
  delete process.env.DAFEIYU_CLOUD_API_KEY
  delete process.env.DAFEIYU_CLOUD_BASE_URL
  const plugin = createPlugin({ dataDir, log: () => {} })
  const handler = createRequestHandler(plugin)
  try {
    // 未配置服务商 → 明确原因
    const unconfigured = await call(handler, 'GET', '/api/dafeiyu/cloud/quota')
    assert.equal(unconfigured.payload.ok, false)
    assert.ok(String(unconfigured.payload.error).includes('未配置'))

    // 配置 DeepSeek + 密钥（保存即生效）→ /user/balance 解析余额
    await call(handler, 'POST', '/api/dafeiyu/settings/cloud', { enabled: true, provider: 'deepseek', model: 'deepseek-chat', dailyBudgetCny: 5 })
    await call(handler, 'POST', '/api/dafeiyu/settings/cloud/key', { apiKey: 'sk-quota-test' })
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      assert.ok(String(url).endsWith('/user/balance'), 'DeepSeek 余额应查源站根 /user/balance')
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', tipped_balance: '100.00' }],
      })
    })
    const deepseek = await call(handler, 'GET', '/api/dafeiyu/cloud/quota')
    assert.equal(deepseek.payload.ok, true)
    assert.equal(deepseek.payload.supported, true)
    assert.equal(deepseek.payload.source, 'deepseek')
    assert.equal(deepseek.payload.quota.availableText, 'CNY 110.00')
    assert.equal(deepseek.payload.quota.details.length, 3)

    // 自定义网关（one-api 风格 billing）：订阅额度 + 本年用量 → 可用余额
    process.env.DAFEIYU_CLOUD_BASE_URL = 'http://stub-gw/v1'
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      if (String(url).includes('/dashboard/billing/subscription')) {
        return Response.json({ hard_limit_usd: 20 })
      }
      if (String(url).includes('/dashboard/billing/usage')) {
        return Response.json({ total_usage: 150 })
      }
      throw new Error('unexpected url ' + String(url))
    })
    const billing = await call(handler, 'GET', '/api/dafeiyu/cloud/quota')
    assert.equal(billing.payload.ok, true)
    assert.equal(billing.payload.source, 'openai_billing')
    assert.equal(billing.payload.quota.availableText, '$18.50')
    assert.ok(billing.payload.quota.details.some((d: { label: string }) => d.label === '本年已用'))

    // 端点不提供 billing（404）→ supported:false 如实标注，不编造数值
    t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }))
    const unsupported = await call(handler, 'GET', '/api/dafeiyu/cloud/quota')
    assert.equal(unsupported.payload.ok, true)
    assert.equal(unsupported.payload.supported, false)
    assert.ok(String(unsupported.payload.note).includes('控制台'))
  } finally {
    for (const key of ['DAFEIYU_CLOUD_API_KEY', 'DAFEIYU_CLOUD_BASE_URL']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('host-api：自定义网关接入（TokenHub hy4）——表单端点测试 + 推理模型空正文 + 额度如实标注', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-custom-gw-'))
  const previous = { ...process.env }
  delete process.env.DAFEIYU_CLOUD_API_KEY
  delete process.env.DAFEIYU_CLOUD_BASE_URL
  const plugin = createPlugin({ dataDir, log: () => {} })
  const handler = createRequestHandler(plugin)
  const urls: string[] = []
  try {
    // 表单端点测试：无预设、无环境变量也能接入自定义网关；推理模型空正文视为端点验证通过
    t.mock.method(globalThis, 'fetch', async (url: unknown) => {
      const href = String(url)
      urls.push(href)
      if (href.includes('/dashboard/billing/subscription')) return new Response('', { status: 404 })
      return Response.json({
        choices: [{ message: { content: '', reasoning_content: '思考…' }, finish_reason: 'length' }],
      })
    })
    const tested = await call(handler, 'POST', '/api/dafeiyu/settings/cloud/test', {
      provider: 'TokenHub', model: 'hy4', baseUrl: 'https://tokenhub.tencentmaas.com/v1', apiKey: 'sk-gw',
    })
    assert.equal(tested.payload.ok, true, '推理模型空正文应视为端点验证通过')
    assert.ok(String(tested.payload.detail).includes('推理模型'))
    assert.equal(tested.payload.baseURL, 'https://tokenhub.tencentmaas.com/v1')
    assert.ok(urls[0]!.endsWith('/chat/completions'))

    // 保存后：额度路由按界面端点探测（TokenHub 无 billing → 如实标注不支持）
    await call(handler, 'POST', '/api/dafeiyu/settings/cloud', {
      enabled: true, provider: 'TokenHub', model: 'hy4',
      baseUrl: 'https://tokenhub.tencentmaas.com/v1', dailyBudgetCny: 5,
    })
    await call(handler, 'POST', '/api/dafeiyu/settings/cloud/key', { apiKey: 'sk-gw' })
    const quota = await call(handler, 'GET', '/api/dafeiyu/cloud/quota')
    assert.equal(quota.payload.ok, true)
    assert.equal(quota.payload.supported, false, 'TokenHub 无 billing 接口应如实标注')
    assert.ok(urls.some((u) => u.includes('tokenhub.tencentmaas.com/v1/dashboard/billing/subscription')))
  } finally {
    for (const key of ['DAFEIYU_CLOUD_API_KEY', 'DAFEIYU_CLOUD_BASE_URL']) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test('主播互动使用渠道对应的上下文，停播后丢弃旧房间、回复和语音', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-interaction-'))
  const configPath = join(dataDir, 'config.json')
  const config = loadConfig(join(packageDir(), 'config/default.yaml'))
  config.models.cloud = { ...config.models.cloud, provider: 'custom', model: 'test-chat', dailyBudgetCny: 1 }
  writeFileSync(configPath, JSON.stringify(config))
  for (const [key, value] of Object.entries({
    DAFEIYU_OLLAMA_URL: 'http://127.0.0.1:1',
    DAFEIYU_OLLAMA_CPU_URL: 'http://127.0.0.1:1',
    DAFEIYU_CLOUD_BASE_URL: 'http://127.0.0.1:2/v1',
    DAFEIYU_CLOUD_API_KEY: 'test-key',
    DAFEIYU_DANMAKU_ROOM_ID: 'room-a',
    DAFEIYU_DANMAKU_URL: '',
  })) {
    const previous = process.env[key]
    process.env[key] = value
    t.after(() => {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    })
  }

  const plugin = createPlugin({ dataDir, configPath })
  const api = createRequestHandler(plugin)
  const post = (path: string, body?: unknown) => call(api, 'POST', '/api/dafeiyu/' + path, body)
  const state = async () => (await call(api, 'GET', '/api/dafeiyu/interaction')).payload
  const requests: { url: string; messages: { role: string; content: string }[] }[] = []
  let localAvailable = true
  let cloudAvailable = true
  let waitingForAnswer: Promise<void> | undefined
  let localStream: ReadableStream<Uint8Array> | undefined
  const answer = '草莓种在向阳处吧。浇水后咱们再去看看。'
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const { messages, stream } = JSON.parse(String(options.body))
    requests.push({ url, messages })
    if (url.endsWith('/api/chat')) {
      if (localStream) {
        assert.equal(stream, true)
        const body = localStream
        localStream = undefined
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson' } })
      }
      if (waitingForAnswer) await waitingForAnswer
      return localAvailable ? Response.json({
        model: 'qwen3:4b-actual', prompt_eval_count: 13, eval_count: 5, message: { content: answer },
      }) : new Response('', { status: 404 })
    }
    assert.ok(url.endsWith('/chat/completions'))
    return cloudAvailable ? Response.json({ choices: [{ message: { content: answer } }] }) : new Response('', { status: 503 })
  })
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  try {
    await configureWizardBasics(api)
    const date = new Date(Date.now() + 86_400_000).toISOString()
    const memory = '草莓的本地参考资料是温室东侧的种植记录。'
    plugin.db.prepare(`INSERT INTO learned_stable
      (id, revision, layer, claim, scope, source_consolidation, review_at, valid_until)
      VALUES ('strawberry', 1, 'L1', ?, 'dsh-pet/garden', 'test', ?, ?)`).run(memory, date, date)
    await post('preview/start')
    const first = await post('interaction/send', { text: '草莓怎么种？' })
    assert.equal(first.code, 202)
    await settle()
    assert.equal((await state()).turns[0].memoryUsed, 1)
    assert.match(requests[0]!.messages[0]!.content, /温室东侧/)
    assert.match(requests[0]!.messages[0]!.content, /「DSH 蓝发女仆」，正在本地预览/)
    assert.ok(!requests[0]!.messages[0]!.content.includes('不超过两句'))

    localAvailable = false
    await post('interaction/send', { text: '草莓要不要晒太阳？' })
    await settle()
    assert.equal((await state()).turns[1].answer.route, 'cloud')
    assert.equal(requests.at(-1)?.messages.length, 2)
    assert.ok(!requests.at(-1)?.messages[0]?.content.includes('温室东侧'))
    assert.ok(requests.at(-2)?.messages.some(({ content }) => content === '草莓怎么种？'))

    const previousPreview = (await state()).id
    assert.equal((await post('settings/persona', { profileId: 'xiaxia' })).code, 200)
    assert.notEqual((await state()).id, previousPreview)
    assert.deepEqual((await state()).turns, [])
    await post('interaction/send', { text: '介绍一下自己' })
    await settle()
    const cloudMessages = requests.at(-1)!.messages
    assert.equal(cloudMessages[0]?.role, 'system')
    assert.match(cloudMessages[0]!.content, /「夏夏」，正在本地预览/)
    assert.match(cloudMessages[0]!.content, /新传专业大二学生/)
    assert.match(cloudMessages[0]!.content, /英文名：XIAXIA，年龄：19 岁，身高：162cm，星座：白羊座，MBTI：ENFP/)
    assert.match(cloudMessages[0]!.content, /说话方式：活泼热情/)
    assert.doesNotMatch(cloudMessages[0]!.content, /蓝发女仆|温室东侧/)
    assert.deepEqual(cloudMessages.slice(1), [{ role: 'user', content: '介绍一下自己' }])

    await post('live/start')
    await post('live/operator-confirm')
    const live = await state()
    assert.equal(live.mode, 'live')
    assert.deepEqual(live.turns, [])
    assert.deepEqual(live.automatic, ['comment', 'join', 'gift'])
    localAvailable = true
    const event = { id: 'm1', roomId: 'room-a', text: '你好主播', viewerId: 'viewer-a', nickname: '观众小柚', sentAt: new Date().toISOString() }
    const before = requests.length
    assert.equal(plugin.live.conversation.receive({ ...event, roomId: 'room-b' }), false)
    assert.equal(plugin.live.conversation.receive(event), true)
    assert.equal(plugin.live.conversation.receive(event), false)
    await settle()
    assert.equal((await state()).turns[0].status, 'answered', '开播后首条评论无需手动回复')
    const firstViewerRequest = requests[before]!
    assert.equal(requests.length, before + 1)
    assert.match(firstViewerRequest.url, /\/chat\/completions$/)
    assert.match(firstViewerRequest.messages[0]!.content, /「夏夏」，正在直播间互动/)
    assert.match(firstViewerRequest.messages[0]!.content, /MBTI：ENFP/)
    assert.doesNotMatch(JSON.stringify(firstViewerRequest.messages), /观众小柚|viewer-a|温室东侧/)
    assert.equal((await state()).turns[0].answer.route, 'cloud')

    const ownerA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const ownerB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const claimed = await post('interaction/stage', { owner: ownerA })
    assert.equal(claimed.payload.owner, true)
    assert.ok(claimed.payload.reply.key)
    assert.equal((await post('interaction/stage', { owner: ownerB })).payload.owner, false)
    assert.equal((await post('interaction/stage', { owner: ownerA })).payload.reply.key, claimed.payload.reply.key)
    assert.equal((await post('interaction/stage', { owner: ownerA, playingKey: claimed.payload.reply.key })).payload.reply, null)
    assert.equal((await post('preview/role-speech', { profileId: 'xiaxia', text: claimed.payload.reply.text,
      interactionId: live.id, stageOwner: ownerB, playbackKey: claimed.payload.reply.key })).code, 409)
    await post('interaction/stage', { owner: ownerA, completedKey: claimed.payload.reply.key, completedOk: true })
    assert.equal((await state()).turns[0].playback, 'played')

    await post('interaction/stage', { owner: ownerA, release: true })
    localAvailable = true
    let streamWriter!: ReadableStreamDefaultController<Uint8Array>
    localStream = new ReadableStream({ start: (writer) => { streamWriter = writer } })
    const encoder = new TextEncoder()
    const firstChunk = encoder.encode(JSON.stringify({ message: { content: '早上好，', thinking: '内部推理' } }) + '\n')
    const split = firstChunk.indexOf(encoder.encode('早')[0]!) + 1
    streamWriter.enqueue(firstChunk.slice(0, split))
    streamWriter.enqueue(firstChunk.slice(split))
    await post('interaction/automatic', { kinds: ['comment'] })
    assert.equal(plugin.live.conversation.receive({ ...event, id: 'auto-without-audio',
      text: '早上好', sentAt: new Date().toISOString() }), true)
    await settle()
    const drafting = (await state()).turns.at(-1)
    assert.equal(drafting.status, 'thinking')
    assert.equal(drafting.draft, '早上好，')
    assert.equal(drafting.answer, undefined)
    assert.equal(drafting.playback, undefined)
    streamWriter.enqueue(encoder.encode(JSON.stringify({
      message: { content: '今天想聊些什么？' }, done: true,
      model: 'qwen3:4b-actual', prompt_eval_count: 13, eval_count: 5,
    }) + '\n'))
    streamWriter.close()
    await settle()
    const silent = (await state()).turns.at(-1)
    assert.equal(silent.status, 'answered', '文字自动回复独立于播出音频')
    assert.equal(silent.draft, undefined)
    assert.equal(silent.answer.text, '早上好，今天想聊些什么？')
    assert.equal(silent.answer.route, 'local_gpu')
    assert.equal(silent.answer.tokensTotal, 18)
    assert.equal(silent.playback, 'pending')
    assert.equal((await state()).stageReady, false)
    const resumed = (await post('interaction/stage', { owner: ownerA })).payload.reply
    assert.equal(resumed.key, silent.answer.playbackKey)
    await post('interaction/stage', { owner: ownerA, completedKey: resumed.key, completedOk: true })

    for (const count of [1, 3, 2]) {
      assert.equal(plugin.live.conversation.receive({
        id: 'combo-' + count, kind: 'gift', roomId: 'room-a', viewerId: 'viewer-a',
        group: 'combo', quantity: count, giftName: '鲜花', groupComplete: count === 2,
        text: '送礼', sentAt: new Date().toISOString(),
      }), true)
    }
    const gift = (await state()).turns.find((turn: { kind: string }) => turn.kind === 'gift')
    assert.equal(gift.text, '送出 鲜花 ×3')
    assert.equal((await post('interaction/automatic', { kinds: ['gift'] })).code, 200)
    await settle()
    const next = (await post('interaction/stage', { owner: ownerA })).payload.reply
    assert.ok(next?.key)
    const list = (await call(api, 'GET', '/api/dafeiyu/replies')).payload.replies
    assert.equal(list[0].model, 'qwen3:4b-actual')
    assert.equal(list[0].tokensIn, 13)
    assert.equal(list[0].tokensOut, 5)
    assert.equal(list[0].tokensTotal, 18)
    assert.equal((await state()).turns.at(-1).answer.tokensTotal, 18)
    assert.equal(plugin.live.conversation.allowsStageSpeech(live.id, ownerA, next.key, next.text), true)
    assert.match(requests.at(-1)!.messages[0]!.content, /礼物事件/)
    assert.match(requests.at(-1)!.messages.at(-1)!.content, /鲜花 ×3/)
    await post('interaction/stage', { owner: ownerA, completedKey: next.key, completedOk: true })
    await post('interaction/stage', { owner: ownerA, release: true })
    await post('interaction/automatic', { kinds: ['join', 'gift'] })

    const receive = async (viewerId: string, kind: 'join' | 'gift', id = `${kind}-${viewerId}`) => {
      assert.equal(plugin.live.conversation.receive({
        ...event, viewerId, id, kind, text: kind === 'join' ? '进入直播间' : '送出 鲜花 ×1', sentAt: new Date().toISOString(),
      }), true)
      await settle()
      return (await state()).turns.at(-1)
    }
    assert.equal((await receive('viewer-b', 'join')).answer.route, 'cloud')
    assert.match(requests.at(-1)!.messages[0]!.content, /进房事件/)
    assert.equal((await receive('viewer-b', 'gift')).answer.route, 'fallback', '重复候选由角色专属预设接替')
    assert.match(requests.at(-1)!.url, /\/api\/chat$/)

    cloudAvailable = false
    localAvailable = false
    const welcomeA = (await receive('viewer-c', 'join')).answer
    const welcomeB = (await receive('viewer-d', 'join')).answer
    const thanks = (await receive('viewer-c', 'gift')).answer
    assert.equal(welcomeA.route, 'fallback')
    assert.equal(welcomeB.route, 'fallback')
    assert.notEqual(welcomeA.text, welcomeB.text)
    assert.match(welcomeA.text + welcomeB.text, /下课|新搭子/)
    assert.match(thanks.text, /谢谢/)
    assert.equal(thanks.route, 'fallback')

    await post('interaction/automatic', { kinds: ['comment', 'join'] })
    assert.ok((await post('interaction/stage', { owner: ownerA })).payload.reply)
    const progressBefore = requests.length
    localAvailable = true
    const joinWhileSpeaking = { ...event, id: 'join-while-speaking', kind: 'join' as const, text: '进入直播间', sentAt: new Date().toISOString() }
    const commentWhileSpeaking = { ...event, id: 'comment-while-speaking', text: '先聊聊草莓', sentAt: new Date().toISOString() }
    assert.equal(plugin.live.conversation.receive(joinWhileSpeaking), true)
    assert.equal(plugin.live.conversation.receive(commentWhileSpeaking), true)
    assert.equal((await state()).turns.at(-1).status, 'waiting')
    await post('interaction/stage', { owner: ownerA, release: true })
    await settle()
    assert.equal((await state()).turns.at(-1).status, 'answered', '暂停播出后，等待中的评论继续生成文字回复')
    assert.equal(requests[progressBefore]?.messages.at(-1)?.content, commentWhileSpeaking.text, '优先回复评论')

    await post('interaction/automatic', { kinds: ['join'] })
    assert.equal(plugin.live.conversation.receive({ ...event, id: 'manual-only', text: '请手动回复', sentAt: new Date().toISOString() }), true)
    const manual = (await state()).turns.at(-1)
    assert.equal(manual.status, 'waiting')
    assert.equal((await post('interaction/reply', { id: manual.id })).code, 202)
    await settle()
    assert.equal((await state()).turns.at(-1).status, 'answered')

    const capture = plugin.live.conversation.liveWindow()
    assert.ok(capture)
    assert.equal((await post('settings/persona', { usageRightConfirmed: false })).code, 200)
    assert.equal((await state()).id, null)
    assert.deepEqual(plugin.live.conversation.liveWindow(), capture, '角色授权暂时失效时采集仍跟随当前直播场次')
    assert.equal((await post('settings/persona', { usageRightConfirmed: true })).code, 200)
    assert.deepEqual(plugin.live.conversation.liveWindow(), capture)
    assert.deepEqual((await state()).automatic, ['join'], '同一场恢复角色授权后保留评论开关')
    assert.equal(plugin.live.conversation.receive(commentWhileSpeaking), false, '同一场不重复读取旧评论')

    let release!: () => void
    waitingForAnswer = new Promise((resolve) => { release = resolve })
    await post('interaction/send', { text: '正在生成时停播' })
    await settle()
    await post('live/emergency-stop')
    release()
    await settle()
    assert.equal((await state()).id, null)
    assert.equal(plugin.live.conversation.receive({ ...event, id: 'm2' }), false)
    assert.equal((await post('preview/role-speech', { profileId: 'xiaxia', text: answer, interactionId: live.id })).code, 409)
    assert.equal(plugin.db.prepare('SELECT COUNT(*) AS n FROM reply_log WHERE question_text = ?').get('正在生成时停播')?.n, 0)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
