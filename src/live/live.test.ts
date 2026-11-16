import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  DouyinAssistedAdapter,
  type PlatformAdapter,
  type PlatformCapabilities,
} from '../platform/adapter.ts'
import { checkPackValidity, loadPolicyPack } from '../platform/policy-pack.ts'
import { LiveSession } from './session.ts'

const PACK_PATH = resolve(process.cwd(), 'policy-packs/douyin/rules.json')

const okPreflight = {
  aiLabelVisible: true,
  stableReleaseAvailable: true,
  resourceOk: true,
  personaConfigured: true,
  platformConfigured: true,
}

type ConnectResult = { streamEstablished: boolean; platformReceipt: boolean }

const deferredCapabilities: PlatformCapabilities = {
  canPrepareScene: true,
  canStartStream: false,
  canReadLiveState: false,
  requiresOfficialConfirmation: true,
  supportsGiftEvents: false,
  supportsSettlement: false,
  allowedModes: ['assisted'],
}

/** 可手动放行的适配器：让 connectChannel 挂起，确定性地复现等待期间的停止竞争。 */
class DeferredAdapter implements PlatformAdapter {
  readonly platform = 'douyin'
  readonly capabilities = deferredCapabilities
  private readonly pending: Array<(result: ConnectResult) => void> = []

  connectChannel(_idempotencyKey: string): Promise<ConnectResult> {
    return new Promise((resolve) => {
      this.pending.push(resolve)
    })
  }

  async readLiveState(): Promise<'unknown'> {
    return 'unknown'
  }

  /** 放行最早一次挂起的连接（默认与辅助模式一致：未建立推流、无平台回执）。 */
  releaseConnect(result: ConnectResult = { streamEstablished: false, platformReceipt: false }): void {
    this.pending.shift()?.(result)
  }

  get pendingCount(): number {
    return this.pending.length
  }
}

test('规则包：加载/字段校验/哈希通过；缺失或平台不符 ⇒ 开播前单一原因', () => {
  const pack = loadPolicyPack(PACK_PATH)
  assert.ok(pack.rules.length >= 4)
  assert.equal(checkPackValidity(pack, 'douyin').valid, true)
  assert.equal(checkPackValidity(null, 'douyin').valid, false)
  assert.ok(!checkPackValidity(pack, 'kuaishou').valid)
})

test('开播链：未确认绝不显示直播中；无读取能力停在等待平台确认并给官方入口提示', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  assert.equal(session.display(), '未配置')
  const status = await session.start('task-1', okPreflight)
  assert.equal(status, 'awaiting_platform')
  assert.equal(session.display(), '等待平台确认')
  // 幂等：重复点击不重复开播
  assert.equal(await session.start('task-1', okPreflight), 'awaiting_platform')
  // 操作员官方确认后才显示直播中（并留确认记录）
  session.operatorConfirmedLive('2026-11-11T20:00:00Z')
  assert.equal(session.display(), '直播中')
  assert.equal(session.operatorConfirmation, '2026-11-11T20:00:00Z')
  // 结束
  assert.equal(await session.stop(), 'ended')
})

test('开播自检失败：单一可操作原因（AI 标识不可关闭）', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  const check = session.preflight({ ...okPreflight, aiLabelVisible: false })
  assert.equal(check.pass, false)
  assert.ok(check.reason?.includes('AI 标识'))
  const status = await session.start('task-2', { ...okPreflight, aiLabelVisible: false })
  assert.equal(status, 'recoverable_fault')
})

test('紧急停止 ≠ 暂停：立即安全场景；恢复预览需人工', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  await session.start('task-3', okPreflight)
  assert.equal(session.emergencyStop(), 'safe_scene')
  assert.equal(session.display(), '安全场景')
  assert.equal(session.recoverToPreview(), 'local_preview')
})

test('政策包缺规则：开播被阻断（fail-closed）', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), null, 'douyin')
  const status = await session.start('task-4', okPreflight)
  assert.equal(status, 'recoverable_fault')
  const check = session.preflight(okPreflight)
  assert.ok(check.reason?.includes('政策包缺失'))
})

