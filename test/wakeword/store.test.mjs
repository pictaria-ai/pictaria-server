import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectWakeWordModel } from '../../src/wakeword/modelInspector.mjs';
import { MAX_WAKE_WORD_MODEL_BYTES } from '../../src/routes/wakeword.mjs';
import {
  MAX_RESTORED_WAKE_WORD_MODELS,
  MAX_RESTORED_WAKE_WORD_MODEL_BYTES,
  MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES,
  MAX_WAKE_WORD_REGISTRY_BYTES,
  MAX_WAKE_WORD_MODELS,
  MAX_WAKE_WORD_MODEL_TOTAL_BYTES,
  WakeWordModelStore,
  WakeWordModelStoreError,
  validateWakeWordPersistentState,
} from '../../src/wakeword/store.mjs';
import { makeWakeWordModelFixture } from './modelFixture.mjs';

async function withStore(work, options) {
  const dir = await mkdtemp(join(tmpdir(), 'pictaria-wakeword-store-'));
  try {
    return await work(new WakeWordModelStore(dir, options), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function upload(bytes = makeWakeWordModelFixture()) {
  return {
    bytes,
    defaultThreshold: 0.52,
    displayName: 'Kitchen phrase',
    inspection: inspectWakeWordModel(bytes),
    originalFilename: 'kitchen.tflite',
    phrase: 'Hey kitchen',
  };
}

function restoredRecord(index, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    displayName: `Restored ${index}`,
    phrase: `Hey restored ${index}`,
    originalFilename: `restored-${index}.tflite`,
    sha256: index.toString(16).padStart(64, '0'),
    createdAt: '2026-07-09T00:00:00.000Z',
    updatedAt: '2026-07-09T00:00:00.000Z',
    rightsConfirmedAt: '2026-07-09T00:00:00.000Z',
    featureStack: 'pictaria-openwakeword-v1',
    runtime: 'openwakeword',
    defaultThreshold: 0.5,
    byteSize: 1,
    inputFrames: 16,
    embeddingDimension: 96,
    inputShape: [1, 16, 96],
    outputShape: [1, 1],
    ...overrides,
  };
}

test('add, list, reload, read, and delete preserve immutable model metadata and bytes', async () => {
  await withStore(async (store, dir) => {
    const bytes = makeWakeWordModelFixture();
    const added = await store.addModel(upload(bytes));
    assert.match(added.id, /^[0-9a-f-]{36}$/);
    assert.equal(added.sha256, createHash('sha256').update(bytes).digest('hex'));

    const listed = await store.listModels();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].available, true);
    assert.equal(listed[0].phrase, 'Hey kitchen');

    const reloaded = new WakeWordModelStore(dir);
    assert.equal((await reloaded.listModels())[0].id, added.id);
    assert.deepEqual((await reloaded.readModel(added.id)).bytes, bytes);
    assert.equal(await reloaded.deleteModel(added.id), true);
    assert.equal(await reloaded.deleteModel(added.id), false);
    assert.deepEqual(await reloaded.listModels(), []);
  });
});

test('duplicate bytes are rejected and concurrent uploads serialize without losing state', async () => {
  await withStore(async (store) => {
    const first = makeWakeWordModelFixture();
    const second = Buffer.from(first);
    second.writeUInt32LE(17, 296);
    const [one, two] = await Promise.all([
      store.addModel(upload(first)),
      store.addModel({ ...upload(second), displayName: 'Second phrase', phrase: 'Hey second' }),
    ]);
    assert.equal((await store.listModels()).length, 2);
    assert.notEqual(one.id, two.id);
    await assert.rejects(
      store.addModel(upload(first)),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'duplicate_wake_word_model',
    );
  });
});

