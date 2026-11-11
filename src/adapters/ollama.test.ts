import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { test } from 'node:test'
import { OllamaAdapter } from './ollama.ts'
import { ModelCallError } from './model-adapter.ts'

function withStubServer(
  handler: (body: unknown, res: import('node:http').ServerResponse) => void,
  fn: (baseURL: string, server: Server) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        let parsed: unknown = null
        try {
          parsed = JSON.parse(data)
        } catch {
          /* ignore */
        }
        handler(parsed, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('no port'))
        return
      }
      fn(`http://127.0.0.1:${addr.port}`, server)
        .then(() => {
          server.close()
          resolve()
        })
        .catch((err) => {
          server.close()
          reject(err)
        })
    })
  })
}

test('ollama 成功：解析 message.content 与 token 计数', async () => {
  await withStubServer((body, res) => {
    assert.ok((body as { model?: string }).model?.includes('Qwen3'))
    res.end(
      JSON.stringify({
        message: { content: '咱们继续种田！' },
        prompt_eval_count: 42,
        eval_count: 12,
        done_reason: 'stop',
      }),
    )
  }, async (baseURL) => {
    const adapter = new OllamaAdapter({ baseURL, model: 'Qwen/Qwen3-4B-Instruct-2507:Q4_K_M' })
    const result = await adapter.generate({
      messages: [{ role: 'user', text: '今天种什么' }],
    })
    assert.equal(result.text, '咱们继续种田！')
    assert.equal(result.tokensIn, 42)
    assert.equal(result.tokensOut, 12)
  })
})

test('ollama 超时：映射 LOCAL_TIMEOUT', async () => {
  await withStubServer((_body, res) => {
    setTimeout(() => res.end('{}'), 300)
  }, async (baseURL) => {
    const adapter = new OllamaAdapter({ baseURL, model: 'm', timeoutMs: 50 })
    await assert.rejects(
      adapter.generate({ messages: [{ role: 'user', text: 'hi' }] }),
      (err: unknown) => {
        assert.ok(err instanceof ModelCallError)
        assert.equal(err.reasonCode, 'LOCAL_TIMEOUT')
        return true
      },
    )
  })
})

test('ollama 不可达：映射 LOCAL_UNAVAILABLE', async () => {
  const adapter = new OllamaAdapter({ baseURL: 'http://127.0.0.1:1', model: 'm', timeoutMs: 500 })
  await assert.rejects(
    adapter.generate({ messages: [{ role: 'user', text: 'hi' }] }),
    (err: unknown) => {
      assert.ok(err instanceof ModelCallError)
      assert.equal(err.reasonCode, 'LOCAL_UNAVAILABLE')
      return true
    },
  )
})

test('ollama 能力探测：tools → toolCalling', async () => {
  await withStubServer((body, res) => {
    assert.equal((body as { model?: string }).model, 'm')
    res.end(JSON.stringify({ capabilities: ['completion', 'tools'] }))
  }, async (baseURL) => {
    const adapter = new OllamaAdapter({ baseURL, model: 'm' })
    const caps = await adapter.probe()
    assert.equal(caps.toolCalling, true)
    assert.equal(caps.image, false)
    assert.equal(caps.structuredOutput, false)
  })
})
