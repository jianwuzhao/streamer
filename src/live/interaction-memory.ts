import { createHash } from 'node:crypto'
import { all, get, nowIso, run, type DB } from '../storage/db.ts'

const PRIVATE_CONTENT = /身份证|银行卡|验证码|密码|手机号|联系方式|家庭住址|私聊|私信|不公开|只告诉你|保密|别说出去|我住在|我的地址|我的电话|微信号|微信是|QQ号|疾病|病史|收入|性取向|宗教信仰|[\w.+-]+@[\w.-]+\.\w+|\d[\d\s-]{7,}\d/i
const TOPICS = [
  ['草莓种植', /草莓/],
  ['园艺种植', /种植|浇水|日照|花盆|园艺/],
  ['美食烹饪', /烹饪|做饭|食谱|菜谱|美食|炖汤|炒菜/],
  ['游戏', /游戏|通关|电竞|排位|副本/],
  ['音乐', /音乐|歌曲|乐器|唱歌|吉他/],
  ['运动', /运动|跑步|健身|篮球|足球/],
  ['阅读', /读书|阅读|小说|绘本/],
  ['角色介绍', /角色介绍|介绍一下自己|人设/],
] as const

export function liveTopic(text: string): string | undefined {
  return TOPICS.find(([, match]) => match.test(text))?.[0]
}

export function topicMatches(text: string, topic: string): boolean {
  const question = text.trim().replace(/[？?。！!]+$/, '')
  return text.includes(topic) || liveTopic(text) === topic || (question.length >= 3 && topic.includes(question))
}

export function publicBroadcastText(text: string, nicknames: readonly string[] = []): string | undefined {
  let result = text.trim()
  if (PRIVATE_CONTENT.test(result) || /https?:\/\/|[@＠]/i.test(result)) return undefined
  for (const nickname of new Set(nicknames.filter(Boolean))) result = result.replaceAll(nickname, '观众')
  return result || undefined
}

export function viewerPreference(text: string): { address?: string; preference?: string; joke?: string } {
  const safe = publicBroadcastText(text)
  if (!safe) return {}
  const address = safe.match(/^(?:以后|下次|平时)?(?:请)?叫我[「“]?([\p{L}\p{N}_-]{1,12})[」”]?[。！!]?$/u)?.[1]
  const liked = safe.match(/^(?:我(?:很|最|特别)?(?:喜欢|爱看)|我更想聊)(.+)/)?.[1]
  const preference = liked && (liveTopic(liked) ?? liked.match(/^([\p{L}\p{N}· -]{0,20}(?:电影|漫画|歌曲|话题|冷笑话|小游戏))[。！!]?$/u)?.[1])
  const joke = safe.match(/^(?:(?:咱们|我们)的(?:共同)?梗是|记住(?:咱们|我们)的梗[：:]?)[「“]?([\p{L}\p{N}_-]{1,16})[」”]?[。！!]?$/u)?.[1]
  return { ...(address ? { address } : {}), ...(preference ? { preference } : {}), ...(joke ? { joke } : {}) }
}

export interface ProgramMemory {
  readonly id: string
  readonly sessionId: string
  readonly profileId: string
  readonly topic: string
  readonly summary: string
  readonly updatedAt: string
}

interface InteractionEvidence {
  readonly viewerKey: string
  readonly sourceId: string
  readonly sessionId: string
  readonly profileId: string
  readonly kind: string
  readonly text: string
  readonly observedAt: string
}

interface Relationship {
  profileId: string
  kind: 'address' | 'preference' | 'inside_joke' | 'shared_topic'
  value: string
  sourceId: string
  observedAt: string
}

const RELATIONSHIP_COLUMNS = 'profile_id AS profileId, kind, value, source_id AS sourceId, observed_at AS observedAt'
const PROGRAM_COLUMNS = 'id, session_id AS sessionId, profile_id AS profileId, topic, summary, updated_at AS updatedAt'

