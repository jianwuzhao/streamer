export interface HostInteraction {
  readonly kind: 'join' | 'gift'
  readonly variant: number
}

const CUES = {
  join: ['把直播间想成角色熟悉的地点，请观众来坐坐', '用一个轻松的小梗打招呼', '像认识新搭子一样，用一个简单的问题开启聊天'],
  gift: ['直接道谢，再用符合人设的比喻接住这份心意', '先道谢，再俏皮地说一句当下的反应', '用温和真诚的口吻道谢，轻松接回聊天'],
}

export function interactionInstruction({ kind, variant }: HostInteraction): string {
  const intent = kind === 'join'
    ? '这是进房事件。用一句中文口语欢迎刚进来的观众，不要把事件念一遍。'
    : '这是礼物事件。用一两句中文口语感谢观众；事件给出礼物名称和数量时可以自然提到，不能编造、索要更多礼物或许诺回报。'
  const cues = CUES[kind]
  return `${intent}这次开场可以${cues[variant % cues.length]}。直接称呼「你」。`
}

const PRESETS: Readonly<Record<string, Record<HostInteraction['kind'], readonly string[]>>> = {
  'dsh-pet': {
    join: ['欢迎呀，给你留了张靠窗的小椅子。', '有人来啦，我把小台灯拧亮一点。欢迎来坐坐。', '叮咚，今天又多一位聊天搭子。刚忙完吗？'],
    gift: ['谢谢你的礼物！今天的小台灯好像又亮了一格。', '这份心意我接牢啦，谢谢你。', '谢谢你的礼物呀。忙了一天，能在这儿聊两句就很开心。'],
  },
  xiaxia: {
    join: ['嘿，欢迎加入课间聊天小分队。靠窗那排还有位！', '欢迎欢迎！刚下课还是刚下班？', '哎，新搭子来啦！今天有什么小事想吐槽吗？'],
    gift: ['谢谢你的礼物！给我的快乐电量瞬间充了一格。', '哇，接住啦！谢谢，课间的快乐又续上了。', '谢谢你惦记我呀。来，咱们继续聊刚才那个话题。'],
  },
  lubai: {
    join: ['欢迎入场。前排观战位给你留着。', '新队友就位，欢迎。今天想聊点什么？', '欢迎来直播间。想看细节还是想听结论，你选。'],
    gift: ['谢谢你的礼物。这波支援来得很准。', '礼物收到了，谢谢。给你的配合打十分。', '谢谢你的心意。咱们把这局继续聊透。'],
  },
  guyu: {
    join: ['欢迎来坐坐，茶刚泡好，你慢慢聊。', '欢迎呀，今天过得怎么样？先在这儿歇口气。', '厨房这边正热闹呢。欢迎，今晚想聊点什么？'],
    gift: ['谢谢你的礼物。像炖汤出锅前撒的一撮葱花，刚刚好。', '哎呀，心意收到了，谢谢你。', '谢谢你呀。这点暖意够我们慢慢聊上一阵了。'],
  },
  beila: {
    join: ['欢迎上场！随便挑个话题，咱俩接着聊。', '新搭子到了。欢迎！今天有没有什么痛快事？', '嗨，来得正好。先喘口气，下一轮你起头。'],
    gift: ['谢啦，这份礼物接到了！这波配合挺帅。', '干脆利落！谢谢你的礼物，我稳稳接住。', '谢谢你的心意。来，咱们继续聊。'],
  },
}

export function interactionFallback(interaction: HostInteraction, profileId: string | undefined): string | undefined {
  const lines = PRESETS[profileId ?? '']?.[interaction.kind] ?? PRESETS['dsh-pet']?.[interaction.kind]
  return lines?.[interaction.variant % lines.length]
}
