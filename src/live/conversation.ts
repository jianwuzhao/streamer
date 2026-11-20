import { randomUUID } from 'node:crypto'
import type { LiveSession } from './session.ts'
import type { SettingsStore } from '../settings/store.ts'
import type { RequestRouter, RouteContext } from '../routing/router.ts'
import type { DafeiyuRuntime } from '../runtime.ts'
import type { AnswerReceipt, LiveRequest } from '../types.ts'
import { interactionFallback, type HostInteraction } from './interaction-replies.ts'
import { liveTopic, publicBroadcastText, topicMatches, viewerPreference, type LiveInteractionMemory, type ProgramMemory } from './interaction-memory.ts'

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
  readonly sourceId?: string
  readonly deep?: boolean
  generation?: AbortController
  cloudQuestion?: string
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
  readonly memory: LiveInteractionMemory
  readonly resolveViewer: (message: DanmakuMessage) => string | undefined
  readonly checkModels: () => void
  readonly canRecord: () => boolean
  readonly roomId?: string
  readonly roomForRun?: () => string | undefined
}

export class HostConversation {
  private readonly deps: ConversationDeps
  private run: Run | null = null
  private trackedLiveRunId: number | null = null
  private readonly liveAutomatic = new Set<InteractionKind>()
  private liveSessionId = ''
  private readonly history = new Map<string, { profileId: string; question: string; answer: string; cloudQuestion?: string }[]>()
  private readonly program = new Map<string, ProgramMemory>()
  private readonly hiddenProgram = new Set<string>()
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
      this.liveSessionId = live === null ? '' : randomUUID()
      this.history.clear()
      this.program.clear()
      this.hiddenProgram.clear()
      this.seen.clear()
      this.finishedGroups.clear()
      this.liveAutomatic.clear()
      if (live !== null) {
        for (const kind of DEFAULT_AUTOMATIC) this.liveAutomatic.add(kind)
        this.deps.checkModels()
      }
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
    const previous = this.run
    const sameLive = live !== null && previous?.scope.startsWith(`live:${live}:`)
    const carry = scope && previous && sameLive
      ? previous.entries.filter(({ turn }) => turn.kind === 'comment' && !this.expired(turn) &&
        (['waiting', 'queued', 'thinking'].includes(turn.status) || turn.playback === 'pending'))
      : []
    this.reset()
    if (scope === null) return null
    this.run = {
      id: randomUUID(), scope,
      mode, profile, controller: new AbortController(), entries: carry.map((entry) => ({
        turn: { id: randomUUID(), source: entry.turn.source, kind: 'comment', author: entry.turn.author,
          text: entry.turn.text, sentAt: entry.turn.sentAt, status: 'waiting' },
        speaker: entry.speaker, localOnly: entry.localOnly,
        ...(entry.viewer ? { viewer: entry.viewer } : {}),
        ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
      })), running: false,
      automatic: mode === 'live' ? this.liveAutomatic : new Set(),
      lastAutomatic: sameLive && previous ? previous.lastAutomatic : new Map(),
      interactionVariants: { join: 0, gift: 0 }, groups: new Map(),
    }
    if (carry.length) this.scheduleAutomatic(this.run)
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
      automatic: [...(run?.automatic ?? [])], stageReady: !!run?.stage,
      program: { current: [...this.program.values()].slice(-8).reverse(), saved: this.deps.memory.savedProgram(),
        pending: run?.mode === 'live' ? [...new Set(run.entries.filter(({ turn }) =>
          turn.kind === 'comment' && ['queued', 'thinking'].includes(turn.status))
          .flatMap(({ turn }) => liveTopic(publicBroadcastText(turn.text) ?? '') ?? []))].slice(0, 4) : [] } }
  }

  liveWindow() {
    // 采集跟随直播场次，角色授权或对话重建时保留当前连接与读取游标。
    const live = this.trackLiveRun()
    return live === null ? null : { id: String(live), since: new Date(this.liveStartedAt).toISOString() }
  }

  acceptsSpeech(runId: string): boolean {
    return this.current()?.id === runId
  }

  send(text: string, previewOnly = false, deep = false) {
    const run = this.requireRun()
    if (previewOnly && run.mode !== 'preview') throw new ConversationError(409, '请先进入本地预览')
    this.checkCapacity(run, previewOnly ? 1 : QUEUE_LIMIT)
    const entry: Entry = {
      turn: { id: randomUUID(), source: 'operator', author: '操作员', text, sentAt: new Date().toISOString(), status: 'queued' },
      speaker: 'operator',
      localOnly: previewOnly,
      deep: deep && run.mode === 'live',
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
      kind === 'gift' && message.group ? `gift:${message.viewerId ?? message.nickname ?? message.id}:${message.group}` : null
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
    const viewer = this.deps.resolveViewer(message)
    const entry: Entry = {
      turn: { id: randomUUID(), source: 'danmaku', kind: message.kind ?? 'comment', author: nickname || '直播间观众',
        text: message.text, sentAt: message.sentAt, status: 'waiting' },
      speaker: message.kind && message.kind !== 'comment' ? null : viewer ?? null,
      ...(viewer ? { viewer } : {}),
      sourceId: message.group && message.kind === 'gift' ? `${this.liveSessionId}:gift:${message.group}` : message.id,
      localOnly: false,
    }
    this.append(run, entry)
    if (entry.turn.kind !== 'comment') this.recordInteraction(run, entry)
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

  stagePoll(owner: string, completed?: { key: string; ok: boolean }, playingKey?: string, profileId?: string) {
    const run = this.current()
    if (run?.mode !== 'live') return { runId: null, owner: false, activeKey: null, reply: null }
    if (profileId !== undefined && profileId !== run.profile.id) {
      return { runId: run.id, owner: false, activeKey: null, reply: null }
    }
    this.expireStage(run)
    if (run.stage && run.stage.owner !== owner) return { runId: run.id, owner: false, activeKey: null, reply: null }
    const stage = run.stage ??= { owner, lastSeen: Date.now() }
    stage.lastSeen = Date.now()
    if (completed && stage.active?.answer?.playbackKey === completed.key) {
      stage.active.playback = completed.ok ? 'played' : 'failed'
      if (completed.ok) this.rememberProgram(run, stage.active)
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
    return { runId: run.id, owner: true, activeKey: answer?.playbackKey ?? null, reply: answer && answer.playbackKey !== playingKey ?
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
    if (run.mode !== 'live' || !entry?.turn.answer?.text) throw new ConversationError(404, '找不到当前场次的语音回复')
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

  private recordInteraction(run: Run, entry: Entry): void {
    if (run.mode !== 'live' || !entry.viewer || !entry.sourceId || !this.deps.canRecord()) return
    try {
      this.deps.memory.record({ viewerKey: entry.viewer, sourceId: entry.sourceId, sessionId: this.liveSessionId,
        profileId: run.profile.id, kind: entry.turn.kind ?? 'comment', text: entry.turn.text, observedAt: entry.turn.sentAt })
    } catch {
      // Playback stays available if the evidence store is temporarily unavailable.
    }
  }

  invalidateViewer(viewerKey: string): void {
    this.history.delete(viewerKey)
    const run = this.run
    if (!run) return
    for (const entry of run.entries) {
      if (entry.viewer !== viewerKey) continue
      entry.generation?.abort()
      delete entry.turn.draft
      if (entry.turn.playback === 'playing' || entry.turn.playback === 'pending') {
        if (run.stage?.active === entry.turn) delete run.stage.active
        entry.turn.playback = 'skipped'
        delete entry.turn.answer
      }
    }
  }

  private nicknames(run: Run): string[] {
    return run.entries.filter(({ turn }) => turn.source === 'danmaku' && turn.author !== '直播间观众').map(({ turn }) => turn.author)
  }

  private rememberProgram(run: Run, turn: Turn): void {
    if (run.mode !== 'live' || this.program.has(turn.id) || this.hiddenProgram.has(turn.id) ||
        !turn.answer || turn.answer.route === 'fallback') return
    const nicknames = this.nicknames(run)
    const topic = liveTopic(publicBroadcastText(turn.text, nicknames) ?? '') ??
      (turn.source === 'operator' ? publicBroadcastText(turn.text, nicknames)?.slice(0, 48) : undefined)
    if (!topic) return
    const summary = turn.source === 'operator' ? publicBroadcastText(turn.answer.text, nicknames)?.slice(0, 240) :
      `已在直播中回应「${topic}」相关提问。`
    if (!summary) return
    this.program.set(turn.id, { id: turn.id, sessionId: this.liveSessionId, profileId: run.profile.id,
      topic, summary, updatedAt: new Date().toISOString() })
    if (this.program.size > 40) this.program.delete(this.program.keys().next().value!)
  }

  saveProgram(id: string, summary?: string): void {
    const run = this.current()
    const item = this.program.get(id) ?? this.deps.memory.programById(id)
    if (!item) throw new ConversationError(404, '找不到该节目记忆')
    const text = summary === undefined ? item.summary : publicBroadcastText(summary, run ? this.nicknames(run) : [])
    if (!text || text.length > 240) throw new ConversationError(400, '请输入 1–240 字可公开的节目内容')
    this.deps.memory.saveProgram({ ...item, summary: text })
    if (this.program.has(id)) this.program.set(id, { ...item, summary: text, updatedAt: new Date().toISOString() })
  }

  removeProgram(id: string): void {
    this.current()
    const saved = this.deps.memory.removeProgram(id)
    const current = this.program.delete(id)
    if (!saved && !current) throw new ConversationError(404, '找不到该节目记忆')
    this.hiddenProgram.add(id)
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
        entry.generation = new AbortController()
        try {
          const result = await this.generate(run, entry)
          if (run.controller.signal.aborted || this.current() !== run) break
          turn.answer = result.answer
          turn.memoryUsed = result.memoryUsed
          turn.status = 'answered'
          if (run.mode === 'live' && turn.kind === 'comment' &&
              (result.answer.route !== 'fallback' || result.answer.replyKind === 'preset')) {
            if (entry.viewer && result.answer.route !== 'fallback' && this.deps.memory.personalizes(entry.viewer)) {
              const history = this.history.get(entry.viewer) ?? []
              this.history.delete(entry.viewer)
              this.history.set(entry.viewer, [...history, { profileId: run.profile.id, question: turn.text,
                answer: result.answer.text, ...(entry.cloudQuestion !== undefined ? { cloudQuestion: entry.cloudQuestion } : {}) }].slice(-4))
              if (this.history.size > 256) this.history.delete(this.history.keys().next().value!)
            }
            this.recordInteraction(run, entry)
          }
          if (run.mode === 'live' && result.answer.replyKind !== 'reaction') this.queuePlayback(run, entry)
        } catch {
          delete turn.draft
          turn.status = 'error'
        } finally {
          delete entry.generation
          entry.finish?.(turn.answer ?? null)
        }
      }
    } finally {
      run.running = false
      if (!run.controller.signal.aborted && this.current() === run) this.scheduleAutomatic(run)
    }
  }

  private async generate(run: Run, entry: Entry) {
    const startedAt = Date.now()
    const { turn } = entry
    const interaction: HostInteraction | undefined = turn.kind === 'join' || turn.kind === 'gift'
      ? { kind: turn.kind, variant: run.interactionVariants[turn.kind]++ } : undefined
    const publicEvent = turn.kind !== undefined && turn.kind !== 'comment'
    const sameRole = entry.speaker === null || entry.viewer ? [] : run.entries.filter((previous) =>
      previous.speaker === entry.speaker && previous.turn.answer && previous.turn.answer.route !== 'fallback').slice(-4)
    const messages = (entries: readonly Entry[]) => entries.flatMap(({ turn }) => [
      { role: 'user' as const, text: turn.text },
      { role: 'assistant' as const, text: turn.answer!.text },
    ])
    const viewer = entry.viewer && this.deps.memory.personalizes(entry.viewer) ? entry.viewer : undefined
    const past = viewer ? this.history.get(viewer) ?? [] : []
    const relationship = viewer && !publicEvent && this.deps.canRecord() ? this.deps.memory.relationship(viewer, run.profile.id) : []
    const address = relationship.find(({ kind }) => kind === 'address')?.value
    const joke = relationship.find(({ kind }) => kind === 'inside_joke')?.value
    const history = past.length ? past.flatMap(({ profileId, question, answer }) => {
      if (profileId === run.profile.id) return [{ role: 'user' as const, text: question }, { role: 'assistant' as const, text: answer }]
      const topic = liveTopic(publicBroadcastText(question) ?? '')
      return topic ? [{ role: 'user' as const, text: `刚才我和上一位主播聊到「${topic}」。` }] : []
    }) : messages(sameRole)
    const nicknames = this.nicknames(run)
    if (address) nicknames.push(address)
    const allowCloud = () => turn.source === 'operator' ||
      (this.deps.settings.getCloud().publicChatAllowed && this.deps.settings.getDataUsage().confirmed)
    const cloudText = allowCloud()
      ? publicBroadcastText(turn.text, nicknames) : undefined
    const relationIntent = !publicEvent && turn.kind === 'comment' ? viewerPreference(turn.text) : {}
    const remembersJoke = turn.kind === 'comment' && /还记得.{0,8}(?:共同)?梗|咱们的梗|我们之间的梗/.test(turn.text)
    const setsRelationship = !!(relationIntent.address || relationIntent.preference || relationIntent.joke)
    const privateRelationship = /叫我|称呼我|我的真名|我的名字是|我们之间|共同梗/.test(turn.text) ||
      (joke !== undefined && turn.text.includes(joke))
    const localOnly = entry.localOnly || !cloudText || setsRelationship || remembersJoke || privateRelationship
    if (!localOnly) entry.cloudQuestion = cloudText.slice(0, 140)
    const questions = [turn.text, ...past.map(({ question }) => question)]
    const related = run.mode === 'live' && !publicEvent ? [
      ...[...this.program.values()].reverse().filter((item) => questions.some((text) => topicMatches(text, item.topic))),
      ...this.deps.memory.recallProgram(questions),
    ] : []
    const program = [...new Set(related.map(({ topic, summary }) => `${topic} · ${summary}`))].slice(0, 3)
    const cloudHistory = viewer ? past.flatMap(({ cloudQuestion }) => cloudQuestion
      ? [{ role: 'user' as const, text: cloudQuestion }] : []).slice(-2) :
      messages(sameRole.filter(({ turn: previous }) => previous.answer?.route === 'cloud'))
    const clarify = !publicEvent && history.length === 0 && program.length === 0 &&
      /^(?:那|所以|然后)?(?:刚才|之前|刚刚)?(?:说的)?(?:那个|这个|这件事)(?:呢|怎么办|怎么说|怎么做|是什么)?[？?。\s]*$/.test(turn.text)
    const eventPreset: RouteContext['preset'] = interaction ? {
      kind: 'preset', text: interactionFallback(interaction, run.profile.id) ?? (interaction.kind === 'gift' ? '谢谢你的礼物！' : '欢迎来直播间。'),
    } : publicEvent ? { kind: 'reaction', text: '' } : undefined
    const preferencePreset = setsRelationship ? {
      kind: 'preset' as const,
      text: viewer && this.deps.canRecord() ? (relationIntent.address ? '好呀，我记下这个称呼了。' :
        relationIntent.joke ? '好呀，这个梗我记下啦。' : '我记下这个话题了，咱们可以接着聊。') :
        '收到，咱们接着聊。',
    } : remembersJoke ? {
      kind: 'preset' as const, text: joke ? `我记得呀，是「${joke}」。` : '给我一个关键词，咱们接着聊。',
    } : undefined
    const preset = clarify ? { kind: 'clarification' as const, text: '你说的是刚才哪一件事？给我一个关键词，我就能接上。' } :
      eventPreset ?? preferencePreset
    const recalled = preset ? [] : await this.deps.recall(turn.text, run.profile.id).catch(() => [])
    const memory = [...recalled, ...relationship.map(({ kind, value }) => {
      const label = { address: '观众允许本主播使用的称呼', preference: '观众明确表达的偏好',
        inside_joke: '本主播与这位观众的共同梗', shared_topic: '本主播与这位观众多次聊过的话题' }[kind]
      return `${label}：${value}`
    })]
    const signal = entry.generation ? AbortSignal.any([run.controller.signal, entry.generation.signal]) : run.controller.signal
    signal.throwIfAborted()
    const preferCloud = run.mode === 'live' && (entry.deep || turn.text.length >= 35 &&
      /比较|对比|优缺点/.test(turn.text) && /预算|条件|分别|同时|使用场景/.test(turn.text))
    const context: RouteContext = { signal, startedAt, localOnly, allowCloud, preferCloud, hostProfile: run.profile,
      recentReplies: past.filter(({ profileId, question }) => profileId === run.profile.id && question !== turn.text)
        .slice(-2).map(({ answer }) => answer),
      ...(preset ? { preset } : {}),
      onDraft: (text) => {
        if (signal.aborted || turn.status !== 'thinking') return
        if (text.trim()) turn.draft = text
        else delete turn.draft
      },
      hostConversation: {
        mode: run.mode,
        history,
        cloudHistory,
        memory,
        program,
        ...(cloudText ? { cloudText } : {}),
        ...(address && !past.some(({ profileId, answer }) => profileId === run.profile.id && answer.includes(address))
          ? { address } : {}),
        ...(interaction ? { interaction } : {}),
      },
    }
    const request: LiveRequest = {
      requestId: turn.id, sessionId: run.mode === 'live' ? this.liveSessionId : run.id,
      roomId: run.mode === 'live' ? this.roomId() ?? 'live' : 'local-preview',
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
