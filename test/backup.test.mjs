import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  DESTINATION_MARKER,
  BACKUP_LOCK_DIR,
  MAX_SNAPSHOT_MANIFEST_BYTES,
  MAX_SNAPSHOT_CLOCK_SKEW_MS,
  SNAPSHOT_MANIFEST,
  SNAPSHOT_OWNER,
  adoptBackupDestination,
  backupTargets,
  listBackups,
  markActiveBackupLockAbandoned,
  newestBackupAt,
  newestCompleteBackupAt,
  newestBackupStatus,
  newestBackupStatusAsync,
  readSnapshotStatus,
  newestCompleteBackupAtAsync,
  rotateBackups,
  runBackup,
} from '../src/backup.mjs';
import { loadConfig } from '../src/config.mjs';
import { createBackupRoutes } from '../src/routes/backup.mjs';
import { loadOrCreateSessionSecret } from '../src/sessionTokens.mjs';
import { MAX_SETTINGS_STATE_BYTES, SettingsStore } from '../src/settings.mjs';
import {
  MAX_RESTORED_WAKE_WORD_MODEL_BYTES,
  MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES,
  MAX_RESTORED_WAKE_WORD_SNAPSHOT_BYTES,
} from '../src/wakeword/store.mjs';

function withDataDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-backup-'));
  const db = new DatabaseSync(join(dir, 'enrichment.sqlite'));
  db.exec('CREATE TABLE t (x)');
  db.exec('CREATE TABLE assets (id); CREATE TABLE processing_runs (id); CREATE TABLE asset_tags (id)');
  db.exec("INSERT INTO t VALUES ('precious decision')");
  db.close();
  writeFileSync(join(dir, 'settings.json'), '{"version":1}');
  writeFileSync(join(dir, 'persistent-state.json'), JSON.stringify({
    version: 1,
    initializedAt: '2026-07-09T00:00:00.000Z',
    protectedRoles: ['enrichment.sqlite', 'settings.json', 'smart-albums.json', 'frame.db', 'wake-word-models'],
    recomputableRoles: ['insights.sqlite'],
  }));
  mkdirSync(join(dir, 'wake-word-models'));
  mkdirSync(join(dir, 'wake-word-models', 'models'));
  writeFileSync(join(dir, 'wake-word-models', 'registry.json'), '{"version":1,"models":[]}');
  const config = {
    databasePath: join(dir, 'enrichment.sqlite'),
    settingsPath: join(dir, 'settings.json'),
    sessionSecretPath: join(dir, 'session-secret'),
    persistentState: {
      inventoryPath: join(dir, 'persistent-state.json'),
      markerPath: join(dir, 'persistent-state.json.initialized'),
    },
    wakeWordModelsDir: join(dir, 'wake-word-models'),
    frame: { dbPath: join(dir, 'missing-frame.db') },
    insights: { dbPath: join(dir, 'missing-insights.sqlite') },
    albums: { dataFile: join(dir, 'missing-albums.json') },
    backup: { dir: join(dir, 'backups'), keep: 2, enabled: true, intervalHours: 24 },
  };
  return Promise.resolve(work(config, dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function createAllBackupSources(config) {
  for (const path of [config.frame.dbPath, config.insights.dbPath]) {
    if (!existsSync(path)) {
      const db = new DatabaseSync(path);
      if (path === config.frame.dbPath) {
        db.exec('CREATE TABLE asset_displays (id); CREATE TABLE voice_command_stats (id)');
      } else {
        db.exec('CREATE TABLE t (x)');
      }
      db.close();
    }
  }
  if (!existsSync(config.albums.dataFile)) {
    writeFileSync(config.albums.dataFile, '{"version":1,"jobs":[]}');
  }
}

function createOwnedPartial(config, stamp) {
  adoptBackupDestination(config);
  const partial = join(config.backup.dir, `${stamp}.partial`);
  mkdirSync(partial);
  const backupRoot = statSync(config.backup.dir);
  writeFileSync(join(partial, SNAPSHOT_OWNER), JSON.stringify({
    version: 1,
    stamp,
    backupRoot: {
      dev: String(backupRoot.dev),
      ino: String(backupRoot.ino),
    },
  }));
  return partial;
}

function createBackupLock(config, overrides = {}) {
  adoptBackupDestination(config);
  const lockDir = join(config.backup.dir, BACKUP_LOCK_DIR);
  mkdirSync(lockDir);
  const backupRoot = statSync(config.backup.dir);
  const installationSecret = loadOrCreateSessionSecret(config.sessionSecretPath);
  const installationId = createHash('sha256')
    .update('pictaria-backup-installation-v1\0')
    .update(installationSecret)
    .digest('hex');
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
    version: 2,
    token: randomUUID(),
    hostname: hostname(),
    pid: 99_999_999,
    createdAt: '2026-07-09T00:00:00.000Z',
    abandonedAt: null,
    installationId,
    backupRoot: {
      dev: String(backupRoot.dev),
      ino: String(backupRoot.ino),
    },
    ...overrides,
  }));
  return lockDir;
}

function substituteUnownedDirectory(entryPath) {
  const preservedOwned = `${entryPath}.owned-preserved`;
  renameSync(entryPath, preservedOwned);
  mkdirSync(entryPath);
  writeFileSync(join(entryPath, 'precious.txt'), 'unrelated replacement');
  return preservedOwned;
}

function writeWakeWordRegistry(config, id, bytes) {
  writeFileSync(join(config.wakeWordModelsDir, 'registry.json'), JSON.stringify({
    version: 1,
    models: [wakeWordRegistryRecord(id, bytes)],
  }));
}

function wakeWordRegistryRecord(id, bytes) {
  return {
    id,
    displayName: 'Hey Pictaria',
    phrase: 'Hey Pictaria',
    originalFilename: 'hey-pictaria.tflite',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    rightsConfirmedAt: '2026-07-09T00:00:00.000Z',
    featureStack: 'melspectrogram-embedding',
    runtime: 'tflite',
    defaultThreshold: 0.5,
    byteSize: bytes.length,
    inputFrames: 16,
    embeddingDimension: 96,
    inputShape: [1, 16, 96],
    outputShape: [1, 1],
  };
}

function assertIntegrityManifest(manifest, expected) {
  assert.equal(manifest.version, 2);
  assert.equal(manifest.createdAt, expected.createdAt);
  assert.equal(manifest.complete, expected.complete);
  assert.deepEqual(manifest.missing, expected.missing);
  assert.deepEqual(
    manifest.targets.map((target) => target.name).sort(),
    expected.targets.toSorted(),
  );
  for (const target of manifest.targets) {
    assert.ok(['file', 'directory'].includes(target.kind));
    assert.ok(Number.isSafeInteger(target.bytes) && target.bytes >= 0);
    assert.match(target.sha256, /^[a-f0-9]{64}$/);
  }
}

test('runBackup snapshots existing files, reports missing ones, and restores readable', async () => {
  await withDataDir(async (config) => {
    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    assert.deepEqual(
      result.files.map((file) => file.name).sort(),
      ['enrichment.sqlite', 'persistent-state.json', 'settings.json', 'wake-word-models'],
    );
    assert.ok(result.bytes > 0);
    assert.equal(existsSync(join(result.dir, 'wake-word-models', 'models')), true);
    assert.equal(existsSync(join(result.dir, 'missing-frame.db')), false);
    assert.equal(existsSync(join(result.dir, 'frame.db')), false);

    // Absent sources are visible in the result, not silently omitted: a
    // vanished database must leave a trace in backup status.
    assert.deepEqual(
      result.missing.map((entry) => entry.name).sort(),
      ['frame.db', 'insights.sqlite', 'smart-albums.json'],
    );
    assert.equal(result.missing.find((entry) => entry.name === 'frame.db').path, config.frame.dbPath);
    assert.equal(result.complete, false);
    assertIntegrityManifest(JSON.parse(readFileSync(join(result.dir, SNAPSHOT_MANIFEST), 'utf8')), {
      createdAt: '2026-07-09T01:00:00.000Z',
      complete: false,
      missing: ['frame.db', 'insights.sqlite', 'smart-albums.json'],
      targets: ['enrichment.sqlite', 'settings.json', 'wake-word-models', 'persistent-state.json'],
    });

    const restored = new DatabaseSync(join(result.dir, 'enrichment.sqlite'), { readOnly: true });
    assert.equal(restored.prepare('SELECT x FROM t').get().x, 'precious decision');
    restored.close();
  });
});