test('count and byte quotas reject uploads before creating another model file', async () => {
  const first = makeWakeWordModelFixture();
  const second = Buffer.from(first);
  second.writeUInt32LE(17, 296);

  await withStore(async (store, dir) => {
    await store.addModel(upload(first));
    const filesBefore = await readdir(join(dir, 'models'));
    await assert.rejects(
      store.addModel({ ...upload(second), displayName: 'Second phrase', phrase: 'Hey second' }),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'wake_word_model_quota_exceeded',
    );
    assert.deepEqual(await readdir(join(dir, 'models')), filesBefore);
    assert.equal((await store.listModels()).length, 1);
  }, { maxModels: 1, maxTotalBytes: first.byteLength * 2 });

  await withStore(async (store, dir) => {
    await store.addModel(upload(first));
    const filesBefore = await readdir(join(dir, 'models'));
    await assert.rejects(
      store.addModel({ ...upload(second), displayName: 'Second phrase', phrase: 'Hey second' }),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'wake_word_model_quota_exceeded',
    );
    assert.deepEqual(await readdir(join(dir, 'models')), filesBefore);
  }, { maxModels: 2, maxTotalBytes: first.byteLength + second.byteLength - 1 });
});

test('upload metadata must satisfy the restored-state contract before a model file is created', async () => {
  await withStore(async (store, dir) => {
    const candidate = upload();
    candidate.inspection.outputShape = Array(17).fill(1);
    await assert.rejects(store.addModel(candidate), /invalid model dimensions/);
    assert.deepEqual(await readdir(join(dir, 'models')), []);
    assert.deepEqual(await store.listModels(), []);
  });
});

test('direct store callers cannot create state outside the absolute restore envelope', async () => {
  const candidate = upload();
  candidate.bytes = Buffer.alloc(MAX_RESTORED_WAKE_WORD_MODEL_BYTES + 1);
  await withStore(async (store, dir) => {
    await assert.rejects(store.addModel(candidate), /5 MiB restore limit/);
    assert.deepEqual(await readdir(join(dir, 'models')), []);
    assert.deepEqual(await store.listModels(), []);
  }, {
    maxModels: MAX_RESTORED_WAKE_WORD_MODELS + 1,
    maxTotalBytes: candidate.bytes.byteLength * 2,
  });
});

