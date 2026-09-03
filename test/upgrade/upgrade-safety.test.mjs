import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SNAPSHOT_MANIFEST,
  backupTargets,
  listBackups,
  newestCompleteBackupAt,
  runBackup,
} from '../../src/backup.mjs';
import { loadConfig } from '../../src/config.mjs';
import { Repository } from '../../src/enrich/repository.mjs';
import { tableExists } from '../../src/migrations.mjs';
import { PersistentStateGuard } from '../../src/persistentState.mjs';
import {
  PERSISTENT_STATE_VERSION,
  UpgradeSafetyError,
  preparePersistentStateUpgrade,
} from '../../src/upgradeSafety.mjs';

test('a new installation records the current state baseline without creating an upgrade backup', async () => {
  await withInstallation(async ({ config, guard }) => {
    assert.deepEqual(guard.preflight(), { mode: 'initialize', missingRoles: [] });
    assert.deepEqual(await preparePersistentStateUpgrade({
      guard,
      config,
      currentStateVersion: 1,
      currentServerVersion: '1.0.0',
    }), {
      action: 'baseline',
      fromStateVersion: null,
      toStateVersion: 1,
    });
    assert.deepEqual(listBackups(config.backup.dir), []);

    const inventory = guard.seal({
      successfulStateVersion: 1,
      successfulServerVersion: '1.0.0',
    });
    assert.deepEqual(inventory.upgrade, {
      stateVersion: 1,
      serverVersion: '1.0.0',
      succeededAt: '2026-08-08T01:00:00.000Z',
      recoveryPoint: null,
      pending: null,
    });
  });
});

test('the activity schema contract creates a recovery point before changing an existing v1 installation', async () => {
  await withInstallation(async ({ config, guard: initialGuard }) => {
    // Reproduce the earlier production shape: enrichment schema v5 without
    // the activity table, protected globally as persistent-state contract v1.
    const existing = new Repository(config.databasePath);
    existing.db.exec('DROP TABLE assets; DROP TABLE processing_runs; DROP TABLE asset_tags;');
    existing.initSchema();
    existing.db.exec('DROP TABLE activity_log');
    existing.close();
    initialGuard.preflight();
    initialGuard.seal({ successfulStateVersion: 1, successfulServerVersion: '0.1.0-before-activity' });

    const upgrade = upgradeGuard(config, '2026-08-08T02:00:00Z');
    upgrade.preflight();
    const prepared = await preparePersistentStateUpgrade({
      guard: upgrade,
      config,
      currentStateVersion: PERSISTENT_STATE_VERSION,
      currentServerVersion: '0.1.0-with-activity',
      now: new Date('2026-08-08T02:00:00Z'),
    });
    assert.equal(PERSISTENT_STATE_VERSION, 6);
    assert.equal(prepared.action, 'create');

    const snapshot = new DatabaseSync(join(config.backup.dir, prepared.snapshotName, 'enrichment.sqlite'), {
      readOnly: true,
    });
    assert.equal(tableExists(snapshot, 'activity_log'), false);
    snapshot.close();

    const migrated = new Repository(config.databasePath);
    migrated.initSchema();
    assert.equal(tableExists(migrated.db, 'activity_log'), true);
    migrated.close();
    const sealed = upgrade.seal({
      successfulStateVersion: PERSISTENT_STATE_VERSION,
      successfulServerVersion: '0.1.0-with-activity',
    });
    assert.equal(sealed.upgrade.stateVersion, 6);
    assert.equal(sealed.upgrade.recoveryPoint.snapshotName, prepared.snapshotName);
  });
});

test('a zero-model v2 installation creates a complete schedule-confirmation recovery point', async () => {
  await withInstallation(async ({ config, guard: initialGuard }) => {
    initialGuard.preflight();
    initialGuard.seal({ successfulStateVersion: 2, successfulServerVersion: '0.1.0-before-schedule-confirmation' });
    const originalAlbums = readFileSync(config.albums.dataFile, 'utf8');

    const upgrade = upgradeGuard(config, '2026-08-08T02:00:00Z');
    upgrade.preflight();
    const prepared = await preparePersistentStateUpgrade({
      guard: upgrade,
      config,
      currentServerVersion: '0.1.0-with-schedule-confirmation',
      now: new Date('2026-08-08T02:00:00Z'),
    });

    assert.equal(PERSISTENT_STATE_VERSION, 6);
    assert.deepEqual({
      action: prepared.action,
      fromStateVersion: prepared.fromStateVersion,
      toStateVersion: prepared.toStateVersion,
    }, {
      action: 'create',
      fromStateVersion: 2,
      toStateVersion: 6,
    });
    assert.equal(
      readFileSync(join(config.backup.dir, prepared.snapshotName, 'smart-albums.json'), 'utf8'),
      originalAlbums,
    );
    const snapshotPath = join(config.backup.dir, prepared.snapshotName);
    const manifest = JSON.parse(readFileSync(join(snapshotPath, SNAPSHOT_MANIFEST), 'utf8'));
    assert.deepEqual({
      version: manifest.version,
      createdAt: manifest.createdAt,
      complete: manifest.complete,
      missing: manifest.missing,
      purpose: manifest.purpose,
    }, {
      version: 2,
      createdAt: '2026-08-08T02:00:00.000Z',
      complete: true,
      missing: [],
      purpose: {
        type: 'pre-migration',
        fromStateVersion: 2,
        toStateVersion: 6,
        fromServerVersion: '0.1.0-before-schedule-confirmation',
        toServerVersion: '0.1.0-with-schedule-confirmation',
      },
    });
    assert.deepEqual(
      manifest.targets.map((target) => target.name).sort(),
      ['enrichment.sqlite', 'frame.db', 'insights.sqlite', 'persistent-state.json', 'settings.json', 'smart-albums.json', 'wake-word-models'],
    );
    for (const target of manifest.targets) {
      assert.ok(Number.isSafeInteger(target.bytes) && target.bytes >= 0);
      assert.match(target.sha256, /^[a-f0-9]{64}$/);
    }
    assert.equal(existsSync(join(snapshotPath, 'wake-word-models', 'models')), true);
  });
});

