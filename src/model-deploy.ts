/**
 * 一键部署本地模型（向导「模型与云端」步骤，0.14.1）：
 * 以子进程运行 scripts/setup-ollama.mjs（安装 Ollama → 拉取模型 → 试运行验证），
 * 进程输出作为进度日志（环形缓冲，最近 MAX_LOG_LINES 行），状态机 idle → running → ok | failed。
 *
 * - 幂等：脚本自身探测已安装的 Ollama/模型并跳过重复下载；running 期间 start() 原样返回。
 * - 进程环境：透传宿主环境 + ELECTRON_RUN_AS_NODE（Electron 宿主下以 Node 模式跑 .mjs）
 *   + DAFEIYU_DATA_DIR（安装目录跟随插件数据目录，而非脚本相对位置）。
 * - 不在界面收集任何凭据；代理等仍走环境变量（setup 脚本自读）。
 * - 进度行按 CR/LF 分割（curl --progress-bar 等 CR 回车刷新的输出独立成行）；
 *   另提供 probeOllamaInstallState() 供面板「未安装提示」探测服务/模型状态。
 */
import { type ChildProcess, type SpawnOptions, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Ollama 安装状态（面板「未安装提示」数据源）：服务可达 + 目标模型已导入。 */
export interface OllamaInstallState {
  readonly reachable: boolean
  readonly modelInstalled: boolean
  readonly ready: boolean
  readonly model: string
  readonly ollamaUrl: string
  readonly checkedAt: string
}

/**
 * 探测本机 Ollama 服务与目标模型是否就绪（GET model/deploy 附带；探测失败如实返回不可达，
 * 不猜测）：/api/tags 判服务、/api/show 判模型；两次探测共享同一超时预算。
 */
export async function probeOllamaInstallState(opts: {
  readonly ollamaUrl: string
  readonly model: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
  readonly now?: () => string
}): Promise<OllamaInstallState> {
  const doFetch = opts.fetchImpl ?? fetch
  const now = opts.now ?? (() => new Date().toISOString())
  const base = { model: opts.model, ollamaUrl: opts.ollamaUrl, checkedAt: now() }
  const withTimeout = async (p: (signal: AbortSignal) => Promise<Response>): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1_500)
    try {
      return await p(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    const tags = await withTimeout((signal) => doFetch(`${opts.ollamaUrl}/api/tags`, { signal }))
    if (!tags.ok) return { ...base, reachable: false, modelInstalled: false, ready: false }
  } catch {
    return { ...base, reachable: false, modelInstalled: false, ready: false }
  }
  try {
    const show = await withTimeout((signal) =>
      doFetch(`${opts.ollamaUrl}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model }),
        signal,
      }))
    const modelInstalled = show.ok
    return { ...base, reachable: true, modelInstalled, ready: modelInstalled }
  } catch {
    return { ...base, reachable: true, modelInstalled: false, ready: false }
  }
}

export type DeployStatus = 'idle' | 'running' | 'ok' | 'failed'

export interface DeploySnapshot {
  readonly status: DeployStatus
  /** 部署目标模型（DAFEIYU_OLLAMA_MODEL 或配置默认） */
  readonly model: string
  readonly ollamaUrl: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly error: string | null
  /** 部署进程最近输出（stdout/stderr 合并） */
  readonly log: readonly string[]
}

const MAX_LOG_LINES = 120

/** 可注入的 spawn（单测用；生产缺省 node:child_process.spawn）。 */
export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export class LocalModelDeployer {
  private child: ChildProcess | null = null
  private log: string[] = []
  private partial = ''
  private snapshot: DeploySnapshot
  private readonly now: () => string
  private readonly spawnFn: SpawnFn
  private readonly execPath: string

  private readonly opts: {
    /** 包根目录（scripts/setup-ollama.mjs 与 cwd） */
    readonly packageDir: string
    readonly dataDir: string
    readonly ollamaUrl: string
    readonly model: string
    readonly execPath?: string
    readonly spawnFn?: SpawnFn
    readonly now?: () => string
  }

  constructor(opts: LocalModelDeployer['opts']) {
    this.opts = opts
    this.now = opts.now ?? (() => new Date().toISOString())
    this.spawnFn = opts.spawnFn ?? spawn
    this.execPath = opts.execPath ?? process.execPath
    this.snapshot = {
      status: 'idle',
      model: opts.model,
      ollamaUrl: opts.ollamaUrl,
      startedAt: null,
      finishedAt: null,
      error: null,
      log: [],
    }
  }

  state(): DeploySnapshot {
    return this.snapshot
  }

  /** 启动（或复用进行中的）部署；返回当前状态快照。 */
  start(): DeploySnapshot {
    if (this.snapshot.status === 'running') return this.snapshot
    const script = join(this.opts.packageDir, 'scripts', 'setup-ollama.mjs')
    if (!existsSync(script)) {
      this.snapshot = {
        ...this.snapshot,
        status: 'failed',
        finishedAt: this.now(),
        error: `部署脚本不存在：${script}`,
      }
      return this.snapshot
    }
    this.log = []
    this.partial = ''
    const child = this.spawnFn(this.execPath, [script], {
      cwd: this.opts.packageDir,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        DAFEIYU_DATA_DIR: this.opts.dataDir,
        DAFEIYU_OLLAMA_URL: this.opts.ollamaUrl,
        ...(process.env.DAFEIYU_OLLAMA_MODEL === undefined ? { DAFEIYU_OLLAMA_MODEL: this.opts.model } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.snapshot = {
      ...this.snapshot,
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      log: [],
    }
    const ingest = (chunk: Buffer | string): void => {
      this.partial += chunk.toString('utf8')
      // 按 CR/LF 分割：兼容 curl --progress-bar 等 CR 回车刷新的单行进度输出独立成行
      const lines = this.partial.split(/[\r\n]+/)
      this.partial = lines.pop() ?? ''
      for (const line of lines) {
        if (line === '') continue
        this.log.push(line)
        if (this.log.length > MAX_LOG_LINES) this.log.shift()
      }
      this.snapshot = { ...this.snapshot, log: [...this.log] }
    }
    child.stdout?.on('data', ingest)
    child.stderr?.on('data', ingest)
    child.once('error', (err: Error) => this.finish('failed', err.message))
    child.once('exit', (code: number | null) =>
      this.finish(code === 0 ? 'ok' : 'failed', code === 0 ? null : `部署进程退出码 ${code ?? '已中断'}`))
    return this.snapshot
  }

  /** 插件卸载时终止进行中的部署进程（下载可随时安全重跑）。 */
  dispose(): void {
    this.child?.kill()
    this.child = null
  }

  private finish(status: 'ok' | 'failed', error: string | null): void {
    if (this.partial !== '') {
      this.log.push(this.partial)
      if (this.log.length > MAX_LOG_LINES) this.log.shift()
      this.partial = ''
    }
    this.child = null
    this.snapshot = {
      ...this.snapshot,
      status,
      finishedAt: this.now(),
      error,
      log: [...this.log],
    }
  }
}
