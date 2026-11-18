import { randomUUID } from 'node:crypto'
import type { LiveSession } from './session.ts'
import type { SettingsStore } from '../settings/store.ts'
import type { RequestRouter, RouteContext } from '../routing/router.ts'
import type { DafeiyuRuntime } from '../runtime.ts'
import type { AnswerReceipt, LiveRequest } from '../types.ts'
import type { HostInteraction } from './interaction-replies.ts'

export const MESSAGE_LIMIT = 500
const DISPLAY_LIMIT = 40
const QUEUE_LIMIT = 5
const DANMAKU_TTL_MS = 60_000

export const INTERACTION_KINDS = ['comment', 'gift', 'like', 'join', 'follow', 'fansclub', 'share'] as const
export type InteractionKind = typeof INTERACTION_KINDS[number]
const DEFAULT_AUTOMATIC = ['comment', 'join', 'gift'] as const satisfies readonly InteractionKind[]
type PlaybackStatus = 'pending' | 'playing' | 'played' | 'failed' | 'skipped'
const STAGE_LEASE_MS = 4_000
const AUTO_COOLDOWN_MS = 30_000

export interface DanmakuMessage {
  readonly id: string
  readonly roomId: string
  readonly text: string
  readonly sentAt: string
  readonly nickname?: string | undefined
  readonly viewerId?: string | undefined
  readonly kind?: InteractionKind | undefined
  readonly quantity?: number | undefined
  readonly group?: string | undefined
  readonly groupComplete?: boolean | undefined
  readonly giftName?: string | undefined
}

type TurnStatus = 'waiting' | 'queued' | 'thinking' | 'answered' | 'expired' | 'error'

interface Turn {
  readonly id: string
  readonly source: 'operator' | 'danmaku'
  readonly kind?: InteractionKind
  playback?: PlaybackStatus
  readonly author: string
  readonly text: string
  readonly sentAt: string
  status: TurnStatus
  draft?: string
  answer?: AnswerReceipt
  memoryUsed?: number
}

interface Entry {
  readonly turn: Turn
  readonly speaker: string | null
  readonly localOnly: boolean
  readonly viewer?: string
  readyToPlayAt?: number
  done?: Promise<AnswerReceipt | null>
  finish?: (answer: AnswerReceipt | null) => void
}

interface Run {
  readonly id: string
  readonly scope: string
  readonly mode: 'preview' | 'live'
  readonly profile: ReturnType<SettingsStore['getPersonaProfile']>
  readonly controller: AbortController
  readonly entries: Entry[]
  readonly automatic: Set<InteractionKind>
  readonly lastAutomatic: Map<string, number>
  readonly interactionVariants: Record<HostInteraction['kind'], number>
  readonly groups: Map<string, { message: DanmakuMessage; timer: ReturnType<typeof setTimeout> }>
  stage?: { owner: string; lastSeen: number; active?: Turn }
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
  readonly roomForRun?: () => string | undefined
}

export class HostConversation {
  private readonly deps: ConversationDeps
  private run: Run | null = null
  private trackedLiveRunId: number | null = null
  private readonly liveAutomatic = new Set<InteractionKind>()
  private readonly repliedViewers = new Set<string>()
  private liveStartedAt = 0
  private readonly seen = new Map<string, number>()
  private readonly finishedGroups = new Map<string, number>()

  constructor(deps: ConversationDeps) {
    this.deps = deps
  }

  private trackLiveRun(): number | null {
    const live = this.deps.session.liveRunId
    if (live !== this.trackedLiveRunId) {
      this.trackedLiveRunId = live
      this.liveStartedAt = Date.now()
      this.repliedViewers.clear()
      this.seen.clear()
      this.finishedGroups.clear()
      this.liveAutomatic.clear()
      if (live !== null) for (const kind of DEFAULT_AUTOMATIC) this.liveAutomatic.add(kind)
    }
    return live
  }