test('a zero-model install produces a complete snapshot with a restorable empty models directory', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);

    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    assert.equal(result.complete, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(
      result.files.map((file) => file.name).sort(),
      ['enrichment.sqlite', 'frame.db', 'insights.sqlite', 'persistent-state.json', 'settings.json', 'smart-albums.json', 'wake-word-models'],
    );
    assert.deepEqual(readdirSync(join(result.dir, 'wake-word-models', 'models')), []);
    assertIntegrityManifest(JSON.parse(readFileSync(join(result.dir, SNAPSHOT_MANIFEST), 'utf8')), {
      createdAt: '2026-07-09T01:00:00.000Z',
      complete: true,
      missing: [],
      targets: ['enrichment.sqlite', 'frame.db', 'insights.sqlite', 'settings.json', 'smart-albums.json', 'wake-word-models', 'persistent-state.json'],
    });
  });
});

test('fresh settings state is restorable, while guarded deletion stays incomplete', async () => {
  await withDataDir(async (config, dir) => {
    rmSync(config.settingsPath);
    for (const path of [config.frame.dbPath, config.insights.dbPath]) {
      const db = new DatabaseSync(path);
      if (path === config.frame.dbPath) {
        db.exec('CREATE TABLE asset_displays (id); CREATE TABLE voice_command_stats (id)');
      } else {
        db.exec('CREATE TABLE t (x)');
      }
      db.close();
    }
    writeFileSync(config.albums.dataFile, '{"version":1,"jobs":[]}');

    const runtimeConfig = loadConfig({
      SETTINGS_PATH: config.settingsPath,
      DATABASE_PATH: config.databasePath,
      FRAME_DB_PATH: config.frame.dbPath,
      INSIGHTS_DB_PATH: config.insights.dbPath,
      ALBUMS_DATA_FILE: config.albums.dataFile,
      WAKE_WORD_MODELS_DIR: config.wakeWordModelsDir,
      BACKUP_DIR: config.backup.dir,
    });
    new SettingsStore({ filePath: config.settingsPath, config: runtimeConfig, env: {} }).load();

    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    assert.equal(first.complete, true);
    assert.deepEqual(first.missing, []);
    assert.equal(existsSync(join(first.dir, 'settings.json')), true);

    const restoredPath = join(dir, 'restored', 'settings.json');
    mkdirSync(join(dir, 'restored'));
    copyFileSync(join(first.dir, 'settings.json'), restoredPath);
    const restoredConfig = loadConfig({ SETTINGS_PATH: restoredPath });
    const restored = new SettingsStore({ filePath: restoredPath, config: restoredConfig, env: {} }).load();
    assert.equal(restored.describe().server.immichBaseUrl.source, 'default');

    rmSync(config.settingsPath);
    assert.equal(existsSync(config.settingsPath), false);

    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    assert.equal(second.complete, false);
    assert.deepEqual(second.missing.map((entry) => entry.name), ['settings.json']);
  });
});

test('two sources sharing a basename both survive under their role names', async () => {
  await withDataDir(async (config, dir) => {
    // Env overrides (DATABASE_PATH, FRAME_DB_PATH) can point two targets at
    // files with the same basename in different directories. Destinations
    // are role names, so neither copy may clobber the other.
    const makeDb = (path, value) => {
      const db = new DatabaseSync(path);
      db.exec('CREATE TABLE t (x)');
      db.exec('CREATE TABLE assets (id); CREATE TABLE processing_runs (id); CREATE TABLE asset_tags (id)');
      db.exec('CREATE TABLE asset_displays (id); CREATE TABLE voice_command_stats (id)');
      db.exec(`INSERT INTO t VALUES ('${value}')`);
      db.close();
    };
    mkdirSync(join(dir, 'a'));
    mkdirSync(join(dir, 'b'));
    makeDb(join(dir, 'a', 'state.sqlite'), 'enrichment data');
    makeDb(join(dir, 'b', 'state.sqlite'), 'frame data');
    const collided = {
      ...config,
      databasePath: join(dir, 'a', 'state.sqlite'),
      frame: { dbPath: join(dir, 'b', 'state.sqlite') },
    };

    const result = await runBackup(collided, { now: new Date('2026-07-09T01:00:00Z') });

    assert.deepEqual(
      result.files.map((file) => file.name).sort(),
      ['enrichment.sqlite', 'frame.db', 'persistent-state.json', 'settings.json', 'wake-word-models'],
    );
    const read = (name) => {
      const db = new DatabaseSync(join(result.dir, name), { readOnly: true });
      const value = db.prepare('SELECT x FROM t').get().x;
      db.close();
      return value;
    };
    assert.equal(read('enrichment.sqlite'), 'enrichment data');
    assert.equal(read('frame.db'), 'frame data');
  });
});

test('wake-word backups omit an unsafe target without publishing external bytes', async () => {
  await withDataDir(async (config, dir) => {
    const externalModel = join(dir, 'external-model.tflite');
    writeFileSync(externalModel, 'host-only bytes');
    symlinkSync(externalModel, join(config.wakeWordModelsDir, 'host-secret'));

    const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });

    assert.equal(result.complete, false);
    assert.match(result.missing.find((entry) => entry.name === 'wake-word-models').reason, /unexpected entry.*host-secret/);
    assert.equal(existsSync(join(result.dir, 'wake-word-models')), false);
    assert.equal(existsSync(join(result.dir, 'enrichment.sqlite')), true);
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-02-30']);
  });
});

test('wake-word backups omit a registry-listed model symlink even when its target matches integrity metadata', async () => {
  await withDataDir(async (config, dir) => {
    const bytes = Buffer.from('external registered model bytes');
    const id = '11111111-1111-4111-8111-111111111111';
    const externalModel = join(dir, 'external-model.tflite');
    writeFileSync(externalModel, bytes);
    mkdirSync(join(config.wakeWordModelsDir, 'models'), { recursive: true });
    symlinkSync(externalModel, join(config.wakeWordModelsDir, 'models', `${id}.tflite`));
    writeWakeWordRegistry(config, id, bytes);

    const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });

    assert.equal(result.complete, false);
    assert.match(result.missing.find((entry) => entry.name === 'wake-word-models').reason, /regular file/);
    assert.equal(existsSync(join(result.dir, 'wake-word-models')), false);
    assert.equal(existsSync(join(result.dir, 'enrichment.sqlite')), true);
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-02-30']);
  });
});

test('wake-word transient and host metadata entries omit only that target', async () => {
  for (const unexpected of ['registry.json.tmp-123', '.DS_Store']) {
    await withDataDir(async (config) => {
      writeFileSync(join(config.wakeWordModelsDir, unexpected), 'transient');

      const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });

      assert.equal(result.complete, false);
      const wakeWordFailure = result.missing.find((entry) => entry.name === 'wake-word-models');
      assert.ok(wakeWordFailure);
      assert.match(wakeWordFailure.reason, /unexpected entry/);
      assert.equal(existsSync(join(result.dir, 'wake-word-models')), false);
      assert.equal(existsSync(join(result.dir, 'enrichment.sqlite')), true);
    });
  }
});

test('wake-word backups copy only the registry and exact registered model files', async () => {
  await withDataDir(async (config) => {
    const bytes = Buffer.from('registered model bytes');
    const id = '11111111-1111-4111-8111-111111111111';
    mkdirSync(join(config.wakeWordModelsDir, 'models'), { recursive: true });
    writeFileSync(join(config.wakeWordModelsDir, 'models', `${id}.tflite`), bytes);
    writeWakeWordRegistry(config, id, bytes);
    writeFileSync(join(config.wakeWordModelsDir, 'registry.json.bak'), 'previous live registry');

    const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });
    const copiedDirectory = join(result.dir, 'wake-word-models');
    assert.equal(readFileSync(join(copiedDirectory, 'models', `${id}.tflite`), 'utf8'), bytes.toString());
    assert.equal(existsSync(join(copiedDirectory, 'registry.json.bak')), false);
    assert.deepEqual(readdirSync(copiedDirectory).sort(), ['models', 'registry.json']);
  });
});

