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
import localModels from '../config/local-models.json' with { type: 'json' }

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
type ModelSource = 'registry' | 'modelscope' | 'huggingface'

interface LocalModelOption {
  id: string
  label: string
  family: string
  source: ModelSource
  review?: { performance: string; strength: string; limitation: string; sourceUrl: string }
}

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
  private selectedModel: string
  private switching = false
  private disposed = false
  private readonly now: () => string
  private readonly spawnFn: SpawnFn
  private readonly execPath: string

  private readonly opts: {
    /** 包根目录（scripts/setup-ollama.mjs 与 cwd） */
    readonly packageDir: string
    readonly dataDir: string
    readonly ollamaUrl: string
    readonly model: string
    readonly savedModel?: string
    readonly saveModel?: (model: string) => void
    readonly fetchImpl?: typeof fetch
    readonly execPath?: string
    readonly spawnFn?: SpawnFn
    readonly now?: () => string
  }

  constructor(opts: LocalModelDeployer['opts']) {
    this.opts = opts
    this.now = opts.now ?? (() => new Date().toISOString())
    this.spawnFn = opts.spawnFn ?? spawn
    this.execPath = opts.execPath ?? process.execPath
    this.selectedModel = opts.savedModel && this.catalog().some(({ id }) => id === opts.savedModel)
      ? opts.savedModel : opts.model
    this.snapshot = {
      status: 'idle',
      model: this.selectedModel,
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

  get activeModel(): string {
    return this.selectedModel
  }

  get busy(): boolean {
    return this.switching || this.snapshot.status === 'running'
  }

  catalog(): readonly LocalModelOption[] {
    const forceRegistry = process.env.DAFEIYU_OLLAMA_SOURCE?.trim().toLowerCase() === 'registry'
    const hasCustomMirror = Boolean(process.env.DAFEIYU_MODELSCOPE_REPO?.trim() && process.env.DAFEIYU_MODELSCOPE_FILE?.trim())
    const source = (id: string, hasMirror: boolean): ModelSource =>
      !forceRegistry && hasMirror ? 'modelscope' : /^hf\.co\//i.test(id) ? 'huggingface' : 'registry'
    const models: LocalModelOption[] = localModels.map(({ id, label, family, mirror, review }) => ({
      id, label, family, source: source(id, Boolean(mirror) || (id === this.opts.model && hasCustomMirror)), review,
    }))
    if (!models.some(({ id }) => id === this.opts.model)) {
      models.push({ id: this.opts.model, label: this.opts.model, family: '自定义', source: source(this.opts.model, hasCustomMirror) })
    }
    return models
  }

  async installedModels(): Promise<{ reachable: boolean; models: string[]; checkedAt: string }> {
    const checkedAt = this.now()
    try {
      const response = await (this.opts.fetchImpl ?? fetch)(`${this.opts.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(1_200),
      })
      if (response.ok) {
        const body = await response.json() as { models?: { name?: string; model?: string }[] }
        if (Array.isArray(body.models)) {
          return {
            reachable: true,
            models: body.models.map((entry) => entry?.name ?? entry?.model).filter((name) => typeof name === 'string'),
            checkedAt,
          }
        }
      }
    } catch { /* Ollama 未就绪，下次轮询重试。 */ }
    return { reachable: false, models: [], checkedAt }
  }

  async switchModel(model: string): Promise<string | null> {
    if (this.busy) return '请等待当前模型操作完成'
    this.switching = true
    try {
      const install = await probeOllamaInstallState({ ...this.opts, model, timeoutMs: 1_200 })
      if (this.disposed) return '插件已卸载'
      if (!install.reachable) return 'Ollama 服务未连接，请启动服务后重试'
      if (!install.ready) return '所选模型未就绪，请先部署'
      this.activate(model)
      return null
    } finally {
      this.switching = false
    }
  }

  /** 启动（或复用进行中的）部署；返回当前状态快照。 */
  start(model = this.activeModel): DeploySnapshot {
    if (this.busy) return this.snapshot
    const script = join(this.opts.packageDir, 'scripts', 'setup-ollama.mjs')
    if (!existsSync(script)) {
      this.snapshot = {
        ...this.snapshot,
        model,
        status: 'failed',
        startedAt: null,
        finishedAt: this.now(),
        error: `部署脚本不存在：${script}`,
        log: [],
      }
      return this.snapshot
    }
    this.log = []
    this.partial = ''
    const env = process.platform === 'win32'
      ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
      : process.env
    const child = this.spawnFn(this.execPath, [script], {
      cwd: this.opts.packageDir,
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: '1',
        DAFEIYU_DATA_DIR: this.opts.dataDir,
        DAFEIYU_OLLAMA_URL: this.opts.ollamaUrl,
        DAFEIYU_OLLAMA_MODEL: model,
        // 自定义 GGUF 仅属于配置指定的模型，不能被导入为另一个预设。
        ...(model === this.opts.model ? {} : { DAFEIYU_MODELSCOPE_REPO: '', DAFEIYU_MODELSCOPE_FILE: '' }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.snapshot = {
      ...this.snapshot,
      model,
      status: 'running',
      startedAt: this.now(),
      finishedAt: null,
      error: null,
      log: [],
    }
    const ingest = (chunk: Buffer | string): void => {
      if (this.child !== child) return
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
    child.once('error', (err: Error) => {
      if (this.child === child) this.finish('failed', err.message)
    })
    child.once('close', (code: number | null) => {
      if (this.child !== child) return
      if (code !== 0) return this.finish('failed', `部署进程退出码 ${code ?? '已中断'}`)
      try {
        this.activate(model)
        this.finish('ok', null)
      } catch {
        this.finish('failed', '模型已验证，保存切换结果失败，请重试')
      }
    })
    return this.snapshot
  }

  /** 插件卸载时终止进行中的部署进程（下载可随时安全重跑）。 */
  dispose(): void {
    this.disposed = true
    const child = this.child
    this.child = null
    child?.kill()
  }

  private activate(model: string): void {
    if (model === this.selectedModel) return
    this.opts.saveModel?.(model)
    this.selectedModel = model
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
