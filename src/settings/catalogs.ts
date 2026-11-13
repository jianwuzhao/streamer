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