test('wake-word backups preserve valid state above a later upload quota', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const modelsPath = join(config.wakeWordModelsDir, 'models');
    mkdirSync(modelsPath, { recursive: true });
    const records = [];
    for (let index = 1; index <= 21; index += 1) {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const bytes = Buffer.from([index]);
      writeFileSync(join(modelsPath, `${id}.tflite`), bytes);
      records.push(wakeWordRegistryRecord(id, bytes));
    }
    writeFileSync(join(config.wakeWordModelsDir, 'registry.json'), JSON.stringify({ version: 1, models: records }));

    const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });

    assert.equal(result.complete, true);
    assert.equal(readdirSync(join(result.dir, 'wake-word-models', 'models')).length, 21);
  });
});

test('wake-word backups reject restored aggregate declarations before opening model files', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const records = Array.from({ length: 11 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      return wakeWordRegistryRecord(id, Buffer.from([index + 1]));
    });
    for (const record of records) {
      record.byteSize = MAX_RESTORED_WAKE_WORD_MODEL_BYTES;
    }
    assert.ok(records.reduce((total, record) => total + record.byteSize, 0)
      > MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES);
    writeFileSync(
      join(config.wakeWordModelsDir, 'registry.json'),
      JSON.stringify({ version: 1, models: records }),
    );

    const result = await runBackup(config, { now: new Date('2026-07-09T02:30:00Z') });

    assert.equal(result.complete, false);
    assert.match(
      result.missing.find((entry) => entry.name === 'wake-word-models').reason,
      /50 MiB restore limit/,
    );
    assert.equal(existsSync(join(result.dir, 'wake-word-models')), false);
  });
});

test('duplicate destination names fail the run instead of silently overwriting', async () => {
  await withDataDir(async (config) => {
    const targets = [
      { role: 'enrichment.sqlite', path: config.databasePath, kind: 'sqlite' },
      { role: 'enrichment.sqlite', path: config.settingsPath, kind: 'file' },
    ];

    await assert.rejects(
      runBackup(config, { now: new Date('2026-07-09T01:00:00Z'), targets }),
      /collide on destination name "enrichment\.sqlite"/,
    );
    assert.deepEqual(listBackups(config.backup.dir), []);
  });
});

test('same-minute runs publish under unique names before retention', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    config.backup.keep = 1;
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:15Z') });
    const changedSettings = '{"version":1,"server":{"immichBaseUrl":"http://changed"}}';
    writeFileSync(config.settingsPath, changedSettings);
    let entriesBeforeRetention;
    const second = await runBackup(config, {
      now: new Date('2026-07-09T01:00:45Z'),
      testHooks: {
        beforeRetention() {
          entriesBeforeRetention = listBackups(config.backup.dir);
        },
      },
    });

    assert.deepEqual(entriesBeforeRetention, ['2026-07-09-01-00', '2026-07-09-01-00-run-0002']);
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-01-00-run-0002']);
    assert.notEqual(second.dir, first.dir);
    assert.equal(readFileSync(join(second.dir, 'settings.json'), 'utf8'), changedSettings);
    assert.equal(readdirSync(config.backup.dir).some((name) => name.endsWith('.partial')), false);
  });
});

test('malformed protected JSON is reported missing instead of producing a complete snapshot', async () => {
  for (const role of ['settings.json', 'smart-albums.json']) {
    await withDataDir(async (config) => {
      createAllBackupSources(config);
      const target = backupTargets(config).find((candidate) => candidate.role === role);
      writeFileSync(target.path, 'null');

      const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

      assert.equal(result.complete, false, role);
      assert.deepEqual(result.missing.map((entry) => entry.name), [role]);
      assert.match(result.missing[0].reason, /expected a versioned settings object|Smart Album state version 1/);
      assert.equal(existsSync(join(result.dir, role)), false);
    });
  }
});

test('a bounded source that disappears after validation degrades only its backup target', async () => {
  await withDataDir(async (config, dir) => {
    const healthyPath = join(dir, 'healthy.json');
    const changingPath = join(dir, 'changing.json');
    writeFileSync(healthyPath, '{"ok":true}');
    writeFileSync(changingPath, '{"ok":true}');
    let removed = false;
    const targets = [
      {
        role: 'healthy.json',
        path: healthyPath,
        kind: 'file',
        maxBytes: 64,
        validate: () => ({ valid: true }),
      },
      {
        role: 'changing.json',
        path: changingPath,
        kind: 'file',
        maxBytes: 64,
        validate: () => {
          if (!removed) {
            removed = true;
            rmSync(changingPath);
          }
          return { valid: true };
        },
      },
    ];

    const result = await runBackup(config, {
      now: new Date('2026-07-09T02:30:00Z'),
      targets,
    });

    assert.equal(result.complete, false);
    assert.deepEqual(result.missing.map((entry) => entry.name), ['changing.json']);
    assert.equal(readFileSync(join(result.dir, 'healthy.json'), 'utf8'), '{"ok":true}');
    assert.equal(existsSync(join(result.dir, 'changing.json')), false);
  });
});

test('an incomplete same-minute rerun preserves the prior complete snapshot', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const complete = await runBackup(config, { now: new Date('2026-07-09T01:00:15Z') });
    rmSync(config.settingsPath);

    const incomplete = await runBackup(config, { now: new Date('2026-07-09T01:00:45Z') });

    assert.equal(incomplete.complete, false);
    assert.deepEqual(listBackups(config.backup.dir), [
      '2026-07-09-01-00',
      '2026-07-09-01-00-run-0002',
    ]);
    assert.equal(JSON.parse(readFileSync(join(complete.dir, SNAPSHOT_MANIFEST), 'utf8')).complete, true);
    assert.equal(existsSync(join(complete.dir, 'settings.json')), true);
  });
});

test('an exact pre-migration recovery-point collision fails closed', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const purpose = {
      type: 'pre-migration',
      fromStateVersion: 4,
      toStateVersion: 5,
      fromServerVersion: '0.4.0',
      toServerVersion: '0.5.0',
    };
    const first = await runBackup(config, {
      now: new Date('2026-07-09T01:00:15Z'),
      purpose,
    });

    await assert.rejects(
      runBackup(config, { now: new Date('2026-07-09T01:00:45Z'), purpose }),
      /Pre-migration backup destination collision.*refused to overwrite/,
    );
    assert.equal(readSnapshotStatus(first.dir, backupTargets(config)).state, 'complete');
  });
});

test('rotation keeps the newest N backups and newestBackupAt reads the stamp', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const third = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });

    assert.equal(third.removed, 1);
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-02-00', '2026-07-09-03-00']);
    assert.equal(newestBackupAt(config.backup.dir).toISOString(), '2026-07-09T03:00:00.000Z');
  });
});

test('an incomplete snapshot does not reset the automatic-backup cadence', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    rmSync(config.settingsPath);
    await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });

    assert.equal(newestBackupAt(config.backup.dir).toISOString(), '2026-07-09T03:00:00.000Z');
    assert.equal(
      newestCompleteBackupAt(config.backup.dir, backupTargets(config)).toISOString(),
      '2026-07-09T01:00:00.000Z',
    );
  });
});

test('clock skew is tolerated but future or inconsistent snapshot timestamps never reset cadence', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const current = new Date('2026-07-09T03:00:00.000Z');
    const withinSkew = new Date(current.getTime() + MAX_SNAPSHOT_CLOCK_SKEW_MS - 60000);
    const healthy = await runBackup(config, { now: withinSkew });
    const targets = backupTargets(config);

    assert.equal(
      newestCompleteBackupAt(config.backup.dir, targets, { verifyIntegrity: false, now: current }).toISOString(),
      withinSkew.toISOString(),
      'ordinary clock correction inside the documented allowance remains usable',
    );

    const futureName = '2026-07-09-03-10';
    const futureDir = join(config.backup.dir, futureName);
    renameSync(healthy.dir, futureDir);
    const manifestPath = join(futureDir, SNAPSHOT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.createdAt = '2026-07-09T03:10:00.000Z';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    assert.equal(
      newestCompleteBackupAt(config.backup.dir, targets, { verifyIntegrity: false, now: current }),
      null,
      'a snapshot beyond the skew allowance cannot suppress the next backup',
    );
    assert.equal(
      readSnapshotStatus(futureDir, targets, { verifyIntegrity: false, now: current }).state,
      'unknown',
    );

    const inconsistentDir = join(config.backup.dir, '2026-07-09-02-00');
    renameSync(futureDir, inconsistentDir);
    assert.equal(
      readSnapshotStatus(inconsistentDir, targets, { verifyIntegrity: false, now: current }).state,
      'unknown',
      'a manifest and directory stamp that disagree beyond the allowance are ignored',
    );
  });
});

