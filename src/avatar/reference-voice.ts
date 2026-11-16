/**
 * 参考音色本地合成（role-voices 运行时，零切片音色克隆内核）：
 * - 只用数据目录内自建的本地运行时（data/role-voices/.venv/bin/python，不经
 *   PATH 搜索），驱动随插件分发的固定版本助手脚本 scripts/synthesize-role-voice.py
 *   （packageDir 定位）；全程无 shell（execFile 传参数组）、无网络。
 * - argv 中只出现「受信任路径」：模型目录 / 参考音频路径由白名单档案 id 与
 *   dataDir 拼装（id 限 xiaxia/lubai/guyu/beila，与 role-speech 同一白名单），
 *   正文文本一律经 UTF-8 临时文件 --text-file 喂入，永不进入 argv。
 * - 运行时三件套（venv 解释器、model/config.json、references/<id>.wav）缺任一
 *   即视为「未安装」返回 null，由调用方静默降级（如回退 /usr/bin/say 或浏览器
 *   朗读）；已配置却合成失败则显式抛错，由调用方如实呈现。
 * - 输出 WAV 落在 mkdtemp 独立临时目录，读回后校验 RIFF/WAVE 容器与大小上限，
 *   finally 一律清理；单次合成 90s 超时（SIGKILL 子进程）。
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { packageDir } from '../index-wiring.ts'
import { ROLE_SPEECH_PROFILE_IDS, ROLE_SPEECH_TEXT_MAX } from './role-speech.ts'

const execFileAsync = promisify(execFile)

/** 助手脚本（随插件分发的固定版本，packageDir 定位，不经 PATH/网络获取）。 */
export const ROLE_VOICE_HELPER = 'scripts/synthesize-role-voice.py'

/** 单次合成超时：本地模型推理较慢，给足 90s；超时 SIGKILL。 */
export const REFERENCE_VOICE_TIMEOUT_MS = 90_000

/** 输出 WAV 上限（与 role-speech / 模型文件下发同一 24MB 口径）。 */
export const REFERENCE_VOICE_MAX_OUTPUT_BYTES = 24 * 1024 * 1024

export type ReferenceVoiceErrorCode =
  | 'unknown_profile'
  | 'invalid_text'
  | 'busy'
  | 'timeout'
  | 'output_too_large'
  | 'synthesis_failed'

export class ReferenceVoiceError extends Error {
  public readonly code: ReferenceVoiceErrorCode
  constructor(code: ReferenceVoiceErrorCode, message: string) {
    super(message)
    this.name = 'ReferenceVoiceError'
    this.code = code
  }
}

/** 本地运行时三件套的就绪路径（合成 argv 全部来自这里，均为受信任路径）。 */
export interface ReferenceVoiceRuntime {
  /** venv 内解释器（不经 PATH，防同名可执行文件劫持） */
  readonly pythonBin: string
  /** 模型目录（内含 config.json；--model 传目录） */
  readonly modelDir: string
  /** 该档案的参考音频（--reference） */
  readonly referenceWav: string
}

/** 常规文件且存在才计为就绪（目录/符号链接缺失等一律按未安装处理）。 */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * 定位本地运行时：venv 解释器、model/config.json、references/<id>.wav
 * 缺任一返回 null（未安装 → 调用方降级，不报错）。
 */
export function resolveReferenceVoiceRuntime(dataDir: string, profileId: string): ReferenceVoiceRuntime | null {
  const root = join(dataDir, 'role-voices')
  const pythonBin = join(root, '.venv', 'bin', 'python')
  const modelDir = join(root, 'model')
  const referenceWav = join(root, 'references', `${profileId}.wav`)
  if (
    !isRegularFile(pythonBin) ||
    !isRegularFile(join(modelDir, 'config.json')) ||
    !isRegularFile(join(modelDir, 'model.safetensors')) ||
    !isRegularFile(join(modelDir, 'speech_tokenizer', 'model.safetensors')) ||
    !isRegularFile(referenceWav)
  ) {
    return null
  }
  return { pythonBin, modelDir, referenceWav }
}

function describe(err: unknown): string {
  const e = err as { message?: string; code?: string; stderr?: string }
  if (e !== null && typeof e === 'object' && typeof e.message === 'string') {
    const head = e.code !== undefined && e.code !== '' ? `${e.message}（${e.code}）` : e.message
    if (typeof e.stderr === 'string' && e.stderr.trim() !== '') {
      // 助手脚本的 stderr 是定位失败原因的关键线索，截尾附上（防巨日志撑爆报错文案）
      return `${head}：${e.stderr.trim().slice(-500)}`
    }
    return head
  }
  return String(err)
}

