CREATE TABLE asset_displays (
  asset_id TEXT NOT NULL,
  device_id TEXT NOT NULL DEFAULT 'frame',
  display_count INTEGER NOT NULL DEFAULT 0,
  first_shown_at TEXT NOT NULL,
  last_shown_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, device_id)
);

CREATE TABLE voice_command_stats (
  label TEXT PRIMARY KEY,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT NOT NULL
);

INSERT INTO asset_displays VALUES (
  'fixture-asset-1', 'fixture-frame', 3,
  '2024-01-02T10:00:00Z', '2024-01-03T10:00:00Z'
);
INSERT INTO voice_command_stats VALUES (
  'next', 7, '2024-01-03T10:05:00Z'
);
