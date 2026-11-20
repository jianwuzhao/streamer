import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, closeSync, openSync, writeSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import localModels from '../config/local-models.json' with { type: 'json' }

// Official release assets and SHA-256 values, pinned together.
const release = 'v0.40.16'
const archives = {
  'darwin-arm64': ['ollama-darwin.tgz', 'a743717494315da7cd352982b805f6b992d4b4452ca117fd5fbf86c4ee46fca0'],
  'darwin-x64': ['ollama-darwin.tgz', 'a743717494315da7cd352982b805f6b992d4b4452ca117fd5fbf86c4ee46fca0'],
  'linux-x64': ['ollama-linux-amd64.tar.zst', '87bfafb2acbc89b2e6a1be0a9043de6aa75fb450696f86bc426e65fc448f788d'],
  'linux-arm64': ['ollama-linux-arm64.tar.zst', 'e45b8e6dcb86cb9f3057396351655079c9a4879b4ced2678c9350d375dcbc224'],
  'win32-x64': ['ollama-windows-amd64.zip', '50fcf5ad54277f2fa5d173ebfc93bcb017adbc0c9ef2314daabc96ca9e6aa64e'],
  'win32-arm64': ['ollama-windows-arm64.zip', '86d2b329cae3125684ff29b506623710b68e1393f679594f1c6aa267beac31c2'],
}

const model = process.env.DAFEIYU_OLLAMA_MODEL?.trim() || 'qwen3:4b'
const root = join(resolve(process.env.DAFEIYU_DATA_DIR || fileURLToPath(new URL('../data', import.meta.url))), 'ollama')
const windows = process.platform === 'win32'

// 有镜像映射时直连 ModelScope，其余模型由 Ollama 拉取官方仓库的标签。
const repo = process.env.DAFEIYU_MODELSCOPE_REPO?.trim()
const file = process.env.DAFEIYU_MODELSCOPE_FILE?.trim()
const mirror = repo && file ? { repo, file } : localModels.find((entry) => entry.id === model)?.mirror
const useRegistry = process.env.DAFEIYU_OLLAMA_SOURCE?.trim().toLowerCase() === 'registry' || !mirror
const modelscopeBase = (process.env.DAFEIYU_MODELSCOPE_BASE || 'https://modelscope.cn').replace(/\/+$/, '')

function windowsTool(...segments) {
  return process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', ...segments) : segments.at(-1)
}

function macProxy() {
  if (process.platform !== 'darwin') return ''
  const { stdout } = spawnSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' })
  for (const kind of ['HTTPS', 'HTTP']) {
    const field = (suffix) => stdout?.match(new RegExp(`^\\s*${kind}${suffix}\\s*:\\s*(\\S+)`, 'm'))?.[1]
    if (field('Enable') === '1' && field('Proxy') && field('Port')) {
      const host = field('Proxy')
      return `http://${host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host}:${field('Port')}`
    }
  }
  return ''
}

function environment() {
  const selected = process.env.DAFEIYU_OLLAMA_PROXY ??
    (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || macProxy())
  // Windows 环境变量不区分大小写，规范化后再覆盖代理和服务的启动参数。
  const env = windows
    ? Object.fromEntries(Object.entries(process.env).map(([key, value]) => [key.toUpperCase(), value]))
    : { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NO_PROXY']) delete env[key]
  if (selected && selected !== 'direct') {
    const proxy = URL.canParse(selected) ? new URL(selected) : null
    if (!proxy || !['http:', 'https:'].includes(proxy.protocol)) {
      throw new Error('请设置 HTTP 或 HTTPS 代理地址。Clash 请使用 HTTP 或混合端口。')
    }
    env.HTTPS_PROXY = proxy.href
  }
  env.NO_PROXY = [process.env.NO_PROXY || process.env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',')
  return env
}

function run(bin, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(bin, args, { env, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`${bin} 执行失败（${code ?? '已中断'}）`)))
  })
}

async function installed(candidates) {
  for (const file of candidates) {
    try {
      await access(file)
      return file
    } catch { /* Try the next install location. */ }
  }
}

