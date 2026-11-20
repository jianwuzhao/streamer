import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudDisabledError, OpenAICompatCloudAdapter } from './cloud.ts'
import { CloudUsageLedger } from '../routing/cloud-usage.ts'
import { makeTmpDb } from '../testing/helpers.ts'

function makeAdapter(over: Partial<ConstructorParameters<typeof OpenAICompatCloudAdapter>[0]> = {}) {
  let fetchCount = 0
  const adapter = new OpenAICompatCloudAdapter({
    baseURL: 'http://127.0.0.1:9/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    enabled: true,
    providerConfigured: true,
    dailyBudgetCny: 10,
    costTracker: { getSpentTodayCny: () => 0, add: () => {} },
    fetchImpl: (async () => {
      fetchCount += 1
      throw new Error('should not fetch')
    }) as typeof fetch,
    ...over,
  })
  return { adapter, fetchCount: () => fetchCount }
}

test('未配置/禁用：不发起任何网络请求即拒绝', async () => {
  const { adapter, fetchCount } = makeAdapter({
    enabled: false,
    providerConfigured: false,
    dailyBudgetCny: null,
  })
  await assert.rejects(adapter.generate({ messages: [{ role: 'user', text: 'hi' }] }), CloudDisabledError)
  assert.equal(fetchCount(), 0)
})

test('计量并发请求：原子预留费用，失败请求仍计数，未知费用不记作零', async () => {
  const { db, cleanup } = makeTmpDb()
  try {
    const ledger = new CloudUsageLedger(db)
    const input = { model: 'test', requestLimit: 2, budgetCny: 1, inputCeiling: 100, outputCeiling: 500,
      inputRate: 1000, outputRate: 1000 }
    const settle = ledger.reserve(input)
    assert.ok(settle)
    assert.equal(ledger.reserve(input), undefined, '未完成的调用已占用预算')
    settle({ prompt_tokens: 100, completion_tokens: 10 }, true)
    const failed = ledger.reserve(input)
    assert.ok(failed)
    failed(undefined, false)
    assert.deepEqual({ ...ledger.today() }, { requests: 2, tokens: 110, estimatedCostCny: 0.11, unknownCostRequests: 1 })
    assert.equal(ledger.reserve({ ...input, inputRate: null, outputRate: null }), undefined, '失败请求计入次数')
  } finally { cleanup() }
})

test('预算耗尽：budget_exhausted 且不发起请求（§19）', async () => {
  const { adapter, fetchCount } = makeAdapter({
    costTracker: { getSpentTodayCny: () => 10, add: () => {} },
  })
  await assert.rejects(
    adapter.generate({ messages: [{ role: 'user', text: 'hi' }] }),
    (err: unknown) => {
      assert.ok(err instanceof CloudDisabledError)
      assert.ok(err.reasons.includes('budget_exhausted'))
      return true
    },
  )
  assert.equal(fetchCount(), 0)
})

test('配置齐全 + 预算未耗尽：发起请求并解析响应', async () => {
  const adapter = new OpenAICompatCloudAdapter({
    baseURL: 'http://stub/v1',
    model: 'test-model',
    apiKey: 'sk-test',
    enabled: true,
    providerConfigured: true,
    dailyBudgetCny: 10,
    costTracker: { getSpentTodayCny: () => 1, add: () => {} },
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '云端回复' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      )) as typeof fetch,
  })
  const result = await adapter.generate({ messages: [{ role: 'user', text: 'hi' }] })
  assert.equal(result.text, '云端回复')
  assert.equal(result.tokensIn, 10)
  assert.equal(result.tokensOut, 5)
})

