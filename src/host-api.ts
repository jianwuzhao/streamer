/**
 * 宿主共享 API（Web 面板后端）：经宿主 `connection/request` 瀑布承接
 * 已认证的同源请求（/api/dafeiyu/*），只暴露产品入口语义，不透出内部服务句柄。
 *
 * 路由分派（按功能拆分，均 <400 行/文件）：
 * - 本文件：GET status、POST 四主操作/紧急停止/设置写入/反馈/观众操作/训练
 * - host-api-data.ts：面板数据 GET（settings/preview/selfcheck/diagnostics/
 *   replies/feedback/gifts/summary/training/progress/costs）
 * - host-api-audience.ts：观众与治理 GET（audience×2、governance×4）
 * - host-api-shared.ts：类型与公共助手
 */
import type { DafeiyuPluginHandle } from './index.ts'
import { BUILTIN_VOICES, SettingsValidationError, type Readiness } from './settings/store.ts'
import { SimulationError } from './live/simulation.ts'
import { json, readBody, todayCostCny, FEEDBACK_LABELS, type FeedbackLabelInput, type ServerRequest, type ServerResponse } from './host-api-shared.ts'
import { handleDataGetRoute } from './host-api-data.ts'
import { handleAudienceGetRoute } from './host-api-audience.ts'

export interface DafeiyuStatus {
  liveStatus: string
  liveDisplay: string
  learningPaused: boolean
  activeReleaseId: string | null
  trainingEligible: boolean
  trainingEligibleDetail: string
  cloudEnabled: boolean
  mode: string
  killSwitch: boolean
  /** 操作员设置就绪（§24.1 向导输入） */
  personaReady: boolean
  personaReadyReason: string | null
  platformReady: boolean
  platformReadyReason: string | null
  previewActive: boolean
  todayCostCny: number
  /** 待处理问题数（负面反馈待核实队列） */
  pendingIssues: number
  /** 模拟开播概览（首播演练，不接触平台） */
  simulationRunNo: number
  simulationStatus: string
  simulationFirstCompleted: boolean
}

function readyFlag(r: Readiness): { ready: boolean; reason: string | null } {
  return r.ready ? { ready: true, reason: null } : { ready: false, reason: r.reason }
}

export function buildStatus(handle: DafeiyuPluginHandle): DafeiyuStatus {
  const verdict = handle.training.scheduler.evaluateOpportunity()
  const readiness = handle.settings.readiness()
  const persona = readyFlag(readiness.persona)
  const platform = readyFlag(readiness.platform)
  const simulation = handle.simulation.state()
  return {
    liveStatus: handle.live.session.current,
    liveDisplay: handle.live.session.display(),
    learningPaused: handle.live.trainingEntry.learningPaused,
    activeReleaseId: handle.governance.releases.activeReleaseId(),
    trainingEligible: verdict.admit,
    trainingEligibleDetail: verdict.admit ? '样本/资源/政策门通过' : verdict.detail,
    cloudEnabled: handle.featureGates.cloudCallsEnabled,
    mode: handle.config.mode,
    killSwitch: handle.config.killSwitch,
    personaReady: persona.ready,
    personaReadyReason: persona.reason,
    platformReady: platform.ready,
    platformReadyReason: platform.reason,
    previewActive: handle.live.session.previewActive,
    todayCostCny: todayCostCny(handle.db),
    pendingIssues: handle.feedback.pendingQueue().length,
    simulationRunNo: simulation.runNo,
    simulationStatus: simulation.status,
    simulationFirstCompleted: simulation.firstCompleted,
  }
}