function gb(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** curl 下载（走 env 代理）：--progress-bar 的 \r 进度收敛为 ≥5% 一条的日志行。 */
function runCurl(file, url, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(windows ? windowsTool('curl.exe') : 'curl', ['-q', '--fail', '--location', '--retry', '3',
      '--connect-timeout', '15', '--proto', '=https', '--proto-redir', '=https',
      '--progress-bar', '--output', file, url], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let buffered = ''
    let lastPct = -1
    child.stderr.on('data', (chunk) => {
      buffered += chunk.toString('utf8')
      const parts = buffered.split(/[\r\n]+/)
      buffered = parts.pop() ?? ''
      for (const part of parts) {
        const pct = Number(part.match(/(\d+(?:\.\d+)?)%\s*$/)?.[1] ?? NaN)
        if (!Number.isNaN(pct)) {
          const whole = Math.floor(pct)
          if (whole >= lastPct + 5 || whole >= 100) {
            console.log(`下载 Ollama ${release}：${whole}%`)
            lastPct = whole
          }
        } else if (part.trim() !== '') console.log(part)
      }
    })
    child.once('error', reject)
    child.once('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`curl 执行失败（${code ?? '已中断'}）`))))
  })
}

/** ModelScope 直连下载 GGUF（不走代理）：断点续传 + 60s 无数据看门狗 + 百分比进度日志。 */
async function downloadGguf(url, dest) {
  const part = `${dest}.part`
  await mkdir(join(root, 'models'), { recursive: true, mode: 0o700 })
  for (let attempt = 1; attempt <= 3; attempt++) {
    let start = 0
    try {
      start = (await stat(part)).size
    } catch { /* 无历史分片则从头下载 */ }
    const controller = new AbortController()
    let watchdog
    const reset = () => {
      clearTimeout(watchdog)
      watchdog = setTimeout(() => controller.abort(new Error('下载停滞超过 60 秒')), 60_000)
    }
    try {
      const res = await fetch(url, {
        ...(start > 0 ? { headers: { range: `bytes=${start}-` } } : {}),
        redirect: 'follow',
        signal: controller.signal,
      })
      if (res.status === 404) {
        throw Object.assign(new Error('ModelScope 上未找到该模型文件（404）：请检查 DAFEIYU_MODELSCOPE_REPO / DAFEIYU_MODELSCOPE_FILE'), { fatal: true })
      }
      if (!res.ok || (start > 0 && res.status !== 206)) throw new Error(`HTTP ${res.status}`)
      const resumed = start > 0 && res.status === 206
      if (!resumed) start = 0
      const total = Number(res.headers.get('content-length') || 0) + (resumed ? start : 0)
      console.log(`开始下载模型权重（ModelScope 直连，无需代理）${resumed ? `，续传自 ${gb(start)}` : ''}`)
      const output = openSync(part, resumed ? 'a' : 'w')
      let done = start
      let lastPct = -1
      let lastLog = Date.now()
      try {
        reset()
        for await (const chunk of res.body) {
          writeSync(output, chunk)
          reset()
          done += chunk.length
          if (total > 0) {
            const pct = Math.floor((100 * done) / total)
            const now = Date.now()
            if (pct !== lastPct && (pct - lastPct >= 5 || pct >= 100 || now - lastLog > 10_000)) {
              console.log(`模型下载：${pct}%（${gb(done)} / ${gb(total)}）`)
              lastPct = pct
              lastLog = now
            }
          }
        }
      } finally {
        closeSync(output)
      }
      if (total > 0 && done < total) throw new Error('连接中断（内容不完整）')
      if (total === 0 && done < 100 * 1024 * 1024) throw new Error('响应未提供长度且内容过小，疑似错误页')
      await rename(part, dest)
      return
    } catch (error) {
      if (error.fatal || attempt === 3) {
        throw new Error(`ModelScope 下载失败（${error.message}）${error.fatal ? '' : '。可重跑续传，或设 DAFEIYU_OLLAMA_SOURCE=registry 走官方仓库（需要代理）。'}`)
      }
      console.log(`下载中断（${error.message}），第 ${attempt + 1} 次续传重试…`)
      await wait(2_000)
    } finally {
      clearTimeout(watchdog)
    }
  }
}

/** 把权重流式推送进本地 Ollama blob 存储（loopback POST /api/blobs/:digest，不占内存）。 */
function pushBlob(base, digest, file) {
  return new Promise((resolvePush, reject) => {
    stat(file).then(
      (info) => {
        const req = request(new URL(`/api/blobs/${digest}`, base), {
          method: 'POST',
          headers: { 'content-length': info.size, 'content-type': 'application/octet-stream' },
        }, (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            if (response.statusCode === 201) return resolvePush()
            reject(new Error(`权重注册失败（HTTP ${response.statusCode}）：${Buffer.concat(chunks).toString('utf8').slice(0, 160)}`))
          })
        })
        req.on('error', reject)
        createReadStream(file).pipe(req)
      },
      reject,
    )
  })
}

