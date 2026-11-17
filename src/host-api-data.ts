/**
 * 面板数据 GET 路由：settings / preview / selfcheck / diagnostics /
 * replies / feedback / gifts/summary / training/progress / costs。
 * 命中路径自行写响应并返回 true；未命中返回 false 交回主入口。
 */
import type { DafeiyuPluginHandle } from './index.ts'
import { probeOllamaInstallState, type OllamaInstallState } from './model-deploy.ts'
import { runSelfCheck } from './installer/selfcheck.ts'
import { exportDiagnosticReport } from './installer/diagnostics.ts'
import { BUILTIN_AVATARS, BUILTIN_VOICES, BUILTIN_PROFILES, CLOUD_PROVIDER_PRESETS, resolveCloudBaseUrl } from './settings/catalogs.ts'
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
  /** 云端密钥状态（掩码 + 来源；明文永不回传） */
  cloudKey: { source: 'env' | 'ui' | 'none'; masked: string | null; updatedAt: string | null }
  /** 当前选中的角色档案（主播信息来源） */
  profile: ReturnType<DafeiyuPluginHandle['settings']['getPersonaProfile']>
  readiness: { persona: Readiness; platform: Readiness }
  catalogs: {
    avatars: typeof BUILTIN_AVATARS
    voices: typeof BUILTIN_VOICES
    profiles: typeof BUILTIN_PROFILES
    cloudProviders: typeof CLOUD_PROVIDER_PRESETS
  }
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
    cloudKey: handle.settings.getCloudKeyStatus(),
    readiness: handle.settings.readiness(),
    catalogs: {
      avatars: BUILTIN_AVATARS,
      voices: BUILTIN_VOICES,
      profiles: BUILTIN_PROFILES,
      cloudProviders: CLOUD_PROVIDER_PRESETS,
    },
    notes: [
      '平台登录、实名与人脸认证在官方客户端完成，本插件只保存操作员声明时间戳，不保存任何凭据',
      '云端 API Key 可在「模型与云端」界面维护（仅回掩码；环境变量 DAFEIYU_CLOUD_API_KEY 优先）；云端设置与密钥保存后即时生效（测试通过才可保存）',
      'AI 标识不可关闭（§23.2）：任何设置写入都无法将其隐藏',
      '观众画像默认不用于参数训练；个性化退出始终可用（隐私下限不可放宽）',
    ],
  }
}