test('预览门：形象未配置拒绝进入并给单一原因；就绪进入本地预览、退出回已停止', () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  const denied = session.enterPreview({ ready: false, reason: '主播形象未配置：在「角色档案」中选择角色并确认使用授权' })
  assert.equal(denied.ok, false)
  assert.equal(denied.status, 'unconfigured')
  assert.ok(denied.reason?.includes('主播形象未配置'))
  const entered = session.enterPreview({ ready: true })
  assert.equal(entered.ok, true)
  assert.equal(entered.status, 'local_preview')
  assert.equal(session.previewActive, true)
  assert.equal(session.exitPreview(), 'stopped')
  assert.equal(session.previewActive, false)
})

test('开播自检：形象/接入未配置在政策包检查之前给出单一可操作原因', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  const personaCheck = session.preflight({ ...okPreflight, personaConfigured: false })
  assert.equal(personaCheck.pass, false)
  assert.ok(personaCheck.reason?.includes('主播形象未配置'))
  const platformCheck = session.preflight({ ...okPreflight, platformConfigured: false })
  assert.equal(platformCheck.pass, false)
  assert.ok(platformCheck.reason?.includes('直播接入未配置'))
  const status = await session.start('task-5', { ...okPreflight, personaConfigured: false })
  assert.equal(status, 'recoverable_fault')
})

test('等待平台通道期间的紧急停止：立即安全场景，迟到的开播续行不得覆盖（即使平台回执为 live）', async () => {
  const adapter = new DeferredAdapter()
  const session = new LiveSession(adapter, loadPolicyPack(PACK_PATH), 'douyin')
  // 一键开播挂起在 adapter.connectChannel 上
  const starting = session.start('task-es', okPreflight)
  assert.equal(adapter.pendingCount, 1)
  // 操作员工作者的紧急停止必须即时生效，无需等待通道结果
  assert.equal(session.emergencyStop(), 'safe_scene')
  // 平台随后回执「已直播」也不得复活开播/覆盖安全场景
  adapter.releaseConnect({ streamEstablished: true, platformReceipt: true })
  assert.equal(await starting, 'safe_scene')
  assert.equal(session.current, 'safe_scene')
  assert.equal(session.display(), '安全场景')
  // 恢复仍需人工
  assert.equal(session.recoverToPreview(), 'local_preview')
})

test('等待平台通道期间的正常停止：回到已结束，迟到的开播续行不得复活等待确认', async () => {
  const adapter = new DeferredAdapter()
  const session = new LiveSession(adapter, loadPolicyPack(PACK_PATH), 'douyin')
  const starting = session.start('task-stop', okPreflight)
  assert.equal(await session.stop(), 'ended')
  adapter.releaseConnect()
  assert.equal(await starting, 'ended')
  assert.equal(session.current, 'ended')
  assert.equal(session.display(), '已结束')
})

test('等待平台通道期间退出预览：回到已停止，迟到的续行不得改写为等待平台确认', async () => {
  const adapter = new DeferredAdapter()
  const session = new LiveSession(adapter, loadPolicyPack(PACK_PATH), 'douyin')
  const starting = session.start('task-exit', okPreflight)
  assert.equal(session.exitPreview(), 'stopped')
  adapter.releaseConnect()
  assert.equal(await starting, 'stopped')
  assert.equal(session.current, 'stopped')
})

test('守卫不阻碍停止后的重试：同幂等键重试视为新尝试并可正常开播（幂等语义保持）', async () => {
  const adapter = new DeferredAdapter()
  const session = new LiveSession(adapter, loadPolicyPack(PACK_PATH), 'douyin')
  const first = session.start('task-retry', okPreflight)
  assert.equal(session.emergencyStop(), 'safe_scene')
  adapter.releaseConnect()
  assert.equal(await first, 'safe_scene')
  // 同一幂等键在紧急停止后重试：是新的开播尝试，正常走到等待平台确认
  const second = session.start('task-retry', okPreflight)
  adapter.releaseConnect()
  assert.equal(await second, 'awaiting_platform')
  assert.equal(session.display(), '等待平台确认')
  // 幂等：进行中重复点击不重复开播
  assert.equal(await session.start('task-retry', okPreflight), 'awaiting_platform')
})


test('已下播后从独立本地预览可以再次开始直播', async () => {
  const session = new LiveSession(new DouyinAssistedAdapter(), loadPolicyPack(PACK_PATH), 'douyin')
  assert.equal(await session.start('first', okPreflight), 'awaiting_platform')
  assert.equal(await session.stop(), 'ended')
  assert.equal(session.enterPreview({ ready: true }).ok, true)
  assert.equal(await session.start('second', okPreflight), 'awaiting_platform')
})
