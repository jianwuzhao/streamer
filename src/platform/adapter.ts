/**
 * 平台适配契约（方案 §24.2 PlatformAdapter）。
 *
 * 每项能力通过契约测试和真实账号测试后启用；没有平台状态读取能力时
 * 明确显示「推流已建立，平台状态待确认」，保留操作员确认记录。
 * 默认抖音辅助模式：不开全自动公开直播；需官方确认。
 */
export interface PlatformCapabilities {
  readonly canPrepareScene: boolean
  readonly canStartStream: boolean
  readonly canReadLiveState: boolean
  readonly requiresOfficialConfirmation: boolean
  readonly supportsGiftEvents: boolean
  readonly supportsSettlement: boolean
  readonly allowedModes: readonly ('assisted' | 'human_driven')[]
}

export interface PlatformAdapter {
  readonly platform: string
  readonly capabilities: PlatformCapabilities
  /** 尝试连接授权通道（幂等键防重复开播） */
  connectChannel(idempotencyKey: string): Promise<{ streamEstablished: boolean; platformReceipt: boolean }>
  /** 平台直播状态回执（无读取能力 ⇒ 永远 unknown） */
  readLiveState(): Promise<'unknown' | 'live' | 'not_live'>
}

/** 抖音辅助模式（默认）：无自动开播、无状态读取——一切以官方确认为准。 */
export class DouyinAssistedAdapter implements PlatformAdapter {
  readonly platform = 'douyin'
  readonly capabilities: PlatformCapabilities = {
    canPrepareScene: true,
    canStartStream: false,
    canReadLiveState: false,
    requiresOfficialConfirmation: true,
    supportsGiftEvents: true,
    supportsSettlement: false,
    allowedModes: ['assisted'],
  }

  async connectChannel(idempotencyKey: string): Promise<{ streamEstablished: boolean; platformReceipt: boolean }> {
    // 辅助模式：本插件不推流（直播伴侣负责）；仅登记幂等键，等待官方回执
    void idempotencyKey
    return { streamEstablished: false, platformReceipt: false }
  }

  async readLiveState(): Promise<'unknown'> {
    return 'unknown' // 无状态读取能力：如实未知，不伪造
  }
}
