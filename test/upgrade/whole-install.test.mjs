import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { SmartAlbumStore } from '../../src/albums/store.mjs';
import { backupTargets, runBackup } from '../../src/backup.mjs';
import { loadConfig } from '../../src/config.mjs';
import { Repository } from '../../src/enrich/repository.mjs';
import { createFrameLedger } from '../../src/frame/ledger.mjs';
import { getUserVersion } from '../../src/migrations.mjs';
import {
  PROTECTED_PERSISTENT_ROLES,
  PersistentStateGuard,
  RECOMPUTABLE_PERSISTENT_ROLES,
} from '../../src/persistentState.mjs';
import { SettingsStore } from '../../src/settings.mjs';
import { InsightsRepository } from '../../src/insights/repository.mjs';
import { createVoiceMetrics } from '../../src/voice/metrics.mjs';
import { WakeWordModelStore } from '../../src/wakeword/store.mjs';
import { PERSISTENT_STATE_VERSION, preparePersistentStateUpgrade } from '../../src/upgradeSafety.mjs';
import { loadOrCreateSessionSecret } from '../../src/sessionTokens.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'upgrades');
const WHOLE_INSTALL_FIXTURE = join(FIXTURES, 'whole-install-v1');

test('a complete legacy installation upgrades, restarts, backs up, and restores without data loss', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pictaria-whole-upgrade-'));
  try {
    const sourceRoot = join(workspace, 'source');
    materializeLegacyInstallation(sourceRoot);
    const sourceConfig = fixtureConfig(sourceRoot);

    const first = await openInstallation(sourceConfig, 'initialize');
    assert.deepEqual(first.enrichmentMigration.applied, [1, 2, 3, 4, 5, 6, 7]);
    await assertRepresentativeState(first, sourceConfig);

    const migratedSettings = readFileSync(sourceConfig.settingsPath, 'utf8');
    const firstSnapshot = semanticSnapshot(first);
    closeInstallation(first);

    // A normal restart verifies the new inventory and performs no migration
    // work or duplicate seeding. Current-version settings are not rewritten.
    const second = await openInstallation(sourceConfig, 'verify');
    assert.deepEqual(second.enrichmentMigration.applied, []);
    assert.equal(readFileSync(sourceConfig.settingsPath, 'utf8'), migratedSettings);
    assert.deepEqual(semanticSnapshot(second), firstSnapshot);

    // Back up while every production store is open, just like the live
    // server's scheduled/manual backup path.
    const backup = await runBackup(sourceConfig, {
      now: new Date('2026-08-07T12:34:00Z'),
    });
    assert.equal(backup.complete, true);
    assert.deepEqual(backup.missing, []);
    assert.deepEqual(
      backup.files.map((file) => file.name).sort(),
      [
        ...PROTECTED_PERSISTENT_ROLES,
        ...RECOMPUTABLE_PERSISTENT_ROLES,
        'persistent-state.json',
      ].sort(),
    );
    closeInstallation(second);

    // Restore only the snapshot's semantic roles into a clean volume. The
    // marker is deliberately not backed up; the restored inventory is enough
    // to verify the volume, and seal() recreates the local marker.
    const restoredRoot = join(workspace, 'restored');
    const restoredConfig = fixtureConfig(restoredRoot);
    restoreSnapshot(backup.dir, restoredConfig);
    const restored = await openInstallation(restoredConfig, 'verify');
    assert.deepEqual(restored.enrichmentMigration.applied, []);
    assert.deepEqual(semanticSnapshot(restored), firstSnapshot);
    await assertRepresentativeState(restored, restoredConfig);
    closeInstallation(restored);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function fixtureConfig(root) {
  return loadConfig({
    DATABASE_PATH: join(root, 'enrichment.sqlite'),
    SETTINGS_PATH: join(root, 'settings.json'),
    ALBUMS_DATA_FILE: join(root, 'smart-albums.json'),
    FRAME_DB_PATH: join(root, 'frame.db'),
    INSIGHTS_DB_PATH: join(root, 'insights.sqlite'),
    WAKE_WORD_MODELS_DIR: join(root, 'wake-word-models'),
    BACKUP_DIR_DEFAULT: join(root, 'backups'),
  });
}

function materializeLegacyInstallation(root) {
  mkdirSync(root, { recursive: true });
  cpSync(join(FIXTURES, 'settings-v1-legacy.json'), join(root, 'settings.json'));
  cpSync(join(WHOLE_INSTALL_FIXTURE, 'smart-albums-v1.json'), join(root, 'smart-albums.json'));
  cpSync(join(WHOLE_INSTALL_FIXTURE, 'wake-word-models-v1'), join(root, 'wake-word-models'), { recursive: true });
  createDatabaseFromSql(join(root, 'enrichment.sqlite'), join(WHOLE_INSTALL_FIXTURE, 'enrichment-v0.sql'));
  createDatabaseFromSql(join(root, 'frame.db'), join(WHOLE_INSTALL_FIXTURE, 'frame-v0.sql'));
  createDatabaseFromSql(join(root, 'insights.sqlite'), join(WHOLE_INSTALL_FIXTURE, 'insights-v0.sql'));
}

function createDatabaseFromSql(databasePath, fixturePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(readFileSync(fixturePath, 'utf8'));
  } finally {
    database.close();
  }
}

async function openInstallation(config, expectedMode) {
  const guard = new PersistentStateGuard({
    inventoryPath: config.persistentState.inventoryPath,
    markerPath: config.persistentState.markerPath,
    legacySettingsMarkerPath: config.persistentState.legacySettingsMarkerPath,
    targets: backupTargets(config),
    now: () => new Date('2026-08-07T12:00:00Z'),
  });
  assert.deepEqual(guard.preflight(), { mode: expectedMode, missingRoles: [] });
  await preparePersistentStateUpgrade({
    guard,
    config,
    currentServerVersion: '1.0.0-fixture',
  });

  const settings = new SettingsStore({ filePath: config.settingsPath, config, env: {} }).load();
  const enrichment = new Repository(config.databasePath);
  const enrichmentMigration = enrichment.initSchema();
  const albums = new SmartAlbumStore(config.albums.dataFile, {
    installationSecret: loadOrCreateSessionSecret(config.sessionSecretPath),
  });
  await albums.load();
  const frameLedger = createFrameLedger({ dbPath: config.frame.dbPath, logger: { warn() {} } });
  const voiceMetrics = createVoiceMetrics({ dbPath: config.frame.dbPath, logger: { warn() {} } });
  const wakeWords = new WakeWordModelStore(config.wakeWordModelsDir);
  await wakeWords.load();
  const insights = new InsightsRepository(config.insights.dbPath);
  const inventory = guard.seal({
    successfulStateVersion: PERSISTENT_STATE_VERSION,
    successfulServerVersion: '1.0.0-fixture',
  });

  return {
    settings,
    enrichment,
    enrichmentMigration,
    albums,
    frameLedger,
    voiceMetrics,
    wakeWords,
    insights,
    inventory,
  };
}

function closeInstallation(installation) {
  installation.enrichment.close();
  installation.frameLedger.close();
  installation.voiceMetrics.close();
  installation.insights.close();
}

function semanticSnapshot(installation) {
  const run = installation.enrichment.db
    .prepare("SELECT id, asset_id, status FROM processing_runs WHERE asset_id = 'fixture-asset-1'")
    .get();
  const latest = installation.enrichment.db
    .prepare("SELECT run_id, short_caption, frame_score FROM latest_success WHERE asset_id = 'fixture-asset-1'")
    .get();
  const insight = installation.insights.db
    .prepare("SELECT id, city, country FROM swept_assets WHERE id = 'fixture-asset-1'")
    .get();

  return {
    settingsVersion: JSON.parse(readFileSync(installation.settings.filePath, 'utf8')).version,
    enrichmentVersion: getUserVersion(installation.enrichment.db),
    assetCount: installation.enrichment.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,
    tagCount: installation.enrichment.db.prepare('SELECT COUNT(*) AS n FROM asset_tags').get().n,
    overrideCount: installation.enrichment.db.prepare('SELECT COUNT(*) AS n FROM manual_overrides').get().n,
    syncJobCount: installation.enrichment.db.prepare('SELECT COUNT(*) AS n FROM pending_sync_jobs').get().n,
    run,
    latest,
    display: installation.frameLedger.getDisplayStats(['fixture-asset-1'])['fixture-asset-1'],
    voice: installation.voiceMetrics.summary(),
    insightVersion: getUserVersion(installation.insights.db),
    insight,
    protectedRoles: installation.inventory.protectedRoles,
    recomputableRoles: installation.inventory.recomputableRoles,
  };
}

async function assertRepresentativeState(installation, config) {
  assert.equal(config.immichBaseUrl, 'http://immich.example:2283');
  assert.equal(config.voice.openAiApiKey, 'fixture-openai-key');
  assert.equal(config.voice.askMaxOutputTokens, 750);
  assert.equal(installation.settings.describe().server.openAiApiKey.value, '');

  const run = installation.enrichment.db
    .prepare("SELECT id FROM processing_runs WHERE asset_id = 'fixture-asset-1'")
    .get();
  const latest = installation.enrichment.db
    .prepare("SELECT run_id, short_caption, frame_score FROM latest_success WHERE asset_id = 'fixture-asset-1'")
    .get();
  assert.equal(latest.run_id, run.id);
  assert.equal(latest.short_caption, 'red barn');
  assert.equal(latest.frame_score, 0.82);
  assert.equal(
    installation.enrichment.db.prepare("SELECT source FROM review_list WHERE asset_id = 'fixture-asset-1'").get().source,
    'migration',
  );
  assert.equal(
    installation.enrichment.db.prepare("SELECT dead_at FROM pending_sync_jobs WHERE id = 1").get().dead_at,
    null,
  );
  assert.equal(
    installation.enrichment.db.prepare("SELECT subject_group FROM referee_picks WHERE asset_id = 'fixture-asset-1'").get().subject_group,
    null,
  );

  assert.deepEqual(installation.frameLedger.getDisplayStats(['fixture-asset-1']), {
    'fixture-asset-1': {
      displayCount: 3,
      lastShownAt: '2024-01-03T10:00:00Z',
    },
  });
  assert.equal(installation.voiceMetrics.summary().totalUses, 7);
  assert.deepEqual(installation.voiceMetrics.summary().devices, [{
    deviceId: '',
    uses: 7,
    lastUsedAt: '2024-01-03T10:05:00Z',
  }]);

  const jobs = await installation.albums.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'fixture-album-job');
  assert.equal(jobs[0].albumName, 'Synthetic favorites');
  assert.equal(jobs[0].enabled, false);
  assert.equal(jobs[0].scheduleQuarantined, true);

  const models = await installation.wakeWords.listModels();
  assert.equal(models.length, 1);
  assert.equal(models[0].phrase, 'Hey fixture');
  assert.equal(models[0].available, true);
  const model = await installation.wakeWords.readModel(models[0].id);
  assert.equal(model.bytes.toString('utf8'), 'PICTARIA SYNTHETIC INERT WAKE MODEL FIXTURE\n');

  assert.equal(getUserVersion(installation.insights.db), 1);
  const insight = installation.insights.db
    .prepare("SELECT city, country, day, lat, lon FROM swept_assets WHERE id = 'fixture-asset-1'")
    .get();
  assert.deepEqual({ ...insight }, {
    city: 'Fixture City',
    country: 'Example Country',
    day: null,
    lat: null,
    lon: null,
  });
}

function restoreSnapshot(snapshotDir, restoredConfig) {
  for (const target of backupTargets(restoredConfig)) {
    const source = join(snapshotDir, target.role);
    mkdirSync(dirname(target.path), { recursive: true });
    cpSync(source, target.path, { recursive: target.kind === 'directory' });
  }
  // A restore should not depend on leftover WAL sidecars from the source
  // volume. The online backup outputs are standalone database files.
  for (const target of backupTargets(restoredConfig).filter(({ kind }) => kind === 'sqlite')) {
    for (const suffix of ['-wal', '-shm']) {
      rmSync(`${target.path}${suffix}`, { force: true });
    }
  }
}
