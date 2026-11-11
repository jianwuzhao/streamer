/**
 * 技能注册表（方案 §7.1 / §7.2）。
 *
 * - 版本不可原地覆盖：同 skillId+version 重复注册，内容不同即拒绝；
 * - 生命周期 draft → validated → staged → canary → active → suspended / superseded；
 * - 撤销（suspended/superseded）在执行前实时检查（executor 调 isActive）；
 * - 权限扩张进入管理审核：注册时 manifest.permissions ⊄ 已授予集合 →
 *   只能停在 draft（不允许自动晋级）。
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { get, nowIso, run, type DB } from '../storage/db.ts'

export const SKILL_LIFECYCLE = [
  'draft',
  'validated',
  'staged',
  'canary',
  'active',
] as const
export type SkillStatus = (typeof SKILL_LIFECYCLE)[number] | 'suspended' | 'superseded'
export type SkillKind = 'expression' | 'read_only' | 'action' | 'offline_review'

export const SkillManifestSchema = z.object({
  skillId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  kind: z.enum(['expression', 'read_only', 'action', 'offline_review']),
  description: z.string().min(1),
  trigger: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  permissions: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().max(60_000),
  idempotent: z.boolean().default(true),
  postconditions: z.array(z.string()).default([]),
  fallback: z.string().optional(),
  cooldownMs: z.number().int().nonnegative().default(0),
  handler: z.string().min(1), // 受控执行处理器键（executor 注册表内）
})
export type SkillManifest = z.infer<typeof SkillManifestSchema>

export interface RegisteredSkill {
  readonly skillId: string
  readonly version: string
  readonly status: SkillStatus
  readonly manifestHash: string
  readonly manifest: SkillManifest
}

export class SkillRegistry {
  private readonly db: DB
  private readonly opts: { grantedPermissions: readonly string[] }

  constructor(db: DB, opts: { grantedPermissions: readonly string[] } = { grantedPermissions: [] }) {
    this.db = db
    this.opts = opts
  }

  /** 注册（manifest 结构校验 + 版本不可覆盖 + 权限扩张只能停 draft）。 */
  register(rawManifest: unknown, opts: { packagePath?: string } = {}): RegisteredSkill {
    const parsed = SkillManifestSchema.safeParse(rawManifest)
    if (!parsed.success) {
      throw new Error(
        `技能 manifest 校验失败：${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      )
    }
    const manifest = parsed.data
    const hash = manifestHash(manifest)
    const existing = get<{ manifest_hash: string; status: SkillStatus }>(
      this.db,
      'SELECT manifest_hash, status FROM skill_versions WHERE skill_id = ? AND version = ?',
      manifest.skillId,
      manifest.version,
    )
    if (existing) {
      if (existing.manifest_hash !== hash) {
        throw new Error(`技能 ${manifest.skillId}@${manifest.version} 已存在且内容不同：版本不可原地覆盖（§7.2）`)
      }
      return this.get(manifest.skillId, manifest.version) as RegisteredSkill
    }
    // 注册一律从 draft 起步；权限超出已授予集合的技能无法晋级（setStatus 拦截）
    const status: SkillStatus = 'draft'
    run(
      this.db,
      `INSERT INTO skill_versions (skill_id, version, status, manifest_hash, manifest, package_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
      manifest.skillId,
      manifest.version,
      status,
      hash,
      JSON.stringify(manifest),
      opts.packagePath ?? '',
    )
    return { skillId: manifest.skillId, version: manifest.version, status, manifestHash: hash, manifest }
  }

  get(skillId: string, version: string): RegisteredSkill | undefined {
    const row = get<{ status: SkillStatus; manifest_hash: string; manifest: string }>(
      this.db,
      'SELECT status, manifest_hash, manifest FROM skill_versions WHERE skill_id = ? AND version = ?',
      skillId,
      version,
    )
    if (!row) return undefined
    return {
      skillId,
      version,
      status: row.status,
      manifestHash: row.manifest_hash,
      manifest: JSON.parse(row.manifest) as SkillManifest,
    }
  }

  /**
   * 生命周期推进；permissions ⊄ granted → 拒绝晋级（需管理授权，§7.2）。
   * suspended/superseded 可从任意运行态进入。
   */
  setStatus(skillId: string, version: string, next: SkillStatus): RegisteredSkill {
    const skill = this.get(skillId, version)
    if (!skill) throw new Error(`技能不存在: ${skillId}@${version}`)
    const forward = SKILL_LIFECYCLE as readonly string[]
    if (forward.includes(next)) {
      const currentIdx = forward.indexOf(skill.status)
      const nextIdx = forward.indexOf(next)
      if (currentIdx >= 0 && nextIdx !== currentIdx + 1) {
        throw new Error(`生命周期只能逐级推进（${skill.status} → ${next} 不合法）`)
      }
      const within = skill.manifest.permissions.every((p) => this.opts.grantedPermissions.includes(p))
      if (nextIdx > 0 && !within) {
        throw new Error(`权限超出已授予集合（${skill.manifest.permissions.join(',')}），晋级需管理审核`)
      }
    }
    run(
      this.db,
      `UPDATE skill_versions SET status = ?, published_at = CASE WHEN ? = 'active' THEN ? ELSE published_at END
       WHERE skill_id = ? AND version = ?`,
      next,
      next,
      nowIso(),
      skillId,
      version,
    )
    return this.get(skillId, version) as RegisteredSkill
  }

  /** 执行前实时检查：最新版本仍 active（撤销即时生效）。 */
  isActive(skillId: string, version: string): boolean {
    const row = get<{ status: SkillStatus }>(
      this.db,
      'SELECT status FROM skill_versions WHERE skill_id = ? AND version = ?',
      skillId,
      version,
    )
    return row?.status === 'active'
  }

  /** 全部 active 版本（模型可见的技能清单）。 */
  activeSkills(): readonly RegisteredSkill[] {
    const rows = this.db
      .prepare(`SELECT skill_id, version, status, manifest_hash, manifest FROM skill_versions WHERE status = 'active'`)
      .all() as Array<{ skill_id: string; version: string; status: SkillStatus; manifest_hash: string; manifest: string }>
    return rows.map((r) => ({
      skillId: r.skill_id,
      version: r.version,
      status: r.status,
      manifestHash: r.manifest_hash,
      manifest: JSON.parse(r.manifest) as SkillManifest,
    }))
  }
}

export function manifestHash(manifest: SkillManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}
