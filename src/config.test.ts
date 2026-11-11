import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { ConfigError, getFeatureGates, loadConfig, parseConfig } from './config.ts'

const defaultPath = resolve(process.cwd(), 'config/default.yaml')

test('默认配置加载并通过校验（§18 全字段）', () => {
  const cfg = loadConfig(defaultPath)
  assert.equal(cfg.mode, 'shadow')
  assert.equal(cfg.models.totalDeadlineMs, 12_000)
  assert.equal(cfg.models.localAttemptMs, 5_000)
  assert.equal(cfg.models.outputReserveMs, 1_500)
  assert.equal(cfg.scope.characterId, 'dafeiyu')
  assert.equal(cfg.feedback.rawGiftAmountTrainingWeight, 0)
})

test('null 预算 ⇒ 付费能力禁用并给出原因（§18 注）', () => {
  const cfg = loadConfig(defaultPath)
  const gates = getFeatureGates(cfg)
  assert.equal(gates.cloudCallsEnabled, false)
  assert.ok(gates.cloudDisabledReasons.some((r) => r.includes('dailyBudgetCny=null')))
  assert.ok(gates.cloudDisabledReasons.some((r) => r.includes('provider 未配置')))
  assert.equal(gates.trainingWindowsEnabled, false)
  assert.ok(gates.trainingDisabledReasons.some((r) => r.includes('dailyTrainingMinutesBudget=null')))
})

test('配置齐全后付费能力开启', () => {
  const cfg = loadConfig(defaultPath)
  cfg.models.cloud.provider = 'openai-compat'
  cfg.models.cloud.model = 'some-model'
  cfg.models.cloud.dailyBudgetCny = 30
  cfg.training.dailyTrainingMinutesBudget = 60
  const gates = getFeatureGates(cfg)
  assert.equal(gates.cloudCallsEnabled, true)
  assert.equal(gates.trainingWindowsEnabled, true)
})

test('缺失字段报出具体路径', () => {
  assert.throws(
    () => parseConfig('mode: shadow\nkillSwitch: false\nproductPreset: x'),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError)
      const msg = err.message
      assert.ok(msg.includes('integration'), msg)
      return true
    },
  )
})

test('语义校验：人设内核可写被拒绝', () => {
  const base = loadConfig(defaultPath)
  const bad = structuredClone(base)
  bad.memory.allowPersonaCoreWrite = true
  assert.throws(() => parseConfig(JSON.stringify(bad, null, 2)), ConfigError)
})

test('语义校验：技能权限扩张被拒绝', () => {
  const base = loadConfig(defaultPath)
  const bad = structuredClone(base)
  bad.skills.allowUnreviewedPrivilegeExpansion = true
  assert.throws(() => parseConfig(JSON.stringify(bad, null, 2)), ConfigError)
})

test('语义校验：礼物训练权重非零被拒绝', () => {
  const base = loadConfig(defaultPath)
  const bad = structuredClone(base)
  bad.feedback.rawGiftAmountTrainingWeight = 0.5
  assert.throws(() => parseConfig(JSON.stringify(bad, null, 2)), ConfigError)
})

test('语义校验：JSON 文本形式的完整配置可通过', () => {
  const base = loadConfig(defaultPath)
  // YAML 是 JSON 的超集：把对象序列化为 JSON 再走同一解析器
  const text = JSON.stringify(base, null, 2)
  const cfg = parseConfig(text)
  assert.equal(cfg.mode, 'shadow')
})
