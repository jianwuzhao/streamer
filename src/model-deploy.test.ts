import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { execFile, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRequestHandler } from './host-api.ts'
import type { DafeiyuPluginHandle } from './index.ts'
import { LocalModelDeployer, probeOllamaInstallState, type SpawnFn } from './model-deploy.ts'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false
  kill(): void {
    this.killed = true
  }
}

function makeDeployer(overrides: {
  packageDir?: string
  noScript?: boolean
  fetchImpl?: typeof fetch
  saveModel?: (model: string) => void
} = {}) {
  const packageDir = overrides.packageDir ?? mkdtempSync(join(tmpdir(), 'dafeiyu-deploy-'))
  if (overrides.noScript !== true) {
    mkdirSync(join(packageDir, 'scripts'), { recursive: true })
    writeFileSync(join(packageDir, 'scripts', 'setup-ollama.mjs'), '// stub\n')
  }
  const children: FakeChild[] = []
  const spawned: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
  const spawnFn: SpawnFn = (command, args, options) => {
    spawned.push({ command, args, options })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }
  const deployer = new LocalModelDeployer({
    packageDir,
    dataDir: '/tmp/dafeiyu-data',
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'qwen3:4b',
    execPath: '/usr/bin/node',
    spawnFn,
    ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
    ...(overrides.saveModel ? { saveModel: overrides.saveModel } : {}),
    now: () => '2026-11-16T10:00:00.000Z',
  })
  return { deployer, children, spawned, cleanup: () => rmSync(packageDir, { recursive: true, force: true }) }
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
    end(body = '') {
      this.body = body
    },
  }
}

function makeReq(method: string, url: string, body = '') {
  const chunks = body === '' ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    on(event: string, cb: (c: Buffer) => void) {
      if (event === 'data') for (const c of chunks) cb(c)
      if (event === 'end') queueMicrotask(() => cb(Buffer.from('')))
    },
  }
}

test('model-deploy：idle 起步；start 进入 running 并注入运行环境', async () => {
  const { deployer, children, spawned, cleanup } = makeDeployer()
  try {
    assert.equal(deployer.state().status, 'idle')
    assert.equal(deployer.state().model, 'qwen3:4b')
    assert.equal(deployer.state().ollamaUrl, 'http://127.0.0.1:11434')

    const snap = deployer.start()
    assert.equal(snap.status, 'running')
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0]!.command, '/usr/bin/node')
    assert.ok(spawned[0]!.args[0]!.endsWith('setup-ollama.mjs'))
    assert.equal(spawned[0]!.options.cwd, spawned[0]!.options.cwd) // cwd 存在
    const env = spawned[0]!.options.env as Record<string, string>
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(env.DAFEIYU_DATA_DIR, '/tmp/dafeiyu-data')
    assert.equal(env.DAFEIYU_OLLAMA_URL, 'http://127.0.0.1:11434')
    assert.equal(env.DAFEIYU_OLLAMA_MODEL, 'qwen3:4b')
    assert.equal(children.length, 1)
  } finally {
    cleanup()
  }
})

test('model-deploy：stdout/stderr 跨 chunk 拼行；退出并收齐日志 → ok', async () => {
  const { deployer, children, cleanup } = makeDeployer()
  try {
    deployer.start()
    const child = children[0]!
    child.stdout.emit('data', Buffer.from('下载 Ollama v0.40.16（直'))
    child.stdout.emit('data', Buffer.from('连）\n模型下载：pulling 40%\n'))
    child.stderr.emit('data', Buffer.from('warn: 复用已运行实例\n'))
    child.emit('close', 0)
    const snap = deployer.state()
    assert.equal(snap.status, 'ok')
    assert.equal(snap.error, null)
    assert.equal(snap.finishedAt, '2026-11-16T10:00:00.000Z')
    assert.deepEqual(snap.log, ['下载 Ollama v0.40.16（直连）', '模型下载：pulling 40%', 'warn: 复用已运行实例'])
  } finally {
    cleanup()
  }
})

test('model-deploy：exit 非 0 → failed 带退出码；error 事件同样 failed；日志环形截断到 120 行', async () => {
  const { deployer, children, spawned, cleanup } = makeDeployer()
  try {
    deployer.start()
    children[0]!.emit('close', 3)
    const failed = deployer.state()
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, '部署进程退出码 3')

    // 失败后可重试（新进程）；running 中重复 start 不重复 spawn
    deployer.start()
    deployer.start()
    assert.equal(spawned.length, 2)
    const child = children[1]!

    for (let i = 0; i < 130; i++) child.stdout.emit('data', Buffer.from(`line-${i}\n`))
    child.emit('error', new Error('spawn ENOENT'))
    const errored = deployer.state()
    assert.equal(errored.status, 'failed')
    assert.equal(errored.error, 'spawn ENOENT')
    assert.equal(errored.log.length, 120)
    assert.equal(errored.log[0], 'line-10')
  } finally {
    cleanup()
  }
})

