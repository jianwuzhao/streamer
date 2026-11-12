/**
 * 宿主共享 API 公共件：请求/响应类型、JSON 输出、请求体读取、
 * 当日费用聚合与反馈标签白名单（供 host-api 系列模块共用）。
 */
import { get, type DB } from './storage/db.ts'

export type ServerRequest = { method?: string; url?: string; on(eventName: string, cb: (chunk: Buffer) => void): void }
export type ServerResponse = {
  statusCode?: number
  setHeader(name: string, value: string): unknown
  end(body?: string): unknown
}

export const FEEDBACK_LABELS = ['useful', 'wrong', 'off_persona', 'too_slow', 'not_remembered', 'complaint', 'privacy'] as const
export type FeedbackLabelInput = (typeof FEEDBACK_LABELS)[number]

export function json(res: ServerResponse, code: number, payload: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.statusCode = code
  res.end(JSON.stringify(payload))
}

export function readBody(req: ServerRequest): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
  })
}

export function todayCostCny(db: DB): number {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  const row = get<{ total: number }>(
    db,
    'SELECT COALESCE(SUM(cost_cny), 0) AS total FROM usage WHERE created_at >= ?',
    todayStart.toISOString(),
  )
  return row?.total ?? 0
}