test('a future-dated snapshot cannot evict the last verified recovery point', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const healthy = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    const future = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const futureDir = join(config.backup.dir, '2036-07-09-02-00');
    renameSync(future.dir, futureDir);
    const manifestPath = join(futureDir, SNAPSHOT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.createdAt = '2036-07-09T02:00:00.000Z';
    writeFileSync(manifestPath, JSON.stringify(manifest));

    config.backup.keep = 1;
    rotateBackups(config.backup.dir, 1, backupTargets(config), {
      now: new Date('2026-07-09T03:00:00Z'),
    });

    assert.equal(existsSync(healthy.dir), true);
    assert.equal(existsSync(futureDir), true, 'the ignored restored entry is left untouched');
  });
});

test('automatic cadence ignores a complete snapshot damaged after publication', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const settingsPath = join(result.dir, 'settings.json');
    const original = readFileSync(settingsPath);
    const corrupted = Buffer.from(original);
    corrupted[corrupted.length - 1] ^= 1;
    writeFileSync(settingsPath, corrupted);

    assert.equal(
      await newestCompleteBackupAtAsync(config.backup.dir, backupTargets(config), {
        now: new Date('2026-07-09T03:00:00Z'),
      }),
      null,
    );
  });
});

test('rotation revalidates snapshots and preserves the newest healthy recovery point', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const targets = backupTargets(config);

    writeFileSync(join(second.dir, 'settings.json'), 'null');
    assert.deepEqual(readSnapshotStatus(second.dir, targets), {
      state: 'incomplete',
      complete: false,
      missing: ['settings.json'],
      createdAt: '2026-07-09T02:00:00.000Z',
      damaged: true,
    });

    config.backup.keep = 1;
    rmSync(config.settingsPath);
    const newest = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });

    assert.equal(newest.complete, false);
    assert.deepEqual(listBackups(config.backup.dir), [
      '2026-07-09-01-00',
      '2026-07-09-03-00',
    ]);
    assert.equal(existsSync(first.dir), true, 'the healthy recovery point survives');
    assert.equal(existsSync(second.dir), false, 'the damaged snapshot is pruned first');
  });
});

test('an incomplete run verifies nominal points and preserves the healthy recovery point', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    config.backup.keep = 1;

    // Same-size post-publication damage is invisible to metadata checks.
    // Retention verifies backward until it finds a healthy recovery point,
    // removes the damaged candidate, and keeps the healthy older snapshot
    // while the newest run remains incomplete.
    writeFileSync(join(second.dir, 'settings.json'), '{"version":2}');
    assert.equal(readSnapshotStatus(second.dir, backupTargets(config)).damaged, true);
    rmSync(config.settingsPath);
    await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });

    assert.deepEqual(listBackups(config.backup.dir), [
      '2026-07-09-01-00',
      '2026-07-09-03-00',
    ]);
    assert.equal(existsSync(first.dir), true);
    assert.equal(existsSync(second.dir), false);
  });
});

test('snapshot integrity detects valid-looking post-backup changes and reports them through status', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const copied = new DatabaseSync(join(result.dir, 'enrichment.sqlite'));
    copied.exec("INSERT INTO t VALUES ('changed after backup')");
    copied.close();

    const targets = backupTargets(config);
    const status = readSnapshotStatus(result.dir, targets);
    assert.equal(status.state, 'incomplete');
    assert.equal(status.damaged, true);
    assert.deepEqual(status.missing, ['enrichment.sqlite']);
    assert.equal(newestCompleteBackupAt(config.backup.dir, targets), null);
    assert.deepEqual(newestBackupStatus(config.backup.dir, targets), {
      dir: result.dir,
      at: '2026-07-09T02:00:00.000Z',
      complete: false,
      missing: [{ name: 'enrichment.sqlite' }],
      legacy: false,
      damaged: true,
    });

    const sent = [];
    const response = { writeHead: () => {}, end: (body) => sent.push(JSON.parse(body)) };
    const handler = createBackupRoutes({
      config,
      backupState: { running: false, lastResult: null, lastError: null },
    });
    await handler({ method: 'GET' }, response, new URL('http://x/api/backup/status'));
    assert.equal(sent[0].lastResult.damaged, true);
    assert.deepEqual(sent[0].lastResult.missing, [{ name: 'enrichment.sqlite' }]);
  });
});

test('async status yields during content verification and invalidates its cache on change', async () => {
  await withDataDir(async (config, dir) => {
    const source = join(dir, 'large-state.bin');
    writeFileSync(source, Buffer.alloc(8 * 1024 * 1024, 0x61));
    let structuralChecks = 0;
    const targets = [{
      role: 'large-state.bin',
      path: source,
      kind: 'file',
      validate: () => {
        structuralChecks += 1;
        return { valid: true };
      },
    }];
    const result = await runBackup(config, {
      now: new Date('2026-07-09T02:00:00Z'),
      targets,
    });
    const checksAfterPublish = structuralChecks;

    const verification = newestBackupStatusAsync(config.backup.dir, targets);
    let eventLoopYielded = false;
    await new Promise((resolve) => setImmediate(() => {
      eventLoopYielded = true;
      resolve();
    }));
    assert.equal(eventLoopYielded, true);
    assert.equal((await verification).complete, true);
    assert.equal(structuralChecks, checksAfterPublish, 'v2 status does not repeat synchronous validators');

    writeFileSync(join(result.dir, 'large-state.bin'), Buffer.alloc(8 * 1024 * 1024, 0x62));
    const changed = await newestBackupStatusAsync(config.backup.dir, targets);
    assert.equal(changed.complete, false);
    assert.equal(changed.damaged, true);
    assert.deepEqual(changed.missing, [{ name: 'large-state.bin' }]);
    assert.equal(structuralChecks, checksAfterPublish);
  });
});

test('async status never blesses an entry replaced while its old descriptor is hashing', async () => {
  await withDataDir(async (config, dir) => {
    const source = join(dir, 'bounded-state.bin');
    const replacement = join(dir, 'replacement.bin');
    const size = 2 * 1024 * 1024;
    writeFileSync(source, Buffer.alloc(size, 0x61));
    writeFileSync(replacement, Buffer.alloc(size, 0x62));
    const targets = [{
      role: 'bounded-state.bin',
      path: source,
      kind: 'file',
      maxBytes: size,
    }];
    const result = await runBackup(config, {
      now: new Date('2026-07-09T02:00:00Z'),
      targets,
    });
    const snapshotEntry = join(result.dir, 'bounded-state.bin');

    const verification = newestBackupStatusAsync(config.backup.dir, targets);
    setTimeout(() => renameSync(replacement, snapshotEntry), 1);
    const status = await verification;

    assert.notEqual(status.complete, true);
    assert.equal(readFileSync(snapshotEntry)[0], 0x62);
  });
});

test('retention shape checks apply restored JSON ceilings to v1 and v2 manifests', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const targets = backupTargets(config);
    const oversized = Buffer.alloc(MAX_SETTINGS_STATE_BYTES + 1, 0x20);
    writeFileSync(join(second.dir, 'settings.json'), oversized);

    const manifestPath = join(second.dir, SNAPSHOT_MANIFEST);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const settingsRecord = manifest.targets.find((record) => record.name === 'settings.json');
    settingsRecord.bytes = oversized.byteLength;
    settingsRecord.sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.deepEqual(
      readSnapshotStatus(second.dir, targets, { verifyIntegrity: false }).missing,
      ['settings.json'],
    );

    config.backup.keep = 1;
    rotateBackups(config.backup.dir, config.backup.keep, targets);
    assert.equal(existsSync(first.dir), true, 'v2 oversized state cannot evict the older recovery point');

    writeFileSync(manifestPath, JSON.stringify({
      version: 1,
      createdAt: '2026-07-09T02:00:00.000Z',
      complete: true,
      missing: [],
    }));
    const legacyMissing = readSnapshotStatus(
      second.dir,
      targets,
      { verifyIntegrity: false },
    ).missing;
    assert.ok(legacyMissing.includes('settings.json'));
    assert.equal(legacyMissing.includes('wake-word-models'), false);
    rotateBackups(config.backup.dir, config.backup.keep, targets);
    assert.equal(existsSync(first.dir), true, 'v1 oversized state cannot evict the older recovery point');
  });
});

