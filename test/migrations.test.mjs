import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { addColumnIfMissing, getUserVersion, migrateDatabase, tableExists } from '../src/migrations.mjs';
import { Repository } from '../src/enrich/repository.mjs';
import { InsightsRepository } from '../src/insights/repository.mjs';

const TOY_SCHEMA = 'CREATE TABLE IF NOT EXISTS things (id INTEGER PRIMARY KEY, name TEXT, extra TEXT);';
const TOY_MIGRATIONS = [
  { version: 1, up: (db) => addColumnIfMissing(db, 'things', 'extra', 'TEXT') },
  { version: 2, up: (db) => db.exec("UPDATE things SET extra = 'migrated' WHERE extra IS NULL") },
];

function withDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-migrations-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh database is stamped at the latest version without running migrations', () => {
  const db = new DatabaseSync(':memory:');
  const result = migrateDatabase(db, { schema: TOY_SCHEMA, migrations: TOY_MIGRATIONS });
  assert.deepEqual(result, { fresh: true, from: 0, applied: [] });
  assert.equal(getUserVersion(db), 2);
});

test('a legacy database runs pending migrations in order and carries the stamp', () => {
  const db = new DatabaseSync(':memory:');
  // Legacy shape: things without the extra column, one row, no stamp.
  db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)');
  db.exec("INSERT INTO things (name) VALUES ('old-row')");

  const result = migrateDatabase(db, { schema: TOY_SCHEMA, migrations: TOY_MIGRATIONS });
  assert.deepEqual(result, { fresh: false, from: 0, applied: [1, 2] });
  assert.equal(getUserVersion(db), 2);
  assert.equal(db.prepare('SELECT extra FROM things').get().extra, 'migrated');

  // Booting again is a no-op: already stamped.
  const again = migrateDatabase(db, { schema: TOY_SCHEMA, migrations: TOY_MIGRATIONS });
  assert.deepEqual(again, { fresh: false, from: 2, applied: [] });
});

test('a database stamped mid-way runs only the newer migrations', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT, extra TEXT)');
  db.exec("INSERT INTO things (name) VALUES ('row')");
  db.exec('PRAGMA user_version = 1');

  const result = migrateDatabase(db, { schema: TOY_SCHEMA, migrations: TOY_MIGRATIONS });
  assert.deepEqual(result, { fresh: false, from: 1, applied: [2] });
  assert.equal(db.prepare('SELECT extra FROM things').get().extra, 'migrated');
});

test('prepare() sees the pre-schema shape of an existing database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE other (id INTEGER)');
  let sawThings = null;
  migrateDatabase(db, {
    schema: TOY_SCHEMA,
    migrations: [{ version: 1, up: () => {} }],
    prepare: (candidate) => {
      sawThings = tableExists(candidate, 'things');
      return {};
    },
  });
  // The base schema creates `things`, but prepare ran before that.
  assert.equal(sawThings, false);
  assert.equal(tableExists(db, 'things'), true);
});

test('non-ascending migration versions are refused', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(
    () => migrateDatabase(db, {
      schema: TOY_SCHEMA,
      migrations: [{ version: 2, up: () => {} }, { version: 1, up: () => {} }],
    }),
    /ascending/,
  );
});

test('a failing migration rolls back its changes and the version stamp together', () => {
  withDir((dir) => {
    const path = join(dir, 'toy.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, name TEXT)');
    db.exec("INSERT INTO things (name) VALUES ('original')");

    assert.throws(
      () =>
        migrateDatabase(db, {
          schema: TOY_SCHEMA,
          migrations: [
            { version: 1, up: (d) => addColumnIfMissing(d, 'things', 'extra', 'TEXT') },
            {
              version: 2,
              up: (d) => {
                d.exec("UPDATE things SET name = 'clobbered'");
                throw new Error('migration crashed mid-flight');
              },
            },
          ],
        }),
      /mid-flight/,
    );

    // Migration 1 committed with its stamp; migration 2's partial write and
    // stamp both rolled back.
    assert.equal(getUserVersion(db), 1);
    assert.equal(db.prepare('SELECT name FROM things').get().name, 'original');

    // A rerun picks up cleanly from version 1.
    const result = migrateDatabase(db, { schema: TOY_SCHEMA, migrations: TOY_MIGRATIONS });
    assert.deepEqual(result.applied, [2]);
    assert.equal(getUserVersion(db), 2);
    db.close();
  });
});

test('a fresh enrichment database is stamped and fully shaped', () => {
  withDir((dir) => {
    const repo = new Repository(join(dir, 'enrichment.sqlite'));
    const result = repo.initSchema();
    assert.equal(result.fresh, true);
    assert.equal(getUserVersion(repo.db), 6);
    for (const column of ['subject_group']) {
      const names = repo.db.prepare("SELECT name FROM pragma_table_info('referee_picks')").all().map((row) => row.name);
      assert.ok(names.includes(column));
    }
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM latest_success').get().n, 0);
    assert.equal(tableExists(repo.db, 'activity_log'), true);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n, 0);
    repo.close();
  });
});

