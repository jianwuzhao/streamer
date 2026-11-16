/**
 * macOS 角色语音后端（preview/role-speech 的合成内核）：
 * - 只用本机 `/usr/bin/say`（execFile 传参数组，无 shell、无网络、无远程调用）；
 * - 文本一律经 UTF-8 临时文件 `-f` 喂入，正文永不出现在 argv（杜绝 `--`/`-r` 等旗标注入）；
 * - 输出 WAV（`--data-format=LEI16@22050` + `.wav` 扩展名 → RIFF/WAVE 16-bit PCM），
 *   已在本机 macOS 26.6 实测（详见下方「实测」注释）；
 * - 角色音色为固定映射（白名单 4 个档案 id），音色缺失时显式报错——`say` 对未知
 *   音色名会静默回落系统默认音色且退出码为 0，因此必须先解析 `say -v ?` 确认
 *   「显示名 + zh-CN 区域」确实安装，绝不能只看退出码；
 * - 临时文件落在 `os.tmpdir()` 下的独立 mkdtemp 目录，读回后 finally 一律清理；
 * - 并发上限用模块级计数（超限显式 busy），单次合成有超时（超时 SIGKILL 子进程）。
 *
 * 客户端约定：platform_unsupported / voice_unavailable / busy / timeout 等错误带
 * `code` + `fallback: true`，面板据此回退浏览器 speechSynthesis 朗读。
 *
 * 实测（macOS 26.6.2，arm64，/usr/bin/say）：
 * - `say -v 'Sandy (中文（中国大陆）)' -r 190 -f in.txt -o out.wav --data-format=LEI16@22050`
 *   → RIFF/WAVE，fmt=PCM(1)/单声道/22050Hz/16bit，中文 12 字约 3.5s（159,952B）；
 * - `say -v Sandy`（不带区域的裸名）→ 错误区域回落，0.016s 静音（4,800B），
 *   所以多区域音色必须带「(区域名)」全名；
 * - `say -v NoSuchVoice` → 退出码 0 且用默认音色正常出声（3.69s），退出码不可信；
 * - `say -v ?` 输出形如 `Sandy (中文（中国大陆）)      zh_CN    # 你好！我叫Sandy。`，
 *   fmt 块前还有 JUNK 块（解析 WAV 头须按 chunk 游走，不能固定偏移）。
 */
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 固定二进制路径：不经 PATH 搜索，避免被同名可执行文件劫持。 */
export const SAY_BIN = '/usr/bin/say'

/** 支持角色语音的档案 id 白名单。 */
export const ROLE_SPEECH_PROFILE_IDS = ['xiaxia', 'lubai', 'guyu', 'beila', 'dsh-pet'] as const
export type RoleSpeechProfileId = (typeof ROLE_SPEECH_PROFILE_IDS)[number]

export interface RoleSpeechVoice {
  readonly profileId: RoleSpeechProfileId
  /** 下发给客户端展示的音色名 */
  readonly voiceName: string
  /** 传给 `say -v` 的精确值（多区域音色必须带「(区域名)」全名，见文件头实测） */
  readonly sayVoice: string
  /** `say -v ?` 中该行应处的区域码（下划线统一归一为连字符比较） */
  readonly locale: string
  /** `say -r` 语速（字/分钟） */
  readonly rateWpm: number
}

/** 角色音色映射。 */
export const ROLE_SPEECH_VOICES: readonly RoleSpeechVoice[] = [
  { profileId: 'xiaxia', voiceName: 'Sandy（中文（中国大陆））', sayVoice: 'Sandy (中文（中国大陆）)', locale: 'zh-CN', rateWpm: 190 },
  { profileId: 'lubai', voiceName: 'Tingting（中文（中国大陆））', sayVoice: 'Tingting', locale: 'zh-CN', rateWpm: 153 },
  { profileId: 'guyu', voiceName: 'Flo（中文（中国大陆））', sayVoice: 'Flo (中文（中国大陆）)', locale: 'zh-CN', rateWpm: 168 },
  { profileId: 'beila', voiceName: 'Shelley（中文（中国大陆））', sayVoice: 'Shelley (中文（中国大陆）)', locale: 'zh-CN', rateWpm: 206 },
  { profileId: 'dsh-pet', voiceName: 'Rocko（中文（中国大陆））', sayVoice: 'Rocko (中文（中国大陆）)', locale: 'zh-CN', rateWpm: 192 },
]