test('healthy legacy wake-word snapshots participate in bounded retention after verification', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const snapshots = [];
    for (const hour of ['01', '02', '03']) {
      const snapshot = await runBackup(config, { now: new Date(`2026-07-09T${hour}:00:00Z`) });
      writeFileSync(join(snapshot.dir, SNAPSHOT_MANIFEST), JSON.stringify({
        version: 1,
        createdAt: `2026-07-09T${hour}:00:00.000Z`,
        complete: true,
        missing: [],
      }));
      snapshots.push(snapshot);
    }
    const targets = backupTargets(config);
    assert.equal(readSnapshotStatus(
      snapshots[2].dir,
      targets,
      { verifyIntegrity: false },
    ).complete, true);

    rotateBackups(config.backup.dir, 2, targets);
    assert.equal(existsSync(snapshots[0].dir), false);
    assert.equal(existsSync(snapshots[1].dir), true);
    assert.equal(existsSync(snapshots[2].dir), true);
  });
});

test('unsafe or oversized legacy wake-word directories cannot evict verified recovery points', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    writeFileSync(join(second.dir, SNAPSHOT_MANIFEST), JSON.stringify({
      version: 1,
      createdAt: '2026-07-09T02:00:00.000Z',
      complete: true,
      missing: [],
    }));
    const targets = backupTargets(config);
    assert.equal(
      readSnapshotStatus(second.dir, targets, { verifyIntegrity: false }).complete,
      true,
      'healthy bounded v1 directories remain eligible for retention',
    );

    const unregistered = join(second.dir, 'wake-word-models', 'models', 'unregistered.tflite');
    writeFileSync(unregistered, 'x');
    assert.ok(
      readSnapshotStatus(second.dir, targets, { verifyIntegrity: false }).missing
        .includes('wake-word-models'),
      'small unregistered legacy entries are not trusted by retention',
    );
    assert.ok(
      readSnapshotStatus(second.dir, targets).missing.includes('wake-word-models'),
      'full validation applies the same exact restored inventory',
    );
    rmSync(unregistered);

    const registryPath = join(second.dir, 'wake-word-models', 'registry.json');
    const registryLink = join(second.dir, 'wake-word-models', 'registry-hardlink.json');
    linkSync(registryPath, registryLink);
    assert.ok(
      readSnapshotStatus(second.dir, targets, { verifyIntegrity: false }).missing
        .includes('wake-word-models'),
      'hard-linked legacy entries are not trusted by retention',
    );
    rmSync(registryLink);

    const oversized = join(second.dir, 'wake-word-models', 'models', 'unregistered.tflite');
    writeFileSync(oversized, '');
    truncateSync(oversized, MAX_RESTORED_WAKE_WORD_SNAPSHOT_BYTES + 1);

    assert.ok(
      readSnapshotStatus(second.dir, targets, { verifyIntegrity: false }).missing
        .includes('wake-word-models'),
    );
    config.backup.keep = 1;
    rotateBackups(config.backup.dir, config.backup.keep, targets);
    assert.equal(existsSync(first.dir), true, 'oversized legacy state cannot evict an older recovery point');
  });
});

test('snapshot status rejects a target replaced by a link instead of reading through it', async () => {
  await withDataDir(async (config, dir) => {
    createAllBackupSources(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const outside = join(dir, 'outside-settings.json');
    writeFileSync(outside, '{"version":1}');
    rmSync(join(result.dir, 'settings.json'));
    symlinkSync(outside, join(result.dir, 'settings.json'));

    const status = readSnapshotStatus(result.dir, backupTargets(config));
    assert.equal(status.state, 'incomplete');
    assert.equal(status.damaged, true);
    assert.deepEqual(status.missing, ['settings.json']);
  });
});

test('incomplete snapshots never evict complete recovery points and collapse after recovery', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });

    rmSync(config.settingsPath);
    const firstIncomplete = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    assert.equal(firstIncomplete.complete, false);
    assert.deepEqual(
      listBackups(config.backup.dir),
      ['2026-07-09-01-00', '2026-07-09-02-00', '2026-07-09-03-00'],
    );

    const secondIncomplete = await runBackup(config, { now: new Date('2026-07-09T04:00:00Z') });
    assert.equal(secondIncomplete.complete, false);
    assert.deepEqual(
      listBackups(config.backup.dir),
      ['2026-07-09-01-00', '2026-07-09-02-00', '2026-07-09-04-00'],
    );

    writeFileSync(config.settingsPath, '{"version":1}');
    const recovered = await runBackup(config, { now: new Date('2026-07-09T05:00:00Z') });
    assert.equal(recovered.complete, true);
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-02-00', '2026-07-09-05-00']);
  });
});

test('manifestless legacy snapshots remain unknown until a confirmed complete backup exists', async () => {
  await withDataDir(async (config) => {
    mkdirSync(config.backup.dir, { recursive: true });
    for (const stamp of ['2026-07-09-01-00', '2026-07-09-02-00']) {
      const legacy = join(config.backup.dir, stamp);
      mkdirSync(legacy);
      writeFileSync(join(legacy, 'settings.json'), '{}');
    }

    const incomplete = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    assert.equal(incomplete.complete, false);
    assert.deepEqual(
      listBackups(config.backup.dir),
      ['2026-07-09-01-00', '2026-07-09-02-00', '2026-07-09-03-00'],
      'no unknown recovery point is pruned before a confirmed complete exists',
    );

    createAllBackupSources(config);
    const complete = await runBackup(config, { now: new Date('2026-07-09T04:00:00Z') });
    assert.equal(complete.complete, true);
    assert.deepEqual(
      listBackups(config.backup.dir),
      ['2026-07-09-01-00', '2026-07-09-02-00', '2026-07-09-04-00'],
      'manifestless entries remain visible but are never deleted without ownership evidence',
    );
  });
});

test('version-one snapshot manifests remain readable after integrity metadata is introduced', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    writeFileSync(join(result.dir, SNAPSHOT_MANIFEST), JSON.stringify({
      version: 1,
      createdAt: '2026-07-09T01:00:00.000Z',
      complete: true,
      missing: [],
    }));

    assert.deepEqual(readSnapshotStatus(result.dir, backupTargets(config)), {
      state: 'complete',
      complete: true,
      missing: [],
      createdAt: '2026-07-09T01:00:00.000Z',
      damaged: false,
    });
  });
});

test('oversized snapshot manifests become unknown without being parsed or hashed', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    writeFileSync(
      join(result.dir, SNAPSHOT_MANIFEST),
      Buffer.alloc(MAX_SNAPSHOT_MANIFEST_BYTES + 1, 0x20),
    );

    assert.deepEqual(readSnapshotStatus(result.dir, backupTargets(config)), {
      state: 'unknown',
      complete: null,
      missing: [],
      createdAt: null,
    });
  });
});

test('newest backup status reconstructs an incomplete result from its manifest', async () => {
  await withDataDir(async (config) => {
    const incomplete = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    const status = newestBackupStatus(config.backup.dir);

    assert.equal(status.dir, incomplete.dir);
    assert.equal(status.at, '2026-07-09T03:00:00.000Z');
    assert.equal(status.complete, false);
    assert.equal(status.legacy, false);
    assert.deepEqual(
      status.missing.map((entry) => entry.name),
      ['frame.db', 'insights.sqlite', 'smart-albums.json'],
    );
  });
});

test('backup status route keeps an incomplete warning after process state is lost', async () => {
  await withDataDir(async (config) => {
    await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    const sent = [];
    const response = { writeHead: () => {}, end: (body) => sent.push(JSON.parse(body)) };
    const handler = createBackupRoutes({
      config,
      backupState: { running: false, lastResult: null, lastError: null },
    });

    assert.equal(
      await handler({ method: 'GET' }, response, new URL('http://x/api/backup/status')),
      true,
    );
    assert.equal(sent[0].lastResult.complete, false);
    assert.deepEqual(
      sent[0].lastResult.missing.map((entry) => entry.name),
      ['frame.db', 'insights.sqlite', 'smart-albums.json'],
    );
  });
});