test('concurrent uploads cannot race past the aggregate quota', async () => {
  const first = makeWakeWordModelFixture();
  const second = Buffer.from(first);
  second.writeUInt32LE(17, 296);

  await withStore(async (store) => {
    const results = await Promise.allSettled([
      store.addModel(upload(first)),
      store.addModel({ ...upload(second), displayName: 'Second phrase', phrase: 'Hey second' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const [rejected] = results.filter((result) => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'wake_word_model_quota_exceeded');
    assert.equal((await store.listModels()).length, 1);
  }, { maxModels: 1, maxTotalBytes: first.byteLength * 2 });
});

test('models above a later lower quota remain readable and deletable, and deletion frees space', async () => {
  await withStore(async (store, dir) => {
    const first = makeWakeWordModelFixture();
    const second = Buffer.from(first);
    second.writeUInt32LE(17, 296);
    const firstModel = await store.addModel(upload(first));
    const secondModel = await store.addModel({ ...upload(second), displayName: 'Second phrase', phrase: 'Hey second' });

    const lowered = new WakeWordModelStore(dir, { maxModels: 1, maxTotalBytes: first.byteLength });
    assert.deepEqual((await lowered.readModel(firstModel.id)).bytes, first);
    assert.deepEqual((await lowered.readModel(secondModel.id)).bytes, second);
    assert.equal(await lowered.deleteModel(firstModel.id), true);
    assert.equal(await lowered.deleteModel(secondModel.id), true);

    const replacement = Buffer.from(first);
    replacement.writeUInt32LE(23, 296);
    await lowered.addModel({ ...upload(replacement), displayName: 'Replacement', phrase: 'Hey replacement' });
    assert.equal((await lowered.listModels()).length, 1);
  }, { maxModels: 2, maxTotalBytes: MAX_WAKE_WORD_MODEL_TOTAL_BYTES });
});

test('production wake-word quotas stay within the immutable restore envelope', () => {
  assert.equal(MAX_WAKE_WORD_MODELS, 20);
  assert.equal(MAX_WAKE_WORD_MODEL_TOTAL_BYTES, 50 * 1024 * 1024);
  assert.ok(MAX_WAKE_WORD_MODEL_BYTES <= MAX_RESTORED_WAKE_WORD_MODEL_BYTES);
  assert.ok(MAX_WAKE_WORD_MODELS <= MAX_RESTORED_WAKE_WORD_MODELS);
  assert.ok(MAX_WAKE_WORD_MODEL_TOTAL_BYTES <= MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES);
});

test('restored wake-word registries are byte-bounded before normalization', async () => {
  await withStore(async (_store, dir) => {
    await mkdir(join(dir, 'models'));
    await writeFile(join(dir, 'registry.json'), Buffer.alloc(MAX_WAKE_WORD_REGISTRY_BYTES + 1, 0x20));

    const validation = validateWakeWordPersistentState(dir);
    assert.equal(validation.valid, false);
    assert.match(validation.reason, /byte limit/);
    await assert.rejects(
      new WakeWordModelStore(dir).load(),
      (error) => error instanceof WakeWordModelStoreError
        && error.code === 'wake_word_registry_unreadable'
        && /byte limit/.test(error.message),
    );
  });
});

test('restored wake-word registries enforce a fixed compatibility envelope before opening models', async () => {
  await withStore(async (_store, dir) => {
    await mkdir(join(dir, 'models'));
    const writeRegistry = async (models) => {
      await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 1, models }));
      return validateWakeWordPersistentState(dir);
    };

    assert.equal(MAX_RESTORED_WAKE_WORD_MODELS, 100);
    assert.equal(MAX_RESTORED_WAKE_WORD_MODEL_BYTES, 5 * 1024 * 1024);
    assert.equal(MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES, 50 * 1024 * 1024);

    const atCountLimit = Array.from(
      { length: MAX_RESTORED_WAKE_WORD_MODELS },
      (_, index) => restoredRecord(index + 1),
    );
    assert.match((await writeRegistry(atCountLimit)).reason, /recorded model file is missing/);
    assert.match(
      (await writeRegistry([...atCountLimit, restoredRecord(MAX_RESTORED_WAKE_WORD_MODELS + 1)])).reason,
      /100-model restore limit/,
    );

    assert.match(
      (await writeRegistry([restoredRecord(1, { byteSize: MAX_RESTORED_WAKE_WORD_MODEL_BYTES })])).reason,
      /recorded model file is missing/,
    );
    assert.match(
      (await writeRegistry([restoredRecord(1, { byteSize: MAX_RESTORED_WAKE_WORD_MODEL_BYTES + 1 })])).reason,
      /5 MiB restore limit/,
    );

    const atAggregateLimit = Array.from(
      { length: 10 },
      (_, index) => restoredRecord(index + 1, { byteSize: MAX_RESTORED_WAKE_WORD_MODEL_BYTES }),
    );
    assert.match((await writeRegistry(atAggregateLimit)).reason, /recorded model file is missing/);
    assert.match(
      (await writeRegistry([...atAggregateLimit, restoredRecord(11)])).reason,
      /50 MiB restore limit/,
    );
  });
});

test('restored wake-word registries reject duplicate identity and unbounded metadata shapes', async () => {
  await withStore(async (_store, dir) => {
    await mkdir(join(dir, 'models'));
    const validate = async (models) => {
      await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 1, models }));
      return validateWakeWordPersistentState(dir);
    };
    const first = restoredRecord(1);

    assert.match((await validate([first, { ...restoredRecord(2), id: first.id }])).reason, /duplicate/);
    assert.match((await validate([first, { ...restoredRecord(2), sha256: first.sha256 }])).reason, /duplicate/);
    const uppercase = restoredRecord(10);
    uppercase.id = uppercase.id.toUpperCase();
    uppercase.sha256 = uppercase.sha256.toUpperCase();
    assert.match((await validate([uppercase])).reason, /recorded model file is missing/);
    assert.match(
      (await validate([{ ...first, displayName: 'x'.repeat(1025) }])).reason,
      /oversized model metadata/,
    );
    assert.match(
      (await validate([{ ...first, outputShape: Array(17).fill(1) }])).reason,
      /recorded model file is missing/,
    );
  });
});

test('download rejects a restored model that exceeds its declared size without accepting the bytes', async () => {
  await withStore(async (_store, dir) => {
    await mkdir(join(dir, 'models'));
    const record = restoredRecord(1);
    await writeFile(join(dir, 'registry.json'), JSON.stringify({ version: 1, models: [record] }));
    await writeFile(
      join(dir, 'models', `${record.id}.tflite`),
      Buffer.alloc(MAX_RESTORED_WAKE_WORD_MODEL_BYTES + 1),
    );
    const restored = new WakeWordModelStore(dir);
    await assert.rejects(
      restored.readModel(record.id),
      (error) => error instanceof WakeWordModelStoreError
        && error.code === 'wake_word_model_unavailable',
    );
  });
});

