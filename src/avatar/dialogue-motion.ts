/**
 * 对话动作事件（方案第 4 条「动作与打断」）：
 *
 * 现有 `createAvatarMotion`（client/client.js）已经负责眨眼、呼吸与缓动，
 * 但它只有「倾听 / 说话 / 空闲 / 安全」四种粗状态，倾听因此容易显得在待机。
 * 本模块补的是**阶段语义**：把「收到弹幕 → 开始思考 → 回复起止 → 收尾」
 * 这一串事件翻译成 2D 模型的姿态参数（视线、头肩、点头、眉眼），
 * 让动作由对话事件触发，眨眼和呼吸只做自然补充。
 *
 * 约束（照方案执行）：
 * - 同一次互动里连发弹幕要合并，限制重触发频率，避免一次刷屏把角色
 *   变成不停点头的机器；
 * - 说话期间**不**用动作抢占口型：说话时视线与头肩只做小幅延续，
 *   不得与口型逐音节打架（口型由 lip-timeline 驱动）；
 * - 切角色、打断、紧急停止一律 `interrupt()`，姿态立刻回到安全中性位置，
 *   并递增版本号让渲染端丢弃在途的旧动作；
 * - 参数是「目标值 + 到达方式」，渲染端仍按自己的帧率插值，因此本模块
 *   不依赖时钟，只依赖事件顺序。
 *
 * 本模块是纯函数状态机：不读系统时钟（时间由调用方传 `at`），不碰 DOM、
 * 不碰播放器，可在 Node 测试里直接驱动。
 */

/** 对话阶段（方案第 4 条的四个阶段 + 中断）。 */
export const DIALOGUE_PHASES = ['listening', 'thinking', 'speaking', 'closing', 'safe'] as const
export type DialoguePhase = (typeof DIALOGUE_PHASES)[number]

/** 触发动作的输入事件。 */
export const DIALOGUE_EVENTS = [
  'danmaku',        // 收到弹幕：短暂把视线移到互动区
  'reaction',       // 点赞等轻互动：抬眉、轻点头
  'input-start',    // 观众开始语音输入：点头候选
  'input-pause',    // 输入停顿：点头候选（与 input-start 共享限频）
  'think',          // 等待回复：逐步转入思考
  'speak',          // 实际首音开始
  'tail',           // 尾音结束：收口并返回倾听
  'interrupt',      // 打断：回到倾听并清空在途动作
  'safe',           // 紧急停止：安全中性姿态
  'resume',         // 从安全画面恢复本地预览
] as const
export type DialogueEvent = (typeof DIALOGUE_EVENTS)[number]

/** 姿态参数目标值；渲染端按自己的帧率插值到这些值。 */
export interface MotionTargets {
  /** 视线横向（-1 左 … 1 右） */
  readonly gazeX: number
  /** 视线纵向（-1 上 … 1 下） */
  readonly gazeY: number
  /** 头部左右摆动（-1 … 1） */
  readonly sway: number
  /** 点头幅度（0 … 1） */
  readonly nod: number
  /** 眉毛抬升（-1 … 1） */
  readonly brow: number
  /** 头部倾斜（-1 … 1）；思考时轻微侧头 */
  readonly tilt: number
  /** 该姿态的过渡时长（ms）：思考慢、点头快 */
  readonly blendMs: number
}

export const NEUTRAL_TARGETS: MotionTargets = {
  gazeX: 0, gazeY: 0, sway: 0, nod: 0, brow: 0, tilt: 0, blendMs: 320,
}

export interface DialogueMotionOptions {
  /** 同一类动作的最小重触发间隔（ms）；连发弹幕合并靠它 */
  readonly retriggerMs?: number
  /** 连发合并窗口（ms）：窗口内的弹幕只算一次 */
  readonly mergeWindowMs?: number
  /** 思考态转入耗时（ms） */
  readonly thinkBlendMs?: number
  /** 点头过渡时长（ms） */
  readonly nodBlendMs?: number
}

const DEFAULT_RETRIGGER_MS = 1_800
const DEFAULT_MERGE_WINDOW_MS = 700
const DEFAULT_THINK_BLEND_MS = 900
const DEFAULT_NOD_BLEND_MS = 260

export interface DialogueMotionStats {
  /** 实际生效的事件数 */
  readonly applied: number
  /** 因限频/合并被吞掉的事件数 */
  readonly coalesced: number
  /** 被拒收的事件（当前阶段不允许） */
  readonly rejected: number
  /** 打断次数（切角色/打断/紧急停止） */
  readonly interruptions: number
  readonly version: number
}

/**
 * 对话动作状态机。
 *
 * 用法：`apply(event, at)` 返回当前目标姿态；`interrupt()` 丢弃在途动作。
 * 调用方（渲染端 / 播出窗口）读取 `targets` 与 `version`，
 * 版本变化时放弃上一个插值过程，避免旧动作把新阶段覆盖回去。
 */