const DESKPET_STYLES = new Map([
  ['qing-wan', { sayVoice: 'Sandy (中文（中国大陆）)', rateWpm: 178 }],
  ['chen-lang', { sayVoice: 'Reed (中文（中国大陆）)', rateWpm: 163 }],
  ['tong-qu', { sayVoice: 'Rocko (中文（中国大陆）)', rateWpm: 205 }],
  ['ping-shi', { sayVoice: 'Tingting', rateWpm: 188 }],
])

/** 文本上限（与 preview/chat 同一口径，UTF-16 码点计）。 */
export const ROLE_SPEECH_TEXT_MAX = 500

export type RoleSpeechErrorCode =
  | 'unknown_profile'
  | 'invalid_text'
  | 'platform_unsupported'
  | 'voice_unavailable'
  | 'busy'
  | 'timeout'
  | 'output_too_large'
  | 'synthesis_failed'

const DEFAULT_STATUS: Readonly<Record<RoleSpeechErrorCode, number>> = {
  unknown_profile: 400,
  invalid_text: 400,
  platform_unsupported: 501,
  voice_unavailable: 503,
  busy: 429,
  timeout: 504,
  output_too_large: 413,
  synthesis_failed: 500,
}

/** 可回退浏览器朗读的错误集合（服务端/环境不可用类）。 */
const FALLBACK_CODES: ReadonlySet<RoleSpeechErrorCode> = new Set([
  'platform_unsupported',
  'voice_unavailable',
  'busy',
  'timeout',
  'output_too_large',
  'synthesis_failed',
])

export class RoleSpeechError extends Error {
  public readonly code: RoleSpeechErrorCode
  public readonly status: number
  /** true = 客户端应回退浏览器本地朗读 */
  public readonly fallback: boolean
  constructor(code: RoleSpeechErrorCode, message: string, opts: { status?: number; fallback?: boolean } = {}) {
    super(message)
    this.name = 'RoleSpeechError'
    this.code = code
    this.status = opts.status ?? DEFAULT_STATUS[code]
    this.fallback = opts.fallback ?? FALLBACK_CODES.has(code)
  }
}

export interface RoleSpeechResult {
  /** WAV（RIFF/PCM 16-bit）原始字节的 base64 */
  readonly audioBase64: string
  readonly voiceName: string
  readonly bytes: number
  readonly sampleRateHz: number
  readonly durationMs: number
}

/** 按白名单 id 取音色映射；未知 id 返回 null。 */
export function resolveRoleSpeechVoice(profileId: string): RoleSpeechVoice | null {
  return ROLE_SPEECH_VOICES.find((v) => v.profileId === profileId) ?? null
}

function describe(err: unknown): string {
  const e = err as { message?: string; code?: string }
  if (e !== null && typeof e === 'object' && typeof e.message === 'string') {
    return e.code !== undefined && e.code !== '' ? `${e.message}（${e.code}）` : e.message
  }
  return String(err)
}

/** execFile 超时会把子进程按 killSignal 杀掉并返回 killed/signal 标记。 */
function isTimeout(err: unknown): boolean {
  const e = err as { killed?: boolean; signal?: string | null; message?: string }
  if (e === null || typeof e !== 'object') return false
  return e.killed === true || e.signal === 'SIGKILL' || (e.message ?? '').includes('SIGKILL')
}

/**
 * 解析 `say -v ?` 输出为「显示名\n区域码」键集合。
 * 行形如 `Sandy (中文（中国大陆）)      zh_CN    # 你好！我叫Sandy。`：
 * 以 ` # ` 截去示例文本后，行尾的 xx_XX 记为区域码，其余（去尾空白）为显示名。
 */
