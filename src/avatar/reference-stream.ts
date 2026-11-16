import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { packageDir } from '../index-wiring.ts'
import {
  REFERENCE_VOICE_TIMEOUT_MS,
  ReferenceVoiceError,
  resolveReferenceVoiceRuntime,
  ROLE_VOICE_HELPER,
} from './reference-voice.ts'

type StreamAudio = { sampleRate: number; pcm: string }

interface SpeechJob {
  id: number
  signal: AbortSignal
  stopped: Promise<void>
  receive(chunk: StreamAudio): void
  finish(error?: unknown): void
}

/** One local model process per plugin instance. */
export class ReferenceVoiceStream {
  private process: ChildProcessWithoutNullStreams | undefined
  private ready: Promise<number> | undefined
  private rejectStartup: ((error: unknown) => void) | undefined
  private idleTimer?: ReturnType<typeof setTimeout>
  private job: SpeechJob | undefined
  private nextId = 0

  private readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  private start(profileId: string): Promise<number> | undefined {
    const runtime = resolveReferenceVoiceRuntime(this.dataDir, profileId)
    if (!runtime) return
    if (this.ready) return this.ready

    const child = spawn(runtime.pythonBin, [
      '-u', join(packageDir(), ROLE_VOICE_HELPER), '--worker',
      '--model', runtime.modelDir, '--references', join(this.dataDir, 'role-voices', 'references'),
    ], { env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1' } })
    this.process = child
    child.stderr.resume()

    this.ready = new Promise<number>((resolve, reject) => {
      let sampleRate = 0
      const fail = () => {
        clearTimeout(startTimer)
        if (this.process !== child) return
        const error = new ReferenceVoiceError('synthesis_failed', '本地语音进程已中断，请重试')
        reject(error)
        this.dispose(error)
      }
      const startTimer = setTimeout(fail, REFERENCE_VOICE_TIMEOUT_MS)
      this.rejectStartup = (error) => {
        clearTimeout(startTimer)
        reject(error)
      }
      child.once('error', fail)
      child.once('exit', fail)
      child.stdin.on('error', fail)

      createInterface({ input: child.stdout }).on('line', (line) => {
        if (this.process !== child) return
        let event
        try { event = JSON.parse(line) } catch { return }
        if (event?.type === 'ready' && Number.isInteger(event.sampleRate) &&
          event.sampleRate >= 8000 && event.sampleRate <= 48000) {
          sampleRate = event.sampleRate
          clearTimeout(startTimer)
          this.rejectStartup = undefined
          resolve(sampleRate)
          this.scheduleIdle()
        }
        const job = this.job
        if (!job || event?.id !== job.id) return
        if (event.type === 'audio' && sampleRate && typeof event.pcm === 'string' && event.pcm.length <= 512_000) {
          job.receive({ sampleRate, pcm: event.pcm })
        } else if (event.type === 'end' || event.type === 'error') {
          job.finish(event.type === 'error'
            ? new ReferenceVoiceError('synthesis_failed', '角色语音生成失败，请重试')
            : undefined)
        }
      })
    })
    return this.ready
  }

  warm(profileId: string): void {
    this.start(profileId)?.catch(() => {})
  }

  async speak(profileId: string, text: string, receive: SpeechJob['receive'], signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    const ready = this.start(profileId)
    if (!ready) return false
    await ready
    signal.throwIfAborted()
    const child = this.process
    if (!child) throw new ReferenceVoiceError('synthesis_failed', '本地语音进程已中断，请重试')
    if (this.job?.signal.aborted) await this.job.stopped
    signal.throwIfAborted()
    if (this.process !== child) return this.speak(profileId, text, receive, signal)
    if (this.job) throw new ReferenceVoiceError('busy', '上一条语音还在结束，请稍后重试')
    clearTimeout(this.idleTimer)

    const id = ++this.nextId
    await new Promise<void>((resolve, reject) => {
      let finishStop!: () => void
      const stopped = new Promise<void>((resolveStopped) => { finishStop = resolveStopped })
      let cancelTimer: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        child.stdin.write(JSON.stringify({ cancel: id }) + '\n')
        cancelTimer = setTimeout(() => this.dispose(signal.reason), 3500)
        reject(signal.reason)
      }
      const timer = setTimeout(() =>
        this.dispose(new ReferenceVoiceError('timeout', '角色语音生成超时，请缩短文本重试')), REFERENCE_VOICE_TIMEOUT_MS)
      this.job = {
        id, signal, stopped,
        receive: (chunk) => {
          if (signal.aborted) return
          try { receive(chunk) } catch (error) { this.dispose(error) }
        },
        finish: (error) => {
          clearTimeout(timer)
          clearTimeout(cancelTimer)
          signal.removeEventListener('abort', abort)
          this.job = undefined
          this.scheduleIdle()
          finishStop()
          if (error) reject(error)
          else resolve()
        },
      }
      signal.addEventListener('abort', abort, { once: true })
      child.stdin.write(JSON.stringify({ id, profileId, text }) + '\n')
    })
    return true
  }

  cancel(): void {
    if (this.job) this.dispose()
  }

  dispose(error: unknown = new ReferenceVoiceError('synthesis_failed', '本地语音已停止')): void {
    clearTimeout(this.idleTimer)
    const child = this.process
    this.process = undefined
    this.ready = undefined
    this.rejectStartup?.(error)
    this.rejectStartup = undefined
    this.job?.finish(error)
    child?.kill('SIGKILL')
  }

  private scheduleIdle(): void {
    clearTimeout(this.idleTimer)
    if (this.process && !this.job) this.idleTimer = setTimeout(() => this.dispose(), 5 * 60_000)
  }
}
