import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { runBackup } from '../src/backup.mjs';
import {
  MAX_PERSISTENT_STATE_BYTES,
  PERSISTENT_STATE_ROLE,
  PROTECTED_PERSISTENT_ROLES,
  PersistentStateError,
  PersistentStateGuard,
  RECOMPUTABLE_PERSISTENT_ROLES,
  validatePersistentStateInventory,
  validateSqlitePersistentState,
} from '../src/persistentState.mjs';
import { validateWakeWordPersistentState } from '../src/wakeword/store.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-persistent-state-'));
  const inventoryPath = join(dir, 'persistent-state.json');
  const markerPath = `${inventoryPath}.initialized`;
  const targets = [
    {
      role: 'enrichment.sqlite',
      path: join(dir, 'enrichment.sqlite'),
      kind: 'sqlite',
      validate: (path) => validateSqlitePersistentState(path, ['assets', 'processing_runs', 'asset_tags']),
    },
    { role: 'settings.json', path: join(dir, 'settings.json'), kind: 'file' },
    { role: 'smart-albums.json', path: join(dir, 'smart-albums.json'), kind: 'file' },
    {
      role: 'frame.db',
      path: join(dir, 'frame.db'),
      kind: 'sqlite',
      validate: (path) => validateSqlitePersistentState(path, ['asset_displays', 'voice_command_stats']),
    },
    {
      role: 'insights.sqlite',
      path: join(dir, 'insights.sqlite'),
      kind: 'sqlite',
      validate: validateSqlitePersistentState,
    },
    {
      role: 'wake-word-models',
      path: join(dir, 'wake-word-models'),
      kind: 'directory',
      failureMode: 'degrade',
      validate: validateWakeWordPersistentState,
    },
    {
      role: PERSISTENT_STATE_ROLE,
      path: inventoryPath,
      kind: 'file',
      validate: validatePersistentStateInventory,
    },
  ];
  const targetByRole = new Map(targets.map((target) => [target.role, target]));

  function createTarget(role) {
    const target = targetByRole.get(role);
    if (target.kind === 'directory') {
      mkdirSync(join(target.path, 'models'), { recursive: true });
      writeFileSync(join(target.path, 'registry.json'), '{"version":1,"models":[]}\n', { mode: 0o600 });
    } else if (target.kind === 'sqlite') {
      const database = new DatabaseSync(target.path);
      if (role === 'enrichment.sqlite') {
        database.exec('CREATE TABLE assets (id); CREATE TABLE processing_runs (id); CREATE TABLE asset_tags (id)');
      } else if (role === 'frame.db') {
        database.exec('CREATE TABLE asset_displays (id); CREATE TABLE voice_command_stats (id)');
      } else if (role === 'insights.sqlite') {
        database.exec('CREATE TABLE swept_assets (id)');
      }
      database.close();
    } else {
      writeFileSync(target.path, `${role}\n`, { mode: 0o600 });
    }
  }

  function createAllState() {
    for (const role of [...PROTECTED_PERSISTENT_ROLES, ...RECOMPUTABLE_PERSISTENT_ROLES]) {
      createTarget(role);
    }
  }

  function guard(now = () => new Date('2026-08-06T01:00:00Z')) {
    return new PersistentStateGuard({
      inventoryPath,
      markerPath,
      legacySettingsMarkerPath: join(dir, 'settings.json.initialized'),
      targets,
      now,
    });
  }

  const backupConfig = {
    backup: { dir: join(dir, 'backups'), keep: 2, dirIsCustom: false },
  };

  return {
    dir,
    inventoryPath,
    markerPath,
    targets,
    targetByRole,
    backupConfig,
    createTarget,
    createAllState,
    guard,
  };
}

test('unsafe custom wake-word storage degrades without blessing or replacing it', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const initial = state.guard();
    initial.preflight();
    initial.seal();

    const wakeWords = state.targetByRole.get('wake-word-models');
    const originalModels = join(wakeWords.path, 'models-original');
    const outside = join(state.dir, 'outside-models');
    mkdirSync(outside);
    renameSync(join(wakeWords.path, 'models'), originalModels);
    symlinkSync(outside, join(wakeWords.path, 'models'));

    const restart = state.guard();
    assert.deepEqual(restart.preflight(), {
      mode: 'verify',
      missingRoles: [],
      degradedRoles: ['wake-word-models'],
    });
    assert.doesNotThrow(() => restart.seal());
    assert.equal(existsSync(join(outside, 'registry.json')), false);

    const backup = await runBackup(state.backupConfig, {
      targets: state.targets,
      now: new Date('2026-08-06T01:05:00Z'),
    });
    assert.equal(backup.complete, false);
    assert.deepEqual(backup.missing.map((entry) => entry.name), ['wake-word-models']);
  } finally {
    removeFixture(state);
  }
});

