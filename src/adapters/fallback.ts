/**
 * 已验证固定降级回复（方案 §4.1「固定降级回复」/ §10.2 礼物答谢示例）。
 *
 * 这些短语随发布版本验证，不经模型生成；本地与云端全部失败、政策阻断、
 * 需要澄清时使用。禁止为每份礼物调用云端模型生成答谢（§10.2）。
 */
export type FallbackScenario =
  | 'policy_blocked'
  | 'generation_failed'
  | 'need_clarification'
  | 'gift_ack'
  | 'local_unavailable'

const FALLBACK_REPLIES: Readonly<Record<FallbackScenario, string>> = {
  policy_blocked: '这个话题我接不了，咱们聊点别的吧～',
  generation_failed: '刚刚没想好怎么说，稍等我一下～',
  need_clarification: '我没完全听清，再说一遍好不好？',
  // 方案 §10.2 示例答谢
  gift_ack: '谢谢这份支持，先把日子过好，咱们接着种田。',
  local_unavailable: '我现在脑子有点慢，先听大家聊～',
}

export function getFallbackReply(scenario: FallbackScenario): string {
  return FALLBACK_REPLIES[scenario]
}

export const ALL_FALLBACK_SCENARIOS = Object.keys(FALLBACK_REPLIES) as readonly FallbackScenario[]