test('backup status follows newer standalone snapshots instead of stale process memory', async () => {
  await withDataDir(async (config) => {
    const rememberedIncomplete = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    const backupState = { running: false, lastResult: rememberedIncomplete, lastError: null };
    const handler = createBackupRoutes({ config, backupState });
    const readStatus = async () => {
      const sent = [];
      const response = { writeHead: () => {}, end: (body) => sent.push(JSON.parse(body)) };
      await handler({ method: 'GET' }, response, new URL('http://x/api/backup/status'));
      return sent[0];
    };

    createAllBackupSources(config);
    const standaloneComplete = await runBackup(config, { now: new Date('2026-07-09T04:00:00Z') });
    assert.equal((await readStatus()).lastResult.complete, true, 'newer complete clears an old warning');

    backupState.lastResult = standaloneComplete;
    rmSync(config.settingsPath);
    await runBackup(config, { now: new Date('2026-07-09T05:00:00Z') });
    const newest = await readStatus();
    assert.equal(newest.lastResult.complete, false, 'newer incomplete replaces old healthy status');
    assert.deepEqual(newest.lastResult.missing.map((entry) => entry.name), ['settings.json']);
  });
});

test('newest backup status labels a manifestless snapshot as legacy unknown', async () => {
  await withDataDir(async (config) => {
    const legacy = join(config.backup.dir, '2026-07-09-03-00');
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'settings.json'), '{}');

    assert.deepEqual(newestBackupStatus(config.backup.dir), {
      dir: legacy,
      at: '2026-07-09T03:00:00.000Z',
      complete: null,
      missing: [],
      legacy: true,
    });
  });
});

test('a backup that fails mid-copy is never listed and keeps the prior newest', async () => {
  await withDataDir(async (config) => {
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    // The sqlite copy succeeds first; the settings copy then fails, so the
    // run dies with real files already inside its work directory. Removing
    // the source from its validator models a file disappearing between the
    // pre-copy inspection and copy without depending on root/ACL semantics.
    const targets = [
      { role: 'enrichment.sqlite', path: config.databasePath, kind: 'sqlite' },
      {
        role: 'settings.json',
        path: config.settingsPath,
        kind: 'file',
        validate: (path) => {
          rmSync(path);
          return { valid: true };
        },
      },
    ];
    await assert.rejects(
      runBackup(config, { now: new Date('2026-07-09T02:00:00Z'), targets }),
      /ENOENT/,
    );

    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-01-00']);
    assert.equal(newestBackupAt(config.backup.dir).toISOString(), '2026-07-09T01:00:00.000Z');
    assert.equal(readdirSync(config.backup.dir).some((name) => name.endsWith('.partial')), false);
  });
});

test('a stale .partial from a crashed run is invisible and swept by the next run', async () => {
  await withDataDir(async (config) => {
    const stale = createOwnedPartial(config, '2026-07-09-00-30');
    writeFileSync(join(stale, 'settings.json'), '{"version":1}');

    // A partial never counts as a backup, so the next tick retries.
    assert.deepEqual(listBackups(config.backup.dir), []);
    assert.equal(newestBackupAt(config.backup.dir), null);

    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    assert.equal(existsSync(stale), false);
    assert.ok(existsSync(result.dir));
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-01-00']);
  });
});

test('normal backups preserve every unowned .partial entry', async () => {
  await withDataDir(async (config) => {
    adoptBackupDestination(config);
    const arbitraryDirectory = join(config.backup.dir, 'family-notes.partial');
    const timestampDirectory = join(config.backup.dir, '2026-07-09-00-30.partial');
    const timestampFile = join(config.backup.dir, '2026-07-09-00-45.partial');
    mkdirSync(arbitraryDirectory);
    writeFileSync(join(arbitraryDirectory, 'precious.txt'), 'keep me');
    mkdirSync(timestampDirectory);
    writeFileSync(join(timestampDirectory, 'precious.txt'), 'keep me too');
    writeFileSync(timestampFile, 'not Pictaria work');

    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    assert.equal(readFileSync(join(arbitraryDirectory, 'precious.txt'), 'utf8'), 'keep me');
    assert.equal(readFileSync(join(timestampDirectory, 'precious.txt'), 'utf8'), 'keep me too');
    assert.equal(readFileSync(timestampFile, 'utf8'), 'not Pictaria work');
  });
});

test('same-minute publication preserves an unowned timestamp collision', async (context) => {
  for (const kind of ['directory', 'file']) {
    await context.test(kind, async () => {
      await withDataDir(async (config) => {
        adoptBackupDestination(config);
        const collision = join(config.backup.dir, '2026-07-09-01-00');
        if (kind === 'directory') {
          mkdirSync(collision);
          writeFileSync(join(collision, 'precious.txt'), 'keep me');
        } else {
          writeFileSync(collision, 'keep me');
        }

        const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

        assert.equal(
          kind === 'directory'
            ? readFileSync(join(collision, 'precious.txt'), 'utf8')
            : readFileSync(collision, 'utf8'),
          'keep me',
        );
        assert.equal(result.dir, `${collision}-run-0002`);
        assert.equal(existsSync(join(result.dir, SNAPSHOT_MANIFEST)), true);
        assert.equal(existsSync(`${collision}.partial`), false, 'the current owned work directory is cleaned');
      });
    });
  }
});

test('failure before same-minute publication preserves the previous snapshot', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:10Z') });

    await assert.rejects(
      runBackup(config, {
        now: new Date('2026-07-09T01:00:40Z'),
        testHooks: {
          beforePublish() {
            throw new Error('injected publication failure');
          },
        },
      }),
      /injected publication failure/,
    );

    assert.equal(readSnapshotStatus(first.dir, backupTargets(config)).state, 'complete');
    assert.deepEqual(listBackups(config.backup.dir), ['2026-07-09-01-00']);
    assert.equal(existsSync(`${first.dir}-run-0002.partial`), false);
  });
});

test('destination lock rejects an overlapping run without touching the active backup', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    let signalAcquired;
    let releaseFirst;
    const acquired = new Promise((resolve) => { signalAcquired = resolve; });
    const hold = new Promise((resolve) => { releaseFirst = resolve; });
    const firstRun = runBackup(config, {
      now: new Date('2026-07-09T01:00:10Z'),
      testHooks: {
        async afterLockAcquired() {
          signalAcquired();
          await hold;
        },
      },
    });
    await acquired;

    await assert.rejects(
      runBackup(config, { now: new Date('2026-07-09T01:00:20Z') }),
      (error) => error?.code === 'backup_running' && error?.status === 409,
    );
    assert.equal(existsSync(join(config.backup.dir, BACKUP_LOCK_DIR)), true);

    const backupState = { running: false, lastResult: null, lastError: null };
    const handler = createBackupRoutes({ config, backupState });
    let responseStatus;
    let responseBody;
    await handler(
      { method: 'POST' },
      {
        writeHead(status) { responseStatus = status; },
        end(body) { responseBody = JSON.parse(body); },
      },
      new URL('http://x/api/backup/run'),
    );
    assert.equal(responseStatus, 409);
    assert.equal(responseBody.error.code, 'backup_running');
    assert.equal(backupState.running, false);

    releaseFirst();
    const result = await firstRun;
    assert.equal(result.complete, true);
    assert.equal(existsSync(join(config.backup.dir, BACKUP_LOCK_DIR)), false);
  });
});

test('lock identity is stable for one data directory without exposing its installation secret', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    let firstOwner;
    await runBackup(config, {
      now: new Date('2026-07-09T01:00:00Z'),
      testHooks: {
        afterLockAcquired({ lockDir }) {
          firstOwner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
        },
      },
    });
    let secondOwner;
    await runBackup(config, {
      now: new Date('2026-07-09T02:00:00Z'),
      testHooks: {
        afterLockAcquired({ lockDir }) {
          secondOwner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
        },
      },
    });
    const rawSecret = readFileSync(config.sessionSecretPath, 'utf8').trim();

    assert.match(firstOwner.installationId, /^[a-f0-9]{64}$/);
    assert.equal(secondOwner.installationId, firstOwner.installationId);
    assert.equal(JSON.stringify(firstOwner).includes(rawSecret), false);
  });
});

