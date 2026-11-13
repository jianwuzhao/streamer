/**
 * 面板数据 GET 路由：settings / preview / selfcheck / diagnostics /
 * replies / feedback / gifts/summary / training/progress / costs。
 * 命中路径自行写响应并返回 true；未命中返回 false 交回主入口。
 */
import type { DafeiyuPluginHandle } from './index.ts'
import { runSelfCheck } from './installer/selfcheck.ts'
import { exportDiagnosticReport } from './installer/diagnostics.ts'
import { BUILTIN_AVATARS, BUILTIN_VOICES, BUILTIN_PROFILES } from './settings/catalogs.ts'
import { type Readiness } from './settings/store.ts'
import { all, get } from './storage/db.ts'
import { json, todayCostCny, type ServerResponse } from './host-api-shared.ts'

interface SettingsPayload {
  persona: unknown
  platform: unknown
  scene: unknown
  cloud: unknown
  dataUsage: unknown
  gifts: unknown
  /** 当前选中的角色档案（主播信息来源） */
  profile: ReturnType<DafeiyuPluginHandle['settings']['getPersonaProfile']>
  readiness: { persona: Readiness; platform: Readiness }
  catalogs: { avatars: typeof BUILTIN_AVATARS; voices: typeof BUILTIN_VOICES; profiles: typeof BUILTIN_PROFILES }
  notes: readonly string[]
}

function buildSettingsPayload(handle: DafeiyuPluginHandle): SettingsPayload {
  return {
    persona: handle.settings.getPersona(),
    profile: handle.settings.getPersonaProfile(),
    platform: handle.settings.getPlatform(),
    scene: handle.settings.getScene(),
    cloud: handle.settings.getCloud(),
    dataUsage: handle.settings.getDataUsage(),
    gifts: handle.settings.getGifts(),
    readiness: handle.settings.readiness(),
    catalogs: { avatars: BUILTIN_AVATARS, voices: BUILTIN_VOICES, profiles: BUILTIN_PROFILES },
    notes: [
      '平台登录、实名与人脸认证在官方客户端完成，本插件只保存操作员声明时间戳，不保存任何凭据',
      '云端 API Key 不落库（环境变量 DAFEIYU_CLOUD_API_KEY）；云端设置覆盖在重启插件后生效',
      'AI 标识不可关闭（§23.2）：任何设置写入都无法将其隐藏',
      '观众画像默认不用于参数训练；个性化退出始终可用（隐私下限不可放宽）',
    ],
  }
}

interface ReplyRow {
  readonly reply_id: number
  readonly request_id: string
  readonly session_id: string
  readonly question_text: string
  readonly reply_text: string
  readonly route: string
  readonly created_at: string
}

interface FeedbackLiteRow {
  readonly feedback_id: string
  readonly label: string
  readonly status: string
  readonly target_reply_id: string | null
  readonly correction: string | null
  readonly created_at: string
}

interface GiftEntryRow {
  readonly entry_id: number
  readonly gift_id: string
  readonly quantity_delta: number
  readonly face_value: number | null
  readonly settlement_status: string
  readonly verification_status: string
  readonly received_at: string
}

interface LatestTrainingRunRow {
  readonly run_id: string
  readonly status: string
  readonly optimizer_steps: number
  readonly started_at: string | null
  readonly finished_at: string | null
  readonly error: string | null
}

