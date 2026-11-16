import { randomUUID } from 'node:crypto'
import type { LiveSession } from './session.ts'
import type { SettingsStore } from '../settings/store.ts'
import type { RequestRouter, RouteContext } from '../routing/router.ts'
import type { DafeiyuRuntime } from '../runtime.ts'
import type { AnswerReceipt, LiveRequest } from '../types.ts'

export const MESSAGE_LIMIT = 500
const DISPLAY_LIMIT = 40
const QUEUE_LIMIT = 5
const DANMAKU_TTL_MS = 60_000

export interface DanmakuMessage {
  readonly id: string
  readonly roomId: string
  readonly text: string
  readonly sentAt: string
  readonly nickname?: string | undefined
  readonly viewerId?: string | undefined
}

type TurnStatus = 'waiting' | 'queued' | 'thinking' | 'answered' | 'expired' | 'error'

interface Turn {
  readonly id: string
  readonly source: 'operator' | 'danmaku'
  readonly author: string
  readonly text: string
  readonly sentAt: string
  status: TurnStatus
  answer?: AnswerReceipt
  memoryUsed?: number
}

interface Entry {
  readonly turn: Turn
  readonly speaker: string | null
  readonly localOnly: boolean
  done?: Promise<AnswerReceipt | null>
  finish?: (answer: AnswerReceipt | null) => void
}

interface Run {
  readonly id: string
  readonly scope: string
  readonly startedAt: number
  readonly mode: 'preview' | 'live'
  readonly profile: ReturnType<SettingsStore['getPersonaProfile']>
  readonly controller: AbortController
  readonly entries: Entry[]
  running: boolean
}

export class ConversationError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface ConversationDeps {
  readonly session: LiveSession
  readonly settings: SettingsStore
  readonly router: RequestRouter
  readonly runtime: DafeiyuRuntime
  readonly recall: (message: string, profileId: string) => Promise<readonly string[]>
  readonly roomId?: string
}

export class HostConversation {
  private readonly deps: ConversationDeps
  private run: Run | null = null
  private liveScope: string | null = null
  private liveStartedAt = 0
  private readonly seen = new Map<string, number>()

  constructor(deps: ConversationDeps) {
    this.deps = deps
  }

  private current(): Run | null {
    const { session, settings } = this.deps
    const live = session.liveRunId
    const preview = session.previewRunId
    const mode = live === null ? 'preview' : 'live'
    const number = live ?? preview
    const profile = settings.getPersonaProfile()
    const scope = number === null || !settings.personaReady().ready ? null : `${mode}:${number}:${profile.id}`
    if (scope === this.run?.scope) return this.run
    this.reset()
    if (scope === null) return null
    if (mode === 'live' && this.liveScope !== scope) {
      this.liveScope = scope
      this.liveStartedAt = Date.now()
      this.seen.clear()
    }
    this.run = {
      id: randomUUID(), scope, startedAt: mode === 'live' ? this.liveStartedAt : Date.now(),
      mode, profile, controller: new AbortController(), entries: [], running: false,
    }
    return this.run
  }

  reset(): void {
    const run = this.run
    this.run = null
    run?.controller.abort()
    for (const entry of run?.entries ?? []) entry.finish?.(null)
  }

  snapshot() {
    const run = this.current()
    if (run) {
      for (const { turn } of run.entries) {
        if (turn.status === 'waiting' && this.expired(turn)) turn.status = 'expired'
      }
    }
    return { id: run?.id ?? null, mode: run?.mode ?? null, turns: run?.entries.map(({ turn }) => turn) ?? [] }
  }

  liveWindow() {
    const run = this.current()
    return run?.mode === 'live' ? { id: run.id, since: new Date(run.startedAt).toISOString() } : null
  }

  acceptsSpeech(runId: string): boolean {
    return this.current()?.id === runId
  }

  send(text: string, previewOnly = false) {
    const run = this.requireRun()
    if (previewOnly && run.mode !== 'preview') throw new ConversationError(409, '请先进入本地预览')
    this.checkCapacity(run, previewOnly ? 1 : QUEUE_LIMIT)
    const entry: Entry = {
      turn: { id: randomUUID(), source: 'operator', author: '操作员', text, sentAt: new Date().toISOString(), status: 'queued' },
      speaker: 'operator',
      localOnly: previewOnly,
    }
    this.append(run, entry)
    return { turn: entry.turn, done: this.enqueue(run, entry) }
  }