test('a same-installation shutdown handoff survives a container hostname change', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    const staleLock = createBackupLock(config, {
      hostname: 'previous-container-id',
      abandonedAt: '2026-07-09T00:30:00.000Z',
    });

    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    assert.equal(result.complete, true);
    assert.equal(existsSync(staleLock), false);
  });
});

test('a changed-hostname lock without a shutdown handoff is never reclaimed from PID evidence', async () => {
  await withDataDir(async (config) => {
    const lockDir = createBackupLock(config, {
      hostname: 'still-running-container',
      pid: process.pid,
    });

    await assert.rejects(
      runBackup(config, { now: new Date('2026-07-09T01:00:00Z') }),
      (error) => error?.code === 'backup_running',
    );
    assert.equal(existsSync(lockDir), true);
  });
});

test('controlled shutdown marks the active lock for a recreated container', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    let release;
    let signalAcquired;
    const acquired = new Promise((resolve) => { signalAcquired = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    const running = runBackup(config, {
      now: new Date('2026-07-09T01:00:00Z'),
      testHooks: {
        async afterLockAcquired() {
          signalAcquired();
          await hold;
        },
      },
    });
    await acquired;

    assert.equal(
      markActiveBackupLockAbandoned(config, { now: new Date('2026-07-09T01:00:10Z') }),
      true,
    );
    const owner = JSON.parse(readFileSync(join(config.backup.dir, BACKUP_LOCK_DIR, 'owner.json'), 'utf8'));
    assert.equal(owner.abandonedAt, '2026-07-09T01:00:10.000Z');

    release();
    await running;
  });
});

test('different-installation, legacy, and malformed backup locks are preserved and fail closed', async (context) => {
  for (const kind of ['different-installation', 'legacy', 'malformed']) {
    await context.test(kind, async () => {
      await withDataDir(async (config) => {
        const lockDir = kind === 'different-installation'
          ? createBackupLock(config, {
              installationId: 'f'.repeat(64),
              abandonedAt: '2026-07-09T00:30:00.000Z',
            })
          : createBackupLock(config, kind === 'legacy'
            ? { version: 1, installationId: undefined }
            : { token: 'not-a-token' });

        await assert.rejects(
          runBackup(config, { now: new Date('2026-07-09T01:00:00Z') }),
          (error) => error?.code === 'backup_running'
            && (kind !== 'different-installation'
              ? /unrecognized \.pictaria-backup\.lock/.test(error.message)
              : /locked by .*2026-07-09T00:00:00\.000Z.*docs\/BACKUP\.md/.test(error.message)),
        );
        assert.equal(existsSync(lockDir), true);
      });
    });
  }
});

test('stale cleanup preserves a path substituted after ownership validation', async () => {
  await withDataDir(async (config) => {
    const stale = createOwnedPartial(config, '2026-07-09-00-30');
    let preservedOwned;

    await runBackup(config, {
      now: new Date('2026-07-09T01:00:00Z'),
      testHooks: {
        beforeOwnedRemoval({ entryPath, kind }) {
          if (kind === 'stale-partial') {
            preservedOwned = substituteUnownedDirectory(entryPath);
          }
        },
      },
    });

    assert.equal(readFileSync(join(stale, 'precious.txt'), 'utf8'), 'unrelated replacement');
    assert.equal(existsSync(join(preservedOwned, SNAPSHOT_OWNER)), true);
  });
});

test('failed-run cleanup preserves a substituted partial path', async () => {
  await withDataDir(async (config) => {
    let pathReads = 0;
    let preservedOwned;
    const target = {
      role: 'settings.json',
      kind: 'file',
      get path() {
        pathReads += 1;
        if (pathReads === 2) {
          rmSync(config.settingsPath);
        }
        return config.settingsPath;
      },
    };

    await assert.rejects(
      runBackup(config, {
        now: new Date('2026-07-09T01:00:00Z'),
        targets: [target],
        testHooks: {
          beforeOwnedRemoval({ entryPath, kind }) {
            if (kind === 'failed-partial') {
              preservedOwned = substituteUnownedDirectory(entryPath);
            }
          },
        },
      }),
      /ENOENT/,
    );

    const partial = join(config.backup.dir, '2026-07-09-01-00.partial');
    assert.equal(readFileSync(join(partial, 'precious.txt'), 'utf8'), 'unrelated replacement');
    assert.equal(existsSync(join(preservedOwned, SNAPSHOT_OWNER)), true);
  });
});

test('retention deletes only manifest-confirmed Pictaria snapshots', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    adoptBackupDestination(config);
    const unrelated = join(config.backup.dir, '2026-07-09-00-30');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'precious.txt'), 'not a snapshot');

    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    const result = await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });

    assert.equal(result.removed, 1, 'only the oldest owned snapshot is pruned');
    assert.equal(readFileSync(join(unrelated, 'precious.txt'), 'utf8'), 'not a snapshot');
    assert.deepEqual(listBackups(config.backup.dir), [
      '2026-07-09-00-30',
      '2026-07-09-02-00',
      '2026-07-09-03-00',
    ]);
  });
});

test('retention aborts if an owned snapshot path is substituted before deletion', async () => {
  await withDataDir(async (config) => {
    createAllBackupSources(config);
    config.backup.keep = 3;
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    await runBackup(config, { now: new Date('2026-07-09T03:00:00Z') });
    let preservedOwned;

    assert.throws(
      () => rotateBackups(config.backup.dir, 2, backupTargets(config), {
        now: new Date('2026-07-09T03:00:00Z'),
        testHooks: {
          beforeOwnedRemoval({ entryPath, kind }) {
            if (kind === 'retention') {
              preservedOwned = substituteUnownedDirectory(entryPath);
            }
          },
        },
      }),
      /changed before owned cleanup.*preserved/,
    );

    assert.equal(readFileSync(join(first.dir, 'precious.txt'), 'utf8'), 'unrelated replacement');
    assert.equal(existsSync(join(preservedOwned, SNAPSHOT_MANIFEST)), true);
  });
});

test('a backup taken while the database is being written is still consistent', async () => {
  await withDataDir(async (config) => {
    // Keep a writer open with an in-flight transaction during the backup —
    // the online-backup API must produce a consistent snapshot regardless.
    const writer = new DatabaseSync(config.databasePath);
    writer.exec("INSERT INTO t VALUES ('committed before')");
    const result = await runBackup(config, { now: new Date('2026-07-09T04:00:00Z') });
    writer.close();

    const restored = new DatabaseSync(join(result.dir, 'enrichment.sqlite'), { readOnly: true });
    const rows = restored.prepare('SELECT COUNT(*) AS c FROM t').get().c;
    restored.close();
    assert.equal(rows, 2);
  });
});

// --- The destination must be real, never a stand-in for a mount ---
// Custom destinations are trusted only via their marker, stamped by an
// explicit one-time adoption; nothing is ever created implicitly for them.

test('custom destination: adopt once while mounted, then every absent-mount shape refuses', async () => {
  await withDataDir(async (config, dir) => {
    // Off-machine setup per the docs: a subdirectory of a mount point.
    const mount = join(dir, 'nas');
    mkdirSync(mount);
    config.backup.dir = join(mount, 'pictaria-backups');
    config.backup.dirIsCustom = true;

    // Never-adopted destinations refuse outright — nothing is created.
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T00:00:00Z') }),
      /does not exist.*adopt it once/s,
    );
    assert.equal(existsSync(config.backup.dir), false, 'refusal creates nothing');

    // The one-time explicit adoption, performed while the share is there.
    adoptBackupDestination(config);
    assert.ok(existsSync(join(config.backup.dir, DESTINATION_MARKER)));
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    // macOS unmount: the mount point directory itself disappears.
    rmSync(mount, { recursive: true, force: true });
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T02:00:00Z') }),
      /does not exist/,
    );
    assert.equal(existsSync(mount), false, 'nothing recreated on the local disk');

    // Linux shape: the mount point returns as an EMPTY local directory
    // (leaf missing) — still refused, and still nothing created.
    mkdirSync(mount);
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T03:00:00Z') }),
      /does not exist/,
    );
    assert.equal(existsSync(config.backup.dir), false);

    // Worse Linux shape: something recreated the leaf itself, empty and
    // unmarked — refused as a stand-in.
    mkdirSync(config.backup.dir);
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T04:00:00Z') }),
      /carries no .* marker/,
    );

    // Remount: the share (marker and snapshots included) is back.
    writeFileSync(join(config.backup.dir, DESTINATION_MARKER), 'marker');
    const recovered = await runBackup(config, { now: new Date('2026-07-09T05:00:00Z') });
    assert.ok(recovered.files.length > 0);
  });
});

