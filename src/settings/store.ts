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
  /** classic=传统横版直播画布；deskpet=桌面宠物小窗（气泡/悬浮/AI 角标常显） */
  readonly style: 'classic' | 'deskpet'
}

export interface VoiceOption {
  readonly id: string
  readonly label: string
  readonly lang: string
  readonly style: string
}

/**
 * 角色档案（参照腾讯《鹅次元》官网 eciyuan.qq.com 的 CHARACTERS 角色介绍：
 * 中文名 / 英文名 / # 一句人设标签 / 年龄·身高·星座·性格 MBTI 信息列表）。
 * 「主播信息」由这些档案驱动，不再是一串自由输入的表单字段。
 * - 前四项为鹅次元官网公开角色资料；
 * - `dsh-pet` 为本插件内的桌宠角色档案（status='plugin'，界面标注「插件中」）。
 */
export interface ProfileOption {
  readonly id: string
  /** 中文名（播出时展示的角色名） */
  readonly name: string
  /** 英文名（官网档案卡上的拉丁名） */
  readonly enName: string
  /** # 一句人设标签 */
  readonly tagline: string
  /** 年龄 / Age */
  readonly age: string
  /** 身高 / Height */
  readonly height: string
  /** 星座 / Zodiac */
  readonly zodiac: string
  /** 性格 / MBTI */
  readonly mbti: string
  /** 角色简介 */
  readonly bio: string
  /** 档案卡主题色（预览画布/卡片用） */
  readonly theme: { readonly bg: string; readonly primary: string; readonly accent: string }
  /** 来源：官网角色 / 本插件内角色 */
  readonly source: 'eciyuan' | 'plugin'
  /** 桌宠形象（dsh-pet）标记 */
  readonly style: 'classic' | 'deskpet'
}

export const BUILTIN_PROFILES: readonly ProfileOption[] = [
  {
    id: 'dsh-pet',
    name: '大肥鱼',
    enName: 'DSH-PET',
    tagline: '一只陪你把日子过好的桌宠',
    age: '—',
    height: '—',
    zodiac: '—',
    mbti: 'ENFP',
    bio: '本插件内置的 AI 桌宠角色，常驻桌面小窗陪你直播、聊天、种田。',
    theme: { bg: '#0f3d38', primary: '#0f5e57', accent: '#ffd166' },
    source: 'plugin',
    style: 'deskpet',
  },
  {
    id: 'xiaxia',
    name: '夏夏',
    enName: 'XIAXIA',
    tagline: '新传专业大二学生',
    age: '19 岁',
    height: '162cm',
    zodiac: '白羊座',
    mbti: 'ENFP',
    bio: '元气满满的校园搭子，懂梗、爱聊天，情绪价值永远在线。',
    theme: { bg: '#3a2440', primary: '#7b4b8a', accent: '#ffd6ec' },
    source: 'eciyuan',
    style: 'classic',
  },
  {
    id: 'lubai',
    name: '沈露白',
    enName: 'LUBAI',
    tagline: '目标是万众瞩目的电竞女解说',
    age: '24 岁',
    height: '175cm',
    zodiac: '水瓶座',
    mbti: 'INTP',
    bio: '冷静犀利的战术脑，游戏理解在线，讲解向陪玩首选。',
    theme: { bg: '#10243a', primary: '#2b5c8a', accent: '#9fdcff' },
    source: 'eciyuan',
    style: 'classic',
  },
  {
    id: 'guyu',
    name: '谷雨',
    enName: 'GUYU',
    tagline: '红油粤菜新派料理大师',
    age: '22 岁',
    height: '165cm',
    zodiac: '金牛座',
    mbti: 'INFJ',
    bio: '温和细致的生活家，把每一场陪伴都料理得妥帖。',
    theme: { bg: '#3a2a12', primary: '#8a6a1f', accent: '#ffe3a3' },
    source: 'eciyuan',
    style: 'classic',
  },
  {
    id: 'beila',
    name: '贝拉',
    enName: 'BEILA',
    tagline: '追得上我就告诉你',
    age: '24 岁',
    height: '180cm',
    zodiac: '射手座',
    mbti: 'ESTP',
    bio: '风一样利落的竞技搭子，节奏快、反应更快。',
    theme: { bg: '#3a1420', primary: '#8a2b45', accent: '#ffb3c6' },
    source: 'eciyuan',
    style: 'classic',
  },
]

/** 按 id 取角色档案；未知 id 回落 dsh-pet（schema 已保证可选值合法）。 */
export function resolveProfile(id: string): ProfileOption {
  return BUILTIN_PROFILES.find((p) => p.id === id) ?? BUILTIN_PROFILES[0]!
}

export const BUILTIN_AVATARS: readonly AvatarOption[] = [
  {
    id: 'fish-deskpet',
    label: '大肥鱼桌宠 · 青绿',
    theme: { bg: '#0f3d38', primary: '#0f5e57', accent: '#ffd166' },
    style: 'deskpet',
  },
  {
    id: 'fish-deskpet-gold',
    label: '大肥鱼桌宠 · 暖金',
    theme: { bg: '#4a3410', primary: '#8a6d1f', accent: '#ffe3a3' },
    style: 'deskpet',
  },
  {
    id: 'fish-classic',
    label: '大肥鱼 · 经典青绿',
    theme: { bg: '#0f3d38', primary: '#0f5e57', accent: '#ffd166' },
    style: 'classic',
  },
  {
    id: 'fish-gold',
    label: '大肥鱼 · 暖金',
    theme: { bg: '#4a3410', primary: '#8a6d1f', accent: '#ffe3a3' },
    style: 'classic',
  },
  {
    id: 'fish-night',
    label: '大肥鱼 · 夜航蓝',
    theme: { bg: '#101c33', primary: '#1d3557', accent: '#7ae7ff' },
    style: 'classic',
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
const profileIds = BUILTIN_PROFILES.map((p) => p.id) as [string, ...string[]]

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
  /** 选中的角色档案（参照 eciyuan.qq.com CHARACTERS）；主播信息由该档案驱动展示 */
  profileId: z.enum(profileIds).default('dsh-pet'),
  /** 播出展示名：默认取所选档案中文名；保留为可覆盖字段以兼容既有设置/回退 */
  personaName: z.string().trim().min(1, '主播名称不能为空').max(24, '主播名称不超过 24 字').default('大肥鱼'),
  /** 默认即「大肥鱼桌宠」（用户要求虚拟形象换成桌宠）；旧值 fish-* 仍合法可回退 */
  avatarId: z.enum(avatarIds).default('fish-deskpet'),
  voiceId: z.enum(voiceIds).default('qing-wan'),
  /**
   * 语音互动开关：仅控制客户端是否启用浏览器语音识别 / 语音合成。
   * 麦克风权限仍由浏览器逐次显式授予；录音不上传、不入库，只有转写文本
   * 作为「模拟开播」事件留痕（§24.1 隐私下限不因此放宽）。
   */
  voiceInteractionEnabled: z.boolean().default(true),
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

  /** 当前选中的角色档案（主播信息展示源；未知 id 回落 dsh-pet）。 */
  getPersonaProfile(): ProfileOption {
    return resolveProfile(this.getPersona().profileId)
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
      return { ready: false, reason: '主播形象未配置：在「角色档案」中选择角色并确认使用授权' }
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
