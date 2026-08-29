CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  original_path TEXT,
  checksum TEXT,
  file_created_at TEXT,
  file_modified_at TEXT,
  width INTEGER,
  height INTEGER,
  mime_type TEXT,
  immich_updated_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE processing_runs (
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
  normalized_output_json TEXT
);

CREATE TABLE asset_tags (
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

CREATE TABLE manual_overrides (
  asset_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id, tag)
);

CREATE TABLE pending_sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  asset_ids_json TEXT NOT NULL,
  add_tags_json TEXT NOT NULL,
  remove_tags_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE job_runs (
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
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL
);

CREATE TABLE referee_groups (
  group_key TEXT PRIMARY KEY,
  member_count INTEGER NOT NULL,
  same_subject INTEGER,
  provider TEXT NOT NULL,
  model TEXT,
  refereed_at TEXT NOT NULL
);

CREATE TABLE referee_picks (
  asset_id TEXT PRIMARY KEY,
  group_key TEXT NOT NULL,
  rank INTEGER NOT NULL,
  keep INTEGER NOT NULL DEFAULT 0,
  eyes_closed TEXT,
  note TEXT
);

INSERT INTO assets VALUES (
  'fixture-asset-1', '/synthetic/photo-1.jpg', 'fixture-checksum',
  '2024-01-01T10:00:00Z', '2024-01-01T10:00:00Z', 1200, 800,
  'image/jpeg', '2024-01-01T10:00:00Z',
  '2024-01-01T10:00:00Z', '2024-01-01T10:00:00Z'
);

INSERT INTO processing_runs (
  asset_id, provider, model, model_version, prompt_version, taxonomy_version,
  status, started_at, finished_at, raw_output_json, normalized_output_json
) VALUES (
  'fixture-asset-1', 'local_lmstudio', 'fixture-vision-model', NULL, 'v1', 'v1',
  'succeeded', '2024-01-01T10:01:00Z', '2024-01-01T10:02:00Z', '{}',
  '{"caption":"synthetic red barn in snow","short_caption":"red barn","tags":[{"tag":"ai/scene/snow","confidence":0.91}],"quality":{"frame_worthy_score":0.82,"aesthetic_score":0.76},"needs_review":false,"exclusion_reasons":[]}'
);

INSERT INTO asset_tags VALUES (
  'fixture-asset-1', 'ai/scene/snow', 0.91, 'ai', 'synthetic fixture',
  'fixture-vision-model', 'v1', '2024-01-01T10:02:00Z'
);

INSERT INTO manual_overrides VALUES (
  'fixture-asset-1', 'frame/eligible', 'approve', 'synthetic fixture',
  '2024-01-01T10:03:00Z'
);

INSERT INTO pending_sync_jobs (
  action, asset_ids_json, add_tags_json, remove_tags_json, attempts, last_error,
  created_at
) VALUES (
  'decision', '["fixture-asset-1"]', '["frame/eligible"]', '[]', 1, NULL,
  '2024-01-01T10:03:00Z'
);

INSERT INTO job_runs (
  title, provider, model, prompt_version, taxonomy_version, targeted, status,
  error, counters_json, started_at, finished_at
) VALUES (
  'Synthetic upgrade run', 'local_lmstudio', 'fixture-vision-model', 'v1', 'v1',
  1, 'succeeded', NULL, '{"succeeded":1}',
  '2024-01-01T10:01:00Z', '2024-01-01T10:02:00Z'
);

INSERT INTO referee_groups VALUES (
  'fixture-group', 2, 1, 'local_lmstudio', 'fixture-vision-model',
  '2024-01-01T10:04:00Z'
);
INSERT INTO referee_picks VALUES (
  'fixture-asset-1', 'fixture-group', 1, 1, 'open', 'synthetic pick'
);
