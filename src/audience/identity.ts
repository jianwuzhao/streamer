/**
 * 观众身份（方案 §6.1）。
 *
 * 身份键 = platform + room_scope + platform_user_id，内部使用带密钥的
 * 伪名化 ID（HMAC-SHA256，密钥仅存本机）。昵称变化不创建新身份；
 * 不同平台的同名账号不自动合并；跨平台关联只在可验证绑定时建立（阶段 B 不提供）。
 */
import { createHash, randomBytes } from 'node:crypto'
import { get, run, type DB } from '../storage/db.ts'

const STATE_KEY = 'viewer_pseudonym_key'

export interface ResolveInput {
  readonly platform: string
  readonly roomScope: string
  readonly platformUserId: string
  /** 当前显示昵称（变化仅更新昵称字段，不改身份） */
  readonly nickname?: string
}

export interface ResolveResult {
  readonly viewerKey: string
  readonly created: boolean
  readonly nicknameChanged: boolean
}

export class ViewerIdentity {
  private readonly db: DB
  private key: Buffer | undefined

  constructor(db: DB, opts: { fixedKey?: string } = {}) {
    this.db = db
    if (opts.fixedKey !== undefined) this.key = Buffer.from(opts.fixedKey, 'utf8')
  }

  /** 伪名化密钥：首次使用生成并持久化于 governance_state（不可出域）。 */
  private ensureKey(): Buffer {
    if (this.key !== undefined) return this.key
    const row = get<{ value: string }>(this.db, 'SELECT value FROM governance_state WHERE key = ?', STATE_KEY)
    if (row) {
      this.key = Buffer.from(row.value, 'hex')
    } else {
      const generated = randomBytes(32)
      run(
        this.db,
        `INSERT INTO governance_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        STATE_KEY,
        generated.toString('hex'),
      )
      this.key = generated
    }
    return this.key
  }

  /** 确定性伪名化 ID：同一身份输入永远得到同一 viewerKey。 */
  pseudonymize(input: ResolveInput): string {
    const key = this.ensureKey()
    const mac = createHash('sha256').update(key).update(`${input.platform}|${input.roomScope}|${input.platformUserId}`).digest('hex')
    return `vw_${mac.slice(0, 24)}`
  }

  /** 解析（必要时建档）：昵称变化只更新字段；同名不同账号互不影响。 */
  resolve(input: ResolveInput): ResolveResult {
    const viewerKey = this.pseudonymize(input)
    const existing = get<{ display_nickname: string | null }>(
      this.db,
      'SELECT display_nickname FROM viewer_profiles WHERE viewer_key = ?',
      viewerKey,
    )
    if (existing) {
      const nicknameChanged =
        input.nickname !== undefined && input.nickname !== existing.display_nickname
      if (nicknameChanged) {
        run(
          this.db,
          'UPDATE viewer_profiles SET display_nickname = ?, last_seen_at = CURRENT_TIMESTAMP WHERE viewer_key = ?',
          input.nickname,
          viewerKey,
        )
      }
      return { viewerKey, created: false, nicknameChanged }
    }
    const now = new Date().toISOString()
    run(
      this.db,
      `INSERT INTO viewer_profiles (viewer_key, platform, room_scope, platform_user_id, display_nickname, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      viewerKey,
      input.platform,
      input.roomScope,
      input.platformUserId,
      input.nickname ?? null,
      now,
      now,
    )
    return { viewerKey, created: true, nicknameChanged: false }
  }
}
