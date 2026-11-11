/**
 * 政策授权服务骨架（方案 §11.1）。
 *
 * - 由 policy-engine 签发短期机器授权：actor=policy_service，不伪造 actor=user；
 * - 凭证绑定 payloadHash、epoch（治理纪元）与 TTL；回滚/切换增加 epoch 后
 *   旧凭证全部失效（§12.4）；
 * - fail-closed：签发依赖审计可持久化，写库失败即抛错、不签发新凭证。
 */
import { randomUUID } from 'node:crypto'
import { get, nowIso, run, type DB } from '../storage/db.ts'
import type { PolicyAction, PolicyActor, PolicyDecision } from '../types.ts'

export interface VerifyOptions {
  readonly payloadHash?: string
  /** 当前治理 epoch（缺省用服务内当前值） */
  readonly epoch?: number
  readonly now?: string
}

export interface VerifyResult {
  readonly valid: boolean
  readonly reason?: 'expired' | 'not_allow' | 'hash_mismatch' | 'epoch_superseded' | 'bad_actor'
}

const STATE_KEY_EPOCH = 'governance_epoch'

export class PolicyService {
  private readonly db: DB
  private readonly opts: { policyVersion: string; defaultTtlMs?: number; clock?: () => string }
  private readonly clock: () => string

  constructor(
    db: DB,
    opts: { policyVersion: string; defaultTtlMs?: number; clock?: () => string } = {
      policyVersion: 'unversioned',
    },
  ) {
    this.db = db
    this.opts = opts
    this.clock = opts.clock ?? nowIso
  }

  get currentEpoch(): number {
    const row = get<{ value: string }>(this.db, 'SELECT value FROM governance_state WHERE key = ?', STATE_KEY_EPOCH)
    return row ? Number.parseInt(row.value, 10) || 0 : 0
  }

  /** 增加治理纪元：回滚/切回 shadow/killSwitch 时调用，旧凭证即刻失效（§12.4/§14）。 */
  bumpEpoch(): number {
    const next = this.currentEpoch + 1
    run(
      this.db,
      `INSERT INTO governance_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      STATE_KEY_EPOCH,
      String(next),
      nowIso(),
    )
    return next
  }

  /** 签发决策（fail-closed：decisions 与 audit 任一写失败即抛错）。 */
  issue(input: {
    action: PolicyAction
    payloadHash: string
    result?: 'allow' | 'deny' | 'review'
    ttlMs?: number
    actor?: PolicyActor
  }): PolicyDecision {
    const decision: PolicyDecision = {
      id: `dec_${randomUUID()}`,
      actor: input.actor ?? 'policy_service',
      action: input.action,
      payloadHash: input.payloadHash,
      policyVersion: this.opts.policyVersion,
      epoch: this.currentEpoch,
      expiresAt: new Date(
        Date.parse(this.clock()) + (input.ttlMs ?? this.opts.defaultTtlMs ?? 60_000),
      ).toISOString(),
      result: input.result ?? 'allow',
    }
    run(
      this.db,
      `INSERT INTO decisions (decision_id, actor, action, payload_hash, policy_version, epoch, expires_at, result)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      decision.id,
      decision.actor,
      decision.action,
      decision.payloadHash,
      decision.policyVersion,
      decision.epoch,
      decision.expiresAt,
      decision.result,
    )
    run(
      this.db,
      `INSERT INTO audit (decision_id, action, summary) VALUES (?, ?, ?)`,
      decision.id,
      `policy_issue:${decision.action}`,
      `${decision.actor} ${decision.result} epoch=${decision.epoch} ttl 至 ${decision.expiresAt}`,
    )
    return decision
  }

  /** 校验决策：allow + 未过期 + 哈希匹配 + epoch 未被超越。 */
  verify(decision: PolicyDecision, opts: VerifyOptions = {}): VerifyResult {
    const now = opts.now ?? this.clock()
    if (decision.actor !== 'policy_service' && decision.actor !== 'operator') {
      return { valid: false, reason: 'bad_actor' }
    }
    if (decision.result !== 'allow') return { valid: false, reason: 'not_allow' }
    if (Date.parse(decision.expiresAt) <= Date.parse(now)) {
      return { valid: false, reason: 'expired' }
    }
    if (opts.payloadHash !== undefined && opts.payloadHash !== decision.payloadHash) {
      return { valid: false, reason: 'hash_mismatch' }
    }
    const currentEpoch = opts.epoch ?? this.currentEpoch
    if (decision.epoch < currentEpoch) {
      return { valid: false, reason: 'epoch_superseded' }
    }
    return { valid: true }
  }
}
