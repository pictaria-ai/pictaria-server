CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY,
  original_path TEXT,
  checksum TEXT,
  file_created_at TEXT,
  file_modified_at TEXT,
  width INTEGER,
  height INTEGER,
  mime_type TEXT,
  immich_updated_at TEXT,
  -- Visual descriptors for near-duplicate grouping: Immich's perceptual
  -- thumbhash (base64, ~25 bytes) and its duplicate-detection group id.
  thumbhash TEXT,
  duplicate_id TEXT,
  -- Stamped when a targeted fetch confirms the asset is gone from Immich;
  -- cleared by upsertAsset the moment any run sees it again. A stamped asset
  -- stops feeding the failure-limited retry set.
  missing_since TEXT,
  -- Stamped when a human discards the photo from enrichment:
  -- excluded from the stuck set and skipped by every run until restored.
  -- A deliberate decision, so upsertAsset never clears it — only an
  -- explicit restore does. Local-only; nothing is written to Immich.
  enrich_discarded_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_version TEXT,
  prompt_version TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT,
  raw_output_json TEXT,
  normalized_output_json TEXT,
  FOREIGN KEY(asset_id) REFERENCES assets(asset_id)
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  confidence REAL,
  source TEXT NOT NULL,
  reason TEXT,
  model TEXT,
  taxonomy_version TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id, tag)
);

CREATE TABLE IF NOT EXISTS immich_tag_map (
  tag TEXT PRIMARY KEY,
  immich_tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  asset_ids_json TEXT NOT NULL,
  add_tags_json TEXT NOT NULL,
  remove_tags_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  -- Dead-lettered jobs stay for inspection/retry but never block the queue.
  dead_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_processing_runs_asset_id ON processing_runs(asset_id);
-- Serves "latest succeeded run per asset" scans (migration backfill, coverage
-- probes) from the index alone, without touching multi-KB row data.
CREATE INDEX IF NOT EXISTS idx_processing_runs_status_asset ON processing_runs(status, asset_id, id);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag);
CREATE INDEX IF NOT EXISTS idx_manual_overrides_asset_id ON manual_overrides(asset_id);

-- Review projection: each asset's LATEST succeeded run, reduced to the few
-- fields the review path actually reads — so serving Curate never parses
-- library-sized normalized_output_json blobs. Values are stored raw (scores,
-- reason confidences); thresholds and taxonomy policy apply at read time, so
-- a taxonomy change never requires a re-projection. Kept current by
-- recordProcessingRun (write-through, like caption_index); backfilled once by
-- migration 3.
CREATE TABLE IF NOT EXISTS latest_success (
  asset_id TEXT PRIMARY KEY,
  run_id INTEGER NOT NULL,
  model TEXT,
  taxonomy_version TEXT,
  finished_at TEXT,
  short_caption TEXT,
  frame_score REAL,
  aesthetic_score REAL,
  needs_review INTEGER,
  -- Small [{tag, confidence}] array (or NULL): the only pieces of the
  -- output's exclusion_reasons the review path consumes.
  exclusion_reasons_json TEXT
);

-- "Send to Enrich" queue: pending targeted jobs, run manually from the
-- Enrich page. Filters are stored and resolved fresh at run time.
CREATE TABLE IF NOT EXISTS enrich_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  filters_json TEXT NOT NULL,
  estimated_count INTEGER,
  requested_at TEXT NOT NULL
);

-- Job-level run history (per-asset detail lives in processing_runs).
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT,
  taxonomy_version TEXT,
  targeted INTEGER,
  status TEXT NOT NULL,
  error TEXT,
  counters_json TEXT,
  log_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

-- Curate membership: which photos appear in the review queue at all.
-- Photos enter via "Send to Curate" or an enrich job with "send results to
-- Curate" checked. Decisions (frame/* tags) remain the exit; a row here is
-- membership, not state. Enrichment alone no longer implies review.
CREATE TABLE IF NOT EXISTS review_list (
  asset_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  added_at TEXT NOT NULL
);

-- Caption writeback: durable queue + ledger for copying enrichment captions
-- into Immich's description field (opt-in). Kept separate from
-- pending_sync_jobs: decision syncs apply strictly in order, and a
-- library-sized caption backfill must never block a Curate decision.
-- written_description records exactly what we wrote, so a newer enrichment
-- may update our own text later while human-typed descriptions stay
-- untouched forever. status: pending | written | skipped | failed.
CREATE TABLE IF NOT EXISTS caption_writeback (
  asset_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending',
  written_description TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_caption_writeback_status ON caption_writeback(status);

-- Caption search: full-text index over each photo's latest enrichment
-- caption (idea albums + word cloud). Backfilled once when the table first
-- appears; kept current by recordProcessingRun. caption_vocab exposes
-- term -> photo-count statistics straight from the index.
CREATE VIRTUAL TABLE IF NOT EXISTS caption_index USING fts5(
  asset_id UNINDEXED,
  caption,
  short_caption
);
CREATE VIRTUAL TABLE IF NOT EXISTS caption_vocab USING fts5vocab(caption_index, 'row');

-- Group referee: one multi-image model verdict per "same moment" group.
-- group_key = sha1 of the sorted member asset ids, so a verdict is valid
-- exactly as long as the group's membership; a new member means a new key
-- and an eventual re-referee. Suggestions only — decisions stay human.
CREATE TABLE IF NOT EXISTS referee_groups (
  group_key TEXT PRIMARY KEY,
  member_count INTEGER NOT NULL,
  same_subject INTEGER,
  provider TEXT NOT NULL,
  model TEXT,
  refereed_at TEXT NOT NULL,
  duration_ms INTEGER
);

-- Per-photo referee verdict; an asset keeps only its LATEST verdict (its
-- group changed => the old row is replaced when the new group is refereed).
CREATE TABLE IF NOT EXISTS referee_picks (
  asset_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  keep INTEGER NOT NULL DEFAULT 0,
  eyes_closed TEXT,
  note TEXT,
  subject_group INTEGER
);
CREATE INDEX IF NOT EXISTS idx_referee_picks_group ON referee_picks(group_key);

-- Structured operational history for events that do not already have a
-- durable domain record. Existing Enrich/Curate/referee tables are merged at
-- read time by the Activity page instead of being copied here. `detail_json`
-- is bounded and allowlisted by the activity service; it must never contain
-- credentials, transcripts, settings values, or arbitrary request bodies.
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT,
  device_id TEXT,
  asset_id TEXT,
  provider TEXT,
  model TEXT,
  outcome TEXT,
  summary TEXT NOT NULL,
  detail_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_log_at ON activity_log(at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_category_at ON activity_log(category, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_type_at ON activity_log(type, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_provider_at ON activity_log(provider, at DESC, id DESC);
