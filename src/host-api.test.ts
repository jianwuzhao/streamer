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

test('host-api：状态查询与四主操作/紧急停止路由；非本插件路径放行', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-api-'))
  const plugin = createPlugin({ dataDir, log: () => {} })
  try {
    const handler = createRequestHandler(plugin)

    // 非 /api/dafeiyu/ 前缀 → next() 放行
    let passed = false
    await handler(makeReq('GET', '/api/other'), makeRes(), async () => { passed = true })
    assert.equal(passed, true)

    // 状态
    const res1 = makeRes()
    await handler(makeReq('GET', '/api/dafeiyu/status'), res1, async () => {})
    const payload1 = JSON.parse(res1.body) as { ok: boolean; status: ReturnType<typeof buildStatus> }
    assert.equal(payload1.ok, true)
    assert.equal(payload1.status.liveDisplay, '未配置')
    assert.equal(payload1.status.mode, 'shadow')

    // 开播（政策包齐备 → 等待平台确认；平台未确认不显示直播中）
    const res2 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/live/start', JSON.stringify({ idempotencyKey: 't1' })), res2, async () => {})
    const p2 = JSON.parse(res2.body) as { ok: boolean; status: ReturnType<typeof buildStatus> }
    assert.equal(p2.status.liveStatus, 'awaiting_platform')

    // 操作员确认 → 直播中
    const res3 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/live/operator-confirm'), res3, async () => {})
    const p3 = JSON.parse(res3.body) as { status: ReturnType<typeof buildStatus> }
    assert.equal(p3.status.liveDisplay, '直播中')

    // 紧急停止 → 安全场景
    const res4 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/live/emergency-stop'), res4, async () => {})
    const p4 = JSON.parse(res4.body) as { status: ReturnType<typeof buildStatus> }
    assert.equal(p4.status.liveStatus, 'safe_scene')

    // 训练一次（null 预算 → learning gate 如实报告）
    const res5 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/training/train-once'), res5, async () => {})
    const p5 = JSON.parse(res5.body) as { ok: boolean; result: { status: string } }
    assert.equal(p5.ok, true)
    assert.equal(p5.result.status, 'waiting_resource')

    // 暂停学习 → 状态翻转
    const res6 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/learning/pause'), res6, async () => {})
    assert.equal((JSON.parse(res6.body) as { status: ReturnType<typeof buildStatus> }).status.learningPaused, true)

    // 未知路径 404
    const res7 = makeRes()
    await handler(makeReq('POST', '/api/dafeiyu/nope'), res7, async () => {})
    assert.equal(res7.statusCode, 404)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