export class DialogueMotion {
  private readonly retriggerMs: number
  private readonly mergeWindowMs: number
  private readonly thinkBlendMs: number
  private readonly nodBlendMs: number
  private phase: DialoguePhase = 'listening'
  private current: MotionTargets = NEUTRAL_TARGETS
  private version = 0
  private applied = 0
  private coalesced = 0
  private rejected = 0
  private interruptions = 0
  private lastInteractAt = Number.NEGATIVE_INFINITY
  private lastNodAt = Number.NEGATIVE_INFINITY
  private lastEventAt = Number.NEGATIVE_INFINITY
  /** 互动区视线偏移的偶发方向：交替左右，避免每次都往同一边看 */
  private interactSide = 1

  constructor(options: DialogueMotionOptions = {}) {
    this.retriggerMs = Math.max(0, options.retriggerMs ?? DEFAULT_RETRIGGER_MS)
    this.mergeWindowMs = Math.max(0, options.mergeWindowMs ?? DEFAULT_MERGE_WINDOW_MS)
    this.thinkBlendMs = Math.max(0, options.thinkBlendMs ?? DEFAULT_THINK_BLEND_MS)
    this.nodBlendMs = Math.max(0, options.nodBlendMs ?? DEFAULT_NOD_BLEND_MS)
  }

  get currentPhase(): DialoguePhase {
    return this.phase
  }

  get targets(): MotionTargets {
    return this.current
  }

  get currentVersion(): number {
    return this.version
  }

  /**
   * 应用一个事件并给出新的目标姿态。
   *
   * @param at 事件发生的毫秒时间戳（由调用方的单调时钟给出）
   * @returns 新的目标姿态；事件被合并或拒收时返回当前姿态（引用同一对象）
   */
  apply(event: DialogueEvent, at: number): MotionTargets {
    if (!Number.isFinite(at)) return this.current
    // 时间倒退说明调用方时钟异常：按「更晚」处理，宁可多触发一次也不冻住动作
    const now = at < this.lastEventAt ? this.lastEventAt : at
    this.lastEventAt = now
    switch (event) {
      case 'danmaku':
        return this.interact(now, 0.42, -0.16, 0.09)
      case 'reaction':
        return this.interact(now, 0.15, 0.18, 0.06, true)
      case 'input-start':
      case 'input-pause':
        return this.nodCandidate(now, 0.72, -0.1)
      case 'think':
        return this.enterThinking(now)
      case 'speak':
        return this.enterSpeaking()
      case 'tail':
        return this.enterClosing()
      case 'interrupt':
        return this.interruptPhase('listening', now)
      case 'safe':
        return this.enterSafe()
      case 'resume':
        return this.resume(now)
      default:
        return this.current
    }
  }

  /** 打断：清空在途动作、递增版本、回到倾听中性。切角色/紧急停止同样走这里。 */
  interrupt(at = this.lastEventAt): MotionTargets {
    return this.interruptPhase('listening', at)
  }

  stats(): DialogueMotionStats {
    return {
      applied: this.applied, coalesced: this.coalesced, rejected: this.rejected,
      interruptions: this.interruptions, version: this.version,
    }
  }

  /** 收到弹幕：视线短暂移向互动区（左右交替），合并窗口内只算一次。 */
  private interact(now: number, nod: number, brow: number, tilt: number, reaction = false): MotionTargets {
    if (now - this.lastInteractAt < this.mergeWindowMs) {
      this.coalesced += 1
      return this.current
    }
    if (now - this.lastInteractAt < this.retriggerMs) {
      this.coalesced += 1
      return this.current
    }
    if (this.phase === 'safe') {
      this.rejected += 1
      return this.current
    }
    this.lastInteractAt = now
    this.interactSide = -this.interactSide
    this.phase = this.phase === 'speaking' ? 'speaking' : 'listening'
    this.applied += 1
    // 说话期间不允许视线大幅移动：只做很小的偏移，避免与口型抢注意力
    const scale = this.phase === 'speaking' ? 0.35 : 1
    return this.commit({
      gazeX: this.interactSide * 0.34 * scale,
      gazeY: -0.12 * scale,
      sway: this.interactSide * 0.08 * scale,
      nod: reaction ? nod * scale : Math.min(this.current.nod, nod * scale),
      brow: brow * scale,
      tilt: this.interactSide * tilt * scale,
      blendMs: 420,
    })
  }