function removeFixture(state) {
  rmSync(state.dir, { recursive: true, force: true });
}

function writeRecordedWakeModel(state, contents = 'test') {
  const wakeWords = state.targetByRole.get('wake-word-models');
  const id = '12345678-1234-4123-8123-123456789abc';
  const bytes = Buffer.from(contents);
  const modelPath = join(wakeWords.path, 'models', `${id}.tflite`);
  writeFileSync(modelPath, bytes, { mode: 0o600 });
  writeFileSync(join(wakeWords.path, 'registry.json'), `${JSON.stringify({
    version: 1,
    models: [{
      id,
      displayName: 'Test phrase',
      phrase: 'Hey test',
      defaultThreshold: 0.5,
      originalFilename: 'test.tflite',
      byteSize: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      createdAt: '2026-08-06T01:00:00Z',
      updatedAt: '2026-08-06T01:00:00Z',
      rightsConfirmedAt: '2026-08-06T01:00:00Z',
      embeddingDimension: 96,
      featureStack: 'pictaria-openwakeword-v1',
      inputFrames: 16,
      inputShape: [1, 16, 96],
      outputShape: [1, 1],
      runtime: 'tflite',
      schemaVersion: 1,
    }],
  }, null, 2)}\n`, { mode: 0o600 });
  return { id, modelPath };
}

test('a fresh installation seals a private inventory only after every target exists', () => {
  const state = fixture();
  try {
    const guard = state.guard();
    assert.deepEqual(guard.preflight(), { mode: 'initialize', missingRoles: [] });
    assert.throws(
      () => guard.seal(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_initialization_incomplete',
    );

    state.createAllState();
    const inventory = guard.seal();

    assert.equal(statSync(state.inventoryPath).mode & 0o777, 0o600);
    assert.equal(statSync(state.markerPath).mode & 0o777, 0o600);
    assert.deepEqual(inventory.protectedRoles, PROTECTED_PERSISTENT_ROLES);
    assert.deepEqual(inventory.recomputableRoles, RECOMPUTABLE_PERSISTENT_ROLES);
    assert.equal(inventory.initializedAt, '2026-08-06T01:00:00.000Z');
    assert.deepEqual(JSON.parse(readFileSync(state.inventoryPath, 'utf8')), inventory);

    assert.deepEqual(state.guard().preflight(), { mode: 'verify', missingRoles: [] });
  } finally {
    removeFixture(state);
  }
});

for (const role of PROTECTED_PERSISTENT_ROLES) {
  test(`restart and backup preserve missing protected state: ${role}`, async () => {
    const state = fixture();
    try {
      state.createAllState();
      const firstBoot = state.guard();
      firstBoot.preflight();
      firstBoot.seal();

      const target = state.targetByRole.get(role);
      rmSync(target.path, { recursive: true, force: true });

      assert.throws(
        () => state.guard().preflight(),
        (error) => error instanceof PersistentStateError
          && error.code === 'persistent_state_missing'
          && error.missingRoles.length === 1
          && error.missingRoles[0] === role
          && /refused to recreate empty state/.test(error.message),
      );
      assert.equal(existsSync(target.path), false);

      const backup = await runBackup(state.backupConfig, {
        now: new Date('2026-08-06T02:00:00Z'),
        targets: state.targets,
      });
      assert.equal(backup.complete, false);
      assert.deepEqual(backup.missing.map((entry) => entry.name), [role]);
    } finally {
      removeFixture(state);
    }
  });
}

test('missing Insights state remains explicitly recomputable', () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    const insights = state.targetByRole.get('insights.sqlite').path;
    rmSync(insights);
    const restart = state.guard();
    assert.deepEqual(restart.preflight(), { mode: 'verify', missingRoles: [] });

    state.createTarget('insights.sqlite');
    restart.seal();
  } finally {
    removeFixture(state);
  }
});

for (const role of ['enrichment.sqlite', 'frame.db', 'insights.sqlite']) {
  for (const suffix of ['', '-wal', '-shm']) {
    const position = suffix || 'final entry';
    test(`startup rejects restored ${role} ${position} symlinks before touching the target`, () => {
      const state = fixture();
      try {
        state.createAllState();
        const firstBoot = state.guard();
        firstBoot.preflight();
        firstBoot.seal();

        const databasePath = state.targetByRole.get(role).path;
        const outside = join(state.dir, `outside-${role}-${suffix || 'main'}`);
        writeFileSync(outside, 'untouched', { mode: 0o640 });
        chmodSync(outside, 0o640);
        const outsideMode = statSync(outside).mode & 0o777;
        if (suffix) {
          symlinkSync(outside, `${databasePath}${suffix}`);
        } else {
          rmSync(databasePath);
          symlinkSync(outside, databasePath);
        }

        assert.throws(
          () => state.guard().preflight(),
          (error) => error instanceof PersistentStateError
            && error.code === 'persistent_state_missing'
            && error.missingRoles[0] === role
            && /Unsafe SQLite path/.test(error.message),
        );
        assert.equal(readFileSync(outside, 'utf8'), 'untouched');
        assert.equal(statSync(outside).mode & 0o777, outsideMode);
        assert.equal(lstatSync(`${databasePath}${suffix}`).isSymbolicLink(), true);
      } finally {
        removeFixture(state);
      }
    });
  }
}