export function parseVoiceList(out: string): Set<string> {
  const keys = new Set<string>()
  for (const raw of out.split('\n')) {
    const hashAt = raw.indexOf(' # ')
    const head = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trimEnd()
    if (head === '') continue
    const match = head.match(/^(.*?)[ \t]+([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)$/)
    if (match === null) continue
    const name = match[1]!.trim()
    const locale = match[2]!.replace(/_/g, '-')
    if (name === '') continue
    keys.add(`${name}\n${locale}`)
  }
  return keys
}

/** 校验 RIFF/WAVE 为 PCM 16-bit（按 chunk 游走定位 fmt，兼容 macOS 的 JUNK 前置块）。 */
function inspectWav(buf: Buffer): { sampleRateHz: number; channels: number } {
  const bad = (why: string) => new RoleSpeechError('synthesis_failed', `角色语音输出异常（${why}）`)
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw bad('不是 WAV 文件')
  }
  let off = 12
  let fmt: { sampleRateHz: number; channels: number } | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      if (off + 8 + 16 > buf.length) throw bad('fmt 块不完整')
      const format = buf.readUInt16LE(off + 8)
      const channels = buf.readUInt16LE(off + 10)
      const sampleRateHz = buf.readUInt32LE(off + 12)
      const bitsPerSample = buf.readUInt16LE(off + 8 + 14)
      if (format !== 1) throw bad(`非 PCM 编码（format=${format}）`)
      if (bitsPerSample !== 16) throw bad(`非 16-bit（bits=${bitsPerSample}）`)
      fmt = { sampleRateHz, channels }
      break
    }
    off += 8 + size + (size % 2)
  }
  if (fmt === null) throw bad('缺少 fmt 块')
  return fmt
}

export interface RoleSpeechOptions {
  readonly sayBin?: string
  readonly timeoutMs?: number
  readonly listTimeoutMs?: number
  readonly voiceListTtlMs?: number
  readonly maxOutputBytes?: number
  readonly maxConcurrency?: number
}

export class RoleSpeechService {
  private readonly sayBin: string
  private readonly timeoutMs: number
  private readonly listTimeoutMs: number
  private readonly voiceListTtlMs: number
  private readonly maxOutputBytes: number
  private readonly maxConcurrency: number
  private voiceCache: Set<string> | null = null
  private voiceCacheAt = 0
  private inFlight = 0

  constructor(opts: RoleSpeechOptions = {}) {
    this.sayBin = opts.sayBin ?? SAY_BIN
    this.timeoutMs = opts.timeoutMs ?? 60_000
    this.listTimeoutMs = opts.listTimeoutMs ?? 8_000
    this.voiceListTtlMs = opts.voiceListTtlMs ?? 60_000
    this.maxOutputBytes = opts.maxOutputBytes ?? 24 * 1024 * 1024
    this.maxConcurrency = opts.maxConcurrency ?? 2
  }

  /** 平台与二进制是否可用（快速失败，不启动合成）。 */
  platformSupported(): { ok: boolean; reason: string | null } {
    if (process.platform !== 'darwin') {
      return { ok: false, reason: `角色语音仅支持 macOS（/usr/bin/say），当前平台为 ${process.platform}` }
    }
    try {
      if (!statSync(this.sayBin).isFile()) return { ok: false, reason: `未找到 ${this.sayBin}` }
    } catch {
      return { ok: false, reason: `未找到 ${this.sayBin}` }
    }
    return { ok: true, reason: null }
  }

  private assertPlatform(): void {
    const check = this.platformSupported()
    if (!check.ok) {
      throw new RoleSpeechError('platform_unsupported', `${check.reason}；请改用浏览器本地朗读`)
    }
  }

  /** 已安装音色键集合（带 TTL 缓存，避免每次请求都拉起子进程）。 */
  private async installedVoices(force = false): Promise<Set<string>> {
    const now = Date.now()
    if (!force && this.voiceCache !== null && now - this.voiceCacheAt < this.voiceListTtlMs) {
      return this.voiceCache
    }
    let stdout: string
    try {
      const out = await execFileAsync(this.sayBin, ['-v', '?'], {
        encoding: 'utf8',
        timeout: this.listTimeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      })
      stdout = out.stdout
    } catch (err) {
      throw new RoleSpeechError('voice_unavailable', `无法读取系统音色列表（${this.sayBin} -v ?）：${describe(err)}`)
    }
    this.voiceCache = parseVoiceList(stdout)
    this.voiceCacheAt = now
    return this.voiceCache
  }

  /** 当前并发中的合成数（诊断/测试用）。 */
  get activeJobs(): number {
    return this.inFlight
  }