  receive(message: DanmakuMessage): boolean {
    const run = this.current()
    const sentAt = Date.parse(message.sentAt)
    const now = Date.now()
    if (run?.mode !== 'live' || !this.deps.roomId || message.roomId !== this.deps.roomId ||
        !Number.isFinite(sentAt) || sentAt < run.startedAt || sentAt < now - DANMAKU_TTL_MS || sentAt > now + 5000) return false
    for (const [id, time] of this.seen) {
      if (time >= now - DANMAKU_TTL_MS) break
      this.seen.delete(id)
    }
    if (this.seen.has(message.id) || this.seen.size >= 4096) return false
    this.seen.set(message.id, now)
    this.append(run, {
      turn: { id: randomUUID(), source: 'danmaku', author: message.nickname || '直播间观众',
        text: message.text, sentAt: message.sentAt, status: 'waiting' },
      speaker: message.viewerId ? `viewer:${message.viewerId}` : null,
      localOnly: true,
    })
    return true
  }

  reply(id: string): Turn {
    const run = this.requireRun()
    const entry = run.entries.find(({ turn }) => turn.id === id && turn.source === 'danmaku')
    if (!entry) throw new ConversationError(404, '这条弹幕已离开互动列表')
    if (entry.turn.status !== 'waiting') return entry.turn
    if (this.expired(entry.turn)) {
      entry.turn.status = 'expired'
      throw new ConversationError(409, '这条弹幕已过期')
    }
    this.checkCapacity(run, QUEUE_LIMIT)
    void this.enqueue(run, entry)
    return entry.turn
  }

  private expired(turn: Turn): boolean {
    return turn.source === 'danmaku' && Date.now() - Date.parse(turn.sentAt) > DANMAKU_TTL_MS
  }

  private requireRun(): Run {
    const run = this.current()
    if (!run) throw new ConversationError(409, '请先进入本地预览或确认开播')
    return run
  }

  private checkCapacity(run: Run, limit: number): void {
    const pending = run.entries.filter(({ turn }) => turn.status === 'queued' || turn.status === 'thinking')
    if (pending.length >= limit) throw new ConversationError(409, '正在等待上一条预览或直播回复')
  }

  private append(run: Run, entry: Entry): void {
    run.entries.push(entry)
    if (run.entries.length > DISPLAY_LIMIT) {
      const removable = run.entries.findIndex(({ turn }) => turn.status !== 'queued' && turn.status !== 'thinking')
      run.entries.splice(removable, 1)
    }
  }

  private enqueue(run: Run, entry: Entry): Promise<AnswerReceipt | null> {
    entry.turn.status = 'queued'
    entry.done = new Promise((resolve) => { entry.finish = resolve })
    void this.drain(run)
    return entry.done
  }

  private async drain(run: Run): Promise<void> {
    if (run.running) return
    run.running = true
    try {
      while (!run.controller.signal.aborted && this.current() === run) {
        const entry = run.entries.find(({ turn }) => turn.status === 'queued')
        if (!entry) break
        const { turn } = entry
        if (this.expired(turn)) {
          turn.status = 'expired'
          entry.finish?.(null)
          continue
        }
        turn.status = 'thinking'
        try {
          const result = await this.generate(run, entry)
          if (run.controller.signal.aborted || this.current() !== run) break
          turn.answer = result.answer
          turn.memoryUsed = result.memoryUsed
          turn.status = 'answered'
        } catch {
          turn.status = 'error'
        } finally {
          entry.finish?.(turn.answer ?? null)
        }
      }
    } finally {
      run.running = false
    }
  }

  private async generate(run: Run, entry: Entry) {
    const { turn } = entry
    const past = entry.speaker === null ? [] : run.entries.filter((previous) =>
      previous.speaker === entry.speaker && previous.turn.answer && previous.turn.answer.route !== 'fallback').slice(-4)
    const messages = (entries: readonly Entry[]) => entries.flatMap(({ turn }) => [
      { role: 'user' as const, text: turn.text },
      { role: 'assistant' as const, text: turn.answer!.text },
    ])
    const memory = await this.deps.recall(turn.text, run.profile.id).catch(() => [])
    const signal = run.controller.signal
    signal.throwIfAborted()
    const context: RouteContext = { signal, localOnly: entry.localOnly, recentReplies: [],
      hostConversation: {
        name: run.profile.name,
        description: [run.profile.tagline, run.profile.bio].join('。'),
        history: messages(past),
        cloudHistory: messages(past.filter(({ turn }) => turn.answer?.route === 'cloud')),
        memory,
      },
    }
    const request: LiveRequest = {
      requestId: turn.id, sessionId: run.id, roomId: run.mode === 'live' ? this.deps.roomId ?? 'live' : 'local-preview',
      text: turn.text, type: turn.source === 'operator' ? 'operator' : 'danmaku',
      purposeTags: [run.mode === 'live' ? 'service' : 'preview'], occurredAt: turn.sentAt,
    }
    const answer = run.mode === 'live' ? await this.deps.runtime.answer(request, context) :
      entry.localOnly ? await this.deps.router.routePreview(request, run.profile.name, run.profile.tagline, context) :
        await this.deps.router.route(request, context)
    return {
      answer,
      memoryUsed: answer.route === 'local_gpu' || answer.route === 'local_cpu' ? memory.length : 0,
    }
  }
}