test('custom destination with snapshots but no marker is refused, not silently adopted', async () => {
  await withDataDir(async (config, dir) => {
    // The pre-fix bug's signature: a local directory full of dated
    // snapshots where a mount should be. Content alone earns no trust.
    const mount = join(dir, 'mnt-nas');
    mkdirSync(mount);
    config.backup.dir = join(mount, 'pictaria-backups');
    config.backup.dirIsCustom = true;
    mkdirSync(config.backup.dir);
    mkdirSync(join(config.backup.dir, '2026-07-01-01-00'));

    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T01:00:00Z') }),
      /holds dated snapshots.*adopt it once/s,
    );

    // A real pre-marker destination is adopted with the same explicit step.
    adoptBackupDestination(config);
    const adopted = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    assert.ok(adopted.files.length > 0);
  });
});

test('switching destinations and back: each carries its own trust (A → B → unavailable A)', async () => {
  await withDataDir(async (config, dir) => {
    const mountA = join(dir, 'nas-a');
    const mountB = join(dir, 'nas-b');
    mkdirSync(mountA);
    mkdirSync(mountB);
    const dirA = join(mountA, 'pictaria-backups');
    const dirB = join(mountB, 'pictaria-backups');
    config.backup.dirIsCustom = true;

    config.backup.dir = dirA;
    adoptBackupDestination(config);
    await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });

    config.backup.dir = dirB;
    adoptBackupDestination(config);
    await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });

    // Back to A, but A's share is gone (an empty parent remains). Trust is
    // per-destination, so this refuses; using B in between must never re-open A
    // to silent local writes.
    rmSync(dirA, { recursive: true, force: true });
    config.backup.dir = dirA;
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T03:00:00Z') }),
      /does not exist/,
    );
    assert.equal(existsSync(dirA), false, 'nothing recreated for A');

    // A's share returns (marker still on it) → works again immediately.
    mkdirSync(dirA);
    writeFileSync(join(dirA, DESTINATION_MARKER), 'marker');
    const recovered = await runBackup(config, { now: new Date('2026-07-09T04:00:00Z') });
    assert.ok(recovered.files.length > 0);
  });
});

test('the default data/backups keeps working implicitly, marker stamped on the way', async () => {
  await withDataDir(async (config) => {
    // Fresh install shape: parent (the data dir) exists, backups/ does not,
    // and no dirIsCustom flag — created and adopted without ceremony.
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    assert.ok(first.files.length > 0);
    assert.ok(existsSync(join(config.backup.dir, DESTINATION_MARKER)));

    // An existing default destination from before the marker existed is
    // stamped silently on its next run.
    rmSync(join(config.backup.dir, DESTINATION_MARKER));
    const second = await runBackup(config, { now: new Date('2026-07-09T02:00:00Z') });
    assert.ok(second.files.length > 0);
    assert.ok(existsSync(join(config.backup.dir, DESTINATION_MARKER)));
  });
});

test('the implicit default destination never adopts a restored symbolic link', async () => {
  await withDataDir(async (config, dir) => {
    const outside = join(dir, 'restored-external-destination');
    mkdirSync(outside);
    symlinkSync(outside, config.backup.dir);

    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T01:00:00Z') }),
      /implicit default .* is a symbolic link/,
    );
    assert.equal(existsSync(join(outside, DESTINATION_MARKER)), false);
    assert.deepEqual(readdirSync(outside), []);
  });
});

test('an explicitly configured symbolic-link destination remains supported', async () => {
  await withDataDir(async (config, dir) => {
    const realDestination = join(dir, 'nas-backups');
    const configuredLink = join(dir, 'configured-backups');
    mkdirSync(realDestination);
    symlinkSync(realDestination, configuredLink);
    config.backup.dir = configuredLink;
    config.backup.dirIsCustom = true;

    adoptBackupDestination(config);
    const result = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    assert.ok(result.files.length > 0);
    assert.equal(existsSync(join(realDestination, DESTINATION_MARKER)), true);
    assert.equal(existsSync(join(realDestination, '2026-07-09-01-00')), true);
  });
});

test('adoption refuses a dangling destination-marker link without touching its target', async () => {
  await withDataDir(async (config, dir) => {
    const custom = join(dir, 'nas-backups');
    const outside = join(dir, 'missing-marker-target');
    mkdirSync(custom);
    symlinkSync(outside, join(custom, DESTINATION_MARKER));
    config.backup.dir = custom;
    config.backup.dirIsCustom = true;

    assert.throws(() => adoptBackupDestination(config), /not a regular marker file/);
    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T01:00:00Z') }),
      /carries no .* marker/,
    );
    assert.equal(existsSync(outside), false);
  });
});

test('the Docker image default (BACKUP_DIR_DEFAULT) is trusted, not treated as custom', async () => {
  // Config level: the image relocates the built-in default without making
  // it look user-selected; a user's BACKUP_DIR still wins and is custom.
  const { loadConfig } = await import('../src/config.mjs');
  const dockerFresh = loadConfig({ BACKUP_DIR_DEFAULT: '/data/backups' });
  assert.equal(dockerFresh.backup.dir, '/data/backups');
  assert.equal(dockerFresh.backup.dirIsCustom, false);
  const dockerEmpty = loadConfig({ BACKUP_DIR_DEFAULT: '/data/backups', BACKUP_DIR: '' });
  assert.equal(dockerEmpty.backup.dir, '/data/backups');
  assert.equal(dockerEmpty.backup.dirIsCustom, false);
  const dockerCustom = loadConfig({ BACKUP_DIR_DEFAULT: '/data/backups', BACKUP_DIR: '/mnt/nas/pictaria' });
  assert.equal(dockerCustom.backup.dir, '/mnt/nas/pictaria');
  assert.equal(dockerCustom.backup.dirIsCustom, true);

  // Behavior level: a fresh named volume (parent exists, backups/ absent,
  // no marker anywhere) backs up first try — no adoption ceremony.
  await withDataDir(async (config, dir) => {
    const volume = join(dir, 'volume');
    mkdirSync(volume);
    config.backup.dir = join(volume, 'backups');
    config.backup.dirIsCustom = false;
    const first = await runBackup(config, { now: new Date('2026-07-09T01:00:00Z') });
    assert.ok(first.files.length > 0);
    assert.ok(existsSync(join(config.backup.dir, DESTINATION_MARKER)));
  });
});

test('a destination swapped mid-run is caught without deleting an unowned stand-in entry', async () => {
  await withDataDir(async (config, dir) => {
    const mount = join(dir, 'nas');
    mkdirSync(mount);
    config.backup.dir = join(mount, 'pictaria-backups');
    config.backup.dirIsCustom = true;
    adoptBackupDestination(config);

    // The root-mount shape: unmounting reveals an underlying directory at
    // the same path, where writes keep succeeding. Worst case simulated —
    // the stand-in even carries a same-named .partial, so every copy lands
    // cleanly and only the pre-publish recheck stands between the run and
    // a silent local snapshot. The swap fires on the first source-path
    // access, i.e. after the guard and work-dir creation.
    let swapped = false;
    const targets = [{
      role: 'settings.json',
      kind: 'file',
      get path() {
        if (!swapped) {
          swapped = true;
          rmSync(mount, { recursive: true, force: true });
          mkdirSync(join(config.backup.dir, '2026-07-09-01-00.partial'), { recursive: true });
        }
        return config.settingsPath;
      },
    }];

    await assert.rejects(
      () => runBackup(config, { now: new Date('2026-07-09T01:00:00Z'), targets }),
      /no longer the destination this run validated/,
    );
    assert.deepEqual(listBackups(config.backup.dir), [], 'nothing published on the stand-in');
    const standInPartial = join(config.backup.dir, '2026-07-09-01-00.partial');
    assert.equal(existsSync(standInPartial), true, 'the unowned stand-in entry is preserved');
    assert.equal(existsSync(join(standInPartial, SNAPSHOT_OWNER)), false);
  });
});