/** 生成 connection/request 处理器：非 /api/dafeiyu/ 前缀一律 next() 放行。 */
export function createRequestHandler(handle: DafeiyuPluginHandle) {
  return async (req: ServerRequest, res: ServerResponse, next: () => Promise<void>): Promise<void> => {
    const url = req.url ?? ''
    if (!url.startsWith('/api/dafeiyu/')) return next()
    const path = url.replace(/\?.*$/, '').slice('/api/dafeiyu/'.length)
    const query = new URLSearchParams(url.split('?')[1] ?? '')
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (path === 'status' || path === '')) {
        return json(res, 200, { ok: true, status: buildStatus(handle) })
      }

      if (method === 'GET') {
        if (await handleDataGetRoute(handle, path, res)) return
        if (handleAudienceGetRoute(handle, path, query, res)) return
      }

      if (method === 'POST') {
        const body = await readBody(req)
        const args = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>)
        switch (path) {
          case 'live/start': {
            // preflight 由操作员设置实况拼装（§24.1/§23.2）：
            // - AI 标识恒可见（设置域 schema 为字面量 true，无法关闭）；
            // - pinned 基线即稳定版本（首播无发布版本时成立）；
            // - 推流由直播伴侣负责（辅助模式），本插件不自建推流。
            const readiness = handle.settings.readiness()
            const preflightInput = {
              aiLabelVisible: true,
              stableReleaseAvailable: true,
              resourceOk: true,
              personaConfigured: readiness.persona.ready,
              platformConfigured: readiness.platform.ready,
            }
            const pre = handle.live.session.preflight(preflightInput)
            const status = await handle.live.session.start(
              typeof args.idempotencyKey === 'string' ? args.idempotencyKey : `ui-${Date.now()}`,
              preflightInput,
            )
            return json(res, 200, {
              ok: true,
              status: buildStatus(handle),
              result: { status, ...(pre.pass ? {} : { reason: pre.reason }) },
            })
          }
          case 'live/stop': {
            const status = await handle.live.session.stop()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'live/emergency-stop': {
            const status = handle.live.session.emergencyStop()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'live/operator-confirm': {
            const status = handle.live.session.operatorConfirmedLive(new Date().toISOString())
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'preview/start': {
            const gate = handle.live.session.enterPreview(handle.settings.personaReady())
            if (!gate.ok) {
              return json(res, 400, { ok: false, error: gate.reason, status: buildStatus(handle) })
            }
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status: gate.status } })
          }
          case 'preview/stop': {
            const status = handle.live.session.exitPreview()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'preview/voice-test': {
            // 试听语句本地返回（不调模型）；客户端用浏览器语音朗读并如实标注
            const persona = handle.settings.getPersona()
            const voice =
              BUILTIN_VOICES.find((v) => v.id === persona.voiceId) ??
              ({ id: 'qing-wan', label: '清婉（女声）', lang: 'zh-CN', style: '温和亲切，日常闲聊' } as const)
            return json(res, 200, {
              ok: true,
              result: {
                phrase: persona.samplePhrase,
                voice: { id: voice.id, label: voice.label, lang: voice.lang, style: voice.style },
                voiceInteractionEnabled: persona.voiceInteractionEnabled,
                note: '浏览器语音试听（系统 TTS）；语音互动开关控制麦克风识别与朗读，录音不上传；最终播出音色以直播伴侣音轨为准',
              },
            })
          }
          case 'settings/persona':
          case 'settings/platform':
          case 'settings/scene':
          case 'settings/cloud':
          case 'settings/data-usage':
          case 'settings/gifts': {
            const section = path.split('/')[1] as 'persona' | 'platform' | 'scene' | 'cloud' | 'data-usage' | 'gifts'
            try {
              const saved =
                section === 'persona'
                  ? handle.settings.savePersona(args)
                  : section === 'platform'
                    ? handle.settings.savePlatform(args)
                    : section === 'scene'
                      ? handle.settings.saveScene(args)
                      : section === 'cloud'
                        ? handle.settings.saveCloud(args)
                        : section === 'data-usage'
                          ? handle.settings.saveDataUsage(args)
                          : handle.settings.saveGifts(args)
              return json(res, 200, {
                ok: true,
                section,
                value: saved,
                readiness: handle.settings.readiness(),
                ...(section === 'cloud' ? { note: '云端覆盖在重启插件后生效；API Key 仍走环境变量' } : {}),
              })
            } catch (err) {
              if (err instanceof SettingsValidationError) {
                return json(res, 400, { ok: false, error: err.message, issues: err.issues })
              }
              throw err
            }
          }
          case 'feedback': {
            const label = args.label
            if (typeof label !== 'string' || !(FEEDBACK_LABELS as readonly string[]).includes(label)) {
              return json(res, 400, { ok: false, error: `label 须为 ${FEEDBACK_LABELS.join('/')} 之一` })
            }
            const record = handle.feedback.record({
              actorKind: 'operator',
              ...(typeof args.targetReplyId === 'string' ? { targetReplyId: args.targetReplyId } : {}),
              label: label as FeedbackLabelInput,
              ...(typeof args.correction === 'string' && args.correction !== '' ? { correction: args.correction } : {}),
            })
            return json(res, 200, { ok: true, result: record })
          }
          case 'feedback/advance': {
            // 操作员核实推进：received → verifying → resolved | insufficient_evidence
            const next = args.next
            const allowed = ['verifying', 'resolved', 'insufficient_evidence']
            if (typeof args.feedbackId !== 'string' || typeof next !== 'string' || !allowed.includes(next)) {
              return json(res, 400, { ok: false, error: `next 须为 ${allowed.join('/')} 之一且 feedbackId 必填` })
            }
            try {
              const record = handle.feedback.advance(
                args.feedbackId,
                next as 'verifying' | 'resolved' | 'insufficient_evidence',
                typeof args.note === 'string' ? args.note : undefined,
              )
              return json(res, 200, { ok: true, result: record })
            } catch (err) {
              return json(res, 400, { ok: false, error: (err as Error).message })
            }
          }
          case 'audience/correction': {
            // 观众纠错经操作员录入：viewer_stated 直接覆盖推测并保留审计链（§6.3）
            if (
              typeof args.viewerKey !== 'string' || args.viewerKey === '' ||
              typeof args.fieldName !== 'string' || args.fieldName === '' ||
              typeof args.value !== 'string' || args.value === ''
            ) {
              return json(res, 400, { ok: false, error: 'viewerKey/fieldName/value 均必填' })
            }
            const field = handle.audience.profiles.viewerCorrection({
              viewerKey: args.viewerKey,
              fieldName: args.fieldName,
              value: args.value,
            })
            return json(res, 200, { ok: true, result: field })
          }
          case 'audience/personalization-off': {
            if (typeof args.viewerKey !== 'string' || args.viewerKey === '') {
              return json(res, 400, { ok: false, error: 'viewerKey 必填' })
            }
            const requestId = handle.audience.deletion.personalizationOff(args.viewerKey)
            return json(res, 200, { ok: true, result: { requestId, detail: '已退出个性化：字段保留但不再用于个性化' } })
          }
          case 'audience/deletion-request': {
            // 删除第一步：提交申请（received）——验证身份后才可执行
            if (typeof args.viewerKey !== 'string' || args.viewerKey === '') {
              return json(res, 400, { ok: false, error: 'viewerKey 必填' })
            }
            const requestId = handle.audience.deletion.submitRequest(args.viewerKey, 'deletion')
            return json(res, 200, {
              ok: true,
              result: { requestId, status: 'received', detail: '申请已受理：验证该观众身份后执行删除（两步流）' },
            })
          }
          case 'audience/deletion-execute': {
            // 删除第二步：验证通过后落墓碑；未验证请求保持 received（不删他人画像）
            if (
              typeof args.requestId !== 'string' || args.requestId === '' ||
              typeof args.viewerKey !== 'string' || args.viewerKey === ''
            ) {
              return json(res, 400, { ok: false, error: 'requestId/viewerKey 必填' })
            }
            const receipt = handle.audience.deletion.executeDeletion(args.requestId, {
              verificationPassed: args.verificationPassed === true,
              viewerKey: args.viewerKey,
            })
            if (receipt === null) {
              return json(res, 400, {
                ok: false,
                error: '删除未执行：请求不存在/观众不匹配，或身份验证未通过（请求保持 received）',
              })
            }
            return json(res, 200, { ok: true, result: receipt })
          }
          case 'training/train-once': {
            const result = await handle.live.trainingEntry.trainOnce({
              mode: args.mode === 'qlora' ? 'qlora' : 'dry_run',
            })
            return json(res, 200, { ok: true, status: buildStatus(handle), result })
          }
          case 'learning/pause': {
            handle.live.trainingEntry.pauseLearning()
            return json(res, 200, { ok: true, status: buildStatus(handle) })
          }
          case 'learning/resume': {
            handle.live.trainingEntry.resumeLearning()
            return json(res, 200, { ok: true, status: buildStatus(handle) })
          }
          case 'release/rollback': {
            const active = handle.governance.releases.activeReleaseId()
            if (active === null) return json(res, 400, { ok: false, error: '无 active 版本可回滚' })
            const result = await handle.runtime.rollback(active)
            return json(res, 200, { ok: true, status: buildStatus(handle), result })
          }
          case 'simulation/start':
          case 'simulation/stop':
          case 'simulation/event':
          case 'simulation/voice':
          case 'simulation/run-script': {
            // 模拟开播：本机沙箱演练，不连接平台、不推流、不切换生产播出状态。
            try {
              if (path === 'simulation/start') {
                await handle.simulation.start()
                return json(res, 200, { ok: true, simulation: handle.simulation.state() })
              }
              if (path === 'simulation/stop') {
                await handle.simulation.stop()
                return json(res, 200, { ok: true, simulation: handle.simulation.state() })
              }
              if (path === 'simulation/run-script') {
                const result = await handle.simulation.runScript()
                return json(res, 200, { ok: true, simulation: handle.simulation.state(), result })
              }
              if (typeof args.text !== 'string') {
                return json(res, 400, { ok: false, error: 'text 必填（模拟语音转写 / 弹幕文本）' })
              }
              const kind = path === 'simulation/voice' ? 'voice' : args.kind === 'gift' ? 'gift' : 'danmaku'
              const result = await handle.simulation.emit(
                kind,
                args.text,
                typeof args.actor === 'string' && args.actor.trim() !== '' ? args.actor : undefined,
              )
              return json(res, 200, { ok: true, simulation: handle.simulation.state(), result })
            } catch (err) {
              if (err instanceof SimulationError) return json(res, 400, { ok: false, error: err.message })
              throw err
            }
          }
          default:
            return json(res, 404, { ok: false, error: `未知路径: ${path}` })
        }
      }
      return json(res, 405, { ok: false, error: `方法不支持: ${method}` })
    } catch (err) {
      return json(res, 500, { ok: false, error: (err as Error).message })
    }
  }
}
