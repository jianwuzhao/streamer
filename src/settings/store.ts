/**
 * 操作员设置域（方案 §24.1 首次配置五项输入的持久化）。
 *
 * - 分节存 SQLite `operator_settings`（key=节名，value=JSON），重启保留；
 * - AI 标识不可关闭（§23.2）：`aiLabelVisible` schema 为字面量 true，
 *   写入 false 属校验失败（400），模型与技能均无权翻转；
 * - 平台登录/实名/人脸在官方客户端完成，本模块只保存操作员声明时间戳，
 *   不保存任何凭据、cookie 或认证材料；
 * - 云端密钥不落库：CloudSettings 只存 provider/model/预算引用，
 *   API key 仍走环境变量（DAFEIYU_CLOUD_API_KEY）。
 */
import { z } from 'zod'
import { get, nowIso, run, type DB } from '../storage/db.ts'

// ---------------------------------------------------------------------------
// 内置目录（形象 / 音色元数据；最终音色以直播伴侣音轨为准，试听用浏览器语音）
// ---------------------------------------------------------------------------

export interface AvatarOption {
  readonly id: string
  readonly label: string
  /** 预览画布主题色（背景/主色/点缀） */
  readonly theme: { readonly bg: string; readonly primary: string; readonly accent: string }
}

export interface VoiceOption {
  readonly id: string
  readonly label: string
  readonly lang: string
  readonly style: string
}

export const BUILTIN_AVATARS: readonly AvatarOption[] = [
  {
    id: 'fish-classic',
    label: '大肥鱼 · 经典青绿',
    theme: { bg: '#0f3d38', primary: '#0f5e57', accent: '#ffd166' },
  },
  {
    id: 'fish-gold',
    label: '大肥鱼 · 暖金',
    theme: { bg: '#4a3410', primary: '#8a6d1f', accent: '#ffe3a3' },
  },
  {
    id: 'fish-night',
    label: '大肥鱼 · 夜航蓝',
    theme: { bg: '#101c33', primary: '#1d3557', accent: '#7ae7ff' },
  },
]

export const BUILTIN_VOICES: readonly VoiceOption[] = [
  { id: 'qing-wan', label: '清婉（女声）', lang: 'zh-CN', style: '温和亲切，日常闲聊' },
  { id: 'chen-lang', label: '沉朗（男声）', lang: 'zh-CN', style: '沉稳清楚，讲解向' },
  { id: 'tong-qu', label: '童趣（中性）', lang: 'zh-CN', style: '轻快活泼，游戏向' },
  { id: 'ping-shi', label: '平稳（中性）', lang: 'zh-CN', style: '平实自然，读稿向' },
]

// ---------------------------------------------------------------------------
// Schema（与 operator_settings 各节一一对应；default 保证缺省可用）
// ---------------------------------------------------------------------------

const avatarIds = BUILTIN_AVATARS.map((a) => a.id) as [string, ...string[]]
const voiceIds = BUILTIN_VOICES.map((v) => v.id) as [string, ...string[]]

function httpUrl(message: string) {
  return z.string().trim().refine((v) => {
    try {
      new URL(v)
      return true
    } catch {
      return false
    }
  }, message)
}

export const PersonaSettings = z.object({
  personaName: z.string().trim().min(1, '主播名称不能为空').max(24, '主播名称不超过 24 字').default('大肥鱼'),
  avatarId: z.enum(avatarIds).default('fish-classic'),
  voiceId: z.enum(voiceIds).default('qing-wan'),
  samplePhrase: z
    .string()
    .trim()
    .min(1, '试听语句不能为空')
    .max(80, '试听语句不超过 80 字')
    .default('大家好，我是大肥鱼，今天咱们一起把日子过好。'),
  usageRightConfirmed: z.boolean().default(false),
  aiLabelText: z.string().trim().min(1, 'AI 标识文案不能为空').max(16, 'AI 标识文案不超过 16 字').default('AI 生成内容'),
  /** §23.2 输出检查最小集：AI 标识不可关闭——只接受 true。 */
  aiLabelVisible: z.literal(true).default(true),
})
export type PersonaSettingsType = z.infer<typeof PersonaSettings>

export const PlatformSettings = z.object({
  platform: z.literal('douyin').default('douyin'),
  operationMode: z.enum(['assisted', 'human_driven']).default('assisted'),
  contentCategory: z.string().trim().max(24, '内容类别不超过 24 字').default(''),
  officialClientUrl: httpUrl('官方客户端入口须为有效 URL').default('https://streamingtool.douyin.com/docs/qna_start_error'),
  /** 操作员声明「已在官方客户端登录」的时间戳；凭据永不入库。 */
  operatorLoginConfirmedAt: z.string().nullable().default(null),
})
export type PlatformSettingsType = z.infer<typeof PlatformSettings>

export const SceneSettings = z.object({
  title: z.string().trim().min(1, '直播间标题不能为空').max(30, '标题不超过 30 字').default('大肥鱼的直播间'),
  resolution: z.enum(['1280x720', '1920x1080']).default('1280x720'),
  background: z.enum(['teal', 'night', 'warm']).default('teal'),
  danmakuOverlay: z.boolean().default(true),
})
export type SceneSettingsType = z.infer<typeof SceneSettings>

/** 云端兜底覆盖值（provider 非空时覆盖 config.yaml；重启插件后生效；密钥仍走环境变量）。 */
export const CloudSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().trim().max(64, '服务商名不超过 64 字').default(''),
  model: z.string().trim().max(128, '模型名不超过 128 字').default(''),
  dailyBudgetCny: z.number().positive('每日费用上限须为正数').nullable().default(null),
})
export type CloudSettingsType = z.infer<typeof CloudSettings>

