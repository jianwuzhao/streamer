import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CloudDisabledError, OpenAICompatCloudAdapter } from './cloud.ts'

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
