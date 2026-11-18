import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { Browser } from 'playwright-core'
import protobuf from 'protobufjs/minimal.js'
import type { DanmakuMessage } from '../live/conversation.ts'
import { DouyinBrowserFeed } from './douyin-browser.ts'

const roomUrl = 'https://live.douyin.com/123'
const room = '99887766'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function chromeStub(offline = false) {
  const network = new EventEmitter()
  const page = new EventEmitter()
  const browser = new EventEmitter()
  const offlineLocator = {
    getByText: () => offlineLocator,
    filter: () => offlineLocator,
    first: () => offlineLocator,
    isVisible: async () => offline,
  }
  Object.assign(network, { send: async (method: string) => method === 'Network.getResponseBody' ?
    { body: '{"data":[],"status_code":0}', base64Encoded: false } : {} })
  Object.assign(page, {
    url: () => roomUrl, goto: async () => {}, mainFrame: () => ({}),
    locator: (selector: string) => { assert.equal(selector, '#TipsLayout'); return offlineLocator },
    context: () => ({ newCDPSession: async () => network }),
  })
  Object.assign(browser, {
    version: () => '142.0.0.0',
    newPage: async () => page,
    close: async () => { browser.emit('disconnected') },
  })
  return { network, browser: browser as unknown as Browser, disconnect: () => browser.emit('disconnected') }
}

function push(network: EventEmitter, id: number) {
  const { Writer } = protobuf
  const common = Writer.create().uint32(24).uint64(room).finish()
  const chat = Writer.create().uint32(10).bytes(common).uint32(26).string('测试评论').finish()
  const message = Writer.create().uint32(10).string('WebcastChatMessage')
    .uint32(18).bytes(chat).uint32(24).uint32(id).finish()
  const batch = Writer.create().uint32(10).bytes(message).finish()
  const packet = Writer.create().uint32(66).bytes(batch).finish()
  network.emit('Network.webSocketCreated', { requestId: 'test', url: `wss://webcast.douyin.com/webcast/im/push/v2/?room_id=${room}` })
  network.emit('Network.webSocketFrameReceived', {
    requestId: 'test', response: { opcode: 2, payloadData: Buffer.from(packet).toString('base64') },
  })
}

test('浏览器断线后重连，结束场次和旧连接的帧不会进入主播队列', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = chromeStub()
  const second = chromeStub()
  const windows = [first, second]
  const roomMessages: DanmakuMessage[] = []
  const feed = new DouyinBrowserFeed({
    liveWindow: () => ({ id: 'live-1', since: '2026-11-16T03:00:00Z' }),
    receive: (message) => { roomMessages.push(message); return true },
  }, async () => windows.shift()!.browser)
  try {
    feed.start(roomUrl)
    await settle()
    first.network.emit('Network.responseReceived', { requestId: 'empty-poll',
      response: { url: `https://live.douyin.com/webcast/im/fetch/?room_id=${room}`, status: 200 } })
    first.network.emit('Network.loadingFinished', { requestId: 'empty-poll' })
    await settle()
    assert.equal(feed.status, 'waiting', '抖音空批次不是协议错误')
    push(first.network, 1)
    assert.equal(feed.status, 'connected')
    first.disconnect()
    await settle()
    assert.equal(feed.status, 'error')
    t.mock.timers.tick(3000)
    await settle()
    push(first.network, 2)
    push(second.network, 3)
    assert.equal(feed.status, 'connected')
    feed.stop()
    push(second.network, 4)
    assert.deepEqual(roomMessages.map(({ id }) => id), [`${room}:1`, `${room}:3`])
  } finally {
    feed.stop()
    await settle()
  }
})

test('播放器提示直播已结束时报告停播，重试后继续采集评论', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const offline = chromeStub(true)
  const online = chromeStub()
  const attempts = [offline, online]
  const received: DanmakuMessage[] = []
  const feed = new DouyinBrowserFeed({
    liveWindow: () => ({ id: 'live-1', since: '2026-11-16T03:00:00Z' }),
    receive: (message) => { received.push(message); return true },
  }, async () => attempts.shift()!.browser)
  try {
    feed.start(roomUrl)
    await settle()
    assert.equal(feed.status, 'room_offline')
    push(offline.network, 1)
    assert.deepEqual(received, [])
    t.mock.timers.tick(14_999)
    assert.equal(attempts.length, 1)
    t.mock.timers.tick(1)
    await settle()
    push(online.network, 2)
    assert.equal(feed.status, 'connected')
    assert.deepEqual(received.map(({ kind, text }) => [kind, text]), [['comment', '测试评论']])
  } finally {
    feed.stop()
    await settle()
  }
})
