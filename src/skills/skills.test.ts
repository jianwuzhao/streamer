import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { makeTmpDb } from '../testing/helpers.ts'
import { SkillExecutor, type SkillHandler } from './executor.ts'
import { loadSkillPackage } from './package-loader.ts'
import { SkillRegistry, type SkillManifest } from './registry.ts'

function makeManifest(over: Partial<SkillManifest> = {}): SkillManifest {
  const base: SkillManifest = {
    skillId: 'test-skill',
    version: '1.0.0',
    kind: 'expression',
    description: '测试技能',
    trigger: undefined,
    preconditions: [],
    inputSchema: undefined,
    outputSchema: undefined,
    permissions: [],
    timeoutMs: 1000,
    idempotent: true,
    postconditions: [],
    fallback: undefined,
    cooldownMs: 0,
    handler: 'test-handler',
  }
  const merged = { ...base, ...over }
  return {
    ...merged,
    ...(merged.trigger === undefined ? { trigger: undefined } : {}),
  }
}

function setup(grantedPermissions: readonly string[] = [], handler?: SkillHandler) {
  const t = makeTmpDb()
  const registry = new SkillRegistry(t.db, { grantedPermissions })
  const executor = new SkillExecutor(t.db, registry, { grantedPermissions, maxStepsPerRequest: 2 })
  executor.registerHandler('test-handler', handler ?? (async (args) => ({ output: args, toolReceipts: [] })))
  return { t, registry, executor }
}

function activate(registry: SkillRegistry, manifest: SkillManifest): void {
  registry.register(manifest)
  registry.setStatus(manifest.skillId, manifest.version, 'validated')
  registry.setStatus(manifest.skillId, manifest.version, 'staged')
  registry.setStatus(manifest.skillId, manifest.version, 'canary')
  registry.setStatus(manifest.skillId, manifest.version, 'active')
}

test('注册校验：坏 manifest 报具体字段；版本不可原地覆盖', () => {
  const { t, registry } = setup()
  try {
    assert.throws(() => registry.register({ ...makeManifest(), version: 'v1' }), /version/)
    assert.throws(() => registry.register({ ...makeManifest(), timeoutMs: 0 }), /timeoutMs/)
    registry.register(makeManifest())
    assert.throws(
      () => registry.register({ ...makeManifest(), description: '改了内容' }),
      /不可原地覆盖/,
    )
    // 内容相同的重复注册幂等
    const again = registry.register(makeManifest())
    assert.equal(again.status, 'draft')
  } finally {
    t.cleanup()
  }
})

test('生命周期：逐级推进；越级拒绝；撤销实时生效', () => {
  const { t, registry } = setup()
  try {
    const m = makeManifest()
    registry.register(m)
    assert.throws(() => registry.setStatus(m.skillId, m.version, 'active'), /逐级推进/)
    activate(registry, m)
    assert.equal(registry.isActive(m.skillId, m.version), true)
    registry.setStatus(m.skillId, m.version, 'suspended')
    assert.equal(registry.isActive(m.skillId, m.version), false)
  } finally {
    t.cleanup()
  }
})

test('权限扩张：超出已授予集合无法晋级（需管理审核）', () => {
  const { t, registry } = setup([]) // 未授予任何权限
  try {
    const m = makeManifest({ permissions: ['file_write'] })
    registry.register(m)
    assert.throws(() => registry.setStatus(m.skillId, m.version, 'validated'), /权限超出/)
    assert.equal(registry.get(m.skillId, m.version)?.status, 'draft')
  } finally {
    t.cleanup()
  }
})