/** 数据用途声明（向导第 5 步确认项；隐私下限不可放宽，只能确认）。 */
export const DataUsageSettings = z.object({
  confirmed: z.boolean().default(false),
  profileTrainingDenied: z.literal(true).default(true),
  personalizationOptOut: z.literal(true).default(true),
})
export type DataUsageSettingsType = z.infer<typeof DataUsageSettings>

/** 礼物答谢设置（危险昵称仍由既有 screen 规则兜底，与此开关无关）。 */
export const GiftsSettings = z.object({
  nameMention: z.boolean().default(true),
})
export type GiftsSettingsType = z.infer<typeof GiftsSettings>

export type SettingsSectionKey = 'persona' | 'platform' | 'scene' | 'cloud' | 'data_usage' | 'gifts'

export type Readiness = { ready: true } | { ready: false; reason: string }

export class SettingsValidationError extends Error {
  public readonly issues: readonly string[]
  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.join('\n')}` : message)
    this.name = 'SettingsValidationError'
    this.issues = issues
  }
}

/** 字面量字段的中文问题翻译（zod 原生报错对操作员不可读）。 */
const LITERAL_FIELD_MESSAGES: Readonly<Record<string, string>> = {
  aiLabelVisible: 'AI 标识不可关闭（§23.2）：模型与技能均无权翻转',
  profileTrainingDenied: '观众画像不得用于参数训练（隐私下限，不可放宽）',
  personalizationOptOut: '观众个性化退出必须可用（隐私下限，不可放宽）',
  platform: '当前仅支持抖音平台',
}

function zodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => {
    const path = i.path.join('.')
    const literalMessage = LITERAL_FIELD_MESSAGES[path]
    if (literalMessage !== undefined) return `${path}：${literalMessage}`
    return `${path || '(根)'}：${i.message}`
  })
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export class SettingsStore {
  private readonly db: DB
  private readonly clock: () => string

  constructor(db: DB, opts: { clock?: () => string } = {}) {
    this.db = db
    this.clock = opts.clock ?? nowIso
  }

  private readSection<S extends z.ZodType>(key: SettingsSectionKey, schema: S): z.infer<S> {
    const row = get<{ value: string }>(this.db, 'SELECT value FROM operator_settings WHERE key = ?', key)
    if (row === undefined) return schema.parse({}) as z.infer<S>
    try {
      // 损坏行回落默认值：设置损坏不应阻断插件启动（保存时覆盖修复）
      const parsed = JSON.parse(row.value) as unknown
      return schema.parse(parsed) as z.infer<S>
    } catch {
      return schema.parse({}) as z.infer<S>
    }
  }

  /**
   * 保存一节：入参与当前值浅合并后整节校验（部分更新语义——
   * 未提交字段保持当前值；aiLabelVisible=false 在字面量 schema 处被拒绝）。
   */
  private saveSection<S extends z.ZodType>(key: SettingsSectionKey, schema: S, input: unknown): z.infer<S> {
    const current = this.readSection(key, schema)
    const patch = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
    let next: z.infer<S>
    try {
      next = schema.parse({ ...(current as object), ...patch }) as z.infer<S>
    } catch (err) {
      throw new SettingsValidationError(`settings/${key} 校验失败`, zodIssues(err as z.ZodError))
    }
    run(
      this.db,
      `INSERT INTO operator_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(next),
      this.clock(),
    )
    run(this.db, `INSERT INTO audit (action, summary) VALUES ('settings', ?)`, `${key} 更新`)
    return next
  }

  getPersona(): PersonaSettingsType {
    return this.readSection('persona', PersonaSettings)
  }

  getPlatform(): PlatformSettingsType {
    return this.readSection('platform', PlatformSettings)
  }

  getScene(): SceneSettingsType {
    return this.readSection('scene', SceneSettings)
  }

  getCloud(): CloudSettingsType {
    return this.readSection('cloud', CloudSettings)
  }

  getDataUsage(): DataUsageSettingsType {
    return this.readSection('data_usage', DataUsageSettings)
  }

  getGifts(): GiftsSettingsType {
    return this.readSection('gifts', GiftsSettings)
  }

  savePersona(input: unknown): PersonaSettingsType {
    return this.saveSection('persona', PersonaSettings, input)
  }

  savePlatform(input: unknown): PlatformSettingsType {
    return this.saveSection('platform', PlatformSettings, input)
  }

  saveScene(input: unknown): SceneSettingsType {
    return this.saveSection('scene', SceneSettings, input)
  }

  saveCloud(input: unknown): CloudSettingsType {
    return this.saveSection('cloud', CloudSettings, input)
  }

  saveDataUsage(input: unknown): DataUsageSettingsType {
    return this.saveSection('data_usage', DataUsageSettings, input)
  }

  saveGifts(input: unknown): GiftsSettingsType {
    return this.saveSection('gifts', GiftsSettings, input)
  }

  /** 形象就绪 = 使用授权已确认（其余字段由 schema 保证合法缺省）。 */
  personaReady(): Readiness {
    const persona = this.getPersona()
    if (!persona.usageRightConfirmed) {
      return { ready: false, reason: '主播形象未配置：在「主播形象」中选择形象与声音并确认使用授权' }
    }
    return { ready: true }
  }

  /** 接入就绪 = 操作员已声明在官方客户端登录（平台认证不在本插件内完成）。 */
  platformReady(): Readiness {
    const platform = this.getPlatform()
    if (platform.operatorLoginConfirmedAt === null) {
      return { ready: false, reason: '直播接入未配置：在「直播接入」确认已在官方客户端登录直播账号' }
    }
    return { ready: true }
  }

  readiness(): { persona: Readiness; platform: Readiness } {
    return { persona: this.personaReady(), platform: this.platformReady() }
  }
}
