/**
 * 第一次模拟开播（本机首播演练，方案 §20.2 / §24.2 的本地验收前置）。
 *
 * 与真实开播链路严格隔离：
 * - 不调用 PlatformAdapter（不连接抖音、不推流、不读平台状态）；
 * - 不切换 LiveSession 状态机（首页「直播中」语义不受影响）；
 * - 事件独立留痕在 simulation_events；感知层以 source=simulation + replay=1
 *   登记（只记录、不更新生产投影、不触发答谢/画像/训练/发布）；
 * - 不写 reply_log / gift_ledger / viewer_profiles / training_samples；
 * - 回复经真实本地优先路由取得（本地不可达时如实降级到已验证固定模板，
 *   并标注 route=fallback，不伪装成模型生成）；
 * - 未配置云端/预算禁用时不产生任何第三方付费调用。
 *
 * 语音互动：麦克风权限与识别/合成在浏览器本机完成（客户端半），
 * 本服务只接收「转写文本」按 kind=voice 留痕，录音永不上传、不入库。
 */
import { randomUUID } from 'node:crypto'
import { all, get, run, type DB } from '../storage/db.ts'
import { createEnvelope } from '../perception/envelope.ts'
import { BUILTIN_AVATARS, BUILTIN_VOICES, type SettingsStore } from '../settings/store.ts'
import { getFallbackReply } from '../adapters/fallback.ts'
import type { AnswerRoute, DurableReceipt, LiveEnvelope, ReasonCode } from '../types.ts'

export type SimulationStatus = 'idle' | 'running' | 'ended'
export type SimulationEventKind = 'danmaku' | 'voice' | 'gift' | 'system'

export interface SimulationEventView {
  readonly id: number
  readonly kind: SimulationEventKind
  readonly actor: string
  readonly text: string
  readonly replyText: string
  readonly route: string
  readonly createdAt: string
}

export interface SimulationReport {
  readonly runNo: number
  readonly isFirst: boolean
  readonly status: SimulationStatus
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly eventCount: number
  readonly voiceCount: number
  readonly routeCounts: Readonly<Partial<Record<AnswerRoute, number>>>
  readonly aiLabelText: string
  readonly avatarLabel: string
  readonly notes: readonly string[]
}

export interface SimulationState {
  readonly status: SimulationStatus
  readonly runNo: number
  readonly firstCompleted: boolean
  readonly startedAt: string | null
  readonly endedAt: string | null
  readonly persona: {
    readonly name: string
    readonly avatarId: string
    readonly aiLabelText: string
    readonly voiceId: string
    readonly voiceInteractionEnabled: boolean
    readonly theme: { readonly bg: string; readonly primary: string; readonly accent: string }
  }
  readonly catalogs: {
    readonly avatars: typeof BUILTIN_AVATARS
    readonly voices: typeof BUILTIN_VOICES
  }
  readonly events: readonly SimulationEventView[]
  readonly report: SimulationReport | null
}

export interface SimulationStepResult {
  readonly kind: SimulationEventKind
  readonly text: string
  readonly replyText: string
  readonly route: AnswerRoute
  readonly ttsText: string
  readonly latencyMs: number
}

/** 演练专用回复：绕开 DafeiyuRuntime.logReply，避免污染生产 reply_log。 */
export type SimulationAnswer = (text: string, kind: SimulationEventKind) => Promise<{
  readonly text: string
  readonly route: AnswerRoute
  readonly reasonCode?: ReasonCode
  readonly latencyMs: number
}>

export type SimulationIngest = (env: LiveEnvelope) => Promise<DurableReceipt>

interface RunRow {
  readonly run_no: number
  readonly status: 'running' | 'ended'
  readonly started_at: string
  readonly ended_at: string | null
}

interface EventRow {
  readonly id: number
  readonly run_no: number
  readonly kind: SimulationEventKind
  readonly actor: string
  readonly text: string
  readonly reply_text: string
  readonly route: string
  readonly created_at: string
}