  private current(): Run | null {
    const { session, settings } = this.deps
    const live = this.trackLiveRun()
    const preview = session.previewRunId
    const mode = live === null ? 'preview' : 'live'
    const number = live ?? preview
    const profile = settings.getPersonaProfile()
    const scope = number === null || !settings.personaReady().ready ? null : `${mode}:${number}:${profile.id}`
    if (scope === this.run?.scope) return this.run
    this.reset()
    if (scope === null) return null
    this.run = {
      id: randomUUID(), scope,
      mode, profile, controller: new AbortController(), entries: [], running: false,
      automatic: mode === 'live' ? this.liveAutomatic : new Set(), lastAutomatic: new Map(),
      interactionVariants: { join: 0, gift: 0 }, groups: new Map(),
    }
    return this.run
  }

  reset(): void {
    const run = this.run
    this.run = null
    run?.controller.abort()
    for (const group of run?.groups.values() ?? []) clearTimeout(group.timer)
    for (const entry of run?.entries ?? []) entry.finish?.(null)
  }

  snapshot() {
    const run = this.current()
    if (run) {
      for (const { turn } of run.entries) {
        if (turn.status === 'waiting' && this.expired(turn)) turn.status = 'expired'
      }
    }
    if (run) {
      if (this.expireStage(run)) this.scheduleAutomatic(run)
      this.trimPlayback(run)
    }
    return { id: run?.id ?? null, mode: run?.mode ?? null, turns: run?.entries.map(({ turn }) => turn) ?? [],
      automatic: [...(run?.automatic ?? [])], stageReady: !!run?.stage }
  }

