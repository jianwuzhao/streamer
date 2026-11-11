/**
 * 感知事件规范化（方案 §2.4 LiveEnvelope）。
 * 弹幕、礼物、管理员操作、工具、TTS 和平台回执先走确定性解析，
 * 只有需要判断语义时才调用本地模型——本模块只负责规范化与结构校验。
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const SCHEMA_VERSION = 1

export const LiveEnvelopeSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  eventId: z.string().min(1),
  source: z.string().min(1),
  sourceEventId: z.string().min(1),
  roomId: z.string().min(1),
  sessionId: z.string().min(1),
  viewerKey: z.string().min(1).optional(),
  occurredAt: z.string().min(1),
  receivedAt: z.string().min(1),
  type: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  causalEventIds: z.array(z.string().min(1)).default([]),
  provenance: z.enum(['platform_verified', 'operator', 'bridge', 'unverified']),
  purposeTags: z.array(z.string().min(1)).default([]),
  payloadRef: z.string().min(1),
  replay: z.boolean().default(false),
})

/** 外部原始输入（字段可缺省，由规范化补全）。 */
export interface EnvelopeInput {
  source: string
  sourceEventId: string
  roomId: string
  sessionId: string
  viewerKey?: string
  occurredAt: string
  receivedAt?: string
  type: string
  correlationId?: string
  causalEventIds?: readonly string[]
  provenance: 'platform_verified' | 'operator' | 'bridge' | 'unverified'
  purposeTags?: readonly string[]
  payloadRef: string
  replay?: boolean
}

/** 规范化构造：补全 eventId / receivedAt / 缺省集合字段，并做结构校验。 */
export function createEnvelope(input: EnvelopeInput) {
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    eventId: `evt_${randomUUID()}`,
    source: input.source,
    sourceEventId: input.sourceEventId,
    roomId: input.roomId,
    sessionId: input.sessionId,
    ...(input.viewerKey !== undefined ? { viewerKey: input.viewerKey } : {}),
    occurredAt: input.occurredAt,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    type: input.type,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    causalEventIds: [...(input.causalEventIds ?? [])],
    provenance: input.provenance,
    purposeTags: [...(input.purposeTags ?? [])],
    payloadRef: input.payloadRef,
    replay: input.replay ?? false,
  }
  return LiveEnvelopeSchema.parse(normalized)
}

/** 校验已存在的 envelope（如从存储读出或外部桥传入），失败给出具体字段路径。 */
export function validateEnvelope(raw: unknown): { ok: true; value: LiveEnvelope } | { ok: false; issues: readonly string[] } {
  const parsed = LiveEnvelopeSchema.safeParse(raw)
  if (parsed.success) return { ok: true, value: parsed.data }
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
  }
}

export type LiveEnvelope = z.infer<typeof LiveEnvelopeSchema>
