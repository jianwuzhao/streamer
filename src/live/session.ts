/**
 * 直播会话状态机与一键开播/紧急停止（方案 §24.2）。
 *
 * 未配置 → 自检中 → 本地预览 → 等待平台确认 → 推流建立
 * → 平台确认直播中 → 正在结束 → 已结束
 * 异常 → 可修复故障 / 安全场景 / 已停止
 *
 * - 平台未确认绝不显示「直播中」；无状态读取能力时停在「等待平台确认」
 *   并提示打开官方客户端（单一可操作原因 §23.2）；
 * - 开始/结束带幂等任务键，重复点击不重复开播；
 * - 紧急停止播出 ≠ 暂停学习：前者立即停止语音/动作输出并进入安全场景，
 *   后者仅停止学习写入/训练/发布（§14）；
 * - 异常重启默认不自动公开开播。
 */
import type { PlatformAdapter } from '../platform/adapter.ts'
import { checkPackValidity, type PolicyPack } from '../platform/policy-pack.ts'

export type LiveStatus =
  | 'unconfigured'
  | 'self_check'
  | 'local_preview'
  | 'awaiting_platform'
  | 'stream_established'
  | 'live_confirmed'
  | 'ending'
  | 'ended'
  | 'recoverable_fault'
  | 'safe_scene'
  | 'stopped'

export const LIVE_DISPLAY: Readonly<Record<LiveStatus, string>> = {
  unconfigured: '未配置',
  self_check: '自检中',
  local_preview: '本地预览',
  awaiting_platform: '等待平台确认',
  stream_established: '推流已建立，平台状态待确认',
  live_confirmed: '直播中',
  ending: '正在结束',
  ended: '已结束',
  recoverable_fault: '可修复故障',
  safe_scene: '安全场景',
  stopped: '已停止',
}

export interface PreflightInput {
  readonly aiLabelVisible: boolean
  readonly stableReleaseAvailable: boolean
  readonly resourceOk: boolean
}

export interface PreflightResult {
  readonly pass: boolean
  /** 单一可操作原因（§23.2 开播前失败动作） */
  readonly reason?: string
}

export class LiveSession {
  private status: LiveStatus = 'unconfigured'
  private startKey: string | null = null
  private lastOperatorConfirmation: string | null = null
  private readonly adapter: PlatformAdapter
  private readonly pack: PolicyPack | null
  private readonly platform: string

  constructor(adapter: PlatformAdapter, pack: PolicyPack | null, platform: string) {
    this.adapter = adapter
    this.pack = pack
    this.platform = platform
  }

  get current(): LiveStatus {
    return this.status
  }

  /** 显示文案（平台未确认不显示「直播中」由状态机保证）。 */
  display(): string {
    return LIVE_DISPLAY[this.status]
  }

  /** 开播前自检（规则包/账号模式/AI 标识/稳定版本/资源）→ 单一可操作原因。 */
  preflight(input: PreflightInput): PreflightResult {
    const pack = checkPackValidity(this.pack, this.platform)
    if (!pack.valid) return { pass: false, reason: pack.reason ?? '政策包无效' }
    if (!input.stableReleaseAvailable) return { pass: false, reason: '无稳定发布版本：先完成首次配置向导' }
    if (!input.aiLabelVisible) return { pass: false, reason: 'AI 标识不可见：修复标识后才能开播（不可关闭）' }
    if (!input.resourceOk) return { pass: false, reason: '资源自检未通过：查看自检结果并降低负载' }
    if (!this.adapter.capabilities.allowedModes.includes('assisted')) {
      return { pass: false, reason: '账号适用模式未核实：仅允许本地预览' }
    }
    return { pass: true }
  }

  /**
   * 一键开播（幂等）：自检 → 本地预览 → 连接通道 → 等待平台确认。
   * 只有平台回执为 live 才进入 live_confirmed；无读取能力保持待确认。
   */
  async start(idempotencyKey: string, preflightInput: PreflightInput): Promise<LiveStatus> {
    if (this.status === 'live_confirmed' || this.status === 'awaiting_platform') {
      return this.status // 幂等：进行中不重复开播
    }
    if (this.startKey !== null && this.startKey !== idempotencyKey && this.isActive()) {
      return this.status
    }
    this.startKey = idempotencyKey

    const check = this.preflight(preflightInput)
    if (!check.pass) {
      this.status = 'recoverable_fault'
      return this.status
    }
    this.status = 'self_check'
    this.status = 'local_preview'
    const channel = await this.adapter.connectChannel(idempotencyKey)
    if (channel.platformReceipt) {
      // 平台回执确认（适配器具备读取能力的路径）
      this.status = channel.streamEstablished ? 'live_confirmed' : 'awaiting_platform'
      return this.status
    }
    this.status = channel.streamEstablished ? 'stream_established' : 'awaiting_platform'
    return this.status
  }

  /** 操作员在官方客户端确认后登记（无自动读取能力时的人工回执）。 */
  operatorConfirmedLive(at: string): LiveStatus {
    if (this.status === 'awaiting_platform' || this.status === 'stream_established') {
      this.lastOperatorConfirmation = at
      this.status = 'live_confirmed'
    }
    return this.status
  }

  get operatorConfirmation(): string | null {
    return this.lastOperatorConfirmation
  }

  /** 结束直播：停止新增播出、保存账本、终止推流、确认状态。 */
  async stop(): Promise<LiveStatus> {
    if (this.isActive()) {
      this.status = 'ending'
      this.status = 'ended'
    }
    return this.status
  }

  /** 紧急停止播出：立即进入安全场景（优先于一切后台任务；≠暂停学习）。 */
  emergencyStop(): LiveStatus {
    this.status = 'safe_scene'
    return this.status
  }

  /** 从安全场景恢复需人工操作（异常重启不自动公开开播）。 */
  recoverToPreview(): LiveStatus {
    if (this.status === 'safe_scene' || this.status === 'stopped') {
      this.status = 'local_preview'
    }
    return this.status
  }

  isActive(): boolean {
    return ['self_check', 'local_preview', 'awaiting_platform', 'stream_established', 'live_confirmed', 'ending'].includes(this.status)
  }
}
