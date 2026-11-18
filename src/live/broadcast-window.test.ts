import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { createPlugin } from '../index.ts'
import { BroadcastWindow } from './broadcast-window.ts'

const OWNER = '4d2c5174-2d4b-41b1-8e88-6d8cb5722d05'
const OTHER_OWNER = 'e30b85ee-ec96-42cc-8ce3-a397dcd33d84'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dafeiyu-broadcast-test-'))
  const macos = join(root, 'lib', 'DafeiyuBroadcast.app', 'Contents', 'MacOS')
  const addressFile = join(root, 'address.txt')
  mkdirSync(macos, { recursive: true })
  mkdirSync(join(root, 'client'))
  writeFileSync(join(root, 'client', 'client.js'), '/* shared stage */')
  writeFileSync(join(root, 'lib', 'broadcast-renderer.iife.js'), '/* bundled React */')
  const executable = join(macos, 'DafeiyuBroadcast')
  // Simulate just the native process handshake. HTTP and plugin services remain real.
  writeFileSync(executable, `#!/usr/bin/env node
const { createInterface } = require('node:readline');
const { appendFileSync, writeFileSync } = require('node:fs');
let line = 0;
createInterface({ input: process.stdin }).on('line', (value) => {
  if (line++ === 0) { writeFileSync(${JSON.stringify(addressFile)}, value); console.log('ready'); }
  else appendFileSync(${JSON.stringify(join(root, 'commands.txt'))}, value + '\\n');
}).on('close', () => process.exit(0));
`)
  chmodSync(executable, 0o755)
  const handle = createPlugin({ dataDir: join(root, 'data') })
  const output = new BroadcastWindow(handle, root)
  return {
    root, handle, output,
    address: () => new URL(readFileSync(addressFile, 'utf8')),
    dispose() {
      output.dispose()
      handle.dispose()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const options = { skip: process.platform !== 'darwin' }

test('独立播出窗口只向已认证的本机窗口开放舞台数据和素材', options, async () => {
  const f = fixture()
  try {
    await Promise.all([f.output.open(OWNER), f.output.open(OWNER)])
    const address = f.address()
    const origin = address.origin
    assert.equal((await fetch(origin + '/frame')).status, 404)
    assert.equal((await fetch(origin + '/?token=wrong')).status, 404)
    const bootstrap = await fetch(address)
    assert.equal(bootstrap.status, 200)
    assert.match(await bootstrap.text(), /renderer.js/)
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    const headers = { cookie }
    assert.equal((await fetch(origin + '/frame', { headers: { ...headers, origin: 'https://example.com' } })).status, 404)
    assert.equal((await fetch(origin + '/frame', { method: 'POST', headers })).status, 404)
    assert.equal((await fetch(origin + '/api/dafeiyu/settings', { headers })).status, 404)
    assert.equal((await fetch(origin + '/api/dafeiyu/live/start', { headers })).status, 404)
    const client = await fetch(origin + '/client.js', { headers })
    assert.match(client.headers.get('content-type')!, /javascript/)
    assert.match(await client.text(), /shared stage/)
    assert.equal((await fetch(origin + '/renderer.js', { headers })).status, 200)
    const preview = await (await fetch(origin + '/api/dafeiyu/preview', { headers })).json() as { preview: { persona: { profileId: string } } }
    assert.equal(preview.preview.persona.profileId, 'dsh-pet')
    const catalog = await (await fetch(origin + '/api/dafeiyu/avatar/catalog', { headers })).json() as { ok: boolean }
    assert.equal(catalog.ok, true)
    assert.equal((await fetch(origin + '/other', { headers })).status, 404)
    f.output.close(OTHER_OWNER)
    assert.equal((await fetch(origin + '/frame', { headers })).status, 200)
    f.output.close(OWNER)
    await assert.rejects(fetch(origin + '/frame', { headers }))
    await f.output.open(OWNER)
    assert.equal((await fetch(f.address())).status, 200)
  } finally { f.dispose() }
})

test('播出字幕口型绑定工作台与角色，紧急停止和失联切换安全画面', options, async () => {
  const f = fixture()
  try {
    await f.output.open(OWNER)
    const bootstrap = await fetch(f.address())
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    await bootstrap.text()
    const frame = async () => (await fetch(f.address().origin + '/frame', { headers: { cookie } })).json() as Promise<{
      safe: boolean; speaking: boolean; subtitle: string; level: number; profileId: string
    }>
    assert.equal((await frame()).safe, true)
    const input = { profileId: 'dsh-pet', speaking: true, subtitle: '这是独立播出字幕', level: 2 }
    assert.equal(f.output.publish(OTHER_OWNER, input), false)
    assert.equal(f.output.publish(OWNER, input), true)
    await assert.rejects(f.output.open(OTHER_OWNER), /另一个工作台/)
    assert.deepEqual(Object.fromEntries(Object.entries(await frame()).filter(([key]) => !['sampledAt', 'sentAt', 'form', 'listening', 'version'].includes(key))), { safe: false, speaking: true, subtitle: input.subtitle, level: 1, profileId: 'dsh-pet' })
    f.handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true })
    assert.equal((await frame()).safe, true)
    f.output.publish(OWNER, { ...input, profileId: 'xiaxia' })
    assert.equal((await frame()).safe, false)
    f.handle.live.session.emergencyStop()
    assert.deepEqual(Object.fromEntries(Object.entries(await frame()).filter(([key]) => !['sampledAt', 'sentAt', 'form', 'listening', 'version'].includes(key))), { safe: true, speaking: false, subtitle: '', level: 0, profileId: 'xiaxia' })
    f.handle.live.session.enterPreview(f.handle.settings.personaReady())
    assert.equal((await frame()).safe, false)
    await delay(1600)
    await f.output.open(OTHER_OWNER)
    assert.equal(f.output.publish(OWNER, input), false)
    assert.equal(f.output.publish(OTHER_OWNER, { ...input, profileId: 'xiaxia' }), true)
    await delay(1600)
    assert.equal((await frame()).safe, true)
  } finally { f.dispose() }
})