test('tampering is visible in the manifest and blocks download with an integrity error', async () => {
  await withStore(async (store, dir) => {
    const added = await store.addModel(upload());
    const modelPath = join(dir, 'models', `${added.id}.tflite`);
    const original = await readFile(modelPath);
    const tampered = Buffer.from(original);
    tampered[400] ^= 0xff;
    await writeFile(modelPath, tampered);
    const persistentState = validateWakeWordPersistentState(dir);
    assert.equal(persistentState.valid, false);
    assert.match(persistentState.reason, /SHA-256/);
    await assert.rejects(
      store.readModel(added.id),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'wake_word_model_unavailable',
    );
    const [listed] = await store.listModels();
    assert.equal(listed.available, false);
    assert.match(listed.unavailableReason, /integrity/);
  });
});

test('an unsafe individual model entry is unavailable without exposing storage details', async () => {
  await withStore(async (store, dir) => {
    const added = await store.addModel(upload());
    const modelPath = join(dir, 'models', `${added.id}.tflite`);
    const outside = `${dir}-outside-model.tflite`;
    try {
      await writeFile(outside, 'outside bytes must never be returned');
      await rm(modelPath);
      await symlink(outside, modelPath);

      await assert.rejects(
        store.readModel(added.id),
        (error) => error instanceof WakeWordModelStoreError
          && error.code === 'wake_word_model_unavailable'
          && error.status === 409
          && !/unsafe|outside/i.test(error.message),
      );
      assert.equal(await readFile(outside, 'utf8'), 'outside bytes must never be returned');
      const [listed] = await store.listModels();
      assert.equal(listed.available, false);
      assert.match(listed.unavailableReason, /unavailable/);

      const auditWarnings = [];
      const reloaded = new WakeWordModelStore(dir, {
        logger: { warn: (message) => auditWarnings.push(message) },
      });
      const [audited] = await reloaded.listModels();
      assert.equal(audited.available, false);
      assert.equal(audited.unavailableReason, 'Model file is unavailable in persistent storage.');
      assert.ok(!audited.unavailableReason.includes(dir));
      assert.equal(auditWarnings.length, 1);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test('a replaced models directory returns a sanitized installation-level error on download', async () => {
  await withStore(async (store, dir) => {
    const added = await store.addModel(upload());
    const outside = join(dir, 'outside-models');
    await mkdir(outside);
    await rename(join(dir, 'models'), join(dir, 'original-models'));
    await symlink(outside, join(dir, 'models'));

    await assert.rejects(
      store.readModel(added.id),
      (error) => error instanceof WakeWordModelStoreError
        && error.code === 'wake_word_storage_unavailable'
        && error.status === 503
        && !error.message.includes(dir),
    );
    assert.deepEqual(await readdir(outside), []);
  });
});

test('an operator-configured root directory link is accepted and pinned', async () => {
  await withStore(async (_store, dir) => {
    const actual = join(dir, 'actual-storage');
    const linked = join(dir, 'linked-storage');
    await mkdir(join(actual, 'models'), { recursive: true });
    await writeFile(join(actual, 'registry.json'), '{"version":1,"models":[]}\n');
    await symlink(actual, linked);

    assert.deepEqual(validateWakeWordPersistentState(linked), { valid: true, reason: null });
    assert.deepEqual(await new WakeWordModelStore(linked).listModels(), []);
    assert.deepEqual(await readdir(join(actual, 'models')), []);
  });
});

test('an unsafe restored models directory disables only custom wake-word storage', async () => {
  await withStore(async (_store, dir) => {
    const root = join(dir, 'restored-storage');
    const outside = join(dir, 'outside-models');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(join(root, 'registry.json'), '{"version":1,"models":[]}\n');
    await symlink(outside, join(root, 'models'));

    const persistentState = validateWakeWordPersistentState(root);
    assert.equal(persistentState.valid, false);
    assert.equal(persistentState.degradable, true);
    assert.match(persistentState.reason, /Unsafe wake-word storage/);
    const warnings = [];
    const store = new WakeWordModelStore(root, { logger: { warn: (message) => warnings.push(message) } });
    await store.load();
    await assert.rejects(
      store.listModels(),
      (error) => error instanceof WakeWordModelStoreError
        && error.code === 'wake_word_storage_unavailable'
        && error.status === 503,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disabled.*Built-in wake-word support remains available/s);
    assert.deepEqual(await readdir(outside), []);
  });
});

test('unexpected restored entries disable only custom wake-word storage and remain untouched', async () => {
  const cases = [
    {
      name: '.DS_Store',
      add: (dir) => writeFile(join(dir, '.DS_Store'), 'finder metadata'),
      entries: (dir) => readdir(dir),
    },
    {
      name: 'atomic-save temporary file',
      add: (dir) => writeFile(
        join(dir, 'registry.json.4242.00000000-0000-4000-8000-000000000000.tmp'),
        'temporary registry',
      ),
      entries: (dir) => readdir(dir),
    },
    {
      name: '@eaDir',
      add: (dir) => mkdir(join(dir, '@eaDir')),
      entries: (dir) => readdir(dir),
    },
    {
      name: 'unregistered model',
      add: (dir) => writeFile(
        join(dir, 'models', '11111111-1111-4111-8111-111111111111.tflite'),
        'orphan model',
      ),
      entries: (dir) => readdir(join(dir, 'models')),
    },
  ];

  for (const scenario of cases) {
    await withStore(async (store, dir) => {
      await store.load();
      const registryBefore = await readFile(join(dir, 'registry.json'));
      await scenario.add(dir);
      const entriesBefore = await scenario.entries(dir);

      const persistentState = validateWakeWordPersistentState(dir);
      assert.equal(persistentState.valid, false, scenario.name);
      assert.equal(persistentState.degradable, true, scenario.name);
      assert.match(persistentState.reason, /Unsafe wake-word storage/, scenario.name);

      const warnings = [];
      const restored = new WakeWordModelStore(dir, {
        logger: { warn: (message) => warnings.push(message) },
      });
      await restored.load();
      await assert.rejects(
        restored.listModels(),
        (error) => error instanceof WakeWordModelStoreError
          && error.code === 'wake_word_storage_unavailable'
          && error.status === 503,
        scenario.name,
      );
      await assert.rejects(
        restored.addModel(upload()),
        (error) => error instanceof WakeWordModelStoreError
          && error.code === 'wake_word_storage_unavailable'
          && error.status === 503,
        scenario.name,
      );
      assert.equal(warnings.length, 1, scenario.name);
      assert.match(
        warnings[0],
        /disabled.*Built-in wake-word support remains available/s,
        scenario.name,
      );
      assert.deepEqual(await readFile(join(dir, 'registry.json')), registryBefore, scenario.name);
      assert.deepEqual(await scenario.entries(dir), entriesBefore, scenario.name);
    });
  }
});

test('upload refuses a models directory replaced with a link after load', async () => {
  await withStore(async (store, dir) => {
    await store.load();
    const outside = join(dir, 'outside-models');
    await mkdir(outside);
    await rename(join(dir, 'models'), join(dir, 'original-models'));
    await symlink(outside, join(dir, 'models'));

    await assert.rejects(
      store.addModel(upload()),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'wake_word_storage_unsafe',
    );
    assert.deepEqual(await readdir(outside), []);
  });
});

test('deletion refuses a models directory replaced with a link after load', async () => {
  await withStore(async (store, dir) => {
    const added = await store.addModel(upload());
    const outside = join(dir, 'outside-models');
    await mkdir(outside);
    await writeFile(join(outside, `${added.id}.tflite`), 'must remain outside');
    await rename(join(dir, 'models'), join(dir, 'original-models'));
    await symlink(outside, join(dir, 'models'));

    await assert.rejects(
      store.deleteModel(added.id),
      (error) => error instanceof WakeWordModelStoreError && error.code === 'wake_word_storage_unsafe',
    );
    assert.equal(await readFile(join(outside, `${added.id}.tflite`), 'utf8'), 'must remain outside');
    assert.equal((await store.listModels()).length, 1);
  });
});