test('a legacy settings marker blocks silent loss during the one-time inventory migration', () => {
  const state = fixture();
  try {
    state.createAllState();
    const legacyMarker = join(state.dir, 'settings.json.initialized');
    writeFileSync(legacyMarker, 'legacy marker\n', { mode: 0o600 });
    rmSync(state.targetByRole.get('settings.json').path);

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_legacy_settings_missing'
        && error.missingRoles[0] === 'settings.json',
    );
    assert.equal(existsSync(state.targetByRole.get('settings.json').path), false);

    state.createTarget('settings.json');
    const restored = state.guard();
    assert.deepEqual(restored.preflight(), { mode: 'initialize', missingRoles: [] });
    restored.seal();
    assert.equal(existsSync(legacyMarker), false, 'successful global seal retires the old marker');
    assert.deepEqual(state.guard().preflight(), { mode: 'verify', missingRoles: [] });
  } finally {
    removeFixture(state);
  }
});

for (const role of ['enrichment.sqlite', 'frame.db']) {
  test(`truncated protected SQLite state is rejected before initialization: ${role}`, async () => {
    const state = fixture();
    try {
      state.createAllState();
      const firstBoot = state.guard();
      firstBoot.preflight();
      firstBoot.seal();

      const target = state.targetByRole.get(role);
      writeFileSync(target.path, '');
      assert.throws(
        () => state.guard().preflight(),
        (error) => error instanceof PersistentStateError
          && error.code === 'persistent_state_missing'
          && error.missingRoles[0] === role
          && /persistent state is unusable/.test(error.message)
          && /SQLite file is empty/.test(error.message)
          && /docs\/BACKUP\.md/.test(error.message)
          && /ordinary file copies rather than symbolic or hard links/.test(error.message)
          && /left the existing state unchanged/.test(error.message)
          && !/persistent state is missing/.test(error.message),
      );
      const backup = await runBackup(state.backupConfig, {
        now: new Date('2026-08-06T02:00:00Z'),
        targets: state.targets,
      });
      assert.equal(backup.complete, false);
      assert.deepEqual(backup.missing.map((entry) => entry.name), [role]);
    } finally {
      removeFixture(state);
    }
  });
}

test('present but unsafe protected state gives repair guidance rather than missing-state guidance', () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    state.targetByRole.get('enrichment.sqlite').validate = () => ({
      valid: false,
      reason: 'entry has multiple hard links',
    });

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_missing'
        && error.missingRoles[0] === 'enrichment.sqlite'
        && /persistent state is unusable/.test(error.message)
        && /entry has multiple hard links/.test(error.message)
        && /docs\/BACKUP\.md/.test(error.message)
        && /ordinary file copies rather than symbolic or hard links/.test(error.message)
        && /left the existing state unchanged/.test(error.message)
        && !/persistent state is missing/.test(error.message),
    );
  } finally {
    removeFixture(state);
  }
});

test('readable SQLite state without the stable Pictaria schema is rejected', () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    const target = state.targetByRole.get('enrichment.sqlite');
    rmSync(target.path);
    const unrelatedDatabase = new DatabaseSync(target.path);
    unrelatedDatabase.exec('CREATE TABLE unrelated (id)');
    unrelatedDatabase.close();

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_missing'
        && error.missingRoles[0] === 'enrichment.sqlite'
        && /SQLite schema is missing: assets, processing_runs, asset_tags/.test(error.message),
    );
  } finally {
    removeFixture(state);
  }
});

test('a malformed persistent-state inventory makes the backup incomplete', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();
    writeFileSync(state.inventoryPath, '{truncated');

    const backup = await runBackup(state.backupConfig, {
      now: new Date('2026-08-06T02:00:00Z'),
      targets: state.targets,
    });
    assert.equal(backup.complete, false);
    assert.deepEqual(backup.missing.map((entry) => entry.name), [PERSISTENT_STATE_ROLE]);
    assert.equal(existsSync(join(backup.dir, PERSISTENT_STATE_ROLE)), false);
  } finally {
    removeFixture(state);
  }
});