  liveWindow() {
    // 采集跟随直播场次，角色授权或对话重建时保留当前连接与读取游标。
    const live = this.trackLiveRun()
    return live === null ? null : { id: String(live), since: new Date(this.liveStartedAt).toISOString() }
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

  private roomId(): string | undefined {
    return this.deps.roomForRun?.() ?? this.deps.roomId
  }

  receive(message: DanmakuMessage): boolean {
    const run = this.current()
    const sentAt = Date.parse(message.sentAt)
    const now = Date.now()
    if (run?.mode !== 'live' || !this.roomId() || message.roomId !== this.roomId() ||
        !Number.isFinite(sentAt) || sentAt < this.liveStartedAt || sentAt < now - DANMAKU_TTL_MS || sentAt > now + 5000) return false
    for (const [id, time] of this.seen) {
      if (time >= now - DANMAKU_TTL_MS) break
      this.seen.delete(id)
    }
    if (this.seen.has(message.id) || this.seen.size >= 4096) return false
    this.seen.set(message.id, now)
    const kind = message.kind ?? 'comment'
    const group = kind === 'like' ? `like:${message.viewerId ?? message.id}:${Math.floor(now / 5000)}` :
      kind === 'gift' && message.group ? `gift:${message.group}` : null
    if (!group) this.accept(run, message)
    else this.aggregate(run, group, message, kind === 'like' ? 5000 - now % 5000 : 2500)
    return true
  }

  private aggregate(run: Run, key: string, message: DanmakuMessage, delay: number): void {
    const now = Date.now()
    for (const [group, finished] of this.finishedGroups) {
      if (finished >= now - DANMAKU_TTL_MS) break
      this.finishedGroups.delete(group)
    }
    if (this.finishedGroups.has(key)) return
    const previous = run.groups.get(key)
    if (!previous && run.groups.size >= 100) return
    if (previous) clearTimeout(previous.timer)
    const quantity = message.kind === 'like' ? (previous?.message.quantity ?? 0) + (message.quantity ?? 1) :
      Math.max(previous?.message.quantity ?? 0, message.quantity ?? 1)
    const combined = { ...message, quantity, text: message.kind === 'like' ? `点赞 ×${quantity}` :
      `送出 ${message.giftName ?? '礼物'} ×${quantity}` }
    const flush = () => {
      run.groups.delete(key)
      if (this.current() !== run) return
      if (message.kind === 'gift') this.finishedGroups.set(key, Date.now())
      this.accept(run, combined)
    }
    if (message.groupComplete) flush()
    else {
      const timer = setTimeout(flush, delay)
      timer.unref()
      run.groups.set(key, { message: combined, timer })
    }
  }

  private accept(run: Run, message: DanmakuMessage): void {
    const nickname = message.nickname?.trim()
    const viewer = message.viewerId ? `id:${message.viewerId}` : nickname ? `name:${nickname}` : undefined
    this.append(run, {
      turn: { id: randomUUID(), source: 'danmaku', kind: message.kind ?? 'comment', author: nickname || '直播间观众',
        text: message.text, sentAt: message.sentAt, status: 'waiting' },
      speaker: message.kind && message.kind !== 'comment' ? null : message.viewerId ? `viewer:${message.viewerId}` : null,
      ...(viewer ? { viewer } : {}),
      localOnly: true,
    })
    this.scheduleAutomatic(run)
  }

  setAutomatic(kinds: readonly InteractionKind[]): void {
    const run = this.requireRun()
    if (run.mode !== 'live') throw new ConversationError(409, '请先确认开播')
    run.automatic.clear()
    for (const kind of kinds) run.automatic.add(kind)
    this.scheduleAutomatic(run)
  }

  private expireStage(run: Run): boolean {
    if (!run.stage || Date.now() - run.stage.lastSeen < STAGE_LEASE_MS) return false
    if (run.stage.active) run.stage.active.playback = 'failed'
    delete run.stage
    return true
  }

  stagePoll(owner: string, completed?: { key: string; ok: boolean }, playingKey?: string) {
    const run = this.current()
    if (run?.mode !== 'live') return { runId: null, owner: false, reply: null }
    this.expireStage(run)
    if (run.stage && run.stage.owner !== owner) return { runId: run.id, owner: false, reply: null }
    const stage = run.stage ??= { owner, lastSeen: Date.now() }
    stage.lastSeen = Date.now()
    if (completed && stage.active?.answer?.playbackKey === completed.key) {
      stage.active.playback = completed.ok ? 'played' : 'failed'
      delete stage.active
    }
    this.trimPlayback(run)
    const next = !stage.active ? run.entries.find(({ turn }) => turn.playback === 'pending')?.turn : undefined
    if (next?.answer) {
      next.playback = 'playing'
      stage.active = next
    }
    this.scheduleAutomatic(run)
    const answer = stage.active?.answer
    return { runId: run.id, owner: true, reply: answer && answer.playbackKey !== playingKey ?
      { key: answer.playbackKey, text: answer.text, profileId: run.profile.id } : null }
  }

  stageRelease(owner: string): void {
    const run = this.current()
    if (run?.stage?.owner !== owner) return
    if (run.stage.active) run.stage.active.playback = 'failed'
    delete run.stage
    this.scheduleAutomatic(run)
  }

  stageReplay(id: string): void {
    const run = this.requireRun()
    const entry = run.entries.find(({ turn }) => turn.id === id)
    if (run.mode !== 'live' || !entry?.turn.answer) throw new ConversationError(404, '找不到当前场次的回复')
    if (entry.turn.playback !== 'playing') this.queuePlayback(run, entry)
  }

  allowsStageSpeech(runId: string, owner: string, key: string, text: string): boolean {
    const run = this.current()
    if (!run || run.id !== runId) return false
    this.expireStage(run)
    const answer = run.stage?.active?.answer
    return run.stage?.owner === owner && answer?.playbackKey === key && answer.text.slice(0, MESSAGE_LIMIT).trim() === text
  }

  private queuePlayback(run: Run, entry: Entry): void {
    entry.readyToPlayAt = Date.now()
    entry.turn.playback = 'pending'
    this.trimPlayback(run)
  }

  private trimPlayback(run: Run): void {
    const now = Date.now()
    const pending = run.entries.filter(({ turn }) => turn.playback === 'pending')
    pending.sort((left, right) => (left.readyToPlayAt ?? 0) - (right.readyToPlayAt ?? 0))
    for (const [index, entry] of pending.entries()) {
      if (index < pending.length - QUEUE_LIMIT || now - (entry.readyToPlayAt ?? now) > DANMAKU_TTL_MS) {
        entry.turn.playback = 'skipped'
      }
    }
  }

  private scheduleAutomatic(run: Run): void {
    if (run.mode !== 'live' || !run.automatic.size) return
    this.expireStage(run)
    this.trimPlayback(run)
    if (run.stage?.active || run.entries.some(({ turn }) =>
      turn.status === 'queued' || turn.status === 'thinking' || (!!run.stage && turn.playback === 'pending'))) return
    const now = Date.now()
    for (const [key, issued] of run.lastAutomatic) {
      if (now - issued < AUTO_COOLDOWN_MS) break
      run.lastAutomatic.delete(key)
    }
    const waiting = run.entries.filter(({ turn }) =>
      turn.status === 'waiting' && turn.kind && run.automatic.has(turn.kind) && !this.expired(turn))
    const comment = waiting.find(({ turn }) => turn.kind === 'comment')
    if (comment) {
      void this.enqueue(run, comment)
      return
    }
    for (const entry of waiting) {
      const key = `${entry.turn.kind}:${entry.viewer ?? 'anonymous'}`
      if (run.lastAutomatic.has(key)) continue
      run.lastAutomatic.set(key, now)
      void this.enqueue(run, entry)
      return
    }
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
    this.expireStage(run)
    this.trimPlayback(run)
    const pending = run.entries.filter(({ turn }) =>
      turn.status === 'queued' || turn.status === 'thinking' ||
      (!!run.stage && turn.playback === 'pending'))
    if (pending.length >= limit) throw new ConversationError(409, '正在等待上一条预览或直播回复')
  }

  private append(run: Run, entry: Entry): void {
    run.entries.push(entry)
    if (run.entries.length > DISPLAY_LIMIT) {
      const removable = run.entries.findIndex(({ turn }) => turn.status !== 'queued' && turn.status !== 'thinking'
        && turn.playback !== 'pending' && turn.playback !== 'playing')
      if (removable >= 0) run.entries.splice(removable, 1)
      else run.entries.pop()
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
          if (entry.viewer) this.repliedViewers.add(entry.viewer)
          if (run.mode === 'live') this.queuePlayback(run, entry)
        } catch {
          turn.status = 'error'
        } finally {
          entry.finish?.(turn.answer ?? null)
        }
      }
    } finally {
      run.running = false
      if (!run.controller.signal.aborted && this.current() === run) this.scheduleAutomatic(run)
    }
  }

  private async generate(run: Run, entry: Entry) {
    const { turn } = entry
    const interaction: HostInteraction | undefined = turn.kind === 'join' || turn.kind === 'gift'
      ? { kind: turn.kind, variant: run.interactionVariants[turn.kind]++ } : undefined
    const preferCloud = run.mode === 'live' && entry.viewer !== undefined && !this.repliedViewers.has(entry.viewer)
    const recentReplies = interaction ? run.entries.filter(({ turn: previous }) =>
      previous.kind === interaction.kind && previous.answer).slice(-2).map(({ turn: previous }) => previous.answer!.text) : []
    const past = entry.speaker === null ? [] : run.entries.filter((previous) =>
      previous.speaker === entry.speaker && previous.turn.answer && previous.turn.answer.route !== 'fallback').slice(-4)
    const messages = (entries: readonly Entry[]) => entries.flatMap(({ turn }) => [
      { role: 'user' as const, text: turn.text },
      { role: 'assistant' as const, text: turn.answer!.text },
    ])
    const memory = interaction ? [] : await this.deps.recall(turn.text, run.profile.id).catch(() => [])
    const signal = run.controller.signal
    signal.throwIfAborted()
    const context: RouteContext = { signal, localOnly: entry.localOnly && !preferCloud, preferCloud, recentReplies, hostProfile: run.profile,
      onDraft: (text) => {
        if (signal.aborted || turn.status !== 'thinking') return
        if (text.trim()) turn.draft = text
        else delete turn.draft
      },
      hostConversation: {
        mode: run.mode,
        history: messages(past),
        cloudHistory: messages(past.filter(({ turn }) => turn.answer?.route === 'cloud')),
        memory,
        ...(interaction ? { interaction } : {}),
      },
    }
    const request: LiveRequest = {
      requestId: turn.id, sessionId: run.id, roomId: run.mode === 'live' ? this.roomId() ?? 'live' : 'local-preview',
      text: turn.kind && turn.kind !== 'comment' ? `观众互动：${turn.text}` : turn.text,
      type: turn.source === 'operator' ? 'operator' : turn.kind === 'gift' ? 'gift_comment' : 'danmaku',
      purposeTags: [run.mode === 'live' ? 'service' : 'preview'], occurredAt: turn.sentAt,
    }
    const answer = run.mode === 'live' ? await this.deps.runtime.answer(request, context) :
      await this.deps.router.route(request, context)
    return {
      answer,
      memoryUsed: answer.route === 'local_gpu' || answer.route === 'local_cpu' ? memory.length : 0,
    }
  }
}