test('实时视图（0.15.1）：resolve 每次调用读取最新配置——密钥与开关即时生效', async () => {
  let runtime = {
    baseURL: 'http://stub/v1',
    model: 'm1',
    apiKey: 'k1',
    enabled: true,
    providerConfigured: true,
    dailyBudgetCny: 10,
  }
  const auths: string[] = []
  const adapter = new OpenAICompatCloudAdapter({
    ...runtime,
    resolve: () => runtime,
    costTracker: { getSpentTodayCny: () => 0, add: () => {} },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      auths.push(String((init?.headers as Record<string, string>).authorization))
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  await adapter.generate({ messages: [{ role: 'user', text: 'hi' }] })
  assert.deepEqual(auths, ['Bearer k1'])
  // 界面关掉云端兜底 → 不重构适配器即拒绝（无网络请求）
  runtime = { ...runtime, enabled: false }
  await assert.rejects(adapter.generate({ messages: [{ role: 'user', text: 'hi' }] }), CloudDisabledError)
  // 界面换密钥 → 下一次请求即用新密钥
  runtime = { ...runtime, enabled: true, apiKey: 'k2' }
  await adapter.generate({ messages: [{ role: 'user', text: 'hi' }] })
  assert.deepEqual(auths, ['Bearer k1', 'Bearer k2'])
})

test('推理模型空正文（finish=length）：单次补预算重试后取到正文（hy4/R1 系）', async () => {
  const calls: number[] = []
  const adapter = new OpenAICompatCloudAdapter({
    baseURL: 'http://stub/v1',
    model: 'hy4',
    apiKey: 'k',
    enabled: true,
    providerConfigured: true,
    dailyBudgetCny: 10,
    costTracker: { getSpentTodayCny: () => 0, add: () => {} },
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens: number }
      calls.push(body.max_tokens)
      return calls.length === 1
        ? new Response(
            JSON.stringify({
              choices: [{ message: { content: '', reasoning_content: '思考' }, finish_reason: 'length' }],
              usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 },
            }),
            { status: 200 },
          )
        : new Response(JSON.stringify({
            model: 'actual-model', choices: [{ message: { content: '正文' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 },
          }), { status: 200 })
    }) as unknown as typeof fetch,
  })
  const result = await adapter.generate({ messages: [{ role: 'user', text: 'hi' }], maxOutputTokens: 128 })
  assert.equal(result.text, '正文')
  assert.equal(result.model, 'actual-model')
  assert.equal(result.tokensIn, 20)
  assert.equal(result.tokensOut, 158)
  assert.equal(result.tokensTotal, 178)
  assert.deepEqual(calls, [128, 1024], '重试应补足到 ≥1024 tokens')
})

test('能力不足：responseSchema + 声明能力不含结构化输出时拒绝', async () => {
  const { adapter, fetchCount } = makeAdapter()
  ;(adapter as unknown as { capabilities: object }).capabilities = {
    text: true,
    structuredOutput: false,
    toolCalling: true,
    image: false,
  }
  await assert.rejects(
    adapter.generate({
      messages: [{ role: 'user', text: 'hi' }],
      responseSchema: { type: 'object' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.ok((err as { reasonCode?: string }).reasonCode === 'UNSUPPORTED_CAPABILITY')
      return true
    },
  )
  assert.equal(fetchCount(), 0)
})

test('兼容云端流式回复只递交正文，并读取独立的用量分块', async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: '内部推理' } }] },
    { model: 'actual-model', choices: [{ delta: { content: '你好，' } }] },
    { choices: [{ delta: { content: '欢迎来直播间。' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 } },
  ]
  const wire = events.map((event) => 'data: ' + JSON.stringify(event)).join('\r\n\r\n') + '\r\n\r\ndata: [DONE]\r\n\r\n'
  const { adapter } = makeAdapter({
    fetchImpl: async (_url, init) => {
      const payload = JSON.parse(String(init?.body))
      assert.equal(payload.stream, true)
      assert.equal(payload.stream_options.include_usage, true)
      return new Response(wire, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  const drafts: string[] = []
  const result = await adapter.generate({ messages: [{ role: 'user', text: '你好' }] }, { onDraft: (text) => drafts.push(text) })
  assert.deepEqual(drafts, ['你好，', '你好，欢迎来直播间。'])
  assert.deepEqual(result, {
    text: '你好，欢迎来直播间。', model: 'actual-model', tokensIn: 21, tokensOut: 9, tokensTotal: 30, finishReason: 'stop',
  })
})
