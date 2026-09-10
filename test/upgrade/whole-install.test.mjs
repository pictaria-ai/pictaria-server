import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { SmartAlbumStore } from '../../src/albums/store.mjs';
import { backupTargets, runBackup } from '../../src/backup.mjs';
import { loadConfig } from '../../src/config.mjs';
import { runBatch } from '../../src/enrich/runner.mjs';
import { createProvider } from '../../src/enrich/providers.mjs';
import { captureRunConfiguration } from '../../src/enrich/runConfiguration.mjs';
import { sampleOutput } from '../enrich/helpers.mjs';
import { EnrichmentProfiles } from '../../src/enrich/profiles.mjs';
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
    assert.deepEqual(first.enrichmentMigration.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    await assertRepresentativeState(first, sourceConfig);

    const migratedDefault = first.profiles.activeProfile();
    assert.equal(migratedDefault.systemPrompt, sourceConfig.promptOverrides?.systemPrompt || first.profiles.builtin().systemPrompt);
    const travel = first.profiles.create({ ...migratedDefault, name: 'Fixture travel', systemPrompt: 'Travel fixture prompt' });
    first.enrichment.queueAdd({ title: 'Active profile fixture', filters: { city: 'Fixture City' } });
    first.profiles.update(travel.id, { ...travel, name: 'Renamed travel', expectedRevisionId: travel.revisionId });
    first.profiles.setActive(travel.id);
    const selected = first.profiles.resolve();
    const provider = createProvider('local_lmstudio', { modelName: 'fixture-model', fetchImpl: async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] }) });
    const configuration = captureRunConfiguration({ provider, taxonomy: selected.taxonomy,
      systemPrompt: selected.systemPrompt, userTemplate: selected.userTemplate, profile: selected.attribution });
    await runBatch({ repo: first.enrichment, provider, configuration, assetIds: ['timing-fixture'],
      immich: { getAsset: async id => ({ id }), getAssetThumbnail: async () => ({ data: Buffer.from('fixture'), contentType: 'image/jpeg' }) } });
    const timingRun = first.enrichment.timings.runs().items[0];
    assert.equal(timingRun.configuration_id, configuration.id);
    assert.equal(first.enrichment.configurationProfile(configuration.id).revisionId, selected.revisionId);
    const photo = first.enrichment.timings.photos(timingRun.id).items[0];
    assert.equal(first.enrichment.timings.attempts(photo.id).items[0].outcome, 'accepted');


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