export class LiveInteractionMemory {
  private readonly db: DB
  private readonly workspace: string
  private readonly retentionDays: number

  constructor(db: DB, workspace: string, retentionDays: number) {
    this.db = db
    this.workspace = workspace
    this.retentionDays = retentionDays
  }

  personalizes(viewerKey: string): boolean {
    return !get(this.db, `SELECT 1 FROM deletion_tombstones WHERE viewer_key = ?
      UNION ALL SELECT 1 FROM privacy_requests WHERE viewer_key = ?
      AND kind = 'personalization_off' AND status = 'resolved' LIMIT 1`, viewerKey, viewerKey)
  }

  record(input: InteractionEvidence): void {
    if (!this.personalizes(input.viewerKey)) return
    const { viewerKey, sessionId, profileId, kind, text, observedAt } = input
    const sourceId = createHash('sha256').update(JSON.stringify([this.workspace, viewerKey, input.sourceId])).digest('hex').slice(0, 24)
    const safe = kind === 'comment' ? publicBroadcastText(text) : undefined
    const topic = safe ? liveTopic(safe) : undefined
    this.db.exec('SAVEPOINT live_interaction')
    try {
      const evidence = run(this.db, `INSERT OR IGNORE INTO live_viewer_interactions
        (viewer_key, source_id, session_id, profile_id, kind, topic, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      viewerKey, sourceId, sessionId, profileId, kind, topic ?? null, observedAt)
      if (evidence.changes === 0) return
      run(this.db, `UPDATE viewer_profiles SET last_seen_at = MAX(COALESCE(last_seen_at, ?), ?),
        profile_version = profile_version + 1 WHERE viewer_key = ?`, observedAt, observedAt, viewerKey)
      if (!safe) return

      const { address, preference, joke } = viewerPreference(safe)
      if (address) this.remember(viewerKey, profileId, 'address', address, sourceId, observedAt)
      if (preference) this.remember(viewerKey, profileId, 'preference', preference, sourceId, observedAt)
      if (joke) this.remember(viewerKey, profileId, 'inside_joke', joke, sourceId, observedAt)
      if (topic && get(this.db, `SELECT 1 FROM live_viewer_interactions WHERE viewer_key = ? AND profile_id = ?
        AND topic = ? AND source_id != ? AND observed_at >= ? LIMIT 1`,
      viewerKey, profileId, topic, sourceId, this.cutoff())) {
        this.remember(viewerKey, profileId, 'shared_topic', topic, sourceId, observedAt)
      }
    } catch (error) {
      this.db.exec('ROLLBACK TO live_interaction')
      throw error
    } finally {
      this.db.exec('RELEASE live_interaction')
    }
  }

  private cutoff(): string {
    return new Date(Date.now() - this.retentionDays * 86_400_000).toISOString()
  }

  private remember(viewerKey: string, profileId: string, kind: Relationship['kind'], value: string, sourceId: string, observedAt: string): void {
    run(this.db, `INSERT INTO live_relationship_memory (viewer_key, profile_id, kind, value, source_id, observed_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(viewer_key, profile_id, kind) DO UPDATE
      SET value = excluded.value, source_id = excluded.source_id, observed_at = excluded.observed_at
      WHERE live_relationship_memory.source_id != 'viewer_correction' AND
        excluded.observed_at >= live_relationship_memory.observed_at`, viewerKey, profileId, kind, value, sourceId, observedAt)
  }

  relationship(viewerKey: string, profileId: string): Relationship[] {
    if (!this.personalizes(viewerKey)) return []
    return all<Relationship>(this.db, `SELECT ${RELATIONSHIP_COLUMNS} FROM live_relationship_memory
      WHERE viewer_key = ? AND profile_id = ? AND observed_at >= ? ORDER BY kind`, viewerKey, profileId, this.cutoff())
  }

  profile(viewerKey: string) {
    const cutoff = this.cutoff()
    const visible = this.personalizes(viewerKey)
    return {
      sessions: visible ? get<{ n: number }>(this.db, `SELECT COUNT(DISTINCT session_id) AS n FROM live_viewer_interactions
        WHERE viewer_key = ? AND observed_at >= ?`, viewerKey, cutoff)?.n ?? 0 : 0,
      topics: visible ? all<{ topic: string; sourceId: string; observedAt: string }>(this.db, `
        SELECT topic, sourceId, observedAt FROM (
          SELECT topic, source_id AS sourceId, observed_at AS observedAt,
            ROW_NUMBER() OVER (PARTITION BY topic ORDER BY observed_at DESC) AS position
          FROM live_viewer_interactions WHERE viewer_key = ? AND topic IS NOT NULL AND observed_at >= ?
        ) WHERE position = 1 ORDER BY observedAt DESC LIMIT 8`, viewerKey, cutoff) : [],
      relationships: visible ? all<Relationship>(this.db, `SELECT ${RELATIONSHIP_COLUMNS} FROM live_relationship_memory
        WHERE viewer_key = ? AND observed_at >= ? ORDER BY profile_id, kind`, viewerKey, cutoff) : [],
    }
  }

  correct(viewerKey: string, profileId: string, kind: Relationship['kind'], value: string): boolean {
    if (!get(this.db, 'SELECT 1 FROM viewer_profiles WHERE viewer_key = ?', viewerKey) ||
        !this.personalizes(viewerKey) || !publicBroadcastText(value) ||
        (kind === 'address' && !/^[\p{L}\p{N}_-]{1,12}$/u.test(value)) ||
        (kind === 'inside_joke' && !/^[\p{L}\p{N}_-]{1,16}$/u.test(value))) return false
    // A correction takes precedence over later automatic observations.
    run(this.db, `INSERT INTO live_relationship_memory (viewer_key, profile_id, kind, value, source_id, observed_at)
      VALUES (?, ?, ?, ?, 'viewer_correction', ?) ON CONFLICT(viewer_key, profile_id, kind) DO UPDATE
      SET value = excluded.value, source_id = excluded.source_id, observed_at = excluded.observed_at`,
    viewerKey, profileId, kind, value, nowIso())
    return true
  }

  savedProgram(): ProgramMemory[] {
    return all<ProgramMemory>(this.db, `SELECT ${PROGRAM_COLUMNS} FROM live_program_memory WHERE workspace = ?
      ORDER BY updated_at DESC LIMIT 30`, this.workspace)
  }

  programById(id: string): ProgramMemory | undefined {
    return get<ProgramMemory>(this.db, `SELECT ${PROGRAM_COLUMNS} FROM live_program_memory WHERE id = ? AND workspace = ?`, id, this.workspace)
  }

  recallProgram(questions: readonly string[]): ProgramMemory[] {
    const entries = this.db.prepare(`SELECT ${PROGRAM_COLUMNS} FROM live_program_memory WHERE workspace = ?
      ORDER BY updated_at DESC`).iterate(this.workspace)
    const matches: ProgramMemory[] = []
    for (const row of entries) {
      const item = row as unknown as ProgramMemory
      if (questions.some((text) => topicMatches(text, item.topic))) matches.push(item)
      if (matches.length === 3) break
    }
    return matches
  }

  saveProgram(item: ProgramMemory): void {
    run(this.db, `INSERT INTO live_program_memory (id, workspace, session_id, profile_id, topic, summary, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET topic = excluded.topic, summary = excluded.summary,
      updated_at = excluded.updated_at WHERE workspace = excluded.workspace`, item.id, this.workspace,
    item.sessionId, item.profileId, item.topic, item.summary, nowIso())
  }

  removeProgram(id: string): boolean {
    return run(this.db, 'DELETE FROM live_program_memory WHERE id = ? AND workspace = ?', id, this.workspace).changes > 0
  }
}
