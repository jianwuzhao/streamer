/**
 * 宿主共享 API（Web 面板后端）：经宿主 `connection/request` 瀑布承接
 * 已认证的同源请求（/api/dafeiyu/*），只暴露产品入口语义，不透出内部服务句柄。
 *
 * 路由分派（按功能拆分，均 <400 行/文件）：
 * - 本文件：GET status、POST 四主操作/紧急停止/设置写入/反馈/观众操作/训练
 *   与 preview/role-speech（macOS 角色语音）
 * - host-api-data.ts：面板数据 GET（settings/preview/selfcheck/diagnostics/
 *   replies/feedback/gifts/summary/training/progress/costs）
 * - host-api-audience.ts：观众与治理 GET（audience×2、governance×4）
 * - host-api-shared.ts：类型与公共助手
 */
import type { DafeiyuPluginHandle } from './index.ts'
import type { BroadcastWindow } from './live/broadcast-window.ts'
import { ConversationError, INTERACTION_KINDS, MESSAGE_LIMIT, type InteractionKind } from './live/conversation.ts'
import { BUILTIN_VOICES, RIGGED_MODEL_ID, resolveCloudBaseUrl } from './settings/catalogs.ts'
import { SettingsValidationError, type Readiness } from './settings/store.ts'
import { json, readBody, todayCostCny, FEEDBACK_LABELS, type FeedbackLabelInput, type ServerRequest, type ServerResponse } from './host-api-shared.ts'
import { handleDataGetRoute } from './host-api-data.ts'
import { handleAudienceGetRoute } from './host-api-audience.ts'
import { handleAvatarGetRoute } from './host-api-avatar.ts'
import { ReferenceVoiceError, synthesizeReferenceVoice } from './avatar/reference-voice.ts'
import {
  ROLE_SPEECH_PROFILE_IDS,
  ROLE_SPEECH_TEXT_MAX,
  RoleSpeechError,
  roleSpeechService,
} from './avatar/role-speech.ts'

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
}

function readyFlag(r: Readiness): { ready: boolean; reason: string | null } {
  return r.ready ? { ready: true, reason: null } : { ready: false, reason: r.reason }
}

export function buildStatus(handle: DafeiyuPluginHandle): DafeiyuStatus {
  const verdict = handle.training.scheduler.evaluateOpportunity()
  const readiness = handle.settings.readiness()
  const persona = readyFlag(readiness.persona)
  const platform = readyFlag(readiness.platform)
  return {
    liveStatus: handle.live.session.current,
    liveDisplay: handle.live.session.display(),
    learningPaused: handle.live.trainingEntry.learningPaused,
    activeReleaseId: handle.governance.releases.activeReleaseId(),
    trainingEligible: verdict.admit,
    trainingEligibleDetail: verdict.admit ? '满足当前训练条件'
      : verdict.reason === 'training_disabled' ? '训练尚未启用'
      : verdict.reason === 'insufficient_vram' ? '当前可用显存不足'
      : verdict.detail,
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
  }
}