interface ReplyRow {
  readonly reply_id: number
  readonly model: string | null
  readonly tokens_in: number | null
  readonly tokens_out: number | null
  readonly tokens_total: number | null
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

/**
 * model/deploy 的安装探测缓存（10s；running 期间不探测，避免与部署进程抢端口/状态）。
 * 探测只在后台刷新：GET 路由同步读缓存——未过期直接返回，过期返回旧值并异步刷新，
 * 面板请求永不被本机网络探测延迟（宿主连接瀑布可能对慢响应超时）。
 */
const installProbeCache = new WeakMap<
  DafeiyuPluginHandle,
  { state: OllamaInstallState | null; expires: number; refreshing: boolean }
>()

function refreshInstallProbe(handle: DafeiyuPluginHandle): void {
  const entry = installProbeCache.get(handle)
  if (entry?.refreshing === true) return
  installProbeCache.set(handle, { state: entry?.state ?? null, expires: entry?.expires ?? 0, refreshing: true })
  probeOllamaInstallState({
    ollamaUrl: process.env.DAFEIYU_OLLAMA_URL ?? 'http://127.0.0.1:11434',
    model: handle.modelDeploy.state().model,
    timeoutMs: 1_200,
  })
    .then((state) => {
      installProbeCache.set(handle, { state, expires: Date.now() + 10_000, refreshing: false })
    })
    .catch(() => {
      const current = installProbeCache.get(handle)
      installProbeCache.set(handle, {
        state: current?.state ?? null,
        expires: Date.now() + 10_000,
        refreshing: false,
      })
    })
}

/** 同步取安装探测快照：无缓存/过期时返回现值并触发后台刷新（首次为 null，下轮轮询补齐）。 */
function ollamaInstallSnapshot(handle: DafeiyuPluginHandle, deployStatus: string): OllamaInstallState | null {
  if (deployStatus === 'running') return null
  const entry = installProbeCache.get(handle)
  if (entry === undefined) {
    refreshInstallProbe(handle)
    return null
  }
  if (entry.expires <= Date.now()) refreshInstallProbe(handle)
  return entry.state
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
        conversationEnabled: handle.live.session.previewRunId !== null,
        // 本地预览 ≠ 已开播（§24.2）；画布常显 AI 标识
        persona: {
          name: profile.name,
          enName: profile.enName,
          profileId: profile.id,
          source: profile.source,
          tagline: profile.tagline,
          bio: profile.bio,
          theme: profile.theme,
          // 官方媒体档案（官网角色封面/试听 + 本地 Live2D 包 id）；插件内角色为 null
          media: profile.media ?? null,
          avatarId: persona.avatarId,
          live2dModelId: persona.live2dModelId,
          voiceId: persona.voiceId,
          aiLabelText: persona.aiLabelText,
        },
        scene,
        officialClientUrl: platform.officialClientUrl,
      },
    })
    return true
  }

  if (path === 'model/deploy') {
    // 一键部署本地模型：状态轮询（no-store，running 期间前端 2s 轮询）；
    // install = Ollama 服务/目标模型探测（未安装提示数据源；running 期间为 null）
    res.setHeader('cache-control', 'no-store')
    json(res, 200, {
      ok: true,
      deploy: handle.modelDeploy.state(),
      install: ollamaInstallSnapshot(handle, handle.modelDeploy.state().status),
    })
    return true
  }

  if (path === 'cloud/quota') {
    // 模型额度/可用余额查询（0.15.2）：按已保存的生效配置（env 优先）尽力查询——
    // DeepSeek 官方 /user/balance；其余 OpenAI 兼容端点尝试 dashboard/billing（one-api/new-api 系支持）；
    // 不支持的服务商（如腾讯混元）如实标注，不编造数值。
    res.setHeader('cache-control', 'no-store')
    const envKey = process.env.DAFEIYU_CLOUD_API_KEY?.trim() ?? ''
    const envBase = process.env.DAFEIYU_CLOUD_BASE_URL?.trim() ?? ''
    const cloud = handle.settings.getCloud()
    const provider = cloud.provider.trim()
    // 端点解析优先级（0.15.3）：环境变量 > 界面「端点 URL」> 服务商预设
    const settingsBase = cloud.baseUrl.trim()
    const baseURL = envBase !== '' ? envBase : settingsBase !== '' ? settingsBase : (resolveCloudBaseUrl(provider) ?? '')
    const apiKey = envKey !== '' ? envKey : handle.settings.getCloudSecretRaw()
    if (provider === '' && envBase === '' && settingsBase === '') {
      json(res, 200, { ok: false, error: '云端服务商未配置：先在上方选择预设并保存' })
      return true
    }
    if (apiKey === '') {
      json(res, 200, { ok: false, error: 'API Key 未配置（环境变量或界面维护）' })
      return true
    }
    const headers = { authorization: `Bearer ${apiKey}` }
    const withTimeout = async (url: string): Promise<Response> => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8_000)
      try {
        return await fetch(url, { headers, signal: controller.signal })
      } finally {
        clearTimeout(timer)
      }
    }
    try {
      if (baseURL === '') {
        json(res, 200, { ok: false, error: '云端服务商未配置：先在上方选择预设并保存' })
        return true
      }
      const base = new URL(baseURL)
      // DeepSeek 官方余额接口挂在源站根（非 /v1 前缀）。
      // 显式端点（环境变量或界面「端点 URL」，自定义网关）优先于按 provider 的识别——
      // 用户换了端点就按新端点的能力查询。
      const explicitBase = envBase !== '' || settingsBase !== ''
      const isDeepseek = explicitBase
        ? base.hostname === 'api.deepseek.com'
        : (provider === 'deepseek' || base.hostname === 'api.deepseek.com')
      if (isDeepseek) {
        const upstream = await withTimeout(`${base.origin}/user/balance`)
        if (upstream.status === 401 || upstream.status === 403) {
          json(res, 200, { ok: false, error: `密钥无效或无权限（HTTP ${upstream.status}）`, provider, baseURL })
          return true
        }
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`)
        const body = (await upstream.json()) as {
          is_available?: boolean
          balance_infos?: Array<{ currency?: string; total_balance?: string; granted_balance?: string; tipped_balance?: string }>
        }
        const info = body.balance_infos?.[0]
        if (info === undefined) throw new Error('响应缺少 balance_infos')
        const total = Number(info.total_balance ?? 0)
        const granted = Number(info.granted_balance ?? 0)
        const tipped = Number(info.tipped_balance ?? 0)
        const currency = info.currency ?? 'CNY'
        json(res, 200, {
          ok: true,
          supported: true,
          source: 'deepseek',
          provider,
          baseURL,
          quota: {
            currency,
            available: total,
            availableText: `${currency} ${total.toFixed(2)}`,
            details: [
              { label: '总余额', value: `${currency} ${total.toFixed(2)}` },
              { label: '赠送额度', value: `${currency} ${granted.toFixed(2)}` },
              { label: '充值额度', value: `${currency} ${tipped.toFixed(2)}` },
              ...(body.is_available === false ? [{ label: '状态', value: 'API 标记不可用（余额不足或已停用）' }] : []),
            ],
          },
          fetchedAt: new Date().toISOString(),
        })
        return true
      }
      // 其余 OpenAI 兼容端点：尝试 one-api/new-api 系的 dashboard/billing（订阅额度 + 本年用量）
      const sub = await withTimeout(`${baseURL}/dashboard/billing/subscription`)
      if (sub.status === 404 || sub.status === 405 || sub.status === 501) {
        json(res, 200, {
          ok: true,
          supported: false,
          provider,
          baseURL,
          note: '该服务商未提供余额查询接口，额度以服务商控制台为准',
          fetchedAt: new Date().toISOString(),
        })
        return true
      }
      if (sub.status === 401 || sub.status === 403) {
        json(res, 200, { ok: false, error: `密钥无效或无权限（HTTP ${sub.status}）`, provider, baseURL })
        return true
      }
      if (!sub.ok) throw new Error(`HTTP ${sub.status}`)
      const subBody = (await sub.json()) as { hard_limit_usd?: number }
      const hardLimit = typeof subBody.hard_limit_usd === 'number' ? subBody.hard_limit_usd : null
      const now = new Date()
      const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1)).toISOString().slice(0, 10)
      const end = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10)
      const usage = await withTimeout(`${baseURL}/dashboard/billing/usage?start_date=${start}&end_date=${end}`)
      let used: number | null = null
      if (usage.ok) {
        const usageBody = (await usage.json()) as { total_usage?: number }
        if (typeof usageBody.total_usage === 'number') used = usageBody.total_usage / 100
      }
      const available = hardLimit !== null && used !== null ? hardLimit - used : hardLimit
      json(res, 200, {
        ok: true,
        supported: true,
        source: 'openai_billing',
        provider,
        baseURL,
        quota: {
          currency: 'USD',
          ...(available !== null ? { available } : {}),
          availableText: available !== null ? `$${available.toFixed(2)}` : '未知',
          details: [
            ...(hardLimit !== null ? [{ label: '总额度', value: `$${hardLimit.toFixed(2)}` }] : []),
            ...(used !== null ? [{ label: '本年已用', value: `$${used.toFixed(2)}` }] : []),
            ...(available !== null ? [{ label: '可用余额', value: `$${available.toFixed(2)}` }] : []),
          ],
        },
        fetchedAt: new Date().toISOString(),
      })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      json(res, 200, { ok: false, error: `余额查询失败：${msg.slice(0, 120)}`, provider, baseURL })
      return true
    }
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
    res.setHeader('cache-control', 'no-store')
    const replies = all<ReplyRow>(handle.db, `
      SELECT r.*, u.model, u.tokens_in, u.tokens_out, COALESCE(u.tokens_total, u.tokens_in + u.tokens_out) AS tokens_total
      FROM reply_log r LEFT JOIN usage u ON u.usage_id = COALESCE(r.usage_id, (
        SELECT last.usage_id FROM usage last WHERE last.request_id = r.request_id
          AND last.route = r.route AND last.reason_code IS NULL ORDER BY last.usage_id DESC LIMIT 1
      ))
      ORDER BY r.reply_id DESC LIMIT 50`)
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
        model: r.model, tokensIn: r.tokens_in, tokensOut: r.tokens_out, tokensTotal: r.tokens_total,
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