  /** 点头候选：input-start / input-pause 共享限频；说话期间不点头。 */
  private nodCandidate(now: number, nod: number, brow: number): MotionTargets {
    if (this.phase === 'speaking') {
      this.rejected += 1
      return this.current
    }
    if (now - this.lastNodAt < this.retriggerMs) {
      this.coalesced += 1
      return this.current
    }
    this.lastNodAt = now
    this.applied += 1
    return this.commit({
      gazeX: this.current.gazeX * 0.5, gazeY: 0,
      sway: 0, nod, brow, tilt: 0, blendMs: this.nodBlendMs,
    })
  }

  /** 等待回复：逐步转入思考（侧头 + 视线偏上 + 轻微皱眉）。 */
  private enterThinking(now: number): MotionTargets {
    if (this.phase === 'safe') {
      this.rejected += 1
      return this.current
    }
    if (this.phase === 'thinking') {
      this.coalesced += 1
      return this.current
    }
    this.phase = 'thinking'
    this.applied += 1
    return this.commit({
      gazeX: 0.18, gazeY: -0.2, sway: 0.05, nod: 0,
      brow: -0.18, tilt: 0.12, blendMs: this.thinkBlendMs,
    })
  }

  /** 实际首音：切到说话。说话期间姿态收敛到很小的范围，让口型成为主角。 */
  private enterSpeaking(): MotionTargets {
    if (this.phase === 'safe') {
      this.rejected += 1
      return this.current
    }
    if (this.phase === 'speaking') {
      this.coalesced += 1
      return this.current
    }
    this.phase = 'speaking'
    this.applied += 1
    return this.commit({
      gazeX: this.current.gazeX * 0.4, gazeY: 0,
      sway: this.current.sway * 0.4, nod: 0,
      brow: 0.04, tilt: this.current.tilt * 0.4, blendMs: 280,
    })
  }

  /** 尾音结束：收口并返回倾听（点头一次作为「我听到了」的收束）。 */
  private enterClosing(): MotionTargets {
    if (this.phase === 'safe') {
      this.rejected += 1
      return this.current
    }
    this.phase = 'closing'
    this.applied += 1
    return this.commit({
      gazeX: this.current.gazeX * 0.3, gazeY: 0.05,
      sway: 0, nod: 0.16, brow: 0.1, tilt: 0, blendMs: 520,
    })
  }

  /** 紧急停止：中性姿态 + 暂停一切对话动作。 */
  private enterSafe(): MotionTargets {
    this.phase = 'safe'
    this.applied += 1
    this.version += 1
    this.current = NEUTRAL_TARGETS
    return this.current
  }

  /** 从安全画面恢复：回到倾听，但保持版本递增（旧在途动作仍然作废）。 */
  private resume(now: number): MotionTargets {
    if (this.phase !== 'safe') {
      this.coalesced += 1
      return this.current
    }
    this.phase = 'listening'
    this.lastInteractAt = Number.NEGATIVE_INFINITY
    this.lastNodAt = Number.NEGATIVE_INFINITY
    this.applied += 1
    this.version += 1
    return this.commit({ ...NEUTRAL_TARGETS, blendMs: 260 })
  }

  private interruptPhase(phase: DialoguePhase, _at: number): MotionTargets {
    this.phase = phase
    this.interruptions += 1
    this.version += 1
    this.lastNodAt = Number.NEGATIVE_INFINITY
    this.applied += 1
    this.current = NEUTRAL_TARGETS
    return this.current
  }

  /** 写入目标姿态并递增版本（版本变化 = 渲染端应重新开始插值）。 */
  private commit(targets: MotionTargets): MotionTargets {
    this.current = targets
    this.version += 1
    return this.current
  }
}

/**
 * 把对话动作参数与既有口型/呼吸姿态合成为渲染端输入。
 *
 * 保持 `createAvatarMotion` 的输入契约不变（它已经处理眨眼、呼吸、口型
 * 平滑与「减少动态」），这里只把动作目标折算成它认识的 sway/nod/gaze，
 * 遇到安全态或减少动态时一律交还给原逻辑。
 */
export interface BlendInput {
  readonly reducedMotion?: boolean | undefined
  readonly safe?: boolean | undefined
  readonly speaking?: boolean | undefined
}

export function blendMotionTargets(targets: MotionTargets, input: BlendInput = {}): {
  readonly swing: number
  readonly nod: number
  readonly gaze: number
  readonly brow: number
} {
  if (input.reducedMotion === true || input.safe === true) {
    return { swing: 0, nod: 0, gaze: 0, brow: 0 }
  }
  // 说话期间动作权重压低：口型与表情才是观众在看的东西
  const weight = input.speaking === true ? 0.45 : 1
  return {
    swing: clampSigned(targets.sway + targets.tilt * 0.5) * weight,
    nod: clamp01(targets.nod) * weight,
    gaze: clampSigned(targets.gazeX) * weight,
    brow: clampSigned(targets.brow) * weight,
  }
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function clampSigned(value: number): number {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0
}