test('migration retries reuse the original recovery point and publish success only after seal', async () => {
  await withInstallation(async ({ config, root, guard: initialGuard }) => {
    initialGuard.preflight();
    initialGuard.seal({ successfulStateVersion: 1, successfulServerVersion: '1.0.0' });
    const originalSettings = readFileSync(config.settingsPath, 'utf8');

    const unsafeAdvance = upgradeGuard(config);
    unsafeAdvance.preflight();
    assert.throws(
      () => unsafeAdvance.seal({ successfulStateVersion: 2, successfulServerVersion: '2.0.0' }),
      (error) => error.code === 'persistent_state_upgrade_recovery_required',
    );

    const firstAttempt = upgradeGuard(config, '2026-08-08T02:00:00Z');
    firstAttempt.preflight();
    const prepared = await preparePersistentStateUpgrade({
      guard: firstAttempt,
      config,
      currentStateVersion: 2,
      currentServerVersion: '2.0.0',
      now: new Date('2026-08-08T02:00:00Z'),
    });
    assert.equal(prepared.action, 'create');
    const snapshotDir = join(config.backup.dir, prepared.snapshotName);
    assert.equal(readFileSync(join(snapshotDir, 'settings.json'), 'utf8'), originalSettings);
    assert.deepEqual(JSON.parse(readFileSync(join(snapshotDir, SNAPSHOT_MANIFEST), 'utf8')).purpose, {
      type: 'pre-migration',
      fromStateVersion: 1,
      toStateVersion: 2,
      fromServerVersion: '1.0.0',
      toServerVersion: '2.0.0',
    });

    // Model a migration that changed one store and then failed before the
    // global seal. The durable marker must still describe v1 as the last
    // successful state and point at the untouched v1 snapshot.
    writeFileSync(config.settingsPath, '{"version":2,"server":{"immichBaseUrl":"http://partial.example"}}\n');
    assert.equal(firstAttempt.upgradeState().stateVersion, 1);
    assert.equal(firstAttempt.upgradeState().pending.snapshotName, prepared.snapshotName);

    const retry = upgradeGuard(config, '2026-08-08T03:00:00Z');
    retry.preflight();
    assert.deepEqual(await preparePersistentStateUpgrade({
      guard: retry,
      config,
      currentStateVersion: 2,
      currentServerVersion: '2.0.1',
      now: new Date('2026-08-08T03:00:00Z'),
    }), {
      action: 'reuse',
      fromStateVersion: 1,
      toStateVersion: 2,
      snapshotName: prepared.snapshotName,
    });
    assert.deepEqual(listBackups(config.backup.dir), [prepared.snapshotName]);
    assert.equal(readFileSync(join(snapshotDir, 'settings.json'), 'utf8'), originalSettings);

    const completed = retry.seal({
      successfulStateVersion: 2,
      successfulServerVersion: '2.0.1',
    });
    assert.equal(completed.upgrade.stateVersion, 2);
    assert.equal(completed.upgrade.serverVersion, '2.0.1');
    assert.equal(completed.upgrade.pending, null);
    assert.equal(completed.upgrade.recoveryPoint.snapshotName, prepared.snapshotName);

    // A pre-migration point never suppresses the normal post-upgrade backup
    // cadence or gets consumed by ordinary retention.
    const normal = await runBackup(config, { now: new Date('2026-08-08T03:05:00Z') });
    assert.equal(normal.complete, true);
    assert.equal(
      newestCompleteBackupAt(config.backup.dir, backupTargets(config)).toISOString(),
      '2026-08-08T03:05:00.000Z',
    );
    config.backup.keep = 1;
    await runBackup(config, { now: new Date('2026-08-08T04:05:00Z') });
    assert.deepEqual(listBackups(config.backup.dir), [
      prepared.snapshotName,
      '2026-08-08-04-05',
    ]);

    const downgrade = upgradeGuard(config, '2026-08-08T05:00:00Z');
    downgrade.preflight();
    await assert.rejects(
      preparePersistentStateUpgrade({
        guard: downgrade,
        config,
        currentStateVersion: 1,
        currentServerVersion: '1.0.0',
      }),
      (error) => error instanceof UpgradeSafetyError
        && error.code === 'persistent_state_downgrade_refused'
        && error.message.includes(prepared.snapshotName),
    );
    assert.equal(existsSync(join(root, 'persistent-state.json')), true);
  });
});

