/**
 * 合并答谢（方案 §10.2）。
 *
 * - 同一观众默认 30 秒合并、全场至少间隔 10 秒、单次不超过 6 秒；
 * - 答谢使用已验证本地模板与短语技能，不为每份礼物调用云端模型；
 * - 播出前再次检查昵称/附言：危险内容不原样朗读（screen 回调判定）；
 * - 退款不自动播报、不指责观众。
 */
import { randomUUID } from 'node:crypto'
import { get, nowIso, run, type DB } from '../storage/db.ts'

export interface AckGiftInput {
  readonly entryId: number
  readonly viewerKey: string
  readonly nickname?: string
  readonly giftName: string
  readonly receivedAtMs: number
}

export interface PendingAck {
  readonly ackId: string
  readonly viewerKey: string
  readonly text: string
  readonly speechSeconds: number
  readonly earliestAtMs: number
}

export class GiftAckService {
  private readonly db: DB
  private readonly clockMs: () => number
  private readonly opts: {
    viewerMergeWindowMs: number
    globalMinIntervalMs: number
    maxAckSpeechSeconds: number
    nameMention: boolean
    screen: ((text: string) => boolean) | undefined
  }

  /** 待合并队列（内存态；断线由 ledger 重放重建，账本是真相源） */
  private queue: AckGiftInput[] = []
  private lastAckAtMs = 0

  constructor(
    db: DB,
    opts: {
      viewerMergeWindowMs?: number
      globalMinIntervalMs?: number
      maxAckSpeechSeconds?: number
      nameMention?: boolean
      screen?: (text: string) => boolean
      clockMs?: () => number
    } = {},
  ) {
    this.db = db
    this.clockMs = opts.clockMs ?? Date.now
    this.opts = {
      viewerMergeWindowMs: opts.viewerMergeWindowMs ?? 30_000,
      globalMinIntervalMs: opts.globalMinIntervalMs ?? 10_000,
      maxAckSpeechSeconds: opts.maxAckSpeechSeconds ?? 6,
      nameMention: opts.nameMention ?? true,
      screen: opts.screen,
    }
  }

  /** 新礼物入队（只对已入账且非退款的条目）。 */
  enqueue(input: AckGiftInput): void {
    this.queue.push(input)
  }

  /**
   * 冲洗队列：按观众合并窗口分组生成待播答谢；全场最小间隔排队；
   * 窗口未满的观众留在队列等待。返回本次生成的待播答谢。
   */
  flush(nowMs?: number): readonly PendingAck[] {
    const now = nowMs ?? this.clockMs()
    const ready = this.queue.filter(
      (g) => now - g.receivedAtMs >= this.opts.viewerMergeWindowMs,
    )
    this.queue = this.queue.filter((g) => now - g.receivedAtMs < this.opts.viewerMergeWindowMs)
    if (ready.length === 0) return []

    const byViewer = new Map<string, AckGiftInput[]>()
    for (const g of ready) {
      const list = byViewer.get(g.viewerKey) ?? []
      list.push(g)
      byViewer.set(g.viewerKey, list)
    }

    const outbox: PendingAck[] = []
    let earliest = Math.max(now, this.lastAckAtMs + this.opts.globalMinIntervalMs)
    for (const [viewerKey, gifts] of byViewer) {
      const nickname = gifts.find((g) => g.nickname !== undefined)?.nickname
      const text = this.buildPhrase(nickname, gifts)
      const ackId = `ack_${randomUUID().slice(0, 12)}`
      run(
        this.db,
        `INSERT INTO gift_ack (ack_id, viewer_key, merged_entry_ids, speech_seconds, state)
         VALUES (?, ?, ?, ?, 'pending')`,
        ackId,
        viewerKey,
        JSON.stringify(gifts.map((g) => g.entryId)),
        this.opts.maxAckSpeechSeconds,
      )
      outbox.push({
        ackId,
        viewerKey,
        text,
        speechSeconds: this.opts.maxAckSpeechSeconds,
        earliestAtMs: earliest,
      })
      earliest += this.opts.globalMinIntervalMs
    }
    this.lastAckAtMs = outbox.length > 0 ? outbox[outbox.length - 1]?.earliestAtMs ?? now : now
    return outbox
  }

  /** 播出回执（TTS 实际播出后调用）。 */
  markPlayed(ackId: string): void {
    run(
      this.db,
      `UPDATE gift_ack SET state = 'played', played_at = ? WHERE ack_id = ? AND state = 'pending'`,
      nowIso(),
      ackId,
    )
  }

  /** 抑制（如政策检查失败/安全场景）：不播出、不指责观众。 */
  suppress(ackId: string): void {
    run(this.db, `UPDATE gift_ack SET state = 'suppressed' WHERE ack_id = ? AND state = 'pending'`, ackId)
  }

  pendingAckCount(): number {
    const row = get<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM gift_ack WHERE state = 'pending'`)
    return row?.n ?? 0
  }

  /** 本地模板短语；危险昵称不点名（screen 判定），退款不走本方法（不播报）。 */
  private buildPhrase(nickname: string | undefined, gifts: readonly AckGiftInput[]): string {
    const giftName = gifts[0]?.giftName ?? '礼物'
    const mention =
      this.opts.nameMention &&
      nickname !== undefined &&
      (this.opts.screen === undefined || !this.opts.screen(nickname))
        ? `感谢「${nickname}」`
        : '谢谢这位朋友'
    const total = gifts.reduce((s, g) => s + 1, 0)
    return total > 1
      ? `${mention}连送的支持，先把日子过好，咱们接着种田。`
      : `${mention}送出的${giftName}，先把日子过好，咱们接着种田。`
  }
}
