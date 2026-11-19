/**
 * 内置目录（形象 / 音色 / 角色档案元数据；最终音色以直播伴侣音轨为准，试听用浏览器语音）。
 * 从操作员设置域拆出（单文件 ≤400 行）：本文件只放静态目录与解析，不放存取逻辑。
 */

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
 * 角色媒体档案包含立绘、可选试听音频和本地模型包 id。
 * - 鹅次元 URL 仅用于预览展示与试听。
 * - `modelId` 为确定性本地包 id（不依赖运行时目录探测），前端按需加载。
 */
export interface ProfileMedia {
  /** 官方公开立绘/封面图 */
  readonly portraitUrl: string
  /** 官方公开试听音频 */
  readonly sampleAudioUrl?: string
  /** 本地 Live2D 模型包 id（确定性映射） */
  readonly modelId: string
}

export const RIGGED_MODEL_ID = 'xiaxia-3d'
export const RIGGED_PROFILE_NAME = '夏夏 · 重构版'

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
  /** 文字回复采用的表达方式 */
  readonly speakingStyle: string
  /** 档案卡主题色（预览画布/卡片用） */
  readonly theme: { readonly bg: string; readonly primary: string; readonly accent: string }
  /** 官方媒体档案（仅官网角色携带；插件内桌宠角色无官方素材，保持缺省） */
  readonly media?: ProfileMedia
  /** 来源：官网角色 / 本插件内角色 */
  readonly source: 'eciyuan' | 'plugin'
  /** 桌宠形象（dsh-pet）标记 */
  readonly style: 'classic' | 'deskpet'
}

/** 鹅次元官网公开静态资源基址（官方站点 JS 引用的封面/音频所在域名）。 */
const ECIYUAN_MEDIA_BASE = 'https://upage.imtt.qq.com/m_imtt/gamebuddy'

/** 由官网角色 slug 与本地模型包 id 组装媒体档案（封面/音频路径为官网既定约定）。 */
function eciyuanMedia(slug: string, modelId: string): ProfileMedia {
  return {
    portraitUrl: `${ECIYUAN_MEDIA_BASE}/images/roles/${slug}/pc-cover.jpg`,
    sampleAudioUrl: `${ECIYUAN_MEDIA_BASE}/audio/${slug}.wav`,
    modelId,
  }
}

export const BUILTIN_PROFILES: readonly ProfileOption[] = [
  {
    id: 'dsh-pet',
    name: 'DSH 蓝发女仆',
    enName: 'DSH PET',
    tagline: '来自 DeepSeek Harness 的蓝发桌宠',
    age: '—',
    height: '—',
    zodiac: '—',
    mbti: '—',
    bio: '蓝发女仆，说话温柔、自然，偶尔带一点俏皮。',
    speakingStyle: '语气轻柔亲切，偶尔俏皮地接梗，像陪观众闲聊。',
    theme: { bg: '#17213c', primary: '#344d86', accent: '#cfdeff' },
    media: { modelId: 'dsh-pet', portraitUrl: '' },
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
    speakingStyle: '活泼热情，像同学聊天一样自然接梗，多用轻松的口语。',
    theme: { bg: '#3a2440', primary: '#7b4b8a', accent: '#ffd6ec' },
    media: eciyuanMedia('xiaxia', 'eciyuan-xiaxia'),
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
    speakingStyle: '冷静直接，先讲判断，再给理由。聊游戏时用简明的解说口吻。',
    theme: { bg: '#10243a', primary: '#2b5c8a', accent: '#9fdcff' },
    media: eciyuanMedia('shenlubai', 'eciyuan-lubai'),
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
    speakingStyle: '语气温和耐心，用具体的生活细节解释，聊到料理时说清关键步骤。',
    theme: { bg: '#3a2a12', primary: '#8a6a1f', accent: '#ffe3a3' },
    media: eciyuanMedia('guyu', 'eciyuan-guyu'),
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
    speakingStyle: '句子短而利落，适度用竞技搭子的调侃接话，节奏明快。',
    theme: { bg: '#3a1420', primary: '#8a2b45', accent: '#ffb3c6' },
    media: eciyuanMedia('beila', 'eciyuan-beila'),
    source: 'eciyuan',
    style: 'classic',
  },
  {
    id: RIGGED_MODEL_ID,
    name: RIGGED_PROFILE_NAME,
    enName: 'XIAXIA 3D',
    tagline: '新传专业大二学生 · 三维骨骼形象',
    age: '19 岁',
    height: '162cm',
    zodiac: '白羊座',
    mbti: 'ENFP',
    bio: '元气满满的校园搭子，懂梗、爱聊天，倾听时会点头，回复时会用手势配合。',
    speakingStyle: '活泼热情，像同学聊天一样自然接梗，多用轻松的口语。',
    theme: { bg: '#3a2440', primary: '#7b4b8a', accent: '#ffd6ec' },
    media: { ...eciyuanMedia('xiaxia', RIGGED_MODEL_ID), portraitUrl: '/api/dafeiyu/avatar/rigged?id=xiaxia-3d&asset=poster' },
    source: 'plugin',
    style: 'classic',
  },
]

