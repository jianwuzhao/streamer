/**
 * 版本化迁移注册表（方案 §16：SQLite 使用事务、WAL、版本化迁移）。
 *
 * 迁移以 TS 内嵌 SQL 字符串维护（而非 .sql 文件），保证 tsdown 打包产物
 * lib/index.js 在安装目录内自包含可用。每个新阶段追加新版本，禁止修改已发布版本。
 */
export interface Migration {
  readonly version: number
  readonly name: string
  readonly sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: '001_init_phase_a',
    sql: `
CREATE TABLE IF NOT EXISTS events (
  event_id        TEXT PRIMARY KEY,
  source          TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  room_id         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  viewer_key      TEXT,
  type            TEXT NOT NULL,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  provenance      TEXT NOT NULL CHECK (provenance IN ('platform_verified','operator','bridge','unverified')),
  purpose_tags    TEXT NOT NULL DEFAULT '[]',
  payload_ref     TEXT NOT NULL,
  correlation_id  TEXT,
  causal_event_ids TEXT NOT NULL DEFAULT '[]',
  replay          INTEGER NOT NULL DEFAULT 0,
  retain_until    TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source, source_event_id)
);
CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, received_at);
CREATE INDEX IF NOT EXISTS idx_events_viewer ON events(viewer_key) WHERE viewer_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS session_state (
  session_id            TEXT PRIMARY KEY,
  summary               TEXT,
  pending_tasks         TEXT NOT NULL DEFAULT '[]',
  referenced_event_ids  TEXT NOT NULL DEFAULT '[]',
  active_release_id     TEXT NOT NULL,
  policy_version        TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blackboard_snapshots (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  revision          INTEGER NOT NULL,
  topic             TEXT NOT NULL,
  game_state_ref    TEXT,
  pending_tasks     TEXT NOT NULL DEFAULT '[]',
  recent_event_ids  TEXT NOT NULL DEFAULT '[]',
  active_release_id TEXT NOT NULL,
  policy_version    TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (session_id, revision)
);

CREATE TABLE IF NOT EXISTS decisions (
  decision_id    TEXT PRIMARY KEY,
  actor          TEXT NOT NULL CHECK (actor IN ('policy_service','operator')),
  action         TEXT NOT NULL CHECK (action IN ('memory_write','profile_update','train','publish','consolidate')),
  payload_hash   TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  epoch          INTEGER NOT NULL,
  expires_at     TEXT NOT NULL,
  result         TEXT NOT NULL CHECK (result IN ('allow','deny','review')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS write_operations (
  op_id           TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  decision_id     TEXT,
  target          TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','staged','reconcile_required','done','failed')),
  backend_ref     TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_write_ops_status ON write_operations(status);

CREATE TABLE IF NOT EXISTS usage (
  usage_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id       TEXT NOT NULL,
  generation_epoch INTEGER NOT NULL,
  route            TEXT NOT NULL CHECK (route IN ('local_gpu','local_cpu','cloud','fallback')),
  reason_code      TEXT,
  model            TEXT,
  latency_ms       INTEGER NOT NULL,
  tokens_in        INTEGER,
  tokens_out       INTEGER,
  cost_cny         REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_request ON usage(request_id);
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage(created_at);

CREATE TABLE IF NOT EXISTS audit (
  audit_id    INTEGER PRIMARY KEY AUTOINCREMENT,
  decision_id TEXT,
  action      TEXT NOT NULL,
  summary     TEXT NOT NULL,
  refs        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS governance_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`,
  },
]