test('model-deploy：CR 刷新的进度条输出独立成行（curl --progress-bar）', async () => {
  const { deployer, children, cleanup } = makeDeployer()
  try {
    deployer.start()
    const child = children[0]!
    child.stderr.emit('data', Buffer.from('###  10%\r'))
    child.stderr.emit('data', Buffer.from('###  40%\r###  80%\r\n模型导入：parsing GGUF\n'))
    child.emit('close', 0)
    const snap = deployer.state()
    assert.equal(snap.status, 'ok')
    assert.deepEqual(snap.log, ['###  10%', '###  40%', '###  80%', '模型导入：parsing GGUF'])
  } finally {
    cleanup()
  }
})

test('model-deploy：probeOllamaInstallState 三态——就绪/缺模型/服务未安装', async () => {
  const opts = { ollamaUrl: 'http://127.0.0.1:11434', model: 'qwen3:4b', now: () => '2026-11-16T10:00:00.000Z' as const }
  // 服务可达但模型缺失（/api/show 404）
  const missing = await probeOllamaInstallState({
    ...opts,
    fetchImpl: (async (url: string) =>
      String(url).endsWith('/api/tags')
        ? new Response(JSON.stringify({ models: [] }), { status: 200 })
        : new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as unknown as typeof fetch,
  })
  assert.deepEqual(
    { ...missing, checkedAt: undefined },
    { reachable: true, modelInstalled: false, ready: false, model: 'qwen3:4b', ollamaUrl: opts.ollamaUrl, checkedAt: undefined },
  )
  // 服务与模型均就绪
  const ready = await probeOllamaInstallState({
    ...opts,
    fetchImpl: (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch,
  })
  assert.equal(ready.ready, true)
  assert.equal(ready.checkedAt, '2026-11-16T10:00:00.000Z')
  // 服务不可达（连接拒绝）
  const down = await probeOllamaInstallState({
    ...opts,
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch,
  })
  assert.equal(down.reachable, false)
  assert.equal(down.ready, false)
})

test('model-deploy：脚本缺失 → failed 不 spawn；dispose 终止进行中的进程', async () => {
  const { deployer, spawned, cleanup } = makeDeployer({ noScript: true })
  try {
    const snap = deployer.start()
    assert.equal(snap.status, 'failed')
    assert.ok(snap.error!.includes('部署脚本不存在'))
    assert.equal(spawned.length, 0)

    // 进行中的部署在插件卸载时被终止
    const live = makeDeployer()
    live.deployer.start()
    live.deployer.dispose()
    assert.equal(live.children[0]!.killed, true)
    live.cleanup()
  } finally {
    cleanup()
  }
})

test('host-api：GET model/deploy 轮询状态；POST 幂等启动（running 中不重复 spawn）', async () => {
  const { deployer, children, spawned, cleanup } = makeDeployer()
  try {
    const handle = { modelDeploy: deployer, live: {} } as unknown as DafeiyuPluginHandle
    const handler = createRequestHandler(handle)
    const call = async (method: string, url: string, body?: unknown) => {
      const res = makeRes()
      await handler(makeReq(method, url, body === undefined ? '' : JSON.stringify(body)), res, async () => {})
      return { code: res.statusCode, payload: JSON.parse(res.body) as Record<string, any> }
    }

    const before = await call('GET', '/api/dafeiyu/model/deploy')
    assert.equal(before.code, 200)
    assert.equal(before.payload.deploy.status, 'idle')
    assert.equal(before.payload.deploy.model, 'qwen3:4b')

    const started = await call('POST', '/api/dafeiyu/model/deploy', {})
    assert.equal(started.code, 202)
    assert.equal(started.payload.deploy.status, 'running')

    const again = await call('POST', '/api/dafeiyu/model/deploy', {})
    assert.equal(again.code, 202)
    assert.equal(again.payload.deploy.status, 'running')
    assert.equal(spawned.length, 1)

    children[0]!.emit('close', 0)
    const done = await call('GET', '/api/dafeiyu/model/deploy')
    assert.equal(done.payload.deploy.status, 'ok')
  } finally {
    cleanup()
  }
})

test('host-api：切换已安装模型不启动部署，部署成功后才保存新模型', async () => {
  const saved: string[] = []
  const installed = ['qwen3:4b', 'qwen3:0.6b']
  const { deployer, children, spawned, cleanup } = makeDeployer({
    saveModel: (model) => saved.push(model),
    fetchImpl: async (input, init) => String(input).endsWith('/api/tags')
      ? Response.json({ models: installed.map((name) => ({ name })) })
      : new Response('{}', { status: installed.includes(JSON.parse(String(init?.body)).model) ? 200 : 404 }),
  })
  try {
    const handler = createRequestHandler({ modelDeploy: deployer, live: {} } as DafeiyuPluginHandle)
    const call = async (path: string, model?: string) => {
      const res = makeRes()
      await handler(makeReq(model ? 'POST' : 'GET', '/api/dafeiyu/model/' + path,
        model ? JSON.stringify({ model }) : ''), res, async () => {})
      return { status: res.statusCode, body: JSON.parse(res.body) }
    }
    await call('deploy')
    await new Promise<void>((resolve) => setImmediate(resolve))
    const inventory = await call('deploy')
    assert.equal(inventory.body.models.find((option: { id: string }) => option.id === 'qwen3:0.6b').installed, true)
    const { review, ...deepseek } = inventory.body.models.find((option: { id: string }) => option.id === 'deepseek-r1:1.5b')
    assert.equal(typeof review.performance, 'string')
    assert.deepEqual(deepseek, {
      id: 'deepseek-r1:1.5b', label: 'DeepSeek-R1 1.5B', family: 'DeepSeek', source: 'registry', installed: false,
    })
    const babyBoon = inventory.body.models.find((option: { family: string }) => option.family === 'Baby Boon')
    assert.equal(babyBoon.source, 'huggingface')
    assert.equal(inventory.body.models.filter((option: { family: string }) => option.family === 'Lythri').length, 2)
    assert.equal(inventory.body.audioModels.length, 4)
    assert.equal((await call('deploy', inventory.body.audioModels[0].id)).status, 400)
    assert.equal((await call('switch', 'qwen3:8b')).status, 409)
    assert.equal((await call('deploy', 'unknown')).status, 400)
    assert.equal((await call('switch', 'qwen3:0.6b')).body.activeModel, 'qwen3:0.6b')
    assert.equal(spawned.length, 0)

    const started = await call('deploy', deepseek.id)
    assert.equal(started.status, 202)
    assert.equal(started.body.deploy.model, deepseek.id)
    assert.equal(started.body.activeModel, 'qwen3:0.6b')
    assert.equal(spawned[0]!.options.env?.DAFEIYU_OLLAMA_MODEL, deepseek.id)
    assert.equal((await call('deploy', 'qwen3:8b')).status, 409)
    assert.equal((await call('switch', 'qwen3:4b')).status, 409)

    children[0]!.emit('close', 1)
    assert.equal((await call('deploy')).body.activeModel, 'qwen3:0.6b')
    await call('deploy', deepseek.id)
    installed.push(deepseek.id)
    children[1]!.emit('close', 0)
    assert.equal((await call('deploy')).body.activeModel, deepseek.id)
    assert.deepEqual(saved, ['qwen3:0.6b', deepseek.id])
  } finally {
    cleanup()
  }
})

test('部署脚本从 Ollama 与 Hugging Face 拉取所选模型，验证后重复运行会复用', async (t) => {
  const installed = new Set<string>()
  const paths: string[] = []
  const requestedModels: string[] = []
  const verificationPrompts: string[] = []
  const server = createServer(async (req, res) => {
    paths.push(req.url ?? '')
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.40.16' }))
    const chunks = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const { model, messages } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requestedModels.push(model)
    if (req.url === '/api/show') {
      res.statusCode = installed.has(model) ? 200 : 404
      return res.end('{}')
    }
    if (req.url === '/api/pull') {
      installed.add(model)
      return res.end('{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n')
    }
    if (req.url === '/api/chat') {
      verificationPrompts.push(messages[0].content)
      return res.end(JSON.stringify({ message: { content: 'Hello!' } }))
    }
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => server.close())
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const script = fileURLToPath(new URL('../scripts/setup-ollama.mjs', import.meta.url))
  const run = (model: string) => promisify(execFile)(process.execPath, [script], {
    timeout: 10_000,
    env: {
      ...process.env,
      DAFEIYU_OLLAMA_MODEL: model,
      DAFEIYU_OLLAMA_URL: `http://127.0.0.1:${address.port}`,
      DAFEIYU_OLLAMA_PROXY: 'direct',
      DAFEIYU_OLLAMA_SOURCE: '',
      DAFEIYU_MODELSCOPE_REPO: '',
      DAFEIYU_MODELSCOPE_FILE: '',
    },
  })
  const gemma = 'gemma3:270m'
  const babyBoon = 'hf.co/maureesewilliams/baby-boon:Q4_K_M'
  assert.match((await run(gemma)).stdout, /Ollama 官方仓库[\s\S]*50%[\s\S]*gemma3:270m 已就绪/)
  assert.match((await run(babyBoon)).stdout, /Hugging Face GGUF[\s\S]*50%[\s\S]*baby-boon:Q4_K_M 已就绪/)
  assert.match((await run(babyBoon)).stdout, /已安装 hf\.co\/maureesewilliams\/baby-boon:Q4_K_M/)
  assert.deepEqual(paths, [
    '/api/version', '/api/show', '/api/pull', '/api/chat',
    '/api/version', '/api/show', '/api/pull', '/api/chat',
    '/api/version', '/api/show', '/api/chat',
  ])
  assert.deepEqual(requestedModels, [gemma, gemma, gemma, ...Array(5).fill(babyBoon)])
  assert.match(verificationPrompts[0]!, /请用中文/)
  assert.match(verificationPrompts[1]!, /Say hello/)
})