/** 从已注册的 GGUF 创建模型（现代 Ollama：POST /api/create { model, files }，流式状态日志）。 */
async function createFromGguf(base, file, digest) {
  const response = await call(base, '/api/create', { model, files: { [file]: `sha256:${digest}` } }, 10 * 60 * 1000)
  if (response.statusCode !== 200) {
    throw new Error('模型导入失败：本机 Ollama 版本可能过旧（建议 ≥ 0.5），或查看服务日志。')
  }
  const lines = createInterface({ input: response, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) continue
    const progress = JSON.parse(line)
    if (progress.error) throw new Error(`模型导入失败：${progress.error}`)
    if (progress.status && progress.status !== 'success') console.log(`模型导入：${progress.status}`)
  }
}

/** ModelScope 直连导入：下载/校验 GGUF → 注册 blob → create 命名目标模型 → 清理原始权重。 */
async function importModelscope(base, target) {
  const dest = join(root, 'models', target.file)
  const url = `${modelscopeBase}/models/${target.repo}/resolve/master/${target.file}`
  let digest = ''
  try {
    digest = (await readFile(`${dest}.sha256`, 'utf8')).trim()
  } catch { /* 无缓存校验文件则重算 */ }
  if (digest === '' || !(await exists(dest))) {
    if (await exists(dest)) {
      console.log('校验已下载的模型权重…')
    } else {
      await downloadGguf(url, dest)
    }
    digest = await sha256File(dest)
    await writeFile(`${dest}.sha256`, `${digest}\n`, { mode: 0o600 })
  }
  console.log(`注册权重到本地 Ollama（${target.file}，sha256:${digest.slice(0, 12)}…）`)
  await pushBlob(base, `sha256:${digest}`, dest)
  await createFromGguf(base, target.file, digest)
  await rm(dest, { force: true })
  await rm(`${dest}.sha256`, { force: true })
  console.log('已导入模型并清理原始权重文件')
}

async function extractArchive(file, payload, env) {
  if (!windows) return run('tar', ['-xf', file, '-C', payload], env)
  try {
    await run(windowsTool('tar.exe'), ['-xf', file, '-C', payload], env)
  } catch {
    await run(windowsTool('WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:DAFEIYU_ZIP_PATH -DestinationPath $env:DAFEIYU_ZIP_DEST -Force',
    ], { ...env, DAFEIYU_ZIP_PATH: file, DAFEIYU_ZIP_DEST: payload })
  }
}

async function install(env) {
  const executable = windows ? 'ollama.exe' : process.platform === 'linux' ? 'bin/ollama' : 'ollama'
  const target = join(root, release)
  const standardApp = process.platform === 'darwin' ? ['/Applications/Ollama.app/Contents/Resources/ollama'] : []
  const name = windows ? 'ollama.exe' : 'ollama'
  const bin = await installed([
    join(target, executable),
    ...(env.PATH || '').split(delimiter).filter(Boolean).map((entry) => join(windows ? entry.replace(/^"|"$/g, '') : entry, name)),
    ...standardApp,
    ...(windows && env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Programs', 'Ollama', name)] : []),
  ])
  if (bin) {
    console.log(`复用已安装的 Ollama：${bin}`)
    return bin
  }

  const asset = archives[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error('当前系统架构没有预置安装包，请安装 Ollama 后重试。')
  const [filename, expected] = asset
  const staging = await mkdtemp(join(root, 'install-'))
  try {
    const file = process.env.DAFEIYU_OLLAMA_ARCHIVE || join(staging, filename)
    if (!process.env.DAFEIYU_OLLAMA_ARCHIVE) {
      console.log(`下载 Ollama ${release}（${env.HTTPS_PROXY ? '使用代理' : '直连'}）`)
      try {
        await runCurl(file, `https://github.com/ollama/ollama/releases/download/${release}/${filename}`, env)
      } catch {
        throw new Error('安装包下载失败。请检查代理，或用 DAFEIYU_OLLAMA_ARCHIVE 指向官方安装包。')
      }
    }
    if (await sha256File(file) !== expected) throw new Error('安装包 SHA-256 与官方发布值不符。')
    const payload = join(staging, 'runtime')
    await mkdir(payload)
    console.log('正在解压已校验的 Ollama 安装包…')
    await extractArchive(resolve(file), payload, env)
    await access(join(payload, executable))
    await rename(payload, target).catch(async (error) => {
      if (!await installed([join(target, executable)])) throw error
    })
    return join(target, executable)
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 })
  }
}

function call(base, path, data, timeout = 3500) {
  return new Promise((resolveResponse, reject) => {
    const body = data === undefined ? undefined : JSON.stringify(data)
    const req = request(new URL(path, base), {
      agent: false,
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      signal: AbortSignal.timeout(timeout),
    }, resolveResponse)
    req.on('error', reject)
    req.end(body)
  })
}

