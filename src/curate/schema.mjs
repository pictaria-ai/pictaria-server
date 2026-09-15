// Additive schema on the existing enrichment DB. Detailed evidence stays cold;
// the worker reads only compact grouping fields. No raw AI response history.
export const CURATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS curate_observations (asset_id TEXT PRIMARY KEY, json TEXT NOT NULL CHECK(length(CAST(json AS BLOB))<=4096));
DELETE FROM curate_observations WHERE NOT EXISTS(SELECT 1 FROM review_list WHERE review_list.asset_id=curate_observations.asset_id);
CREATE TRIGGER IF NOT EXISTS curate_observation_cleanup AFTER DELETE ON review_list BEGIN
 DELETE FROM curate_observations WHERE asset_id=OLD.asset_id;
END;
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
CREATE INDEX IF NOT EXISTS idx_curate_lease_parent ON curate_leases(kind,json_extract(json,'$.viewId'));
CREATE INDEX IF NOT EXISTS idx_curate_lease_snapshot ON curate_leases(json_extract(json,'$.snapshotId'));
CREATE TABLE IF NOT EXISTS curate_view_snapshots (id TEXT PRIMARY KEY, bytes INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS curate_view_groups (
 view_id TEXT NOT NULL, position INTEGER NOT NULL, group_id TEXT NOT NULL, ids_json TEXT NOT NULL, route TEXT NOT NULL,
 PRIMARY KEY(view_id,position), UNIQUE(view_id,group_id)
);
DROP TRIGGER IF EXISTS curate_lease_cleanup;
CREATE TRIGGER curate_lease_cleanup AFTER DELETE ON curate_leases BEGIN
 DELETE FROM curate_leases WHERE kind='comparison' AND json_extract(json,'$.viewId')=OLD.id;
 DELETE FROM curate_view_snapshots WHERE id=json_extract(OLD.json,'$.snapshotId')
   AND NOT EXISTS(SELECT 1 FROM curate_leases WHERE json_extract(json,'$.snapshotId')=curate_view_snapshots.id);
 -- Also clean views created by the earlier development snapshot format.
 DELETE FROM curate_view_groups WHERE view_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS curate_snapshot_cleanup AFTER DELETE ON curate_view_snapshots BEGIN
 DELETE FROM curate_view_groups WHERE view_id=OLD.id;
END;
-- An interrupted snapshot build was never returned to a client. Drop its
-- reservation on boot; a partially written membership must never be served.
DELETE FROM curate_leases WHERE json_extract(json,'$.snapshotId') IN (SELECT id FROM curate_view_snapshots WHERE ready=0);
DELETE FROM curate_view_snapshots WHERE ready=0;
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
  const assetColumns = new Set(
    db
      .prepare('PRAGMA table_info(assets)')
      .all()
      .map((row) => row.name),
  );
  const projectionColumns = [
    'checksum',
    'file_created_at',
    'file_modified_at',
    'width',
    'height',
    'thumbhash',
    'duplicate_id',
    'missing_since',
  ].filter((column) => assetColumns.has(column));
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
      const changed =
        table === 'assets' && event === 'UPDATE'
          ? ` AND (${projectionColumns.map((column) => `NEW.${column} IS NOT OLD.${column}`).join(' OR ') || '0'})`
          : '';
      // Replace the definition on boot, including existing development databases.
      db.exec(`DROP TRIGGER IF EXISTS curate_${table}_${event.toLowerCase()};
        CREATE TRIGGER curate_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} WHEN ${relevant}${changed} BEGIN
        INSERT INTO curate_dirty(asset_id,version) VALUES(${ref}.asset_id,1)
          ON CONFLICT(asset_id) DO UPDATE SET version=version+1;
        END;`);
    }
  }
}