/** execFile 超时会把子进程按 killSignal 杀掉并返回 killed/signal 标记。 */
function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; message?: string }
  if (e === null || typeof e !== 'object') return false
  return e.killed === true || e.signal === 'SIGKILL' || (e.message ?? '').includes('SIGKILL')
}

/** 容器级校验：RIFF/WAVE 魔数（编码格式由本地模型决定，不强制 PCM16）。 */
function assertWavContainer(buf: Buffer): void {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new ReferenceVoiceError('synthesis_failed', '参考音色输出不是有效 WAV（RIFF/WAVE）文件')
  }
}

/**
 * 用参考音色本地合成语音，返回 WAV 原始字节。
 * - 运行时未安装（三件套缺任一）→ null，调用方静默降级；
 * - 已配置却失败（脚本缺失/退出非 0/超时/输出异常）→ 抛 ReferenceVoiceError，
 *   调用方如实呈现，不得假装成功。
 */
let inFlight = false

export async function synthesizeReferenceVoice(
  dataDir: string,
  profileId: string,
  text: string,
): Promise<Buffer | null> {
  // 白名单先行：未知 id 是调用方 bug，显式抛错（绝不静默 null 掩盖）
  if (!(ROLE_SPEECH_PROFILE_IDS as readonly string[]).includes(profileId)) {
    throw new ReferenceVoiceError(
      'unknown_profile',
      `profileId 须为 ${ROLE_SPEECH_PROFILE_IDS.join('/')} 之一（收到：${profileId === '' ? '空' : profileId}）`,
    )
  }
  const normalized = text.trim()
  if (normalized.length === 0 || normalized.length > ROLE_SPEECH_TEXT_MAX) {
    throw new ReferenceVoiceError('invalid_text', `请输入 1–${ROLE_SPEECH_TEXT_MAX} 字的文字`)
  }

  const runtime = resolveReferenceVoiceRuntime(dataDir, profileId)
  if (runtime === null) return null

  const helper = join(packageDir(), ROLE_VOICE_HELPER)
  if (!isRegularFile(helper)) {
    throw new ReferenceVoiceError('synthesis_failed', `本地合成脚本缺失：${helper}（插件安装不完整，请重新安装）`)
  }

  if (inFlight) throw new ReferenceVoiceError('busy', '角色语音正在生成，请稍后再试')
  inFlight = true
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'dafeiyu-reference-voice-'))
    const textFile = join(dir, 'text.txt')
    const outFile = join(dir, 'output.wav')
    // 文本 ≤500 字（UTF-8 最多约 1.8KB），写入量天然有界
    await writeFile(textFile, normalized, 'utf8')
    try {
      await execFileAsync(runtime.pythonBin, [
        helper,
        '--model', runtime.modelDir,
        '--reference', runtime.referenceWav,
        '--text-file', textFile,
        '--output', outFile,
      ], {
        timeout: REFERENCE_VOICE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1', TRANSFORMERS_OFFLINE: '1' },
      })
    } catch (err) {
      if (isTimeout(err)) {
        throw new ReferenceVoiceError(
          'timeout',
          `参考音色合成超时（>${Math.round(REFERENCE_VOICE_TIMEOUT_MS / 1000)}s），请缩短文本后重试`,
        )
      }
      throw new ReferenceVoiceError('synthesis_failed', `参考音色合成失败：${describe(err)}`)
    }

    let wav: Buffer
    try {
      wav = await readFile(outFile)
    } catch {
      throw new ReferenceVoiceError('synthesis_failed', '参考音色合成未产出音频文件')
    }
    if (wav.length === 0) throw new ReferenceVoiceError('synthesis_failed', '参考音色合成产出为空')
    if (wav.length > REFERENCE_VOICE_MAX_OUTPUT_BYTES) {
      throw new ReferenceVoiceError(
        'output_too_large',
        `音频超出上限（${wav.length} > ${REFERENCE_VOICE_MAX_OUTPUT_BYTES} 字节），请缩短文本后重试`,
      )
    }
    assertWavContainer(wav)
    return wav
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
    inFlight = false
  }
}
