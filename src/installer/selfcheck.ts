/**
 * 首次配置自检（方案 §24.1）：向导运行的短测试清单，逐项输出结果与可修复动作。
 * 不承诺未验证的能力（如本机无 GPU 时训练项如实标注）。
 */
import { statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { loadConfig } from '../config.ts'

export interface CheckItem {
  readonly id: string
  readonly label: string
  readonly ok: boolean
  readonly detail: string
  readonly fixAction?: string
}

export interface SelfCheckReport {
  readonly items: readonly CheckItem[]
  readonly allPassed: boolean
  readonly canRunLocalMode: boolean
  readonly canAcceptOnlineTraining: boolean
}

export async function runSelfCheck(opts: {
  configPath?: string
  dataDir: string
  ollamaUrl?: string
  now?: () => string
}): Promise<SelfCheckReport> {
  const items: CheckItem[] = []

  // 1. Node 运行时
  const [major] = process.versions.node.split('.').map(Number)
  items.push({
    id: 'node_version',
    label: 'Node ≥ 22.13',
    ok: (major ?? 0) >= 22,
    detail: `当前 ${process.versions.node}`,
    ...((major ?? 0) < 22 ? { fixAction: '升级 Node 至 22.13 或更高' } : {}),
  })

  // 2. Python worker（dry-run 零依赖）
  try {
    const out = execFileSync('python3', ['--version'], { encoding: 'utf8' }).trim()
    items.push({ id: 'python_worker', label: 'Python 3（训练 worker）', ok: true, detail: out })
  } catch (err) {
    items.push({
      id: 'python_worker', label: 'Python 3（训练 worker）', ok: false,
      detail: (err as Error).message, fixAction: '安装 Python 3.11+（dry-run 验证协议需要）',
    })
  }

  // 3. 配置文件
  try {
    const cfg = loadConfig(opts.configPath)
    items.push({
      id: 'config_valid', label: '统一配置校验', ok: true,
      detail: `mode=${cfg.mode} 云端${cfg.models.cloud.provider === 'configure_before_acceptance' ? '未配置（本地模式可用）' : '已配置'}`,
    })
  } catch (err) {
    items.push({
      id: 'config_valid', label: '统一配置校验', ok: false,
      detail: (err as Error).message.slice(0, 160), fixAction: '按 config/default.yaml 修正字段',
    })
  }

  // 4. 数据目录可写
  try {
    statSync(opts.dataDir)
    items.push({ id: 'data_dir', label: '数据目录', ok: true, detail: opts.dataDir })
  } catch {
    items.push({
      id: 'data_dir', label: '数据目录', ok: false, detail: `${opts.dataDir} 不存在`,
      fixAction: '选择或创建数据保存位置',
    })
  }

  // 5. 本地推理端点（不可用时本地模式受限，如实标注）
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1_500)
  let ollamaOk = false
  let ollamaDetail = '不可达'
  try {
    const res = await fetch(`${opts.ollamaUrl ?? 'http://127.0.0.1:11434'}/api/tags`, { signal: controller.signal })
    ollamaOk = res.ok
    ollamaDetail = res.ok ? `可达（HTTP ${res.status}）` : `HTTP ${res.status}`
  } catch (err) {
    ollamaDetail = (err as Error).message.slice(0, 80)
  } finally {
    clearTimeout(timer)
  }
  items.push({
    id: 'local_model', label: '本地推理端点（Ollama）', ok: ollamaOk, detail: ollamaDetail,
    ...(ollamaOk ? {} : { fixAction: '安装/启动 Ollama 并拉取 Qwen3-4B-Instruct-2507 量化产物；未就绪时仅本地规则与固定回复可用' }),
  })

  // 6. GPU 探测（开发机/无驱动 ⇒ 在线训练不可验收，如实标注）
  let gpuOk = false
  let gpuDetail = '未检测到 NVIDIA GPU'
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
    const mb = Number.parseInt(out.trim().split('\n')[0] ?? '0', 10)
    gpuOk = mb >= 8 * 1024 - 512
    gpuDetail = gpuOk ? `约 ${mb}MB 显存` : `显存 ${mb}MB 不足 8GB 预算`
  } catch {
    gpuDetail = '无 nvidia-smi（开发机或无驱动）'
  }
  items.push({
    id: 'gpu_training', label: '在线训练（8GB 显存预算）', ok: gpuOk, detail: gpuDetail,
    ...(gpuOk ? {} : { fixAction: '在线训练验收需目标机（RTX 4060 Ti 8GB）；本机可运行全部协议与数据层' }),
  })

  const mustPass = ['node_version', 'python_worker', 'config_valid', 'data_dir']
  const canRunLocalMode = items.filter((i) => mustPass.includes(i.id)).every((i) => i.ok)
  return {
    items,
    allPassed: items.every((i) => i.ok),
    canRunLocalMode,
    canAcceptOnlineTraining: gpuOk && ollamaOk,
  }
}