export async function handleDataGetRoute(
  handle: DafeiyuPluginHandle,
  path: string,
  res: ServerResponse,
): Promise<boolean> {
  if (path === 'settings') {
    json(res, 200, { ok: true, settings: buildSettingsPayload(handle) })
    return true
  }

  if (path === 'preview') {
    const persona = handle.settings.getPersona()
    const profile = handle.settings.getPersonaProfile()
    const scene = handle.settings.getScene()
    const platform = handle.settings.getPlatform()
    json(res, 200, {
      ok: true,
      preview: {
        liveStatus: handle.live.session.current,
        liveDisplay: handle.live.session.display(),
        previewActive: handle.live.session.previewActive,
        // 本地预览 ≠ 已开播（§24.2）；画布常显 AI 标识
        persona: {
          name: profile.name,
          enName: profile.enName,
          profileId: profile.id,
          tagline: profile.tagline,
          avatarId: persona.avatarId,
          aiLabelText: persona.aiLabelText,
        },
        scene,
        officialClientUrl: platform.officialClientUrl,
      },
    })
    return true
  }

  if (path === 'selfcheck') {
    const report = await runSelfCheck({
      ...(handle.configPath !== '' ? { configPath: handle.configPath } : {}),
      dataDir: handle.dataDir,
      ...(process.env.DAFEIYU_OLLAMA_URL !== undefined ? { ollamaUrl: process.env.DAFEIYU_OLLAMA_URL } : {}),
    })
    json(res, 200, { ok: true, report })
    return true
  }

  if (path === 'diagnostics') {
    json(res, 200, {
      ok: true,
      report: exportDiagnosticReport(handle.db),
      disclosure: [
        '报告仅含聚合计数与状态分布，不含观众标识、正文、凭据',
        '云端费用以服务商账单为准；礼物标价不等于实际收入',
      ],
    })
    return true
  }

  if (path === 'replies') {
    const replies = all<ReplyRow>(handle.db, 'SELECT * FROM reply_log ORDER BY reply_id DESC LIMIT 50')
    const feedbacks = all<FeedbackLiteRow>(
      handle.db,
      `SELECT feedback_id, label, status, target_reply_id, correction, created_at
       FROM feedback WHERE target_reply_id IS NOT NULL ORDER BY created_at DESC`,
    )
    const byReply = new Map<string, Array<{ label: string; status: string }>>()
    for (const fb of feedbacks) {
      const key = fb.target_reply_id as string
      const list = byReply.get(key) ?? []
      list.push({ label: fb.label, status: fb.status })
      byReply.set(key, list)
    }
    json(res, 200, {
      ok: true,
      replies: replies.map((r) => ({
        replyId: r.reply_id,
        requestId: r.request_id,
        sessionId: r.session_id,
        question: r.question_text,
        reply: r.reply_text,
        route: r.route,
        createdAt: r.created_at,
        feedback: byReply.get(r.request_id) ?? [],
      })),
    })
    return true
  }

  if (path === 'feedback') {
    const rows = all<FeedbackLiteRow>(
      handle.db,
      `SELECT feedback_id, label, status, target_reply_id, correction, created_at
       FROM feedback ORDER BY created_at DESC LIMIT 50`,
    )
    json(res, 200, {
      ok: true,
      feedback: rows.map((r) => ({
        feedbackId: r.feedback_id,
        label: r.label,
        status: r.status,
        targetReplyId: r.target_reply_id,
        correction: r.correction,
        createdAt: r.created_at,
      })),
    })
    return true
  }

  if (path === 'gifts/summary') {
    const totals = handle.gifts.ledger.totals()
    const entries = all<GiftEntryRow>(
      handle.db,
      `SELECT entry_id, gift_id, quantity_delta, face_value, settlement_status, verification_status, received_at
       FROM gift_ledger ORDER BY entry_id DESC LIMIT 20`,
    )
    json(res, 200, {
      ok: true,
      totals,
      entries,
      pendingAckCount: handle.gifts.ack.pendingAckCount(),
      ackSettings: handle.settings.getGifts(),
      notes: [
        '礼物标价不等于实际收入；平台未提供结算接口时需官方账单导入核对',
        '危险昵称不点名由既有规则兜底，与答谢点名开关无关（§10.2）',
      ],
    })
    return true
  }

  if (path === 'training/progress') {
    const verdict = handle.training.scheduler.evaluateOpportunity()
    const latestRun = get<LatestTrainingRunRow>(
      handle.db,
      `SELECT run_id, status, optimizer_steps, started_at, finished_at, error
       FROM training_runs ORDER BY rowid DESC LIMIT 1`,
    )
    json(res, 200, {
      ok: true,
      lastEntry: handle.live.trainingEntry.lastResult,
      learningPaused: handle.live.trainingEntry.learningPaused,
      opportunity: verdict.admit ? { admit: true, detail: '样本/资源/政策门通过' } : { admit: false, detail: verdict.detail },
      latestRun: latestRun ?? null,
    })
    return true
  }

  if (path === 'costs') {
    json(res, 200, {
      ok: true,
      todayCostCny: todayCostCny(handle.db),
      cloudEnabled: handle.featureGates.cloudCallsEnabled,
      disabledReasons: handle.featureGates.cloudDisabledReasons,
      dailyBudgetCny: handle.config.models.cloud.dailyBudgetCny,
      note: '费用以服务商账单为准；预算未配置时付费调用被禁用',
    })
    return true
  }

  return false
}