test('an oversized persistent-state inventory fails before JSON parsing or backup copy', async () => {
  const state = fixture();
  try {
    state.createAllState();
    writeFileSync(state.inventoryPath, Buffer.alloc(MAX_PERSISTENT_STATE_BYTES + 1, 0x20));

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_inventory_unreadable'
        && /byte limit/.test(error.message),
    );
    assert.equal(validatePersistentStateInventory(state.inventoryPath).valid, false);
  } finally {
    removeFixture(state);
  }
});

test('a versioned inventory cannot omit a protected role', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    const inventory = JSON.parse(readFileSync(state.inventoryPath, 'utf8'));
    inventory.protectedRoles = inventory.protectedRoles.filter((role) => role !== 'settings.json');
    writeFileSync(state.inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
    rmSync(state.targetByRole.get('settings.json').path);

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_inventory_invalid',
    );
    const backup = await runBackup(state.backupConfig, {
      now: new Date('2026-08-06T02:00:00Z'),
      targets: state.targets,
    });
    assert.equal(backup.complete, false);
    assert.deepEqual(
      backup.missing.map((entry) => entry.name).sort(),
      [PERSISTENT_STATE_ROLE, 'settings.json'],
    );
  } finally {
    removeFixture(state);
  }
});

test('a surviving wake-word directory cannot hide a deleted registry', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    const wakeWords = state.targetByRole.get('wake-word-models');
    rmSync(join(wakeWords.path, 'registry.json'));

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_missing'
        && error.missingRoles[0] === 'wake-word-models'
        && /registry\.json/.test(error.message),
    );
    const backup = await runBackup(state.backupConfig, {
      now: new Date('2026-08-06T02:00:00Z'),
      targets: state.targets,
    });
    assert.equal(backup.complete, false);
    assert.deepEqual(backup.missing.map((entry) => entry.name), ['wake-word-models']);
  } finally {
    removeFixture(state);
  }
});

test('a registry cannot hide a deleted recorded wake-word model file', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const { modelPath } = writeRecordedWakeModel(state);

    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();
    rmSync(modelPath);

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.missingRoles[0] === 'wake-word-models'
        && /recorded model file is missing/.test(error.message),
    );
    const backup = await runBackup(state.backupConfig, {
      now: new Date('2026-08-06T02:00:00Z'),
      targets: state.targets,
    });
    assert.equal(backup.complete, false);
  } finally {
    removeFixture(state);
  }
});

test('same-length corruption of a recorded wake-word model fails startup and backup', async () => {
  const state = fixture();
  try {
    state.createAllState();
    const { modelPath } = writeRecordedWakeModel(state, 'test');
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();

    writeFileSync(modelPath, 'best', { mode: 0o600 });
    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.missingRoles[0] === 'wake-word-models'
        && /SHA-256 integrity check/.test(error.message),
    );
    const backup = await runBackup(state.backupConfig, {
      now: new Date('2026-08-06T02:00:00Z'),
      targets: state.targets,
    });
    assert.equal(backup.complete, false);
    assert.deepEqual(backup.missing.map((entry) => entry.name), ['wake-word-models']);
  } finally {
    removeFixture(state);
  }
});

test('a missing inventory after initialization fails closed', () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();
    rmSync(state.inventoryPath);

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_inventory_missing'
        && error.missingRoles[0] === PERSISTENT_STATE_ROLE,
    );
    assert.equal(existsSync(state.inventoryPath), false);
  } finally {
    removeFixture(state);
  }
});

test('a restored inventory on a fresh volume verifies state and recreates only its marker', () => {
  const state = fixture();
  try {
    state.createAllState();
    const firstBoot = state.guard();
    firstBoot.preflight();
    firstBoot.seal();
    const originalInventory = readFileSync(state.inventoryPath, 'utf8');
    rmSync(state.markerPath);

    const restored = state.guard(() => new Date('2027-01-01T00:00:00Z'));
    assert.deepEqual(restored.preflight(), { mode: 'verify', missingRoles: [] });
    restored.seal();

    assert.equal(readFileSync(state.inventoryPath, 'utf8'), originalInventory);
    assert.equal(existsSync(state.markerPath), true);
  } finally {
    removeFixture(state);
  }
});

test('a corrupt inventory never falls back to fresh initialization', () => {
  const state = fixture();
  try {
    state.createAllState();
    writeFileSync(state.inventoryPath, '{not json');

    assert.throws(
      () => state.guard().preflight(),
      (error) => error instanceof PersistentStateError
        && error.code === 'persistent_state_inventory_unreadable',
    );
  } finally {
    removeFixture(state);
  }
});
