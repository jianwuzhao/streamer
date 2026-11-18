/**
 * 口型时间线（方案第 3 条「音频和口型时间线」）：
 *
 * - 一段已排程播放的 PCM 对应一条时间线：`turnId` + `profileId` + 采样率 +
 *   起止采样位置 + 逐帧口型权重。位置单位是「采样点数」而不是毫秒，换算是
 *   `sampleRate` 的职责——同一句话里混用两种单位会让整句口型整体偏移，
 *   而这种偏移在观感上只表现为「嘴慢半拍」，很难在测试以外被发现。
 * - 权重共 6 维：开口 `open`、闭唇 `closed`（b/p/m）、圆唇 `round`（o/u）、
 *   横展 `wide`（e/i）、露齿 `teeth`、自然微笑 `smile`。它们表达的是
 *   「该口型的强度」（0–1），不是 Live2D 参数原值；映射到 ParamMouthForm、
 *   ParamMouthOpenY 等参数的符号与缩放由渲染端负责。
 * - 求值按实际播放位置做短线性插值（连读过渡），相邻帧不跳变；闭唇权重
 *   直接压制开口——发 b/p/m 时口型必须是闭的，不能被音量或呼吸余量顶开。
 * - `source` 标明这段口型是经核验的 TTS 发音对齐（`aligned`）还是音频估计
 *   （`estimated`）。对齐没赶上播放时用估计，并在降级记录里留痕：
 *   验收与对外说明不得把估计结果当成对齐结果。
 * - `sequence` 是同一话轮内重算的顺序号；`LipTimelinePlayer` 用它拒收迟到
 *   与乱序的旧时间线，打断和紧急停止通过递增播放版本作废全部在途数据。
 *
 * 本模块是纯函数：不读时钟、不读文件、不依赖播放器与渲染器，测试直接
 * 构造采样位置，因此在 30/60/120 FPS 与不同采样率下给出同一结论。
 */

/** 口型维度（顺序稳定，便于日志与降级记录对照）。 */
export const VISEME_KEYS = ['open', 'closed', 'round', 'wide', 'teeth', 'smile'] as const
export type VisemeKey = (typeof VISEME_KEYS)[number]
export type VisemeWeights = Readonly<Record<VisemeKey, number>>

/** 单个口型帧：采样位置 + 该处的口型强度。 */
export interface LipFrame {
  /** 相对该段音频起点的采样点数（整数，非负） */
  readonly sample: number
  readonly visemes: VisemeWeights
}

/**
 * 口型来源：
 * - `aligned`：经核验的 TTS 发音时间戳或强制对齐结果；
 * - `estimated`：对齐未赶上播放时的音频估计（降级）。
 */
export type LipSource = 'aligned' | 'estimated'

export interface LipTimeline {
  /** 话轮 id：跨话轮的口型样本一律丢弃 */
  readonly turnId: string
  /** 角色档案 id：角色切换后旧时间线作废 */
  readonly profileId: string
  /** 采样率（Hz），用于采样位置 ↔ 秒的换算 */
  readonly sampleRate: number
  /** 该段音频在播放时间线上的起始采样位置（整数，≥0） */
  readonly startSample: number
  /** 结束采样位置（整数，> startSample；含端点前闭区间语义见 evaluate） */
  readonly endSample: number
  readonly source: LipSource
  /** 同一话轮内的重算顺序号（越大越新） */
  readonly sequence: number
  /** 按 sample 升序、同位置去重后的帧 */
  readonly frames: readonly LipFrame[]
}

/** 求值结果：除权重外带上来源，供渲染端与诊断区分对齐/降级。 */
export interface LipPose {
  readonly open: number
  readonly closed: number
  readonly round: number
  readonly wide: number
  readonly teeth: number
  readonly smile: number
  readonly source: LipSource
  readonly degraded: boolean
}

export type LipTimelineErrorCode =
  | 'invalid_turn'
  | 'invalid_profile'
  | 'invalid_sample_rate'
  | 'invalid_window'
  | 'invalid_frame'
  | 'too_many_frames'

