/**
 * Python 训练进程启动器（方案 §9.2 / §17 training-worker）。
 *
 * 协议：job JSON 经 stdin 传入；stdout 按行输出状态/回执 JSON；
 * 退出码 0 且含 receipt 行为成功。授权不通过退出码 2。
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

export interface TrainingJobSpec {
  readonly run_id: string
  readonly mode: 'dry_run' | 'qlora'
  readonly base_profile: string
  readonly max_steps: number
  readonly wall_budget_s: number
  readonly samples: readonly { readonly text: string }[]
  readonly replay_fraction: number
  readonly checkpoint_dir: string
  readonly resume_from: string | null
  readonly decision: {
    readonly id: string
    readonly action: string
    readonly payloadHash: string
    readonly epoch: number
    readonly expiresAt: string
    readonly result: 'allow' | 'deny' | 'review'
  }
}

export interface TrainingReceipt {
  readonly run_id: string
  readonly steps: number
  readonly params_changed: boolean
  readonly checkpoint_id: string
  readonly state: 'completed' | 'failed'
  readonly error?: string
}

export type WorkerEvent = { type: 'state'; state: string } | { type: 'receipt'; receipt: TrainingReceipt }

export function jobPayloadHash(spec: Omit<TrainingJobSpec, 'decision'>): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        run_id: spec.run_id,
        mode: spec.mode,
        base_profile: spec.base_profile,
        max_steps: spec.max_steps,
        samples: spec.samples.length,
        replay_fraction: spec.replay_fraction,
        resume_from: spec.resume_from,
      }),
    )
    .digest('hex')
}

/** 启动训练 worker 并等待最终回执（超时即取消进程，回执 timeout 错误）。 */
export function runTrainingWorker(
  spec: TrainingJobSpec,
  opts: {
    command?: string
    args?: readonly string[]
    cwd?: string
    timeoutMs: number
    env?: Readonly<Record<string, string>>
  },
): Promise<{ events: readonly WorkerEvent[]; receipt: TrainingReceipt | null; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const command = opts.command ?? 'python3'
    const args = opts.args ?? ['worker.py']
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const events: WorkerEvent[] = []
    let receipt: TrainingReceipt | null = null
    let stderr = ''
    let stdoutErrorLine: string | null = null
    let stdoutBuf = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill('SIGKILL')
    }, opts.timeoutMs)
    timer.unref?.()

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8')
      let nl: number
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim()
        stdoutBuf = stdoutBuf.slice(nl + 1)
        if (line === '') continue
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          if (parsed.type === 'state') {
            events.push({ type: 'state', state: String(parsed.state ?? '') })
          } else if (parsed.type === 'receipt') {
            receipt = parsed as unknown as TrainingReceipt
            events.push({ type: 'receipt', receipt })
          } else if (parsed.type === 'error') {
            stdoutErrorLine = String(parsed.error ?? '')
          }
        } catch {
          // 非 JSON 行忽略（worker 自由日志）
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (killed) {
        resolve({
          events,
          receipt: {
            run_id: spec.run_id,
            steps: 0,
            params_changed: false,
            checkpoint_id: '',
            state: 'failed',
            error: `worker 超时（${opts.timeoutMs}ms）被终止`,
          },
          exitCode: null,
        })
        return
      }
      if (receipt === null && code !== 0) {
        resolve({
          events,
          receipt: {
            run_id: spec.run_id,
            steps: 0,
            params_changed: false,
            checkpoint_id: '',
            state: 'failed',
            error: stdoutErrorLine ?? (stderr.trim().slice(0, 400) || `worker 退出码 ${code}`),
          },
          exitCode: code,
        })
        return
      }
      resolve({ events, receipt, exitCode: code })
    })

    child.stdin.write(JSON.stringify(spec))
    child.stdin.end()
  })
}

export function newRunId(): string {
  return `run_${randomUUID().slice(0, 12)}`
}