test('contract 10 upgrade snapshots queue pins before clearing them and retains the active choice', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pictaria-profile-upgrade-'));
  try {
    const config = fixtureConfig(join(workspace, 'source'));
    materializeLegacyInstallation(join(workspace, 'source'));
    const preview = await openInstallation(config, 'initialize');
    const initial = preview.profiles.activeProfile();
    const travel = preview.profiles.create({ ...initial, name: 'Travel preview' });
    preview.profiles.setActive(travel.id);
    preview.enrichment.queueAdd({ title: 'Preview photos', filters: { city: 'Fixture City' } });
    preview.enrichment.db.prepare('UPDATE enrich_queue SET profile_revision_id = ?').run(initial.revisionId);
    const before = semanticSnapshot(preview);
    closeInstallation(preview);
    // Contract 10 used the same schema, but persisted a separate default and queue pins.
    const inventory = JSON.parse(readFileSync(config.persistentState.inventoryPath, 'utf8'));
    inventory.upgrade.stateVersion = 10;
    writeFileSync(config.persistentState.inventoryPath, JSON.stringify(inventory));

    const upgraded = await openInstallation(config, 'verify');
    assert.equal(upgraded.inventory.upgrade.stateVersion, 14);
    assert.deepEqual(semanticSnapshot(upgraded), before);
    assert.equal(upgraded.profiles.activeProfile().id, travel.id);
    assert.equal(upgraded.enrichment.db.prepare('SELECT COUNT(*) AS n FROM enrich_queue WHERE profile_revision_id IS NOT NULL').get().n, 0);
    const snapshotDir = join(config.backup.dir, upgraded.inventory.upgrade.recoveryPoint.snapshotName);
    closeInstallation(upgraded);

    // Restoring the pre-upgrade snapshot recovers the exact old queue references
    // and version metadata, so rollback can use the matching older server.
    const restoredConfig = fixtureConfig(join(workspace, 'restored'));
    restoreSnapshot(snapshotDir, restoredConfig);
    const restoredInventory = JSON.parse(readFileSync(restoredConfig.persistentState.inventoryPath, 'utf8'));
    assert.equal(restoredInventory.upgrade.stateVersion, 10);
    const restoredDb = new DatabaseSync(restoredConfig.databasePath);
    try {
      const pins = restoredDb.prepare('SELECT profile_revision_id FROM enrich_queue').all();
      assert.ok(pins.length > 0);
      assert.ok(pins.every(row => row.profile_revision_id === initial.revisionId));
      assert.equal(restoredDb.prepare('SELECT id FROM enrich_profiles WHERE is_default = 1').get().id, travel.id);
    } finally { restoredDb.close(); }
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

test('contract 13 upgrade snapshots version 6 settings and history before adopting retention settings', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pictaria-retention-recovery-'));
  try {
    const root = join(workspace, 'source'); materializeLegacyInstallation(root);
    const config = fixtureConfig(root);
    const installed = await openInstallation(config, 'initialize');
    installed.enrichment.recordJobRun({ title: 'Retained before upgrade', provider: 'venice', status: 'finished',
      log: ['Original log'], startedAt: '2026-09-01', finishedAt: '2026-09-01' });
    closeInstallation(installed);
    const settings = JSON.parse(readFileSync(config.settingsPath, 'utf8'));
    settings.version = 6; writeFileSync(config.settingsPath, JSON.stringify(settings));
    const inventory = JSON.parse(readFileSync(config.persistentState.inventoryPath, 'utf8'));
    inventory.upgrade.stateVersion = 13; writeFileSync(config.persistentState.inventoryPath, JSON.stringify(inventory));
    const upgraded = await openInstallation(config, 'verify');
    assert.equal(upgraded.inventory.upgrade.stateVersion, 14);
    assert.equal(JSON.parse(readFileSync(config.settingsPath, 'utf8')).version, 7);
    assert.equal(config.enrichHistoryRuns, 100); assert.equal(config.enrichHistoryLogs, 100);
    const snapshotDir = join(config.backup.dir, upgraded.inventory.upgrade.recoveryPoint.snapshotName);
    assert.equal(JSON.parse(readFileSync(join(snapshotDir, 'settings.json'), 'utf8')).version, 6);
    assert.equal(upgraded.enrichment.listJobRuns()[0].title, 'Retained before upgrade');
    closeInstallation(upgraded);
    const restoredConfig = fixtureConfig(join(workspace, 'restored')); restoreSnapshot(snapshotDir, restoredConfig);
    assert.equal(JSON.parse(readFileSync(restoredConfig.settingsPath, 'utf8')).version, 6);
    assert.equal(JSON.parse(readFileSync(restoredConfig.persistentState.inventoryPath, 'utf8')).upgrade.stateVersion, 13);
    const restored = new Repository(restoredConfig.databasePath);
    try { assert.equal(restored.getJobRunLog(restored.listJobRuns()[0].id).log[0], 'Original log'); } finally { restored.close(); }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('contract 12 upgrade saves schema-10 history before introducing discovery', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pictaria-discovery-recovery-'));
  try {
    const config = fixtureConfig(join(workspace, 'source')); materializeLegacyInstallation(join(workspace, 'source'));
    const installed = await openInstallation(config, 'initialize');
    installed.enrichment.db.exec(`DROP TABLE enrich_inventory; DROP TABLE enrich_inventory_stage; DROP TABLE enrich_discovery;
      PRAGMA user_version = 10;
      INSERT INTO job_runs(title,provider,status,started_at,finished_at) VALUES('Before discovery','venice','finished','2026-09-01','2026-09-01');`);
    closeInstallation(installed);
    const inventory = JSON.parse(readFileSync(config.persistentState.inventoryPath, 'utf8'));
    inventory.upgrade.stateVersion = 12; writeFileSync(config.persistentState.inventoryPath, JSON.stringify(inventory));
    const upgraded = await openInstallation(config, 'verify');
    assert.deepEqual(upgraded.enrichmentMigration.applied, [11]);
    assert.equal(upgraded.enrichment.listJobRuns()[0].title, 'Before discovery');
    assert.equal(upgraded.enrichment.db.prepare('SELECT COUNT(*) n FROM enrich_inventory').get().n, 0);
    const snapshotPath = join(config.backup.dir, upgraded.inventory.upgrade.recoveryPoint.snapshotName, 'enrichment.sqlite');
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    assert.equal(getUserVersion(snapshot), 10);
    assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='enrich_inventory'").get(), undefined);
    assert.equal(snapshot.prepare('SELECT title FROM job_runs ORDER BY id DESC LIMIT 1').get().title, 'Before discovery');
    snapshot.close(); closeInstallation(upgraded);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('contract 11 upgrade saves a schema-9 recovery point before introducing timings', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'pictaria-timing-recovery-'));
  try {
    const sourceRoot = join(workspace, 'source'); materializeLegacyInstallation(sourceRoot);
    const config = fixtureConfig(sourceRoot);
    const installed = await openInstallation(config, 'initialize'); closeInstallation(installed);
    // The fixture is the exact schema from the approved PIC-340 merge.
    rmSync(config.databasePath);
    const old = new DatabaseSync(config.databasePath);
    old.exec(readFileSync(join(FIXTURES, 'enrichment-v9.sql'), 'utf8'));
    old.exec("PRAGMA user_version = 9; INSERT INTO job_runs(title, provider, status, started_at, finished_at) VALUES ('Before timing', 'venice', 'finished', '2026-09-01', '2026-09-01');");
    old.close();
    const inventory = JSON.parse(readFileSync(config.persistentState.inventoryPath, 'utf8'));
    inventory.upgrade.stateVersion = 11; writeFileSync(config.persistentState.inventoryPath, JSON.stringify(inventory));
    const upgraded = await openInstallation(config, 'verify');
    assert.deepEqual(upgraded.enrichmentMigration.applied, [10, 11]);
    assert.equal(upgraded.enrichment.listJobRuns()[0].timingRunId, null);
    const snapshotDir = join(config.backup.dir, upgraded.inventory.upgrade.recoveryPoint.snapshotName);
    closeInstallation(upgraded);
    const restoredConfig = fixtureConfig(join(workspace, 'restored')); restoreSnapshot(snapshotDir, restoredConfig);
    assert.equal(JSON.parse(readFileSync(restoredConfig.persistentState.inventoryPath, 'utf8')).upgrade.stateVersion, 11);
    const restored = new DatabaseSync(restoredConfig.databasePath);
    try {
      assert.equal(getUserVersion(restored), 9);
      assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'enrich_timing_runs'").get().n, 0);
      assert.equal(restored.prepare('SELECT title FROM job_runs').get().title, 'Before timing');
    } finally { restored.close(); }
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

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
  enrichment.timings.interrupt();
  enrichment.setHistoryRetention({ runs: config.enrichHistoryRuns, logs: config.enrichHistoryLogs });
  const profiles = new EnrichmentProfiles({ repo: enrichment, config });
  profiles.initialize();
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
    profiles,
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
    timingRuns: installation.enrichment.db.prepare('SELECT * FROM enrich_timing_runs ORDER BY id').all(),
    photoTimings: installation.enrichment.db.prepare('SELECT * FROM enrich_photo_executions ORDER BY id').all(),
    providerAttempts: installation.enrichment.db.prepare('SELECT * FROM enrich_provider_attempts ORDER BY id').all(),
    profiles: installation.profiles.list(),
    profileRevisions: installation.enrichment.db.prepare('SELECT * FROM enrich_profile_revisions ORDER BY id').all(),
    queue: installation.enrichment.queuePage().items,
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
