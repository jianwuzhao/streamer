/**
 * 操作员设置域（方案 §24.1 首次配置五项输入的持久化）。
 *
 * - 分节存 SQLite `operator_settings`（key=节名，value=JSON），重启保留；
 * - AI 标识不可关闭（§23.2）：`aiLabelVisible` schema 为字面量 true，
 *   写入 false 属校验失败（400），模型与技能均无权翻转；
 * - 平台登录/实名/人脸在官方客户端完成，本模块只保存操作员声明时间戳，
 *   不保存任何凭据、cookie 或认证材料；
 * - 云端密钥（0.15）：可在界面维护（cloud_secret 节，SQLite 持久化）；
 *   读取路径一律只回掩码与来源，环境变量 DAFEIYU_CLOUD_API_KEY 仍优先；保存后重启插件生效。
 */
import { isRetiredSample } from '../avatar/model-store.ts'
import { douyinRoomUrl } from '../platform/douyin-protocol.ts'
import { z } from 'zod'
import { get, nowIso, run, type DB } from '../storage/db.ts'
import { BUILTIN_AVATARS, BUILTIN_VOICES, BUILTIN_PROFILES, RIGGED_MODEL_ID, RIGGED_PROFILE_NAME, resolveProfile, type ProfileOption } from './catalogs.ts'

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

const PersonaSettingsObject = z.object({
  /** 选中的角色档案（参照 eciyuan.qq.com CHARACTERS）；主播信息由该档案驱动展示 */
  profileId: z.preprocess((value) => value === 'lanxu' ? RIGGED_MODEL_ID : value, z.enum(profileIds).default('dsh-pet')),
  /** 播出展示名：默认取所选档案中文名；保留为可覆盖字段以兼容既有设置/回退 */
  personaName: z.string().trim().min(1, '主播名称不能为空').max(24, '主播名称不超过 24 字').default('DSH 蓝发女仆').transform((value) => value === '大肥鱼' ? 'DSH 蓝发女仆' : value),
  /** Normalize retired avatars when reading existing settings. */
  avatarId: z.preprocess((value) => typeof value === 'string' &&
    ['fish-deskpet', 'fish-deskpet-gold', 'fish-classic', 'fish-gold', 'fish-night'].includes(value) ? 'dsh-pet' : value,
  z.enum(avatarIds).default('dsh-pet')),
  /** 缺省沿用自动选取，null 使用内置形象。 */
  live2dModelId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).max(128).nullable().optional()
    .transform((id) => id && isRetiredSample(id) ? null : id),
  voiceId: z.enum(voiceIds).default('qing-wan'),
  samplePhrase: z
    .string()
    .trim()
    .min(1, '试听语句不能为空')
    .max(80, '试听语句不超过 80 字')
    .default('大家好，很高兴在直播间见到你。'),
  usageRightConfirmed: z.boolean().default(false),
  aiLabelText: z.string().trim().min(1, 'AI 标识文案不能为空').max(16, 'AI 标识文案不超过 16 字').default('AI 生成内容'),
  /** §23.2 输出检查最小集：AI 标识不可关闭——只接受 true。 */
  aiLabelVisible: z.literal(true).default(true),
})
const normalizePersona = (value: z.infer<typeof PersonaSettingsObject>) => value.profileId === RIGGED_MODEL_ID && value.personaName === '澜序' ?
  { ...value, personaName: RIGGED_PROFILE_NAME } : value
export const PersonaSettings = PersonaSettingsObject.transform(normalizePersona)
const PortablePersonaSettings = PersonaSettingsObject.strict().transform(normalizePersona)
export type PersonaSettingsType = z.infer<typeof PersonaSettings>

export const PlatformSettings = z.object({
  platform: z.literal('douyin').default('douyin'),
  interactionSource: z.enum(['browser', 'relay']).default('browser'),
  roomUrl: z.string().trim().max(500).refine((value) => value === '' || douyinRoomUrl(value) !== null,
    '请输入 https://live.douyin.com/ 开头的直播间链接')
    .transform((value) => value ? douyinRoomUrl(value)! : '').default(''),
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
  broadcastLayout: z.enum(['portrait', 'landscape']).default('portrait'),
  background: z.enum(['teal', 'night', 'warm']).default('teal'),
  danmakuOverlay: z.boolean().default(true),
})
export type SceneSettingsType = z.infer<typeof SceneSettings>

/** 云端兜底覆盖值（provider 非空时覆盖 config.yaml；重启插件后生效；密钥仍走环境变量）。 */
export const CloudSettings = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().trim().max(64, '服务商名不超过 64 字').default(''),
  /** 自定义 OpenAI 兼容端点（0.15.3）：非空时优先于预设；留空走预设。解析链 env > 此值 > 预设。 */
  baseUrl: z
    .string()
    .trim()
    .max(300, '端点不超过 300 字符')
    .refine((v) => v === '' || URL.canParse(v), '端点须为有效 URL（如 https://host/v1）')
    .default(''),
  model: z.string().trim().max(128, '模型名不超过 128 字').default(''),
  dailyBudgetCny: z.number().positive('每日费用上限须为正数').nullable().default(null),
})
export type CloudSettingsType = z.infer<typeof CloudSettings>