/** 生成 connection/request 处理器：非 /api/dafeiyu/ 前缀一律 next() 放行。 */
export function createRequestHandler(handle: DafeiyuPluginHandle, broadcastWindow?: BroadcastWindow) {
  const { session, conversation, startInteraction, stopInteraction, interactionSource, interactionStatus } = handle.live
  const handler = async (req: ServerRequest, res: ServerResponse, next: () => Promise<void>): Promise<void> => {
    const url = req.url ?? ''
    if (!url.startsWith('/api/dafeiyu/')) return next()
    const path = url.replace(/\?.*$/, '').slice('/api/dafeiyu/'.length)
    const query = new URLSearchParams(url.split('?')[1] ?? '')
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (path === 'status' || path === '')) {
        return json(res, 200, { ok: true, status: buildStatus(handle) })
      }

      if (method === 'GET' && path === 'settings/export') {
        res.setHeader('cache-control', 'no-store')
        return json(res, 200, { ok: true, backup: handle.settings.exportBackup() })
      }

      if (method === 'GET') {
        if (path === 'interaction') {
          res.setHeader('cache-control', 'no-store')
          return json(res, 200, { ok: true, ...conversation.snapshot(), danmaku: interactionStatus(), source: interactionSource() })
        }
        if (await handleDataGetRoute(handle, path, res)) return
        if (handleAudienceGetRoute(handle, path, query, res)) return
        if (handleAvatarGetRoute(handle.avatar, path, query, res, req.headers)) return
      }

      if (method === 'POST') {
        // 预览输入类端点共用 8192 字节请求体上限（chat 文本 + role-speech 的 profileId/文本）
        const boundedPreviewInput = path === 'preview/chat' || path.startsWith('preview/role-speech') ||
          path.startsWith('interaction/') || path.startsWith('broadcast-window/')
        const body = await readBody(req, path.startsWith('settings/import') ? 131072 : boundedPreviewInput ? 8192 : Infinity)
        if (body === null) return json(res, 413, { ok: false, error: '请求体过大' })
        let parsed: unknown
        try {
          parsed = body === '' ? {} : JSON.parse(body)
        } catch {
          return json(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return json(res, 400, { ok: false, error: '请求体须为 JSON 对象' })
        }
        const args = parsed as Record<string, unknown>
        switch (path) {
          case 'settings/import/validate':
          case 'settings/import': {
            if (!['unconfigured', 'stopped', 'ended', 'recoverable_fault'].includes(session.current)) {
              return json(res, 409, { ok: false, error: '请先下播并退出本地预览，再导入配置' })
            }
            try {
              if (path === 'settings/import/validate') {
                return json(res, 200, { ok: true, backup: handle.settings.validateBackup(args.backup) })
              }
              if (args.confirm !== true) return json(res, 400, { ok: false, error: '请先预览并确认覆盖当前设置' })
              handle.settings.importBackup(args.backup)
              broadcastWindow?.interrupt()
              conversation.snapshot()
              return json(res, 200, { ok: true, readiness: handle.settings.readiness() })
            } catch (err) {
              if (err instanceof SettingsValidationError) {
                return json(res, 400, { ok: false, error: err.message, issues: err.issues })
              }
              throw err
            }
          }

          case 'broadcast-window/open':
          case 'broadcast-window/close':
          case 'broadcast-window/interrupt':
          case 'broadcast-window/frame': {
            if (!broadcastWindow) return json(res, 404, { ok: false, error: '播出窗口不可用' })
            if (typeof args.owner !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.owner)) {
              return json(res, 400, { ok: false, error: '播出窗口标识无效' })
            }
            if (path === 'broadcast-window/frame') {
              const accepted = broadcastWindow.publish(args.owner, args)
              const playbackVersion = broadcastWindow.playbackVersion(args.owner)
              return json(res, 200, { ok: true, open: playbackVersion !== null, accepted, playbackVersion })
            }
            if (path === 'broadcast-window/interrupt') {
              // 工作台主动打断（连发弹幕合并超限、切角色、操作员中止）：
              // 递增播出版本并清空当前帧，之后旧版本上行帧会被 publish 拒收
              return json(res, 200, { ok: true, playbackVersion: broadcastWindow.interrupt(args.owner) })
            }
            if (path === 'broadcast-window/close') {
              broadcastWindow.close(args.owner)
              return json(res, 200, { ok: true })
            }
            await broadcastWindow.open(args.owner)
            return json(res, 200, { ok: true, playbackVersion: broadcastWindow.playbackVersion(args.owner) })
          }
          case 'live/start': {
            // preflight 由操作员设置与实况状态拼装（§24.1/§23.2）：
            // - AI 标识恒可见（设置域 schema 为字面量 true，无法关闭）；
            // - 稳定版本 = 已发布 active 版本，或首播前钉住的本地基线（二者取一即成立）；
            // - 推流由直播伴侣负责（辅助模式），本插件不自建推流；资源不足不阻断
            //   开播——本地推理不可达时按路由规则降级固定模板，训练准入的资源
            //   fail-safe 在 TrainingScheduler 侧，不在此处拦截。
            const readiness = handle.settings.readiness()
            const preflightInput = {
              aiLabelVisible: true,
              stableReleaseAvailable:
                handle.governance.releases.activeReleaseId() !== null ||
                handle.config.models.local.artifact === 'pinned_approved_artifact',
              resourceOk: true,
              personaConfigured: readiness.persona.ready,
              platformConfigured: readiness.platform.ready,
            }
            const pre = handle.live.session.preflight(preflightInput)
            const status = await handle.live.session.start(
              typeof args.idempotencyKey === 'string' ? args.idempotencyKey : `ui-${Date.now()}`,
              preflightInput,
            )
            conversation.snapshot()
            if (session.liveRunId !== null) startInteraction()
            return json(res, 200, {
              ok: true,
              status: buildStatus(handle),
              result: { status, ...(pre.pass ? {} : { reason: pre.reason }) },
            })
          }
          case 'live/stop': {
            const status = await handle.live.session.stop()
            stopInteraction()
            conversation.reset()
            // 结束直播同样是一次打断：递增播出版本，迟到帧不得恢复最后一句的口型
            broadcastWindow?.interrupt()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'live/emergency-stop': {
            handle.referenceVoiceStream.cancel()
            const status = handle.live.session.emergencyStop()
            stopInteraction()
            conversation.reset()
            // 紧急停止立即作废在途口型与动作：版本递增后旧帧一律拒收，画面切安全稿
            broadcastWindow?.interrupt()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'live/operator-confirm': {
            const status = handle.live.session.operatorConfirmedLive(new Date().toISOString())
            if (session.liveRunId !== null) startInteraction()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'preview/start': {
            if (handle.live.session.current === 'safe_scene' && args.resume !== true) {
              return json(res, 409, { ok: false, error: '请先恢复本地预览', status: buildStatus(handle) })
            }
            const resuming = session.current === 'safe_scene'
            const gate = handle.live.session.enterPreview(handle.settings.personaReady())
            if (!gate.ok) {
              return json(res, 400, { ok: false, error: gate.reason, status: buildStatus(handle) })
            }
            if (resuming) broadcastWindow?.interrupt()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status: gate.status } })
          }
          case 'preview/stop': {
            const wasPreview = session.current === 'local_preview'
            const status = handle.live.session.exitPreview()
            if (wasPreview && status === 'stopped') broadcastWindow?.interrupt()
            conversation.snapshot()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: { status } })
          }
          case 'interaction/automatic': {
            if (!Array.isArray(args.kinds) || args.kinds.length > INTERACTION_KINDS.length ||
              !args.kinds.every((item) => INTERACTION_KINDS.includes(item as InteractionKind))) {
              return json(res, 400, { ok: false, error: '请选择互动类型' })
            }
            conversation.setAutomatic(args.kinds as InteractionKind[])
            return json(res, 200, { ok: true })
          }
          case 'interaction/stage': {
            const owner = args.owner
            if (typeof owner !== 'string' || !/^[a-f0-9-]{36}$/i.test(owner)) return json(res, 400, { ok: false })
            if (args.release === true) {
              conversation.stageRelease(owner)
              return json(res, 200, { ok: true })
            }
            const completion = typeof args.completedKey === 'string' && typeof args.completedOk === 'boolean' ?
              { key: args.completedKey, ok: args.completedOk } : undefined
            const playingKey = typeof args.playingKey === 'string' ? args.playingKey : undefined
            return json(res, 200, { ok: true, ...conversation.stagePoll(owner, completion, playingKey) })
          }
          case 'interaction/replay': {
            if (typeof args.id !== 'string') return json(res, 400, { ok: false, error: '请选择一条回复' })
            conversation.stageReplay(args.id)
            return json(res, 200, { ok: true })
          }
          case 'interaction/reply': {
            if (typeof args.id !== 'string') return json(res, 400, { ok: false, error: '请选择一条弹幕' })
            return json(res, 202, { ok: true, turn: conversation.reply(args.id) })
          }
          case 'interaction/send':
          case 'preview/chat': {
            const legacy = path === 'preview/chat'
            if (legacy && session.previewRunId === null) return json(res, 409, { ok: false, error: '请先进入本地预览' })
            const text = typeof args.text === 'string' ? args.text.trim() : ''
            if (text.length === 0 || text.length > MESSAGE_LIMIT) {
              return json(res, 400, { ok: false, error: `请输入 1–${MESSAGE_LIMIT} 字的文字` })
            }
            const { turn, done } = conversation.send(text, legacy)
            if (!legacy) return json(res, 202, { ok: true, id: conversation.snapshot().id, turn })
            const result = await done
            if (!result) return json(res, 409, { ok: false, error: '预览已结束或回复中断，请重新发送' })
            return json(res, 200, { ok: true, result })
          }
          case 'preview/role-speech/warm': {
            const profileId = handle.settings.getPersonaProfile().id
            if (handle.settings.personaReady().ready &&
              (ROLE_SPEECH_PROFILE_IDS as readonly string[]).includes(profileId)) {
              handle.referenceVoiceStream.warm(profileId === RIGGED_MODEL_ID ? 'xiaxia' : profileId)
            }
            return json(res, 200, { ok: true })
          }
          case 'preview/role-speech': {
            // 使用已保存角色的本地参考音色，未安装时标明系统音色。
            const personaGate = handle.settings.personaReady()
            if (!personaGate.ready) {
              return json(res, 400, { ok: false, error: personaGate.reason, status: buildStatus(handle) })
            }
            const profileId = typeof args.profileId === 'string' ? args.profileId.trim() : ''
            const referenceProfile = profileId === RIGGED_MODEL_ID ? 'xiaxia' : profileId
            if (!(ROLE_SPEECH_PROFILE_IDS as readonly string[]).includes(profileId)) {
              return json(res, 400, { ok: false, error: `profileId 须为 ${ROLE_SPEECH_PROFILE_IDS.join('/')} 之一` })
            }
            const currentProfile = handle.settings.getPersonaProfile()
            if (profileId !== currentProfile.id) {
              return json(res, 409, {
                ok: false,
                error: `请求的角色（${profileId}）与当前保存角色（${currentProfile.id}）不一致，请刷新后重试`,
              })
            }
            const speechText = typeof args.text === 'string' ? args.text.trim() : ''
            if (speechText.length === 0 || speechText.length > ROLE_SPEECH_TEXT_MAX) {
              return json(res, 400, { ok: false, error: `请输入 1–${ROLE_SPEECH_TEXT_MAX} 字的文字` })
            }
            const interactionId = typeof args.interactionId === 'string' ? args.interactionId : null
            const verifyRun = () => {
              if (interactionId && !conversation.acceptsSpeech(interactionId)) throw new ConversationError(409, '本场互动已结束')
              if (!interactionId || !conversation.liveWindow()) return
              if (typeof args.stageOwner !== 'string' || typeof args.playbackKey !== 'string' ||
                !conversation.allowsStageSpeech(interactionId, args.stageOwner, args.playbackKey, speechText)) {
                throw new ConversationError(409, '请在直播画面启用播出音频')
              }
            }
            verifyRun()
            let streaming = false
            const controller = new AbortController()
            const disconnect = () => controller.abort()
            const referenceDeadline = new AbortController()
            let firstAudio: ReturnType<typeof setTimeout> | undefined
            const useSystemVoice = (error: unknown) => {
              if (!controller.signal.aborted && !streaming && error instanceof ReferenceVoiceError) return null
              throw error
            }
            try {
              const write = res.write?.bind(res)
              res.once?.('close', disconnect)
              let reference: Buffer | null = null
              if (args.stream === true && write) {
                if (typeof args.stageOwner === 'string') {
                  firstAudio = setTimeout(() => referenceDeadline.abort(
                    new ReferenceVoiceError('timeout', '参考音色未及时开始，改用系统音色')), 4500)
                }
                const streamed = await handle.referenceVoiceStream.speak(referenceProfile, speechText, (chunk) => {
                  verifyRun()
                  clearTimeout(firstAudio)
                  if (!streaming) {
                    res.statusCode = 200
                    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8')
                    res.setHeader('cache-control', 'no-store')
                    res.setHeader('x-accel-buffering', 'no')
                    streaming = true
                  }
                  write(JSON.stringify({ type: 'audio', voiceName: currentProfile.name, ...chunk }) + '\n')
                }, AbortSignal.any([controller.signal, referenceDeadline.signal])).catch(useSystemVoice)
                clearTimeout(firstAudio)
                if (streamed && streaming) {
                  verifyRun()
                  return void res.end(JSON.stringify({ type: 'end' }) + '\n')
                }
              } else {
                reference = await synthesizeReferenceVoice(handle.dataDir, referenceProfile, speechText).catch(useSystemVoice)
              }
              if (controller.signal.aborted) return
              verifyRun()
              const storedVoice = handle.settings.getPersona().voiceId
              const speech = reference === null ? await roleSpeechService.synthesize(profileId, speechText, storedVoice, typeof args.stageOwner === 'string') : {
                audioBase64: reference.toString('base64'),
                voiceName: currentProfile.name,
              }
              const source = reference === null ? 'system' : 'reference'
              if (controller.signal.aborted) return
              verifyRun()
              // 合成耗时数秒，期间角色可能被切换——与 preview/chat 同样事后复核
              if (handle.settings.getPersonaProfile().id !== profileId) {
                return json(res, 409, { ok: false, error: '角色已切换，请重新生成' })
              }
              return json(res, 200, { ok: true, result: { audioBase64: speech.audioBase64, voiceName: speech.voiceName, source } })
            } catch (err) {
              if (controller.signal.aborted) return
              if (streaming) {
                const error = err instanceof ReferenceVoiceError ? err.message : '角色语音播放中断'
                return void res.end(JSON.stringify({ type: 'error', error }) + '\n')
              }
              if (err instanceof ReferenceVoiceError) {
                const status = err.code === 'busy' ? 429 : err.code === 'timeout' ? 504 : 500
                const error = err.code === 'synthesis_failed' ? '本地参考音色生成失败，请检查模型和参考录音' : err.message
                return json(res, status, { ok: false, error, code: err.code, fallback: true })
              }
              if (err instanceof RoleSpeechError) {
                return json(res, err.status, { ok: false, error: err.message, code: err.code, fallback: err.fallback })
              }
              throw err
            } finally {
              clearTimeout(firstAudio)
              res.removeListener?.('close', disconnect)
            }
          }
          case 'model/deploy': {
            // 一键部署本地模型：幂等启动（running 中重复调用原样返回），进度经 GET model/deploy 轮询
            const deploy = handle.modelDeploy.start()
            return json(res, deploy.status === 'running' ? 202 : 200, { ok: true, deploy })
          }
          case 'preview/voice-test': {
            const persona = handle.settings.getPersona()
            const phrase = args.phrase === undefined ? persona.samplePhrase :
              typeof args.phrase === 'string' ? args.phrase.trim() : ''
            const voice = BUILTIN_VOICES.find((entry) => entry.id === (args.voiceId ?? persona.voiceId))
            if (phrase.length === 0 || phrase.length > 80 || voice === undefined) {
              return json(res, 400, { ok: false, error: '请选择有效的朗读风格并输入 1–80 字的试听语句' })
            }
            return json(res, 200, { ok: true, result: { phrase, voice, note: '浏览器语音试听（本地）' } })
          }
          case 'settings/cloud/key': {
            // 云端密钥界面维护（0.15）：保存/清除；响应只回掩码状态，明文永不回传
            try {
              if (args.clear === true) {
                handle.settings.clearCloudKey()
              } else if (typeof args.apiKey === 'string' && args.apiKey.trim() !== '') {
                handle.settings.saveCloudKey(args.apiKey)
              } else {
                return json(res, 400, { ok: false, error: '请输入密钥，或用 {"clear":true} 清除界面维护的密钥' })
              }
              return json(res, 200, {
                ok: true,
                cloudKey: handle.settings.getCloudKeyStatus(),
                note: '界面密钥已保存并即时生效；环境变量 DAFEIYU_CLOUD_API_KEY 优先',
              })
            } catch (err) {
              if (err instanceof SettingsValidationError) {
                return json(res, 400, { ok: false, error: err.message, issues: err.issues })
              }
              throw err
            }
          }
          case 'settings/cloud/test': {
            // 云端配置连接测试（0.15.1）：按「表单当前值 + 现有密钥」组合发起一次最小 chat 请求，
            // 不写入任何设置；端点/密钥解析与保存后的真实调用一致（env 优先），通过后前端才放行保存。
            const provider = typeof args.provider === 'string' ? args.provider.trim() : ''
            const model = typeof args.model === 'string' ? args.model.trim() : ''
            const formKey = typeof args.apiKey === 'string' ? args.apiKey.trim() : ''
            const formBase = typeof args.baseUrl === 'string' ? args.baseUrl.trim() : ''
            const envKey = process.env.DAFEIYU_CLOUD_API_KEY?.trim() ?? ''
            const envBase = process.env.DAFEIYU_CLOUD_BASE_URL?.trim() ?? ''
            // 端点解析优先级（0.15.3）：环境变量 > 表单「端点 URL」> 服务商预设
            const presetBase = resolveCloudBaseUrl(provider)
            const baseURL = envBase !== '' ? envBase : formBase !== '' ? formBase : presetBase
            if (baseURL === null || baseURL === '') {
              return json(res, 400, {
                ok: false,
                error: '无法确定端点：选择内置预设（腾讯云混元/DeepSeek），或在「端点 URL」填写自定义网关地址',
              })
            }
            if (model === '') return json(res, 400, { ok: false, error: '请填写模型名' })
            const apiKey = envKey !== '' ? envKey : formKey !== '' ? formKey : handle.settings.getCloudSecretRaw()
            if (apiKey === '') {
              return json(res, 400, { ok: false, error: '请填写 API Key（或配置环境变量 DAFEIYU_CLOUD_API_KEY）' })
            }
            const keySource = envKey !== '' ? 'env' : formKey !== '' ? 'form' : 'ui'
            try {
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(), 8_000)
              let upstream: Response
              try {
                upstream = await fetch(`${baseURL}/chat/completions`, {
                  method: 'POST',
                  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
                  body: JSON.stringify({
                    model,
                    messages: [{ role: 'user', content: '连接测试：请只回复四个字「连接成功」' }],
                    // 推理模型思考会先消耗预算，给足余量避免正文被截空误报失败
                    max_tokens: 512,
                  }),
                  signal: controller.signal,
                })
              } finally {
                clearTimeout(timer)
              }
              if (!upstream.ok) {
                const hint = upstream.status === 401 || upstream.status === 403 ? '（密钥无效或无权限）'
                  : upstream.status === 404 ? '（端点或模型名不匹配）' : ''
                return json(res, 200, { ok: false, error: `服务商返回 HTTP ${upstream.status} ${hint}`, keySource, baseURL, model })
              }
              const body = (await upstream.json()) as {
                choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>
              }
              const content = body.choices?.[0]?.message?.content?.trim() ?? ''
              const reasoning = body.choices?.[0]?.message?.reasoning_content?.trim() ?? ''
              if (content === '' && reasoning !== '') {
                // 推理模型（hy4/R1 系）：端点/密钥/模型均已验证，只是思考未完成正文
                return json(res, 200, {
                  ok: true,
                  detail: '（推理模型）端点与密钥验证通过，已返回思考内容',
                  keySource,
                  baseURL,
                  model,
                })
              }
              if (content === '') {
                return json(res, 200, {
                  ok: false,
                  error: '端点可达但响应缺少文本（检查模型名是否支持 chat/completions）',
                  keySource,
                  baseURL,
                  model,
                })
              }
              return json(res, 200, { ok: true, detail: content.slice(0, 40), keySource, baseURL, model })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              return json(res, 200, { ok: false, error: `连接失败：${msg.slice(0, 120)}`, keySource, baseURL, model })
            }
          }
          case 'settings/persona':
          case 'settings/platform':
          case 'settings/scene':
          case 'settings/cloud':
          case 'settings/data-usage':
          case 'settings/gifts': {
            if (path === 'settings/persona' && session.liveRunId !== null &&
              typeof args.profileId === 'string' && args.profileId !== handle.settings.getPersonaProfile().id) {
              return json(res, 409, { ok: false, error: '下播后可切换主播角色' })
            }
            if (path === 'settings/platform' && session.liveRunId !== null &&
              ('roomUrl' in args || 'interactionSource' in args)) {
              return json(res, 409, { ok: false, error: '下播后可更换互动来源和直播间' })
            }
            const section = path.split('/')[1] as 'persona' | 'platform' | 'scene' | 'cloud' | 'data-usage' | 'gifts'
            try {
              const previousProfile = section === 'persona' ? handle.settings.getPersonaProfile().id : undefined
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
              if (section === 'persona') {
                if (previousProfile !== handle.settings.getPersonaProfile().id) broadcastWindow?.interrupt()
                conversation.snapshot()
              }
              return json(res, 200, {
                ok: true,
                section,
                value: saved,
                readiness: handle.settings.readiness(),
                ...(section === 'cloud' ? { note: '云端设置与 API Key 保存后即时生效（环境变量优先）' } : {}),
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
          default:
            return json(res, 404, { ok: false, error: `未知路径: ${path}` })
        }
      }
      return json(res, 405, { ok: false, error: `方法不支持: ${method}` })
    } catch (err) {
      if (err instanceof ConversationError) return json(res, err.status, { ok: false, error: err.message })
      return json(res, 500, { ok: false, error: (err as Error).message })
    }
  }
  return handler
}