export const SIMULATION_NOTES: readonly string[] = [
  '模拟开播在本机沙箱进行：未连接抖音、未推流、未读取平台状态，首页不会显示「直播中」',
  '云端未配置/预算禁用时不产生任何第三方付费调用；本地模型未部署时回复如实来自已验证固定模板（route=fallback），不伪装为模型生成',
  '演练事件独立留痕（simulation_events），不写生产回复、礼物账本、观众画像、训练样本或发布链',
  '感知事件以 source=simulation、replay=1 登记：只记录、不更新生产黑板投影、不触发答谢/学习动作',
  'AI 标识在桌宠窗口常显且不可关闭（§23.2）',
  '语音识别与朗读在浏览器本机完成，录音不上传；仅转写文本按模拟事件留痕',
  '本场次不计入生产灰度、发布、固化或模型晋级，也不计入当日真实直播场次',
]

/** 内置「第一次模拟开播」脚本：开场 → 弹幕 → 语音 → 礼物 → 收尾问答。
 *  开场白由 start() 写入、收尾由 stop() 写入，脚本只负责中间 4 条互动，避免重复。 */
export const FIRST_RUN_SCRIPT: readonly { kind: SimulationEventKind; actor: string; text: string }[] = [
  { kind: 'danmaku', actor: '观众·小鱼干', text: '大肥鱼今天种什么？' },
  { kind: 'voice', actor: '语音观众', text: '你好呀，能听到我说话吗？' },
  { kind: 'gift', actor: '观众·阿禾', text: '送出一个小心心' },
  { kind: 'danmaku', actor: '观众·慢慢', text: '讲讲今天的安排吧～' },
]

export class SimulationService {
  private readonly db: DB
  private readonly settings: SettingsStore
  private readonly answer: SimulationAnswer
  private readonly ingest?: SimulationIngest
  private readonly clock: () => string
  private readonly nowMs: () => number

  constructor(deps: {
    db: DB
    settings: SettingsStore
    answer: SimulationAnswer
    ingest?: SimulationIngest
    clock?: () => string
    nowMs?: () => number
  }) {
    this.db = deps.db
    this.settings = deps.settings
    this.answer = deps.answer
    if (deps.ingest !== undefined) this.ingest = deps.ingest
    this.clock = deps.clock ?? (() => new Date().toISOString())
    this.nowMs = deps.nowMs ?? (() => Date.now())
  }

  // -------------------------------------------------------------------------
  // 查询
  // -------------------------------------------------------------------------

  private latestRun(): RunRow | undefined {
    return get<RunRow>(this.db, 'SELECT * FROM simulation_runs ORDER BY run_no DESC LIMIT 1')
  }

  private runningRun(): RunRow | undefined {
    return get<RunRow>(this.db, "SELECT * FROM simulation_runs WHERE status = 'running' ORDER BY run_no DESC LIMIT 1")
  }

