/**
 * 第一次模拟开播 · 本机演练脚本（CLI 入口，无宿主依赖）。
 *
 * 用途：在本机（有抖音直播伴侣环境）完成一次可复核的「首播演练」，
 * 产出 docs/simulation-first-run.md 报告所需的结构化数据。
 *
 * 运行：node scripts/simulate-first-run.ts
 * 可选：DAFEIYU_DATA_DIR 指定数据目录（默认 ./data）
 *
 * 严格隔离：不连接抖音、不推流、不改生产播出状态、不写 reply_log /
 * 礼物账本 / 画像 / 训练样本 / 发布链；感知事件 replay=1。
 * 回复走真实本地优先路由，本地不可达如实标 fallback。
 */
import { createPlugin } from '../src/index.ts'

const dataDir = process.env.DAFEIFYU_DATA_DIR ?? './data'
const plugin = createPlugin({ dataDir, log: () => {} })

const out: Record<string, unknown> = {}
try {
  // 1. 形象切换：确认「大肥鱼桌宠」为当前虚拟形象，并开启语音互动
  const before = plugin.settings.getPersona()
  plugin.settings.savePersona({
    avatarId: 'fish-deskpet',
    voiceInteractionEnabled: true,
    usageRightConfirmed: true,
  })
  const persona = plugin.settings.getPersona()
  out.persona = {
    before: { avatarId: before.avatarId, voiceInteractionEnabled: before.voiceInteractionEnabled },
    after: { name: persona.personaName, avatarId: persona.avatarId, aiLabelText: persona.aiLabelText, voiceId: persona.voiceId, voiceInteractionEnabled: persona.voiceInteractionEnabled },
  }

  // 2. 真实直播状态（不得被演练改变）
  const liveBefore = plugin.live.session.display()
  out.liveStatusBefore = liveBefore

  // 3. 第一次模拟开播：一键跑完内置首播脚本
  const startedAt = new Date().toISOString()
  const { steps, report } = await plugin.simulation.runScript()
  const endedAt = new Date().toISOString()

  // 4. 复核：状态/事件/报告/隔离约束
  const state = plugin.simulation.state()
  const liveAfter = plugin.live.session.display()
  const rows = plugin.db
    .prepare('SELECT COUNT(*) AS n FROM simulation_events')
    .get() as { n: number }
  const production = {
    replies: (plugin.db.prepare('SELECT COUNT(*) AS n FROM reply_log').get() as { n: number }).n,
    gifts: (plugin.db.prepare('SELECT COUNT(*) AS n FROM gift_ledger').get() as { n: number }).n,
    profiles: (plugin.db.prepare('SELECT COUNT(*) AS n FROM viewer_profiles').get() as { n: number }).n,
    samples: (plugin.db.prepare('SELECT COUNT(*) AS n FROM training_samples').get() as { n: number }).n,
    releases: (plugin.db.prepare('SELECT COUNT(*) AS n FROM releases').get() as { n: number }).n,
  }
  const simEvents = plugin.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'simulation' AND replay = 1")
    .get() as { n: number }
  const platformEvents = plugin.db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE source != 'simulation'")
    .get() as { n: number }

  out.run = { startedAt, endedAt, status: state.status, runNo: state.runNo, firstCompleted: state.firstCompleted }
  out.steps = steps
  out.report = report
  out.events = state.events
  let localOllamaReachable = false
  try {
    const probe = await fetch(`${process.env.DAFEIFYU_OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/tags`, {
      signal: AbortSignal.timeout(1500),
    })
    localOllamaReachable = probe.ok
  } catch {
    localOllamaReachable = false
  }

  out.verification = {
    liveStatusBefore: liveBefore,
    liveStatusAfter: liveAfter,
    liveStatusUnchanged: liveBefore === liveAfter,
    simulationEventCount: rows.n,
    simulationReplayEventCount: simEvents.n,
    nonSimulationEventCount: platformEvents.n,
    production,
    productionUntouched: Object.values(production).every((n) => n === 0),
    aiLabelVisible: persona.aiLabelVisible === true,
    localOllamaReachable,
  }
  console.log(JSON.stringify(out, null, 2))
} finally {
  plugin.dispose()
}
