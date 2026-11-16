import { z } from 'zod'
import { MESSAGE_LIMIT, type HostConversation } from '../live/conversation.ts'

const event = z.object({
  id: z.string().min(1).max(180),
  roomId: z.string().min(1).max(180),
  text: z.string().trim().min(1).max(MESSAGE_LIMIT),
  sentAt: z.iso.datetime({ offset: true }),
  nickname: z.string().trim().max(40).optional(),
  viewerId: z.string().min(1).max(180).optional(),
})
const batch = z.object({ cursor: z.string().max(1024), messages: z.array(z.unknown()).max(100) })

interface FeedSettings {
  readonly url?: string | undefined
  readonly roomId?: string | undefined
  readonly token?: string | undefined
}

export class DanmakuFeed {
  private readonly conversation: HostConversation
  private readonly settings: FeedSettings
  private readonly url: URL | null
  private readonly configured: boolean
  private controller: AbortController | null = null
  private state: 'waiting' | 'connected' | 'error' = 'waiting'

  constructor(conversation: HostConversation, settings: FeedSettings) {
    this.conversation = conversation
    this.settings = settings
    const url = URL.canParse(settings.url ?? '') ? new URL(settings.url!) : null
    const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    this.url = url && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && local)) ? url : null
    this.configured = !!(settings.url || settings.roomId || settings.token)
  }

  get status() {
    if (!this.configured) return 'unconfigured'
    if (!this.url || !this.settings.roomId || !this.settings.token) return 'invalid'
    return this.state
  }

  start(): void {
    const window = this.conversation.liveWindow()
    if (!window || this.status === 'unconfigured' || this.status === 'invalid' || this.controller) return
    const controller = this.controller = new AbortController()
    void this.read(window, controller.signal).finally(() => {
      if (this.controller === controller) this.stop()
    })
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.state = 'waiting'
  }

  private async read(window: NonNullable<ReturnType<HostConversation['liveWindow']>>, signal: AbortSignal): Promise<void> {
    let cursor: string | undefined
    const url = new URL(this.url!)
    url.searchParams.set('roomId', this.settings.roomId!)
    url.searchParams.set('since', window.since)
    while (!signal.aborted && this.conversation.liveWindow()?.id === window.id) {
      try {
        if (cursor !== undefined) url.searchParams.set('cursor', cursor)
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${this.settings.token}` },
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        })
        if (!response.ok) throw new Error('Feed unavailable')
        const result = batch.parse(await response.json())
        if (signal.aborted || this.conversation.liveWindow()?.id !== window.id) break
        for (const raw of result.messages) {
          const parsed = event.safeParse(raw)
          if (parsed.success) this.conversation.receive(parsed.data)
        }
        cursor = result.cursor
        this.state = 'connected'
      } catch {
        if (!signal.aborted) this.state = 'error'
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, this.state === 'error' ? 3000 : 750)
        timer.unref()
        if (signal.aborted) finish()
        else signal.addEventListener('abort', finish, { once: true })
      })
    }
  }
}
