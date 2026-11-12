/**
 * 宿主共享 API（Web 面板后端）：经宿主 `connection/request` 瀑布承接
 * 已认证的同源请求（/api/dafeiyu/*），只暴露产品入口语义（四主操作 +
 * 紧急停止 + 状态查询），不透出内部服务句柄。
 */
import type { DafeiyuPluginHandle } from './index.ts'

type ServerRequest = { method?: string; url?: string; on(eventName: string, cb: (chunk: Buffer) => void): void }
type ServerResponse = {
  statusCode?: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

function json(res: ServerResponse, code: number, payload: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.statusCode = code
  res.end(JSON.stringify(payload))
}

function readBody(req: ServerRequest): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

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
}

export function buildStatus(handle: DafeiyuPluginHandle): DafeiyuStatus {
  const verdict = handle.training.scheduler.evaluateOpportunity()
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
  }
}

/** 生成 connection/request 处理器：非 /api/dafeiyu/ 前缀一律 next() 放行。 */
export function createRequestHandler(handle: DafeiyuPluginHandle) {
  return async (req: ServerRequest, res: ServerResponse, next: () => Promise<void>): Promise<void> => {
    const url = req.url ?? ''
    if (!url.startsWith('/api/dafeiyu/')) return next()
    const path = url.replace(/\?.*$/, '').slice('/api/dafeiyu/'.length)
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && (path === 'status' || path === '')) {
        return json(res, 200, { ok: true, status: buildStatus(handle) })
      }
      if (method === 'POST') {
        const body = await readBody(req)
        const args = body === '' ? {} : (JSON.parse(body) as Record<string, unknown>)
        switch (path) {
          case 'live/start': {
            const status = await handle.live.session.start(
              typeof args.idempotencyKey === 'string' ? args.idempotencyKey : `ui-${Date.now()}`,
              {
                aiLabelVisible: args.aiLabelVisible !== false,
                stableReleaseAvailable: true,
                resourceOk: true,
              },
            )
            return json(res, 200, { ok: true, status: buildStatus(handle), result: status })
          }
          case 'live/stop': {
            const status = await handle.live.session.stop()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: status })
          }
          case 'live/emergency-stop': {
            const status = handle.live.session.emergencyStop()
            return json(res, 200, { ok: true, status: buildStatus(handle), result: status })
          }
          case 'live/operator-confirm': {
            const status = handle.live.session.operatorConfirmedLive(new Date().toISOString())
            return json(res, 200, { ok: true, status: buildStatus(handle), result: status })
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
      return json(res, 500, { ok: false, error: (err as Error).message })
    }
  }
}