/**
 * 云端密钥（界面维护，0.15）：存 cloud_secret 节。
 * - 只存密钥本体与更新时间；面板/GET 一律经 getCloudKeyStatus() 取「掩码 + 来源」，明文永不回传；
 * - 环境变量 DAFEIYU_CLOUD_API_KEY 优先于界面值（运维覆盖通道，index.ts 装配处解析）；
 * - 保存/清除写审计，但审计摘要不含密钥值。
 */
export const CloudSecret = z.object({
  apiKey: z.string().max(512, '密钥长度不超过 512 字符').default(''),
  updatedAt: z.string().nullable().default(null),
})
export type CloudSecretType = z.infer<typeof CloudSecret>

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

/** Portable operator settings only: never serialize secrets, environment or runtime data. */
const PortableSections = z.object({
  persona: PortablePersonaSettings,
  platform: PlatformSettings.strict(),
  scene: SceneSettings.strict(),
  cloud: CloudSettings.strict(),
  dataUsage: DataUsageSettings.strict(),
  gifts: GiftsSettings.strict(),
}).strict()

const SettingsBackup = z.object({
  format: z.literal('dsh-dafeiyu-settings'),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  sections: PortableSections,
}).strict()

export type SettingsSectionKey = 'persona' | 'platform' | 'scene' | 'cloud' | 'cloud_secret' | 'data_usage' | 'gifts'

/** 密钥掩码（getCloudKeyStatus 专用）：首 3 + •••• + 尾 4；过短全部打码，永不回明文。 */
function maskSecret(secret: string): string {
  if (secret.length <= 8) return '••••'
  return secret.slice(0, 3) + '••••' + secret.slice(-4)
}

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
    run(
      this.db,
      `INSERT INTO audit (action, summary) VALUES ('settings', ?)`,
      key === 'cloud_secret' ? '云端密钥经界面更新（审计不含密钥值）' : `${key} 更新`,
    )
    return next
  }

  exportBackup() {
    return SettingsBackup.parse({
      format: 'dsh-dafeiyu-settings', version: 1, exportedAt: this.clock(),
      sections: {
        persona: this.getPersona(), platform: this.getPlatform(), scene: this.getScene(),
        cloud: this.getCloud(), dataUsage: this.getDataUsage(), gifts: this.getGifts(),
      },
    })
  }

  validateBackup(input: unknown) {
    try {
      const backup = SettingsBackup.parse(input)
      // Permission declarations belong to this machine/account; a restored endpoint
      // must be tested before enabling it with an already-stored credential.
      backup.sections.persona.usageRightConfirmed = false
      backup.sections.platform.operatorLoginConfirmedAt = null
      backup.sections.dataUsage.confirmed = false
      backup.sections.cloud.enabled = false
      return backup
    } catch (err) {
      throw new SettingsValidationError('配置备份校验失败，请使用本插件导出的 v1 JSON 文件', zodIssues(err as z.ZodError))
    }
  }

  importBackup(input: unknown) {
    const backup = this.validateBackup(input)
    this.db.exec('SAVEPOINT settings_import')
    try {
      this.savePersona(backup.sections.persona)
      this.savePlatform(backup.sections.platform)
      this.saveScene(backup.sections.scene)
      this.saveCloud(backup.sections.cloud)
      this.saveDataUsage(backup.sections.dataUsage)
      this.saveGifts(backup.sections.gifts)
      run(this.db, "INSERT INTO audit (action, summary) VALUES ('settings', '导入 v1 配置备份（不含密钥与运行数据）')")
      this.db.exec('RELEASE settings_import')
    } catch (err) {
      this.db.exec('ROLLBACK TO settings_import')
      this.db.exec('RELEASE settings_import')
      throw err
    }
    return backup
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

  /** 界面维护的云端密钥原文（仅 index.ts 装配处解析凭据用；面板/GET 一律不得调用）。 */
  getCloudSecretRaw(): string {
    return this.readSection('cloud_secret', CloudSecret).apiKey
  }

  /**
   * 云端密钥状态（面板回显）：source=env（环境变量，优先）/ ui（界面维护）/ none；
   * masked 永远是掩码，明文不出存储层以外的任何读取路径。
   */
  getCloudKeyStatus(): { source: 'env' | 'ui' | 'none'; masked: string | null; updatedAt: string | null } {
    const envKey = process.env.DAFEIYU_CLOUD_API_KEY?.trim() ?? ''
    if (envKey !== '') return { source: 'env', masked: maskSecret(envKey), updatedAt: null }
    const secret = this.readSection('cloud_secret', CloudSecret)
    if (secret.apiKey !== '') {
      return { source: 'ui', masked: maskSecret(secret.apiKey), updatedAt: secret.updatedAt }
    }
    return { source: 'none', masked: null, updatedAt: null }
  }

  /** 保存界面维护的密钥（非空校验；审计摘要不含值）。 */
  saveCloudKey(input: string): CloudSecretType {
    const apiKey = input.trim()
    if (apiKey === '') {
      throw new SettingsValidationError('settings/cloud_secret 校验失败', ['apiKey：请输入密钥（清除请用 clearCloudKey）'])
    }
    return this.saveSection('cloud_secret', CloudSecret, { apiKey, updatedAt: this.clock() })
  }

  /** 清除界面维护的密钥（环境变量不受影响）。 */
  clearCloudKey(): CloudSecretType {
    return this.saveSection('cloud_secret', CloudSecret, { apiKey: '', updatedAt: null })
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
      return { ready: false, reason: '主播形象未配置：在「设置 → 角色与声音」中选择角色并确认使用授权' }
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