  /**
   * 合成角色语音：文本经 UTF-8 临时文件 `-f` 喂入，输出 WAV 后读回并清理。
   * 并发超上限直接显式 busy（不排队），由客户端决定重试或回退浏览器朗读。
   */
  async synthesize(profileId: string, text: string, voiceId?: string): Promise<RoleSpeechResult> {
    const voice = resolveRoleSpeechVoice(profileId)
    if (voice === null) {
      throw new RoleSpeechError(
        'unknown_profile',
        `profileId 须为 ${ROLE_SPEECH_PROFILE_IDS.join('/')} 之一（收到：${profileId === '' ? '空' : profileId}）`,
      )
    }
    const normalized = text.trim()
    if (normalized.length === 0 || normalized.length > ROLE_SPEECH_TEXT_MAX) {
      throw new RoleSpeechError('invalid_text', `请输入 1–${ROLE_SPEECH_TEXT_MAX} 字的文字`)
    }
    this.assertPlatform()
    if (this.inFlight >= this.maxConcurrency) {
      throw new RoleSpeechError('busy', '角色语音合成忙（请稍后重试，或先用浏览器朗读）')
    }
    this.inFlight += 1
    try {
      const style = profileId === 'dsh-pet' && voiceId ? DESKPET_STYLES.get(voiceId) : undefined
      return await this.run(style ? { ...voice, ...style, voiceName: style.sayVoice } : voice, normalized)
    } finally {
      this.inFlight -= 1
    }
  }

  private async run(voice: RoleSpeechVoice, text: string): Promise<RoleSpeechResult> {
    // 音色可用性必须显式确认：say 对未知音色名会静默回落默认音色且退出码为 0
    let voices: Set<string>
    try {
      voices = await this.installedVoices()
    } catch (err) {
      if (err instanceof RoleSpeechError) throw err
      throw new RoleSpeechError('voice_unavailable', `无法确认系统音色：${describe(err)}`)
    }
    if (!voices.has(`${voice.sayVoice}\n${voice.locale}`)) {
      throw new RoleSpeechError(
        'voice_unavailable',
        `系统未安装角色音色 ${voice.voiceName}，请在「系统设置 → 辅助功能 → 朗读内容 → 系统声线」下载后重试，或改用浏览器朗读`,
      )
    }

    // 每次合成独立临时目录；正文只进文件，argv 中不出现任何用户输入
    const dir = await mkdtemp(join(tmpdir(), 'dafeiyu-role-speech-'))
    try {
      const inputFile = join(dir, 'input.txt')
      const outFile = join(dir, 'speech.wav')
      // 文本 ≤500 字（UTF-8 最多约 1.8KB），写入量天然有界
      await writeFile(inputFile, text, 'utf8')
      try {
        await execFileAsync(this.sayBin, [
          '-v', voice.sayVoice,
          '-r', String(voice.rateWpm),
          '-f', inputFile,
          '-o', outFile,
          '--data-format=LEI16@22050',
        ], { timeout: this.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 })
      } catch (err) {
        if (isTimeout(err)) {
          throw new RoleSpeechError('timeout', `角色语音合成超时（>${Math.round(this.timeoutMs / 1000)}s），请缩短文本后重试`)
        }
        throw new RoleSpeechError('synthesis_failed', `角色语音合成失败：${describe(err)}`)
      }

      let wav: Buffer
      try {
        wav = await readFile(outFile)
      } catch {
        throw new RoleSpeechError('synthesis_failed', '角色语音合成未产出音频文件')
      }
      if (wav.length === 0) throw new RoleSpeechError('synthesis_failed', '角色语音合成产出为空')
      if (wav.length > this.maxOutputBytes) {
        throw new RoleSpeechError(
          'output_too_large',
          `音频超出下发上限（${wav.length} > ${this.maxOutputBytes} 字节），请缩短文本后重试`,
        )
      }
      const { sampleRateHz, channels } = inspectWav(wav)
      const dataBytes = wavDataBytes(wav)
      return {
        audioBase64: wav.toString('base64'),
        voiceName: voice.voiceName,
        bytes: wav.length,
        sampleRateHz,
        durationMs: channels > 0 && sampleRateHz > 0
          ? Math.round((dataBytes / (2 * channels)) / sampleRateHz * 1000)
          : 0,
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 取 data 块字节数（估算时长用；定位失败按 0 处理）。 */
function wavDataBytes(buf: Buffer): number {
  let off = 12
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'data') return size
    off += 8 + size + (size % 2)
  }
  return 0
}

/** 模块级共享实例：并发计数跨请求共享（host-api 直接使用）。 */
export const roleSpeechService = new RoleSpeechService()