test('原生窗口启动失败后可重试，缺少构建产物时给出操作提示', options, async () => {
  const f = fixture()
  try {
    const executable = join(f.root, 'lib', 'DafeiyuBroadcast.app', 'Contents', 'MacOS', 'DafeiyuBroadcast')
    const source = readFileSync(executable)
    writeFileSync(executable, '#!/bin/sh\nexit 1\n')
    await assert.rejects(f.output.open(OWNER), /启动失败/)
    writeFileSync(executable, source)
    await f.output.open(OWNER)
    assert.equal((await fetch(f.address())).status, 200)
    f.output.dispose()
    rmSync(executable)
    await assert.rejects(f.output.open(OWNER), /缺少播出窗口/)
  } finally { f.dispose() }
})


test('口型推送无需轮询，过期语音收口，紧急停止覆盖推送，关闭释放连接', options, async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    await f.output.open(OWNER)
    const bootstrap = await fetch(f.address())
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    await bootstrap.text()
    assert.equal((await fetch(f.address().origin + '/frames')).status, 404)
    const response = await fetch(f.address().origin + '/frames', { headers: { cookie }, signal: controller.signal })
    assert.match(response.headers.get('content-type')!, /event-stream/)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    const next = async (matches: (frame: any) => boolean): Promise<any> => {
      const timeout = setTimeout(() => controller.abort(), 2000)
      try {
        while (true) {
          const split = pending.indexOf('\n\n')
          if (split >= 0) {
            const event = pending.slice(0, split); pending = pending.slice(split + 2)
            const frame = JSON.parse(event.slice(6))
            if (matches(frame)) return frame
          } else {
            const { value, done } = await reader.read()
            if (done) throw new Error('stream closed')
            pending += decoder.decode(value, { stream: true })
          }
        }
      } finally { clearTimeout(timeout) }
    }
    assert.equal((await next(() => true)).safe, true)
    const sampledAt = Date.now()
    f.output.publish(OWNER, { profileId: 'dsh-pet', speaking: true, level: 0.8, form: -0.4, sampledAt, subtitle: '已审核回复' })
    const speaking = await next((frame) => frame.speaking)
    assert.equal(speaking.form, -0.4)
    assert.equal(speaking.sampledAt, sampledAt)
    const stale = await next((frame) => !frame.speaking && !frame.safe)
    assert.equal(stale.level, 0)
    assert.equal(stale.subtitle, '')
    f.output.publish(OWNER, { profileId: 'dsh-pet', speaking: true, level: 1 })
    await next((frame) => frame.speaking)
    f.handle.live.session.emergencyStop()
    assert.equal((await next((frame) => frame.safe)).level, 0)
    controller.abort()
    await reader.cancel().catch(() => {})
  } finally { controller.abort(); f.dispose() }
})

test('播放版本：切角色与安全画面递增版本，迟到旧版本帧拒收，打断清空当前帧', options, async () => {
  const f = fixture()
  try {
    await f.output.open(OWNER)
    const bootstrap = await fetch(f.address())
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!
    await bootstrap.text()
    const frame = async () => (await fetch(f.address().origin + '/frame', { headers: { cookie } })).json() as Promise<{
      safe: boolean; speaking: boolean; profileId: string; version: number
    }>
    assert.equal(f.output.playbackVersion(OWNER), 1)
    assert.equal(f.output.playbackVersion(OTHER_OWNER), null)
    // 每次上行都必须带新鲜 sampledAt：过期样本不得让画面保持张嘴（既有语义）
    const base = () => ({ speaking: true, level: 0.7, subtitle: '已审核回复', sampledAt: Date.now() })
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'dsh-pet' }), true)
    assert.equal((await frame()).version, 1)
    // 同一角色：版本不变（普通上行帧不应被当成新播放）
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'dsh-pet' }), true)
    assert.equal((await frame()).version, 1)
    // 切角色：版本递增，渲染端据此丢弃上一段在途口型
    f.handle.settings.savePersona({ profileId: 'xiaxia', usageRightConfirmed: true })
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'xiaxia' }), true)
    assert.equal((await frame()).version, 2)
    // 工作台声明了旧版本：拒收（迟到上传不得覆盖新版本画面）
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'xiaxia', playbackVersion: 1 }), false)
    assert.equal((await frame()).version, 2)
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'xiaxia', playbackVersion: 2 }), true)
    // 打断：版本递增并清空当前帧，画面回到安全画面
    assert.equal(f.output.interrupt(OWNER), 3)
    assert.equal((await frame()).safe, true)
    assert.equal((await frame()).version, 3)
    // 打断后旧版本帧继续被拒收，新版本可正常播出
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'xiaxia', playbackVersion: 2 }), false)
    assert.equal(f.output.publish(OWNER, { ...base(), profileId: 'xiaxia', playbackVersion: 3 }), true)
    assert.equal((await frame()).speaking, true)
    // 非 owner 不能打断
    assert.equal(f.output.interrupt(OTHER_OWNER), null)
    assert.equal((await frame()).version, 3)
  } finally { f.dispose() }
})

