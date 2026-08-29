CREATE TABLE swept_assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  taken_at TEXT,
  year INTEGER,
  city TEXT,
  state TEXT,
  country TEXT,
  make TEXT,
  model TEXT,
  lens TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER
);

INSERT INTO swept_assets VALUES (
  'fixture-asset-1', 'IMAGE', '2024-01-01T10:00:00Z', 2024,
  'Fixture City', 'Example State', 'Example Country',
  'Example Camera Co', 'Fixture Camera', 'Fixture Lens', 1, 0, 123456
);