/** 按 id 取角色档案；未知 id 回落 dsh-pet（schema 已保证可选值合法）。 */
export function resolveProfile(id: string): ProfileOption {
  return BUILTIN_PROFILES.find((p) => p.id === id) ?? BUILTIN_PROFILES[0]!
}

export const BUILTIN_AVATARS: readonly AvatarOption[] = [
  { id: 'dsh-pet', label: 'DSH 蓝发女仆', theme: { bg: '#17213c', primary: '#344d86', accent: '#cfdeff' }, style: 'deskpet' },
]

/**
 * 云端服务商预设（OpenAI 兼容端点）：向导第 4 步的快捷选项。
 * - 预设只固化「端点 baseURL + 建议模型名」这类公开信息，不涉及任何凭据；
 *   API Key 仍只走环境变量 DAFEIYU_CLOUD_API_KEY（不落库）。
 * - baseURL 解析优先级：DAFEIYU_CLOUD_BASE_URL 环境变量 > 预设内置值 > 不可路由占位。
 *   自定义服务商（不在预设内）保持原行为：必须用环境变量提供端点。
 */
export interface CloudProviderPreset {
  /** 写入 settings.cloud.provider 的标识（也是预设匹配键） */
  readonly id: string
  readonly label: string
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly note: string
}

export const CLOUD_PROVIDER_PRESETS: readonly CloudProviderPreset[] = [
  {
    id: 'tencent-hunyuan',
    label: '腾讯云混元',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-lite', 'hunyuan-standard', 'hunyuan-pro', 'hunyuan-turbo', 'hunyuan-t1'],
    note: '腾讯混元官方 OpenAI 兼容端点；API Key 为腾讯云密钥（仅设 DAFEIYU_CLOUD_API_KEY），模型名以腾讯云控制台为准。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    note: 'DeepSeek 官方 OpenAI 兼容端点；API Key 仅经 DAFEIYU_CLOUD_API_KEY 提供。',
  },
]

/** 按服务商名解析预设端点；未命中返回 null（自定义服务商需环境变量提供端点）。 */
export function resolveCloudBaseUrl(provider: string): string | null {
  const hit = CLOUD_PROVIDER_PRESETS.find((p) => p.id === provider.trim())
  return hit ? hit.baseUrl : null
}

export const BUILTIN_VOICES: readonly VoiceOption[] = [
  { id: 'qing-wan', label: '清婉（女声）', lang: 'zh-CN', style: '温和亲切，日常闲聊' },
  { id: 'chen-lang', label: '沉朗（男声）', lang: 'zh-CN', style: '沉稳清楚，讲解向' },
  { id: 'tong-qu', label: '童趣（中性）', lang: 'zh-CN', style: '轻快活泼，游戏向' },
  { id: 'ping-shi', label: '平稳（中性）', lang: 'zh-CN', style: '平实自然，读稿向' },
]
