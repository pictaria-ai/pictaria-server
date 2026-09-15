// Additive schema on the existing enrichment DB. Detailed evidence stays cold;
// the worker reads only compact grouping fields. No raw AI response history.
export const CURATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_observations (asset_id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=4096));
CREATE TABLE IF NOT EXISTS curate_dirty (asset_id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS curate_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO curate_meta VALUES('generation',0);
CREATE TABLE IF NOT EXISTS curate_photos (
 asset_id TEXT PRIMARY KEY, captured_ms INTEGER, checksum TEXT, duplicate_id TEXT,
 image_key TEXT NOT NULL, rendition_key TEXT, facts_key TEXT NOT NULL,
 input_key TEXT NOT NULL, material_key TEXT NOT NULL, human_key TEXT NOT NULL,
 state TEXT NOT NULL, availability TEXT NOT NULL, people_count INTEGER, recognized_count INTEGER,
 evidence_json TEXT NOT NULL CHECK(length(CAST(evidence_json AS BLOB))<=4096)
);
CREATE INDEX IF NOT EXISTS idx_curate_state_time ON curate_photos(state,captured_ms,asset_id);
CREATE TABLE IF NOT EXISTS curate_separations (
 id TEXT PRIMARY KEY, active INTEGER NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, undo_until INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS curate_separation_members (
 separation_id TEXT NOT NULL, asset_id TEXT NOT NULL, partition_no INTEGER NOT NULL,
 PRIMARY KEY(separation_id,asset_id)
);
CREATE INDEX IF NOT EXISTS idx_curate_separation_asset ON curate_separation_members(asset_id,separation_id);
CREATE TABLE IF NOT EXISTS curate_leases (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope_hash TEXT NOT NULL, json TEXT NOT NULL,
 bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_curate_lease_expiry ON curate_leases(expires_at);
CREATE TABLE IF NOT EXISTS curate_view_groups (
 view_id TEXT NOT NULL, position INTEGER NOT NULL, group_id TEXT NOT NULL, ids_json TEXT NOT NULL, route TEXT NOT NULL,
 PRIMARY KEY(view_id,position), UNIQUE(view_id,group_id)
);
CREATE TRIGGER IF NOT EXISTS curate_lease_cleanup AFTER DELETE ON curate_leases BEGIN
 DELETE FROM curate_view_groups WHERE view_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS curate_advice (
 role TEXT NOT NULL, input_key TEXT NOT NULL, schema_version TEXT NOT NULL, json TEXT NOT NULL,
 PRIMARY KEY(role,input_key)
);
CREATE TABLE IF NOT EXISTS curate_advice_members (
 role TEXT NOT NULL, input_key TEXT NOT NULL, asset_id TEXT NOT NULL,
 PRIMARY KEY(role,asset_id)
);
CREATE TRIGGER IF NOT EXISTS curate_advice_cleanup AFTER DELETE ON curate_advice BEGIN
 DELETE FROM curate_advice_members WHERE role=OLD.role AND input_key=OLD.input_key;
END;
`;

// Triggers cover every current writer, including Frame tag mutations, review
// membership, Enrich, and availability stamps. Work rolls back with its source
// transaction and is reconciled after a restart. No per-read full DB assembly.
export function installCurateTriggers(db) {
  for (const table of [
    'assets',
    'latest_success',
    'asset_tags',
    'review_list',
    'manual_overrides',
    'curate_observations',
  ]) {
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = event === 'DELETE' ? 'OLD' : 'NEW';
      const relevant =
        table === 'review_list' ? '1' : `EXISTS(SELECT 1 FROM review_list WHERE asset_id=${ref}.asset_id)`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS curate_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} WHEN ${relevant} BEGIN
        INSERT INTO curate_dirty(asset_id,version) VALUES(${ref}.asset_id,1)
          ON CONFLICT(asset_id) DO UPDATE SET version=version+1;
        END;`);
    }
  }
}