test('a legacy enrichment database lands in the current shape via migration 1', () => {
  withDir((dir) => {
    const path = join(dir, 'enrichment.sqlite');
    // Build the pre-user_version era by hand: old manual_overrides keyed on
    // (asset_id, tag), job_runs without log_json, assets without visual
    // columns, no review_list, no caption index, one succeeded run.
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE manual_overrides (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag)
      );
      CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE assets (asset_id TEXT PRIMARY KEY, original_path TEXT);
      CREATE TABLE processing_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL,
        model TEXT,
        taxonomy_version TEXT,
        status TEXT NOT NULL,
        finished_at TEXT,
        normalized_output_json TEXT
      );
      INSERT INTO manual_overrides VALUES ('a1', 'frame/eligible', 'approve', 'legacy', '2024-01-01T00:00:00Z');
      INSERT INTO processing_runs (asset_id, model, taxonomy_version, status, finished_at, normalized_output_json)
        VALUES ('a1', 'm', 'v1', 'succeeded', '2024-01-01T00:00:05Z',
                '{"caption":"a red barn in snow","short_caption":"red barn","quality":{"frame_worthy_score":0.8}}');
    `);
    legacy.close();

    const repo = new Repository(path);
    const result = repo.initSchema();
    assert.equal(result.fresh, false);
    assert.deepEqual(result.applied, [1, 2, 3, 4, 5, 6]);
    assert.equal(getUserVersion(repo.db), 6);

    // manual_overrides rebuilt append-only with data preserved.
    const overrideColumns = repo.db.prepare("SELECT name FROM pragma_table_info('manual_overrides')").all().map((row) => row.name);
    assert.ok(overrideColumns.includes('id'));
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM manual_overrides').get().n, 1);

    // Columns added to legacy tables.
    const jobRunColumns = repo.db.prepare("SELECT name FROM pragma_table_info('job_runs')").all().map((row) => row.name);
    assert.ok(jobRunColumns.includes('log_json'));
    const assetColumns = repo.db.prepare("SELECT name FROM pragma_table_info('assets')").all().map((row) => row.name);
    assert.ok(assetColumns.includes('thumbhash') && assetColumns.includes('duplicate_id'));
    assert.ok(assetColumns.includes('missing_since'));
    assert.ok(assetColumns.includes('enrich_discarded_at'));

    // Grandfathered review list, caption backfill, and latest_success
    // projection from the succeeded run.
    assert.equal(repo.db.prepare("SELECT source FROM review_list WHERE asset_id = 'a1'").get().source, 'migration');
    assert.equal(repo.searchCaptions('barn').length, 1);
    const projected = repo.db.prepare("SELECT * FROM latest_success WHERE asset_id = 'a1'").get();
    assert.equal(projected.short_caption, 'red barn');
    assert.equal(projected.frame_score, 0.8);
    assert.equal(tableExists(repo.db, 'activity_log'), true);

    // Second boot: nothing left to do.
    assert.deepEqual(repo.initSchema().applied, []);
    repo.close();
  });
});

test('provider-payload migration removes raw envelopes and superseded normalized results', () => {
  withDir((dir) => {
    const repo = new Repository(join(dir, 'enrichment.sqlite'));
    repo.initSchema();
    repo.upsertAsset({ id: 'asset-1' });
    for (const caption of ['old', 'new']) {
      repo.recordProcessingRun({
        assetId: 'asset-1', provider: 'p', model: 'm', promptVersion: 'v1', taxonomyVersion: 'v1',
        status: 'succeeded', normalizedOutput: { caption, short_caption: caption },
      });
    }
    const rows = repo.db.prepare('SELECT id FROM processing_runs ORDER BY id').all();
    repo.db.prepare('UPDATE processing_runs SET raw_output_json = ?').run(JSON.stringify({ debug: 'provider envelope' }));
    repo.db.prepare('UPDATE processing_runs SET normalized_output_json = ? WHERE id = ?')
      .run(JSON.stringify({ caption: 'old', short_caption: 'old' }), rows[0].id);
    repo.db.exec('PRAGMA user_version = 5');

    assert.deepEqual(repo.initSchema().applied, [6]);
    const migrated = repo.db.prepare(`
      SELECT raw_output_json, normalized_output_json
      FROM processing_runs ORDER BY id
    `).all();
    assert.ok(migrated.every((row) => row.raw_output_json === null));
    assert.equal(migrated[0].normalized_output_json, null);
    assert.equal(JSON.parse(migrated[1].normalized_output_json).caption, 'new');
    repo.close();
  });
});

test('a legacy insights database gains the day/lat/lon columns', () => {
  withDir((dir) => {
    const path = join(dir, 'insights.sqlite');
    const legacy = new DatabaseSync(path);
    // Real v1 shape: year/country exist (the base schema indexes them),
    // day/lat/lon do not.
    legacy.exec(`
      CREATE TABLE swept_assets (asset_id TEXT PRIMARY KEY, taken_at TEXT, year INTEGER, country TEXT);
      INSERT INTO swept_assets VALUES ('a1', '2024-06-01T10:00:00Z', 2024, 'United States');
    `);
    legacy.close();

    const repo = new InsightsRepository(path);
    assert.equal(getUserVersion(repo.db), 1);
    const columns = repo.db.prepare("SELECT name FROM pragma_table_info('swept_assets')").all().map((row) => row.name);
    for (const column of ['day', 'lat', 'lon']) {
      assert.ok(columns.includes(column), column);
    }
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM swept_assets').get().n, 1);
    repo.close();
  });
});