export class LipTimelineError extends Error {
  public readonly code: LipTimelineErrorCode
  constructor(code: LipTimelineErrorCode, message: string) {
    super(message)
    this.name = 'LipTimelineError'
    this.code = code
  }
}

/** 单条时间线的帧上限（30 秒 @ 60fps ≈ 1800 帧；留足余量但不接受无界输入）。 */
export const LIP_MAX_FRAMES = 20_000
const ID_MAX_LENGTH = 120
const SAMPLE_RATE_MIN = 8_000
const SAMPLE_RATE_MAX = 192_000

export interface LipFrameInput {
  readonly sample: number
  readonly visemes: Partial<VisemeWeights>
}

export interface LipTimelineInput {
  readonly turnId: string
  readonly profileId: string
  readonly sampleRate: number
  readonly startSample: number
  readonly endSample: number
  readonly frames: readonly LipFrameInput[]
  /** 缺省按 estimated（降级）处理：只有明确对齐过才可声明 aligned */
  readonly source?: LipSource | undefined
  readonly sequence?: number | undefined
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function requireId(value: unknown, code: LipTimelineErrorCode, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > ID_MAX_LENGTH) {
    throw new LipTimelineError(code, `${label} 须为 1–${ID_MAX_LENGTH} 字符的非空字符串`)
  }
  return value
}

function requireInteger(value: unknown, min: number, max: number, code: LipTimelineErrorCode, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new LipTimelineError(code, `${label} 须为 ${min}–${max} 之间的整数（收到：${String(value)}）`)
  }
  return value
}

/**
 * 规范化为可安全求值的时间线：
 * - 权重一律钳到 0–1（越界不是可恢复错误，钳制后继续，避免整句被丢弃）；
 * - 帧按采样位置升序；同一位置后者覆盖前者（重算覆盖旧值）；
 * - 采样位置必须落在 [startSample, endSample] 内，越界的帧直接拒绝——
 *   静默丢弃会让口型在句子中间留下空洞。
 */
export function createLipTimeline(input: LipTimelineInput): LipTimeline {
  const turnId = requireId(input.turnId, 'invalid_turn', 'turnId')
  const profileId = requireId(input.profileId, 'invalid_profile', 'profileId')
  const sampleRate = requireInteger(input.sampleRate, SAMPLE_RATE_MIN, SAMPLE_RATE_MAX, 'invalid_sample_rate', 'sampleRate')
  const startSample = requireInteger(input.startSample, 0, Number.MAX_SAFE_INTEGER, 'invalid_window', 'startSample')
  const endSample = requireInteger(input.endSample, 0, Number.MAX_SAFE_INTEGER, 'invalid_window', 'endSample')
  if (endSample <= startSample) {
    throw new LipTimelineError('invalid_window', `endSample（${endSample}）须大于 startSample（${startSample}）`)
  }
  if (!Array.isArray(input.frames)) {
    throw new LipTimelineError('invalid_frame', 'frames 须为数组')
  }
  if (input.frames.length > LIP_MAX_FRAMES) {
    throw new LipTimelineError('too_many_frames', `口型帧超出上限（${input.frames.length} > ${LIP_MAX_FRAMES}）`)
  }
  if (input.source !== undefined && input.source !== 'aligned' && input.source !== 'estimated') {
    throw new LipTimelineError('invalid_frame', `source 须为 aligned 或 estimated（收到：${String(input.source)}）`)
  }
  const sequence = input.sequence === undefined ? 0 :
    requireInteger(input.sequence, 0, Number.MAX_SAFE_INTEGER, 'invalid_frame', 'sequence')

  const bySample = new Map<number, VisemeWeights>()
  for (const frame of input.frames) {
    if (frame === null || typeof frame !== 'object') {
      throw new LipTimelineError('invalid_frame', '口型帧须为对象')
    }
    const sample = requireInteger(frame.sample, startSample, endSample, 'invalid_frame', 'frame.sample')
    const source = frame.visemes ?? {}
    bySample.set(sample, {
      open: clamp01(source.open ?? 0),
      closed: clamp01(source.closed ?? 0),
      round: clamp01(source.round ?? 0),
      wide: clamp01(source.wide ?? 0),
      teeth: clamp01(source.teeth ?? 0),
      smile: clamp01(source.smile ?? 0),
    })
  }
  const frames = [...bySample.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([sample, visemes]) => ({ sample, visemes }))

  return {
    turnId, profileId, sampleRate, startSample, endSample,
    source: input.source ?? 'estimated',
    sequence,
    frames,
  }
}

