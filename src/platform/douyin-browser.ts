import type { Browser, CDPSession } from 'playwright-core'
import type { HostConversation } from '../live/conversation.ts'
import { decodeDouyinPacket, douyinNetworkRoom, douyinRoomUrl } from './douyin-protocol.ts'

export type BrowserFeedStatus = 'waiting' | 'connected' | 'error' | 'protocol' | 'browser_error' | 'room_error' | 'room_offline'
type Close = () => Promise<void>
type BrowserRun = { abort: AbortController; close?: Close; room?: string }
const OFFLINE_RETRY_MS = 15_000

function emptyPollingResponse(body: string): boolean {
  if (!body.trim()) return true
  try {
    const reply = JSON.parse(body) as { status_code?: unknown; data?: unknown }
    return reply?.status_code === 0 && (reply.data === null ||
      (typeof reply.data === 'object' && Object.keys(reply.data).length === 0))
  } catch {
    return false
  }
}

async function launchChrome(): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  return chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true,
    args: ['--mute-audio'], timeout: 8000 })
}

export class DouyinBrowserFeed {
  private active: BrowserRun | null = null
  private state: BrowserFeedStatus = 'waiting'

  private readonly conversation: Pick<HostConversation, 'liveWindow' | 'receive'>
  private readonly launch: () => Promise<Browser>

  constructor(conversation: Pick<HostConversation, 'liveWindow' | 'receive'>, launch = launchChrome) {
    this.conversation = conversation
    this.launch = launch
  }

  get status(): BrowserFeedStatus { return this.state }

  start(roomUrl: string): void {
    const window = this.conversation.liveWindow()
    if (!window || this.active || !douyinRoomUrl(roomUrl)) return
    const active = { abort: new AbortController() }
    this.active = active
    void this.connect(active, roomUrl, window.id)
  }

  stop(): void {
    const active = this.active
    this.active = null
    this.state = 'waiting'
    active?.abort.abort()
    void active?.close?.()
  }

  private async connect(
    active: BrowserRun,
    roomUrl: string,
    runId: string,
  ): Promise<void> {
    const signal = active.abort.signal
    const current = () => !signal.aborted && this.conversation.liveWindow()?.id === runId
    while (current()) {
      let browser: Browser | undefined
      let stopListening: (() => void) | undefined
      let roomCheck: ReturnType<typeof setTimeout> | undefined
      let watching = true
      const alive = () => watching && current()
      try {
        browser = await this.launch()
        const launched = browser
        active.close = () => launched.close().catch(() => {})
        if (!current()) break
        // The live site returns empty interaction responses for HeadlessChrome.
        // Keep the collector hidden while using the installed desktop Chrome identity.
        const major = browser.version().split('.')[0]
        const page = await browser.newPage({ acceptDownloads: false,
          userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        })
        const cdp = await page.context().newCDPSession(page)
        const closed = new Promise<void>((resolve) => {
          browser?.once('disconnected', () => resolve())
          page.once('close', () => resolve())
          page.once('crash', () => resolve())
          if (!current()) resolve()
        })
        stopListening = this.listen(cdp, active, roomUrl, alive, () => { void active.close?.() })
        await cdp.send('Network.enable', { maxTotalBufferSize: 8_388_608, maxResourceBufferSize: 2_097_152 })
        await page.goto(roomUrl, { waitUntil: 'commit', timeout: 12000 })
        if (!current()) break
        if (douyinRoomUrl(page.url()) !== roomUrl) {
          this.state = 'room_error'
        } else {
          const offline = page.locator('#TipsLayout').getByText(/^(直播已结束|主播暂未开播|主播还未开播)$/)
            .filter({ visible: true }).first()
          const checkRoom = async () => {
            if (!alive()) return
            const offlineNow = await offline.isVisible().catch(() => false)
            if (!alive()) return
            if (offlineNow) {
              // 提示位于播放器，避免把评论或推荐房间中的同名文字当成当前房间停播。
              watching = false
              this.state = 'room_offline'
              delete active.room
              await active.close?.()
              return
            }
            roomCheck = setTimeout(checkRoom, 4000)
            roomCheck.unref()
          }
          page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame() && douyinRoomUrl(frame.url()) !== roomUrl && current()) {
              this.state = 'room_error'
              void active.close?.()
            }
          })
          void checkRoom()
          await closed
          if (current() && this.state !== 'room_error' && this.state !== 'room_offline') this.state = 'error'
        }
      } catch {
        if (current()) this.state = browser ? 'error' : 'browser_error'
      } finally {
        watching = false
        clearTimeout(roomCheck)
        stopListening?.()
        await active.close?.()
        delete active.close
      }
      if (!current()) break
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, this.state === 'room_offline' ? OFFLINE_RETRY_MS : 3000)
        timer.unref()
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }
  }

  private listen(
    cdp: CDPSession, active: BrowserRun, roomUrl: string, current: () => boolean, reconnect: () => void,
  ): () => void {
    const sockets = new Map<string, string>()
    const polls = new Map<string, string>()
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const recover = () => {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    const disconnected = () => {
      if (!current()) return
      this.state = 'error'
      if (reconnectTimer) return
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined
        if (current() && this.state === 'error') reconnect()
      }, 10_000)
      reconnectTimer.unref()
    }
    const consume = (data: string, room: string, transport: 'socket' | 'poll') => {
      if (!current() || (active.room && active.room !== room) || !data) return
      try {
        if (data.length > 2_800_000) throw new Error('Oversize encoded packet')
        const messages = decodeDouyinPacket(Buffer.from(data, 'base64'), transport, room, roomUrl)
        recover()
        if (this.state === 'error') this.state = active.room ? 'connected' : 'waiting'
        if (messages.length) {
          active.room = room
          this.state = 'connected'
        }
        for (const message of messages) this.conversation.receive(message)
      } catch {
        this.state = 'protocol'
      }
    }
    cdp.on('Network.webSocketCreated', (event) => {
      const room = douyinNetworkRoom(event.url, 'socket')
      if (current() && room && sockets.size < 32) sockets.set(event.requestId, room)
    })
    cdp.on('Network.webSocketFrameReceived', (event) => {
      const room = sockets.get(event.requestId)
      if (room && event.response.opcode === 2) consume(event.response.payloadData, room, 'socket')
    })
    cdp.on('Network.webSocketClosed', ({ requestId }) => {
      if (sockets.delete(requestId) && sockets.size === 0) disconnected()
    })
    cdp.on('Network.responseReceived', (event) => {
      const room = douyinNetworkRoom(event.response.url, 'poll')
      if (current() && room && event.response.status === 200 && polls.size < 100) polls.set(event.requestId, room)
    })
    cdp.on('Network.loadingFailed', ({ requestId }) => polls.delete(requestId))
    cdp.on('Network.loadingFinished', ({ requestId }) => {
      const room = polls.get(requestId)
      polls.delete(requestId)
      if (!room || !current()) return
      void cdp.send('Network.getResponseBody', { requestId }).then(({ body, base64Encoded }) => {
        if (base64Encoded) consume(body, room, 'poll')
        else if (current()) {
          if (emptyPollingResponse(body)) {
            recover()
            if (this.state === 'error' || this.state === 'protocol') this.state = active.room ? 'connected' : 'waiting'
          } else this.state = 'protocol'
        }
      }).catch(disconnected)
    })
    return recover
  }
}