test('a missing pending recovery point blocks retry instead of snapshotting partially migrated state', async () => {
  await withInstallation(async ({ config, guard: initialGuard }) => {
    initialGuard.preflight();
    initialGuard.seal({ successfulStateVersion: 1, successfulServerVersion: '1.0.0' });

    const firstAttempt = upgradeGuard(config);
    firstAttempt.preflight();
    const prepared = await preparePersistentStateUpgrade({
      guard: firstAttempt,
      config,
      currentStateVersion: 2,
      currentServerVersion: '2.0.0',
      now: new Date('2026-08-08T02:00:00Z'),
    });
    rmSync(join(config.backup.dir, prepared.snapshotName), { recursive: true });

    const retry = upgradeGuard(config);
    retry.preflight();
    await assert.rejects(
      preparePersistentStateUpgrade({
        guard: retry,
        config,
        currentStateVersion: 2,
        currentServerVersion: '2.0.0',
      }),
      (error) => error instanceof UpgradeSafetyError
        && error.code === 'pre_migration_recovery_point_invalid',
    );
    assert.deepEqual(listBackups(config.backup.dir), []);
    assert.equal(retry.upgradeState().stateVersion, 1);
  });
});

test('an incomplete pre-migration snapshot never licenses migration or advances the marker', async () => {
  await withInstallation(async ({ config, guard: initialGuard }) => {
    initialGuard.preflight();
    initialGuard.seal({ successfulStateVersion: 1, successfulServerVersion: '1.0.0' });
    rmSync(config.insights.dbPath);

    const attempt = upgradeGuard(config);
    attempt.preflight();
    await assert.rejects(
      preparePersistentStateUpgrade({
        guard: attempt,
        config,
        currentStateVersion: 2,
        currentServerVersion: '2.0.0',
        now: new Date('2026-08-08T02:00:00Z'),
      }),
      (error) => error instanceof UpgradeSafetyError
        && error.code === 'pre_migration_backup_incomplete'
        && /insights\.sqlite/.test(error.message),
    );
    assert.equal(attempt.upgradeState().stateVersion, 1);
    assert.equal(attempt.upgradeState().pending, null);
  });
});

async function withInstallation(work) {
  const root = mkdtempSync(join(tmpdir(), 'pictaria-upgrade-safety-'));
  try {
    const config = loadConfig({
      DATABASE_PATH: join(root, 'enrichment.sqlite'),
      SETTINGS_PATH: join(root, 'settings.json'),
      ALBUMS_DATA_FILE: join(root, 'smart-albums.json'),
      FRAME_DB_PATH: join(root, 'frame.db'),
      INSIGHTS_DB_PATH: join(root, 'insights.sqlite'),
      WAKE_WORD_MODELS_DIR: join(root, 'wake-word-models'),
      BACKUP_DIR_DEFAULT: join(root, 'backups'),
    });
    createPersistentTargets(config);
    const guard = upgradeGuard(config, '2026-08-08T01:00:00Z');
    await work({ config, root, guard });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createPersistentTargets(config) {
  mkdirSync(join(config.wakeWordModelsDir, 'models'), { recursive: true });
  writeFileSync(join(config.wakeWordModelsDir, 'registry.json'), '{"version":1,"models":[]}\n');
  writeFileSync(config.settingsPath, '{"version":2}\n');
  writeFileSync(config.albums.dataFile, '{"version":1,"jobs":[]}\n');

  const enrichment = new DatabaseSync(config.databasePath);
  enrichment.exec('CREATE TABLE assets (id); CREATE TABLE processing_runs (id); CREATE TABLE asset_tags (id)');
  enrichment.close();
  const frame = new DatabaseSync(config.frame.dbPath);
  frame.exec('CREATE TABLE asset_displays (id); CREATE TABLE voice_command_stats (id)');
  frame.close();
  const insights = new DatabaseSync(config.insights.dbPath);
  insights.exec('CREATE TABLE swept_assets (id)');
  insights.close();
}

function upgradeGuard(config, now = '2026-08-08T01:00:00Z') {
  return new PersistentStateGuard({
    inventoryPath: config.persistentState.inventoryPath,
    markerPath: config.persistentState.markerPath,
    legacySettingsMarkerPath: config.persistentState.legacySettingsMarkerPath,
    targets: backupTargets(config),
    now: () => new Date(now),
  });
}
