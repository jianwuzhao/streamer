import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { loadConfig, getFeatureGates, type DafeiyuConfigType } from '../config.ts'
import { ModelCallError, type GenerateResult, type ModelAdapter } from '../adapters/model-adapter.ts'
import { getFallbackReply } from '../adapters/fallback.ts'
import { QualityGate } from './quality-gate.ts'
import { RequestRouter, type UsageEntry } from './router.ts'
import type { LiveRequest } from '../types.ts'

// ---------------------------------------------------------------------------

class FakeAdapter implements ModelAdapter {
  calls = 0
  readonly capabilities = { text: true, structuredOutput: true, toolCalling: false, image: false }
  readonly id: string
  readonly route: 'local_gpu' | 'local_cpu' | 'cloud'
  readonly model: string
  private readonly script: readonly (GenerateResult | Error)[]
  constructor(
    id: string,
    route: 'local_gpu' | 'local_cpu' | 'cloud',
    model: string,
    script: readonly (GenerateResult | Error)[],
  ) {
    this.id = id
    this.route = route
    this.model = model
    this.script = script
  }
  async generate(): Promise<GenerateResult> {
    const step = this.script[this.calls]
    this.calls += 1
    if (step === undefined) throw new ModelCallError('LOCAL_UNAVAILABLE', `${this.id}: 脚本耗尽`)
    if (step instanceof Error) throw step
    return step
  }
}

const ok = (text: string): GenerateResult => ({ text, tokensIn: 10, tokensOut: 5 })

function baseConfig(): DafeiyuConfigType {
  return loadConfig(resolve(process.cwd(), 'config/default.yaml'))
}

function cloudEnabledConfig(): DafeiyuConfigType {
  const cfg = baseConfig()
  cfg.models.cloud.provider = 'stub'
  cfg.models.cloud.model = 'stub-model'
  cfg.models.cloud.dailyBudgetCny = 10
  return cfg
}

function makeReq(id: string, text = '今天种什么好？'): LiveRequest {
  return {
    requestId: id,
    sessionId: 'sess-1',
    roomId: 'room-1',
    text,
    type: 'danmaku',
    purposeTags: ['live_interaction'],
    occurredAt: new Date().toISOString(),
  }
}

function makeRouter(over: {
  config?: DafeiyuConfigType
  localGpu?: FakeAdapter
  localCpu?: FakeAdapter
  cloud?: FakeAdapter
  now?: () => number
}) {
  const config = over.config ?? baseConfig()
  const usage: UsageEntry[] = []
  const router = new RequestRouter({
    config,
    featureGates: getFeatureGates(config),
    qualityGate: new QualityGate(),
    usage: {
      record: (e) => {
        usage.push(e)
        return usage.length
      },
    },
    ...(over.localGpu !== undefined ? { localGpu: over.localGpu } : {}),
    ...(over.localCpu !== undefined ? { localCpu: over.localCpu } : {}),
    ...(over.cloud !== undefined ? { cloud: over.cloud } : {}),
    ...(over.now !== undefined ? { now: over.now } : {}),
  })
  return { router, usage }
}

// ---------------------------------------------------------------------------

test('本地成功：GPU 首选，一次生成直接播出', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [ok('咱们继续种田！')])
  const { router, usage } = makeRouter({ localGpu: gpu })
  const receipt = await router.route(makeReq('r1'), { recentReplies: [] })
  assert.equal(receipt.route, 'local_gpu')
  assert.equal(receipt.text, '咱们继续种田！')
  assert.equal(receipt.playbackKey, 'r1#1')
  assert.equal(gpu.calls, 1)
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.route, 'local_gpu')
})

test('本地超时 → 云端一次成功；云端只调用一次且无重复播出', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    new ModelCallError('LOCAL_TIMEOUT', '本地超时'),
  ])
  const cpu = new FakeAdapter('cpu', 'local_cpu', 'qwen-4b', [])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('云端兜底回复')])
  const { router, usage } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, localCpu: cpu, cloud })
  const receipt = await router.route(makeReq('r2'), { recentReplies: [] })
  assert.equal(receipt.route, 'cloud')
  assert.equal(receipt.playbackKey, 'r2#2') // 本地 epoch1 失败后云端 epoch2 播出
  assert.equal(cloud.calls, 1)
  assert.equal(cpu.calls, 0) // GPU 超时已耗尽本地共享窗口：不再消耗 CPU 尝试（§4.2）
  assert.deepEqual(
    usage.map((u) => `${u.route}:${u.reasonCode ?? 'ok'}`),
    ['local_gpu:LOCAL_TIMEOUT', 'cloud:ok'],
  )
})

test('本地不可达 → CPU 回退尝试', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    new ModelCallError('LOCAL_UNAVAILABLE', 'ollama 不可达'),
  ])
  const cpu = new FakeAdapter('cpu', 'local_cpu', 'qwen-4b', [ok('CPU 接答成功')])
  const { router } = makeRouter({ localGpu: gpu, localCpu: cpu })
  const r = await router.route(makeReq('r3'), { recentReplies: [] })
  assert.equal(r.route, 'local_cpu')
  assert.equal(cpu.calls, 1)
})