async function json(base, path, data, timeout) {
  const response = await call(base, path, data, timeout)
  const chunks = []
  for await (const chunk of response) chunks.push(chunk)
  return { status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}

async function reachable(base) {
  try {
    const response = await json(base, '/api/version')
    if (response.status !== 200 || typeof response.body.version !== 'string') throw new Error('unexpected version response')
    return true
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return false
    throw new Error('本机端口无法通过 Ollama 检查，请确认端口占用和服务状态。')
  }
}

async function pull(base) {
  const response = await call(base, '/api/pull', { model, stream: true }, 4 * 60 * 60 * 1000)
  const lines = createInterface({ input: response, crlfDelay: Infinity })
  let lastStatus = ''
  let lastProgress = 0
  for await (const line of lines) {
    if (!line) continue
    const progress = JSON.parse(line)
    if (progress.error || response.statusCode !== 200) throw new Error('模型仓库下载失败，请检查 Ollama 服务使用的代理和网络。')
    if (progress.status === 'success') return
    const now = Date.now()
    if (progress.status !== lastStatus || now - lastProgress > 5000) {
      const percent = progress.total > 0 ? ` ${Math.floor(100 * (progress.completed || 0) / progress.total)}%` : ''
      console.log(`模型下载：${progress.status}${percent}`)
      lastStatus = progress.status
      lastProgress = now
    }
  }
  throw new Error('模型下载连接中断，请重试。')
}

async function main() {
  const base = new URL(process.env.DAFEIYU_OLLAMA_URL || 'http://127.0.0.1:11434')
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
      base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('一键配置使用本机 HTTP 端点，例如 http://127.0.0.1:11434。')
  }
  const env = environment()
  const existing = await reachable(base)
  if (!existing) {
    await mkdir(root, { recursive: true, mode: 0o700 })
    const bin = await install(env)
    const logfile = join(root, 'serve.log')
    const log = openSync(logfile, 'a', 0o600)
    const child = spawn(bin, ['serve'], {
      cwd: dirname(bin),
      env: { ...env, OLLAMA_HOST: `${base.hostname}:${base.port || '80'}`, OLLAMA_NO_CLOUD: '1' },
      detached: true, windowsHide: true, stdio: ['ignore', log, log],
    })
    closeSync(log)
    let crashed = false
    child.once('error', () => { crashed = true })
    child.once('exit', () => { crashed = true })
    child.unref()
    let started = false
    for (let attempt = 0; attempt < 60 && !crashed; attempt++) {
      await wait(500)
      if (await reachable(base)) { started = true; break }
    }
    if (!started) throw new Error(`Ollama 启动失败，请查看 ${logfile}`)
    console.log(`已启动 Ollama（PID ${child.pid}）`)
  }
  const show = await json(base, '/api/show', { model })
  if (show.status === 404) {
    if (useRegistry) {
      console.log(/^hf\.co\//i.test(model) ? '模型来源：Hugging Face GGUF（由 Ollama 拉取）' : '模型来源：Ollama 官方仓库')
      if (existing && env.HTTPS_PROXY) console.log('正在复用已运行的 Ollama。模型下载使用该服务启动时的代理设置。')
      try {
        await pull(base)
      } catch (error) {
        if (existing && env.HTTPS_PROXY) {
          throw new Error('模型下载失败。请先在原有 Ollama 服务中设置 HTTPS_PROXY 后重启，或退出它后重跑本命令。')
        }
        throw error
      }
    } else {
      console.log(`模型来源：ModelScope 国内镜像（${modelscopeBase}，直连下载）`)
      await importModelscope(base, mirror)
    }
  } else if (show.status !== 200) {
    throw new Error('无法查询 Ollama 模型，请检查服务版本和日志。')
  } else {
    console.log(`已安装 ${model}`)
  }
  console.log('正在验证模型能否生成回复…')
  const result = await json(base, '/api/chat', {
    model, messages: [{ role: 'user', content: /^hf\.co\/maureesewilliams\/baby-boon:/i.test(model)
      ? 'Say hello in one short sentence.' : '请用中文打个简短的招呼。' }],
    think: false, stream: false, options: { num_predict: 24 },
  }, 180_000)
  if (result.status !== 200 || !result.body.message?.content?.trim()) {
    throw new Error('模型已下载，但试运行未生成文本，请查看 Ollama 日志。')
  }
  console.log(`${model} 已就绪 · ${base.origin}`)
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
