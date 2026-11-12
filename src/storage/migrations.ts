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
  {
    version: 6,
    name: '006_retrieval_index',
    sql: `
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_id     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('memory','skill','scene','game','event','viewer_profile','claim')),
  ref         TEXT NOT NULL DEFAULT '',
  character_id TEXT NOT NULL,
  scene       TEXT NOT NULL DEFAULT '',
  viewer_key  TEXT,
  label       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_nodes_scope ON graph_nodes(character_id, scene);

CREATE TABLE IF NOT EXISTS graph_edges (
  edge_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  relation    TEXT NOT NULL CHECK (relation IN ('supports','contradicts','derived_from','supersedes','applies_to','used_in','preference_for')),
  weight      REAL NOT NULL DEFAULT 1,
  valid_from  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  valid_until TEXT,
  extractor   TEXT NOT NULL DEFAULT '',
  review_status TEXT NOT NULL CHECK (review_status IN ('candidate','verified')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON graph_edges(src);
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON graph_edges(dst);

CREATE TABLE IF NOT EXISTS vector_chunks (
  chunk_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('memory','skill')),
  ref          TEXT NOT NULL,
  text         TEXT NOT NULL,
  character_id TEXT NOT NULL,
  namespace    TEXT NOT NULL,
  scene        TEXT NOT NULL DEFAULT '',
  viewer_key   TEXT,
  embedding    TEXT NOT NULL,
  embedding_model_revision TEXT NOT NULL,
  index_generation INTEGER NOT NULL,
  document_revision INTEGER NOT NULL DEFAULT 1,
  expires_at   TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_vector_scope ON vector_chunks(character_id, kind, revoked);

CREATE TABLE IF NOT EXISTS index_generations (
  generation   INTEGER PRIMARY KEY,
  embedding_model_revision TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('building','active','retired')),
  event_cursor INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  retired_at   TEXT
);

CREATE TABLE IF NOT EXISTS index_outbox (
  op_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  generation INTEGER NOT NULL,
  op         TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at TEXT
);
`,
  },
  {
    version: 7,
    name: '007_training',
    sql: `
CREATE TABLE IF NOT EXISTS training_samples (
  sample_id     TEXT PRIMARY KEY,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('human_correction','verified_local_reply','allowed_third_party','skill_trajectory','counterexample')),
  purpose_ok    INTEGER NOT NULL,
  redacted_text TEXT NOT NULL,
  cluster_id    TEXT NOT NULL,
  session_id    TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL CHECK (status IN ('validated','rejected','revoked')),
  split         TEXT NOT NULL CHECK (split IN ('train','heldout')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_training_samples_status ON training_samples(status, split, created_at);
CREATE INDEX IF NOT EXISTS idx_training_samples_cluster ON training_samples(cluster_id);

CREATE TABLE IF NOT EXISTS datasets (
  dataset_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('online_batch','offline_snapshot')),
  sample_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS training_runs (
  run_id             TEXT PRIMARY KEY,
  base_profile       TEXT NOT NULL,
  challenger_adapter TEXT NOT NULL,
  champion_release_id TEXT NOT NULL,
  decision_id        TEXT,
  status             TEXT NOT NULL CHECK (status IN ('pending','prepare_cpu','drain_gpu','train_slice','checkpoint','release_gpu','warmup_champion','completed','failed','cancelled')),
  optimizer_steps    INTEGER NOT NULL DEFAULT 0,
  window_budget_ms   INTEGER,
  error              TEXT,
  started_at         TEXT,
  finished_at        TEXT
);

CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  path          TEXT NOT NULL,
  manifest      TEXT NOT NULL,
  steps         INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, created_at);
`,
  },
  {
    version: 8,
    name: '008_release_consolidation',
    sql: `
CREATE TABLE IF NOT EXISTS releases (
  release_id     TEXT PRIMARY KEY,
  candidate_hash TEXT NOT NULL,
  manifest       TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('candidate','rejected','staged','canary','active','suspended','rolled_back','retired')),
  canary_fraction REAL NOT NULL DEFAULT 0,
  previous_release_id TEXT,
  verification_report_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  activated_at TEXT,
  retired_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status, created_at);

CREATE TABLE IF NOT EXISTS verification_reports (
  report_id    TEXT PRIMARY KEY,
  candidate_hash TEXT NOT NULL,
  baseline_release_id TEXT NOT NULL,
  verdict      TEXT NOT NULL CHECK (verdict IN ('pass','fail','inconclusive')),
  checks       TEXT NOT NULL DEFAULT '[]',
  metrics      TEXT NOT NULL DEFAULT '{}',
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS consolidations (
  consolidation_id   TEXT PRIMARY KEY,
  source_id          TEXT NOT NULL,
  source_revision    INTEGER NOT NULL,
  stable_id          TEXT NOT NULL,
  stable_revision    INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('eligible','proposed','policy_checked','staged_stable','active_stable','challenged','revoked','superseded')),
  evidence_clusters  INTEGER NOT NULL DEFAULT 0,
  independent_sessions INTEGER NOT NULL DEFAULT 0,
  observation_days   INTEGER NOT NULL DEFAULT 0,
  gates              TEXT NOT NULL DEFAULT '[]',
  review_at          TEXT,
  valid_until        TEXT,
  revoked_at         TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS learned_stable (
  id          TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  layer       TEXT NOT NULL CHECK (layer IN ('L1','L3')),
  namespace   TEXT NOT NULL DEFAULT 'learned_stable',
  claim       TEXT NOT NULL,
  scope       TEXT NOT NULL,
  source_consolidation TEXT NOT NULL,
  review_at   TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (id, revision)
);
CREATE INDEX IF NOT EXISTS idx_learned_stable_active ON learned_stable(id);
`,
  },
  {
    version: 9,
    name: '009_operator_settings_reply_log',
    sql: `
CREATE TABLE IF NOT EXISTS operator_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reply_log (
  reply_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id    TEXT NOT NULL UNIQUE,
  session_id    TEXT NOT NULL,
  question_text TEXT NOT NULL,
  reply_text    TEXT NOT NULL,
  route         TEXT NOT NULL CHECK (route IN ('local_gpu','local_cpu','cloud','fallback')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reply_log_created ON reply_log(created_at DESC);
`,
  },
]