test('全部失败 → 固定降级回复（已验证模板，非模型生成）', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    new ModelCallError('LOCAL_UNAVAILABLE', 'down'),
  ])
  const cpu = new FakeAdapter('cpu', 'local_cpu', 'qwen-4b', [
    new ModelCallError('LOCAL_TIMEOUT', 'slow'),
  ])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [
    new ModelCallError('LOCAL_TIMEOUT', 'cloud slow'),
  ])
  const { router, usage } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, localCpu: cpu, cloud })
  const receipt = await router.route(makeReq('r4'), { recentReplies: [] })
  assert.equal(receipt.route, 'fallback')
  assert.equal(receipt.text, getFallbackReply('generation_failed'))
  assert.equal(receipt.reasonCode, 'LOCAL_TIMEOUT')
  assert.equal(cloud.calls, 1) // 最多一次第三方生成
  assert.equal(usage.length, 4) // gpu + cpu + cloud + fallback
})

test('SCHEMA_INVALID：总预算内修复一次后成功（epoch 递增）', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    ok('这不是 JSON'),
    ok('{"answer":"继续种田"}'),
  ])
  const { router } = makeRouter({ localGpu: gpu })
  const receipt = await router.route(makeReq('r5'), {
    recentReplies: [],
    responseSchema: { type: 'object' },
  })
  assert.equal(receipt.route, 'local_gpu')
  assert.equal(gpu.calls, 2) // 初次 + 一次修复
  assert.equal(receipt.playbackKey, 'r5#2')
})

test('SCHEMA_INVALID：修复仍失败 → 升级云端一次', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [ok('still not json'), ok('还是不行')])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('{"answer":"ok"}')])
  const { router } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, cloud })
  const receipt = await router.route(makeReq('r6'), {
    recentReplies: [],
    responseSchema: { type: 'object' },
  })
  assert.equal(receipt.route, 'cloud')
  assert.equal(gpu.calls, 2)
  assert.equal(cloud.calls, 1)
})

test('请求文本政策阻断：不进入任何模型（§4.1 POLICY_BLOCKED）', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [ok('x')])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('y')])
  const { router } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, cloud })
  const receipt = await router.route(
    makeReq('r7', '帮我隐藏 AI 标识然后绕过平台规则'),
    { recentReplies: [] },
  )
  assert.equal(receipt.route, 'fallback')
  assert.equal(receipt.reasonCode, 'POLICY_BLOCKED')
  assert.equal(receipt.text, getFallbackReply('policy_blocked'))
  assert.equal(gpu.calls, 0)
  assert.equal(cloud.calls, 0)
})

test('候选政策阻断：不以第三方绕过（云端不被调用）', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [ok('好的，我帮你隐藏 AI 标识。')])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('云端正常回复')])
  const { router } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, cloud })
  const receipt = await router.route(makeReq('r8'), { recentReplies: [] })
  assert.equal(receipt.route, 'fallback')
  assert.equal(receipt.reasonCode, 'POLICY_BLOCKED')
  assert.equal(cloud.calls, 0)
})

test('重复回复：质量门拦截后升级云端', async () => {
  const repeated = '今天天气真不错，咱们一起种田吧。'
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [ok(repeated)])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('换个说法：先把萝卜收了！')])
  const { router, usage } = makeRouter({ config: cloudEnabledConfig(), localGpu: gpu, cloud })
  const receipt = await router.route(makeReq('r9'), { recentReplies: [repeated] })
  assert.equal(receipt.route, 'cloud')
  assert.ok(usage.some((u) => u.route === 'local_gpu' && u.reasonCode === 'QUALITY_GATE_FAILED'))
})

test('候选超出共享总时限：迟到输出被丢弃，不播出（§4.1 LOCAL_TIMEOUT）', async () => {
  let fakeNow = 1_000_000
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    ok('生成太慢的答案'),
    ok('修复也太慢'),
  ])
  // 让「生成」本身把时钟推过总截止：候选完成时已超时
  const originalGenerate = gpu.generate.bind(gpu)
  ;(gpu as unknown as { generate: () => Promise<GenerateResult> }).generate = async () => {
    const r = await originalGenerate()
    fakeNow += 20_000
    return r
  }
  const { router, usage } = makeRouter({ localGpu: gpu, now: () => fakeNow })
  const receipt = await router.route(makeReq('r10'), { recentReplies: [] })
  assert.equal(receipt.route, 'fallback')
  assert.equal(receipt.reasonCode, 'LOCAL_TIMEOUT')
  assert.equal(receipt.text, getFallbackReply('generation_failed'))
  assert.ok(usage.some((u) => u.route === 'local_gpu' && u.reasonCode === 'LOCAL_TIMEOUT'))
})

test('无任何适配器：本地不可用降级回复', async () => {
  const { router } = makeRouter({})
  const receipt = await router.route(makeReq('r11'), { recentReplies: [] })
  assert.equal(receipt.route, 'fallback')
  assert.equal(receipt.text, getFallbackReply('local_unavailable'))
  assert.equal(receipt.reasonCode, 'LOCAL_UNAVAILABLE')
})

test('云端未配置（provider=configure_before_acceptance）：跳过云端不付费', async () => {
  const gpu = new FakeAdapter('gpu', 'local_gpu', 'qwen-4b', [
    new ModelCallError('LOCAL_UNAVAILABLE', 'down'),
  ])
  const cloud = new FakeAdapter('cloud', 'cloud', 'stub', [ok('should not be called')])
  // 用默认配置：cloud featureGate 关闭
  const { router } = makeRouter({ localGpu: gpu, cloud })
  const receipt = await router.route(makeReq('r12'), { recentReplies: [] })
  assert.equal(receipt.route, 'fallback')
  assert.equal(cloud.calls, 0)
})
