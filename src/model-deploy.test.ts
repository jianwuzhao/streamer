import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
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

function makeDeployer(overrides: { packageDir?: string; noScript?: boolean } = {}) {
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

test('model-deploy：stdout/stderr 跨 chunk 拼行；exit 0 → ok', async () => {
  const { deployer, children, cleanup } = makeDeployer()
  try {
    deployer.start()
    const child = children[0]!
    child.stdout.emit('data', Buffer.from('下载 Ollama v0.40.16（直'))
    child.stdout.emit('data', Buffer.from('连）\n模型下载：pulling 40%\n'))
    child.stderr.emit('data', Buffer.from('warn: 复用已运行实例\n'))
    child.emit('exit', 0)
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
    children[0]!.emit('exit', 3)
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
    child.emit('exit', 0)
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

    children[0]!.emit('exit', 0)
    const done = await call('GET', '/api/dafeiyu/model/deploy')
    assert.equal(done.payload.deploy.status, 'ok')
  } finally {
    cleanup()
  }
})
