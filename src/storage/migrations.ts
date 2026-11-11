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
  {
    version: 2,
    name: '002_memory_l2_l4',
    sql: `
CREATE TABLE IF NOT EXISTS memory_candidates (
  id              TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  layer           TEXT NOT NULL CHECK (layer IN ('L2','L4')),
  namespace       TEXT NOT NULL,
  claim           TEXT NOT NULL,
  claim_hash      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  character_id    TEXT NOT NULL,
  scene           TEXT NOT NULL,
  subject         TEXT NOT NULL DEFAULT '',
  supporting_evidence TEXT NOT NULL DEFAULT '[]',
  counter_evidence    TEXT NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL CHECK (status IN ('proposed','validated','active','challenged','expired','superseded')),
  valid_from      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  review_after    TEXT NOT NULL,
  confidence_source TEXT NOT NULL DEFAULT 'calibrated_evidence_policy',
  supersedes      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, revision)
);
CREATE INDEX IF NOT EXISTS idx_memory_active ON memory_candidates(status, character_id, scene);
CREATE INDEX IF NOT EXISTS idx_memory_subject ON memory_candidates(subject, scene) WHERE subject != '';
`,
  },
  {
    version: 3,
    name: '003_viewer_profiles',
    sql: `
CREATE TABLE IF NOT EXISTS viewer_profiles (
  viewer_key       TEXT PRIMARY KEY,
  platform         TEXT NOT NULL,
  room_scope       TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,
  display_nickname TEXT,
  first_seen_at    TEXT,
  last_seen_at     TEXT,
  profile_version  INTEGER NOT NULL DEFAULT 1,
  deletion_status  TEXT NOT NULL DEFAULT 'active' CHECK (deletion_status IN ('active','deletion_requested','deleted')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (platform, room_scope, platform_user_id)
);
CREATE TABLE IF NOT EXISTS profile_fields (
  field_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  viewer_key       TEXT NOT NULL,
  field_name       TEXT NOT NULL,
  value            TEXT NOT NULL,
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  observed_at      TEXT NOT NULL,
  confidence_kind  TEXT NOT NULL CHECK (confidence_kind IN ('observed','inferred','viewer_stated')),
  expires_at       TEXT,
  purpose          TEXT NOT NULL DEFAULT 'service',
  superseded_by    INTEGER,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_profile_fields_current ON profile_fields(viewer_key, field_name) WHERE superseded_by IS NULL;
CREATE TABLE IF NOT EXISTS privacy_requests (
  request_id    TEXT PRIMARY KEY,
  viewer_key    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('view','correction','personalization_off','deletion','export')),
  status        TEXT NOT NULL CHECK (status IN ('received','verifying','resolved','rejected')),
  payload       TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at   TEXT
);
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  viewer_key   TEXT NOT NULL,
  scope        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  propagation  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tombstones_viewer ON deletion_tombstones(viewer_key);
`,
  },
  {
    version: 4,
    name: '004_skills',
    sql: `
CREATE TABLE IF NOT EXISTS skill_versions (
  skill_id      TEXT NOT NULL,
  version       TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('draft','validated','staged','canary','active','suspended','superseded')),
  manifest_hash TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  package_path  TEXT NOT NULL DEFAULT '',
  published_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (skill_id, version)
);
CREATE INDEX IF NOT EXISTS idx_skill_status ON skill_versions(skill_id, status);
CREATE TABLE IF NOT EXISTS skill_runs (
  run_id          TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  version         TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  arguments       TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('retrieved','selected','executed','succeeded','failed','skipped')),
  tool_receipts   TEXT NOT NULL DEFAULT '[]',
  error           TEXT,
  started_at      TEXT,
  finished_at     TEXT
);
`,
  },
  {
    version: 5,
    name: '005_feedback_gifts',
    sql: `
CREATE TABLE IF NOT EXISTS feedback (
  feedback_id       TEXT PRIMARY KEY,
  source_event_id   TEXT,
  actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('viewer','operator','system')),
  viewer_key        TEXT,
  target_reply_id   TEXT,
  target_skill_run_id TEXT,
  label             TEXT NOT NULL,
  correction        TEXT,
  evidence          TEXT NOT NULL DEFAULT '[]',
  consent_scope     TEXT,
  status            TEXT NOT NULL CHECK (status IN ('received','verifying','resolved','insufficient_evidence')),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_target ON feedback(target_reply_id);
CREATE TABLE IF NOT EXISTS gift_ledger (
  entry_id           INTEGER PRIMARY KEY AUTOINCREMENT,
  platform           TEXT NOT NULL,
  room_id            TEXT NOT NULL,
  transaction_id     TEXT,
  event_id           TEXT NOT NULL,
  viewer_key         TEXT NOT NULL,
  gift_id            TEXT NOT NULL,
  combo_id           TEXT,
  combo_total        INTEGER NOT NULL DEFAULT 0,
  quantity_delta     INTEGER NOT NULL,
  unit               TEXT NOT NULL DEFAULT 'unit',
  face_value         REAL,
  currency           TEXT,
  settlement_status  TEXT NOT NULL CHECK (settlement_status IN ('received','pending_settlement','settled','refunded','reversed')),
  refund_ref         TEXT,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','unverified')),
  received_at        TEXT NOT NULL,
  UNIQUE (platform, event_id)
);
CREATE INDEX IF NOT EXISTS idx_gift_combo ON gift_ledger(combo_id) WHERE combo_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS gift_ack (
  ack_id           TEXT PRIMARY KEY,
  viewer_key       TEXT NOT NULL,
  merged_entry_ids TEXT NOT NULL DEFAULT '[]',
  speech_seconds   REAL NOT NULL,
  state            TEXT NOT NULL CHECK (state IN ('pending','played','suppressed','cancelled')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  played_at        TEXT
);
`,
  },
]