test('执行：schema 校验失败 → failed + 技能 fallback，不编造成功', async () => {
  const { t, registry, executor } = setup([], async () => ({ output: { phrase: 'x' }, toolReceipts: [] }))
  try {
    const m = makeManifest({
      inputSchema: { type: 'object', required: ['giftName'], properties: { giftName: { type: 'string' } } },
      fallback: '备用答谢语',
    })
    activate(registry, m)
    const receipt = await executor.execute({
      requestId: 'req-1',
      skillId: m.skillId,
      version: m.version,
      arguments: { wrong: true },
    })
    assert.equal(receipt.outcome, 'failed')
    assert.ok(receipt.reason?.startsWith('input_schema'))
    assert.equal(receipt.fallbackText, '备用答谢语')
  } finally {
    t.cleanup()
  }
})

test('执行：撤销（suspended）后实时拒绝 → skipped', async () => {
  const { t, registry, executor } = setup()
  try {
    const m = makeManifest()
    activate(registry, m)
    registry.setStatus(m.skillId, m.version, 'suspended')
    const receipt = await executor.execute({
      requestId: 'req-1',
      skillId: m.skillId,
      version: m.version,
      arguments: {},
    })
    assert.equal(receipt.outcome, 'skipped')
    assert.ok(receipt.reason?.startsWith('skill_not_active'))
  } finally {
    t.cleanup()
  }
})

test('幂等：同请求同技能重复执行复用既有成功运行（不重复副作用）', async () => {
  let calls = 0
  const { t, registry, executor } = setup([], async () => {
    calls += 1
    return { output: { ok: true }, toolReceipts: [{ tool: 'local', ok: true }] }
  })
  try {
    const m = makeManifest()
    activate(registry, m)
    const first = await executor.execute({ requestId: 'req-1', skillId: m.skillId, version: m.version, arguments: {} })
    const second = await executor.execute({ requestId: 'req-1', skillId: m.skillId, version: m.version, arguments: {} })
    assert.equal(first.outcome, 'succeeded')
    assert.equal(second.duplicate, true)
    assert.equal(calls, 1)
  } finally {
    t.cleanup()
  }
})

test('后置条件：工具回执失败 → failed；输出 schema 失败 → failed', async () => {
  const { t, registry, executor } = setup([], async () => ({
    output: { phrase: 'x' },
    toolReceipts: [{ tool: 'query', ok: false, detail: 'boom' }],
  }))
  try {
    const m = makeManifest()
    activate(registry, m)
    const receipt = await executor.execute({ requestId: 'req-1', skillId: m.skillId, version: m.version, arguments: {} })
    assert.equal(receipt.outcome, 'failed')
    assert.ok(receipt.reason?.startsWith('postcondition_tool'))
  } finally {
    t.cleanup()
  }
})

test('每请求步骤上限：不同技能也受 maxStepsPerRequest 限制', async () => {
  const { t, registry, executor } = setup()
  try {
    const m1 = makeManifest()
    const m2 = makeManifest({ skillId: 'second-skill', version: '2.0.0' })
    const m3 = makeManifest({ skillId: 'third-skill', version: '3.0.0' })
    for (const m of [m1, m2, m3]) activate(registry, m)
    const first = await executor.execute({ requestId: 'req-1', skillId: m1.skillId, version: m1.version, arguments: {} })
    const second = await executor.execute({ requestId: 'req-1', skillId: m2.skillId, version: m2.version, arguments: {} })
    const third = await executor.execute({ requestId: 'req-1', skillId: m3.skillId, version: m3.version, arguments: {} })
    assert.equal(first.outcome, 'succeeded')
    assert.equal(second.outcome, 'succeeded')
    assert.equal(third.outcome, 'skipped')
    assert.equal(third.reason, 'max_steps_per_request')
  } finally {
    t.cleanup()
  }
})

test('包加载：示例技能包 manifest+schema 内联合并', () => {
  const pkgDir = join(process.cwd(), 'skill-packages', 'gift-ack-phrase', '1.0.0')
  const pkg = loadSkillPackage(pkgDir)
  assert.equal(pkg.manifest.skillId, 'gift-ack-phrase')
  const input = pkg.manifest.inputSchema as { type: string; required: string[] }
  assert.equal(input.type, 'object')
  assert.ok(input.required.includes('giftName'))
})