  private eventsFor(runNo: number): SimulationEventView[] {
    const rows = all<EventRow>(
      this.db,
      'SELECT * FROM simulation_events WHERE run_no = ? ORDER BY id DESC LIMIT 50',
      runNo,
    ).reverse()
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      actor: r.actor,
      text: r.text,
      replyText: r.reply_text,
      route: r.route,
      createdAt: r.created_at,
    }))
  }

  private buildReport(run: RunRow, events: readonly SimulationEventView[]): SimulationReport {
    const routeCounts: Partial<Record<AnswerRoute, number>> = {}
    let voiceCount = 0
    for (const e of events) {
      if (e.kind === 'voice') voiceCount++
      if (e.route === 'local_gpu' || e.route === 'local_cpu' || e.route === 'cloud' || e.route === 'fallback') {
        routeCounts[e.route] = (routeCounts[e.route] ?? 0) + 1
      }
    }
    const persona = this.settings.getPersona()
    const avatar = BUILTIN_AVATARS.find((a) => a.id === persona.avatarId)
    return {
      runNo: run.run_no,
      isFirst: run.run_no === 1,
      status: run.status === 'running' ? 'running' : 'ended',
      startedAt: run.started_at,
      endedAt: run.ended_at,
      eventCount: events.length,
      voiceCount,
      routeCounts,
      aiLabelText: persona.aiLabelText,
      avatarLabel: avatar?.label ?? persona.avatarId,
      notes: SIMULATION_NOTES,
    }
  }

  state(): SimulationState {
    const persona = this.settings.getPersona()
    const running = this.runningRun()
    const latest = this.latestRun()
    const active = running ?? latest
    const events = active === undefined ? [] : this.eventsFor(active.run_no)
    const total = get<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM simulation_runs')?.n ?? 0
    const ended = get<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM simulation_runs WHERE status = 'ended'")?.n ?? 0
    const avatar = BUILTIN_AVATARS.find((a) => a.id === persona.avatarId)
    const status: SimulationStatus = running !== undefined ? 'running' : latest !== undefined ? 'ended' : 'idle'
    return {
      status,
      runNo: total,
      firstCompleted: ended > 0,
      startedAt: active?.started_at ?? null,
      endedAt: active?.ended_at ?? null,
      persona: {
        name: persona.personaName,
        avatarId: persona.avatarId,
        aiLabelText: persona.aiLabelText,
        voiceId: persona.voiceId,
        voiceInteractionEnabled: persona.voiceInteractionEnabled,
        theme: avatar?.theme ?? { bg: '#0f3d38', primary: '#0f5e57', accent: '#ffd166' },
      },
      catalogs: { avatars: BUILTIN_AVATARS, voices: BUILTIN_VOICES },
      events,
      report: active === undefined ? null : this.buildReport(active, events),
    }
  }

  report(): SimulationReport | null {
    return this.state().report
  }

  // -------------------------------------------------------------------------
  // 场次
  // -------------------------------------------------------------------------

  /** 开始一场模拟开播（幂等：已有 running 场次直接返回，不重复开场）。 */
  async start(): Promise<SimulationState> {
    const running = this.runningRun()
    if (running === undefined) {
      const at = this.clock()
      // 显式连续序号（不依赖 AUTOINCREMENT 序列）：run_no 恒等于「第几场」，
      // 即使运维清理过历史数据，首场仍为 1，state.runNo(COUNT) 与报告 runNo 一致。
      run(
        this.db,
        `INSERT INTO simulation_runs (run_no, status, started_at)
         VALUES ((SELECT COALESCE(MAX(run_no), 0) + 1 FROM simulation_runs), 'running', ?)`,
        at,
      )
      run(this.db, `INSERT INTO audit (action, summary) VALUES ('simulation', ?)`, '模拟开播场次开始（本机沙箱，未推流）')
      const runNo = Number(get<{ n: number }>(this.db, 'SELECT MAX(run_no) AS n FROM simulation_runs')?.n ?? 0)
      await this.recordEvent(runNo, 'system', '演练系统', '第一次模拟开播开始（本机沙箱，未推流）', {
        text: this.settings.getPersona().samplePhrase,
        route: 'fallback',
        latencyMs: 0,
      })
    }
    return this.state()
  }

  /** 结束当前模拟开播（不接触平台；只置 ended 并留痕）。 */
  async stop(): Promise<SimulationState> {
    const running = this.runningRun()
    if (running !== undefined) {
      const at = this.clock()
      run(this.db, "UPDATE simulation_runs SET status = 'ended', ended_at = ? WHERE run_no = ?", at, running.run_no)
      run(this.db, `INSERT INTO audit (action, summary) VALUES ('simulation', ?)`, `模拟开播场次 ${running.run_no} 结束（未推流）`)
      await this.recordEvent(running.run_no, 'system', '演练系统', '模拟开播结束（未推流、未产生平台动作）', {
        text: '今天先聊到这儿，咱们下次接着把日子过好～',
        route: 'fallback',
        latencyMs: 0,
      })
    }
    return this.state()
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /** 投递一条模拟事件：必须有 running 场次；回复经真实本地优先路由。 */
  async emit(kind: SimulationEventKind, text: string, actor?: string): Promise<SimulationStepResult> {
    const normalized = text.trim().slice(0, 200)
    if (normalized === '') throw new SimulationError('事件文本不能为空')
    const running = this.runningRun()
    if (running === undefined) throw new SimulationError('当前没有进行中的模拟开播：请先点「第一次模拟开播」')

    const started = this.nowMs()
    let receipt: { text: string; route: AnswerRoute; reasonCode?: ReasonCode; latencyMs: number }
    try {
      receipt = await this.answer(normalized, kind)
    } catch {
      // 路由异常也不让演练中断：如实降级到已验证固定模板
      receipt = { text: getFallbackReply('generation_failed'), route: 'fallback', latencyMs: this.nowMs() - started }
    }
    const latencyMs = Math.max(receipt.latencyMs, this.nowMs() - started)

    // 本地/云端均不可用时用桌宠口吻固定模板，避免「脑子有点慢」这类不像首播的降级话术；
    // route 仍如实记为 fallback，报告里可核对，绝不伪装成模型生成。
    const usedTemplate = receipt.route === 'fallback' && (receipt.reasonCode === undefined || receipt.reasonCode !== 'POLICY_BLOCKED')
    const replyText = usedTemplate ? petPhrase(kind, normalized) : receipt.text

    await this.recordEvent(running.run_no, kind, actor ?? defaultActor(kind), normalized, {
      text: replyText,
      route: receipt.route,
      latencyMs,
    })
    return {
      kind,
      text: normalized,
      replyText,
      route: receipt.route,
      ttsText: replyText,
      latencyMs,
    }
  }

  /** 一键跑完内置首播脚本（无场次时自动开场，结束后自动收尾）。 */
  async runScript(): Promise<{ steps: SimulationStepResult[]; report: SimulationReport | null }> {
    if (this.runningRun() === undefined) await this.start()
    const steps: SimulationStepResult[] = []
    for (const s of FIRST_RUN_SCRIPT) {
      steps.push(await this.emit(s.kind, s.text, s.actor))
    }
    await this.stop()
    return { steps, report: this.report() }
  }

  /** 事件落库 + 感知层 replay 留痕（不触发生产动作）。 */
  private async recordEvent(
    runNo: number,
    kind: SimulationEventKind,
    actor: string,
    text: string,
    reply: { text: string; route: string; latencyMs: number },
  ): Promise<void> {
    const at = this.clock()
    run(
      this.db,
      `INSERT INTO simulation_events (run_no, kind, actor, text, reply_text, route, latency_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runNo,
      kind,
      actor,
      text,
      reply.text,
      reply.route,
      reply.latencyMs,
      at,
    )
    if (this.ingest !== undefined) {
      const env = createEnvelope({
        source: 'simulation',
        sourceEventId: `sim-${runNo}-${randomUUID()}`,
        roomId: 'simulation-local',
        sessionId: `sim-${runNo}`,
        occurredAt: at,
        receivedAt: at,
        type: `simulation_${kind}`,
        provenance: 'operator',
        purposeTags: ['simulation'],
        payloadRef: 'inline://simulation-event',
        replay: true,
      })
      await this.ingest(env)
    }
  }
}

export class SimulationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SimulationError'
  }
}

function defaultActor(kind: SimulationEventKind): string {
  return kind === 'voice' ? '语音观众' : kind === 'gift' ? '观众·送礼' : kind === 'system' ? '演练系统' : '观众'
}

/**
 * 桌宠口吻固定模板（随版本验证，不调模型；§4.1 固定降级回复同性质）。
 * 仅在本地/云端都不可达时启用，route 仍如实记为 fallback。
 */
function petPhrase(kind: SimulationEventKind, text: string): string {
  if (kind === 'gift') return getFallbackReply('gift_ack')
  if (kind === 'voice') {
    if (/你好|在吗|听得到|能听到/.test(text)) return '听见啦～我在桌面上陪着你，慢慢说，咱们把日子过好。'
    return '嗯嗯，我听着呢～今天先把手上的事做完，再一起慢慢聊。'
  }
  if (kind === 'system') return '大家好，我是大肥鱼，今天咱们一起把日子过好。'
  if (/种|田|菜|养/.test(text)) return '今天先种点踏实的小计划，别急，一样一样来～'
  if (/安排|今天|干嘛|做什么/.test(text)) return '安排就三条：好好吃饭、慢慢做事、有空来桌面看看我。'
  if (/累|烦|难过|emo/.test(text)) return '先歇会儿吧，日子不赶这一下，我在这儿陪你。'
  return '先把日子过好，咱们慢慢聊～'
}
