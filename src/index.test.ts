import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPlugin } from './index.ts'
import { createEnvelope } from './perception/envelope.ts'
import { NotImplementedError } from './types.ts'

test('插件装配：配置加载 → 迁移 → 恢复 → 各组件就绪', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'dafeiyu-plugin-'))
  const logs: string[] = []
  const plugin = createPlugin({
    configPath: join(process.cwd(), 'config/default.yaml'),
    dataDir,
    log: (m) => logs.push(m),
  })
  try {
    assert.equal(plugin.config.mode, 'shadow')
    assert.equal(plugin.featureGates.cloudCallsEnabled, false) // null 预算 → 云端禁用
    // ingest 去重生效
    const env = createEnvelope({
      source: 'douyin:danmaku',
      sourceEventId: 's-1',
      roomId: 'room-1',
      sessionId: 'sess-1',
      occurredAt: new Date().toISOString(),
      type: 'danmaku',
      provenance: 'platform_verified',
      payloadRef: 'payload://s-1',
    })
    const r1 = plugin.runtime.ingest(env)
    const r2 = plugin.runtime.ingest(env)
    assert.equal((await r1).duplicate, false)
    assert.equal((await r2).duplicate, true)
    // 阶段 A 未实现接口显式声明边界
    assert.throws(() => plugin.runtime.retrieve({ text: 'x', sessionId: 's', characterId: 'dafeiyu' }), NotImplementedError)
    // 政策服务与黑板可用
    const dec = plugin.policy.issue({ action: 'memory_write', payloadHash: 'h1' })
    assert.equal(plugin.policy.verify(dec).valid, true)
    plugin.blackboard.write('sess-1', 0, {
      topic: '种田',
      pendingTasks: [],
      recentEventIds: [env.eventId],
      activeReleaseId: 'rel-baseline',
      policyVersion: 'p1',
    })
    assert.ok(plugin.blackboard.readActive('sess-1') !== undefined)
  } finally {
    plugin.dispose()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