const EMPTY_WEIGHTS: VisemeWeights = { open: 0, closed: 0, round: 0, wide: 0, teeth: 0, smile: 0 }

/** 二分定位 sample 左侧最近的帧下标（无则 -1）。 */
function floorIndex(frames: readonly LipFrame[], sample: number): number {
  let low = 0
  let high = frames.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    const probe = frames[middle]
    if (probe === undefined) break
    if (probe.sample <= sample) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

function mixWeights(left: VisemeWeights, right: VisemeWeights, ratio: number): VisemeWeights {
  const blend = (a: number, b: number) => a + (b - a) * ratio
  return {
    open: blend(left.open, right.open),
    closed: blend(left.closed, right.closed),
    round: blend(left.round, right.round),
    wide: blend(left.wide, right.wide),
    teeth: blend(left.teeth, right.teeth),
    smile: blend(left.smile, right.smile),
  }
}

/**
 * 闭唇优先于音量与呼吸余量：发 b/p/m 时开口必须是 0。
 *
 * 渲染端在短暂段落停顿里有约 15% 的「余量开口」，那是为了避免机械收口；
 * 但遇到闭唇音节时该余量必须让位，否则画面会出现「闭着音还在张嘴」。
 * 因此这里按闭唇强度线性压制开口，强度到 1 时开口归零。
 */
export function applyClosedOverride(opening: number, closed: number): number {
  return clamp01(opening) * (1 - clamp01(closed))
}

/**
 * 按播放位置求值（短线性插值）。位置落在 [startSample, endSample] 之外返回
 * null——调用方据此丢弃过期或尚未开始的样本，而不是把边缘帧无限延长。
 */
export function evaluateLipTimeline(timeline: LipTimeline, sample: number): LipPose | null {
  if (!Number.isFinite(sample)) return null
  if (sample < timeline.startSample || sample > timeline.endSample) return null
  const frames = timeline.frames
  const degraded = timeline.source !== 'aligned'
  if (frames.length === 0) {
    return { ...EMPTY_WEIGHTS, source: timeline.source, degraded }
  }
  const index = floorIndex(frames, sample)
  const before = index >= 0 ? frames[index] : undefined
  const after = frames[index + 1]
  let weights: VisemeWeights
  if (before === undefined) {
    // 首帧之前：保持首帧，不做外推（外推会把首音口型推到画面之外）。
    weights = after?.visemes ?? EMPTY_WEIGHTS
  } else if (after === undefined) {
    weights = before.visemes
  } else {
    const span = after.sample - before.sample
    weights = span <= 0 ? before.visemes : mixWeights(before.visemes, after.visemes, (sample - before.sample) / span)
  }
  return {
    open: applyClosedOverride(weights.open, weights.closed),
    closed: weights.closed,
    round: weights.round,
    wide: weights.wide,
    teeth: weights.teeth,
    smile: weights.smile,
    source: timeline.source,
    degraded,
  }
}

export interface LipPlayerStats {
  /** 已接受的时间线段数 */
  readonly applied: number
  /** 被拒收的时间线（旧顺序号/过期/角色不符） */
  readonly rejected: number
  /** 其中以音频估计代替对齐的段数（降级留痕） */
  readonly degraded: number
  /** 当前播放版本；打断与紧急停止时递增 */
  readonly playbackVersion: number
}

/**
 * 播出侧的口型时间线持有者：
 * - 同一话轮内只接受顺序号更大的时间线（后到的旧值直接丢弃）；
 * - 换话轮或换角色时替换，并在求值时校验调用方期望的话轮，跨话轮样本一律丢；
 * - 打断/紧急停止递增播放版本，此前装载的时间线全部作废，
 *   防止迟到帧把上一句的口型恢复回来。
 */
export class LipTimelinePlayer {
  private active: LipTimeline | undefined
  private version = 0
  private applied = 0
  private rejected = 0
  private degraded = 0

  get playbackVersion(): number {
    return this.version
  }

  get timeline(): LipTimeline | undefined {
    return this.active
  }

  /** 装载一段口型；返回 false 表示拒收（旧顺序号、已过期、或缺失话轮）。 */
  load(timeline: LipTimeline, sample?: number): boolean {
    const active = this.active
    if (active !== undefined && active.turnId === timeline.turnId) {
      if (timeline.sequence <= active.sequence) {
        this.rejected += 1
        return false
      }
      if (active.profileId !== timeline.profileId) {
        this.rejected += 1
        return false
      }
    }
    if (sample !== undefined && (sample < timeline.startSample || sample > timeline.endSample)) {
      this.rejected += 1
      return false
    }
    this.active = timeline
    this.applied += 1
    if (timeline.source !== 'aligned') this.degraded += 1
    return true
  }

  /** 按播放位置求值；expectedTurnId 不匹配时返回 null（跨话轮样本丢弃）。 */
  evaluate(sample: number, expectedTurnId?: string): LipPose | null {
    const active = this.active
    if (active === undefined) return null
    if (expectedTurnId !== undefined && active.turnId !== expectedTurnId) return null
    return evaluateLipTimeline(active, sample)
  }

  /** 播放位置是否已越过当前段末尾（该收口并释放）。 */
  isExpired(sample: number): boolean {
    const active = this.active
    return active === undefined ? false : sample > active.endSample
  }

  /** 打断/紧急停止：作废当前段并递增播放版本。 */
  interrupt(): number {
    this.active = undefined
    this.version += 1
    return this.version
  }

  stats(): LipPlayerStats {
    return { applied: this.applied, rejected: this.rejected, degraded: this.degraded, playbackVersion: this.version }
  }
}

export interface FirstAudioMarks {
  /** 观众输入结束（或本机语音输入停止）的时刻，ms 时间戳 */
  readonly inputEndAt: number
  /** 回复审核完成、进入播出队列的时刻 */
  readonly reviewDoneAt?: number | undefined
  /** 收到首段 PCM 的时刻 */
  readonly firstPcmAt?: number | undefined
  /** 实际听到首音（输出设备开始播放）的时刻 */
  readonly firstAudibleAt?: number | undefined
}

export interface FirstAudioBudget {
  /** 输入结束 → 审核完成 */
  readonly reviewMs: number | null
  /** 输入结束 → 首段 PCM */
  readonly pcmMs: number | null
  /** 输入结束 → 实际首音；未测到时为 null */
  readonly audibleMs: number | null
  /** 是否落在项目目标区间（首音 1–2 秒）；未测到时为 null */
  readonly withinTarget: boolean | null
}

const TARGET_MIN_MS = 1_000
const TARGET_MAX_MS = 2_000

/**
 * 首音预算：方案第 2 阶段的验收要求分别记录「提问结束 → 审核完成 →
 * 收到首段 PCM → 实际首音」三段耗时，目标 1–2 秒。对齐额外等待（等发音
 * 时间戳）也计入这里，不能从账上抹掉。
 */
export function measureFirstAudio(marks: FirstAudioMarks): FirstAudioBudget {
  const base = marks.inputEndAt
  if (!Number.isFinite(base)) {
    return { reviewMs: null, pcmMs: null, audibleMs: null, withinTarget: null }
  }
  const span = (at: number | undefined): number | null => {
    if (at === undefined || !Number.isFinite(at) || at < base) return null
    return at - base
  }
  const audibleMs = span(marks.firstAudibleAt)
  return {
    reviewMs: span(marks.reviewDoneAt),
    pcmMs: span(marks.firstPcmAt),
    audibleMs,
    withinTarget: audibleMs === null ? null : audibleMs >= TARGET_MIN_MS && audibleMs <= TARGET_MAX_MS,
  }
}
