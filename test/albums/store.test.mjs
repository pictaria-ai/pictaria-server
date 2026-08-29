import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_SMART_ALBUM_STATE_BYTES,
  SmartAlbumStore,
  validateSmartAlbumPersistentState,
} from '../../src/albums/store.mjs';
import { normalizeFilters } from '../../src/albums/smartAlbums.mjs';

const INSTALLATION_SECRET = Buffer.alloc(32, 7);

function makeStore(filePath, installationSecret = INSTALLATION_SECRET) {
  return new SmartAlbumStore(filePath, { installationSecret });
}

async function withDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-album-store-'));
  try {
    return await work(dir);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeJob(id) {
  return {
    id,
    albumId: `album-${id}`,
    albumName: `Album ${id}`,
    query: '',
    filters: {},
    smart: true,
    enabled: true,
    intervalDays: 7,
    includeAllResults: false,
    maxResults: 50,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lastRunAt: null,
    lastSuccessAt: null,
    nextRunAt: null,
    lastError: null,
    lastResult: null,
  };
}

test('each save keeps the previous state as .bak', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const store = makeStore(path);
    await store.addJob(makeJob('one'));
    await store.addJob(makeJob('two'));

    const backup = JSON.parse(readFileSync(`${path}.bak`, 'utf8'));
    const primary = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(backup.jobs.map((job) => job.id), ['one']);
    assert.deepEqual(primary.jobs.map((job) => job.id), ['one', 'two']);
  });
});

test('restored fixed-temp and backup symlinks are never followed during a save', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const outside = join(dir, 'outside');
    writeFileSync(outside, 'untouched');
    writeFileSync(path, '{"version":1,"jobs":[]}\n');
    symlinkSync(outside, `${path}.tmp`);
    symlinkSync(outside, `${path}.bak`);

    // Passing the options object keeps this regression compatible with the
    // installation-bound schedule store; constructors without this option
    // harmlessly ignore the extra argument.
    await new SmartAlbumStore(path, { installationSecret: Buffer.alloc(32, 7) })
      .addJob(makeJob('safe'));

    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    assert.equal(lstatSync(`${path}.tmp`).isSymbolicLink(), true);
    assert.equal(lstatSync(`${path}.bak`).isSymbolicLink(), false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).jobs.map((job) => job.id), ['safe']);
  });
});

test('a corrupt state file recovers from .bak instead of blocking startup', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const seed = makeStore(path);
    await seed.addJob(makeJob('keeper'));
    await seed.addJob(makeJob('newest'));
    // Corrupt the primary (as a bad write or disk hiccup would).
    writeFileSync(path, '{"version":1,"jobs":[{tru', 'utf8');

    const store = makeStore(path);
    const jobs = await store.listJobs();
    // .bak holds the state before the LAST save — 'keeper' survives, and the
    // corrupt file is parked for diagnosis rather than deleted.
    assert.deepEqual(jobs.map((job) => job.id), ['keeper']);
    assert.ok(existsSync(`${path}.corrupt`));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).jobs.map((job) => job.id), ['keeper']);
  });
});

test('a corrupt state file with no valid backup refuses to start', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    writeFileSync(path, 'not json at all', 'utf8');

    const store = makeStore(path);
    await assert.rejects(store.listJobs(), /unreadable/);
    // The bad file is untouched — hand recovery stays possible.
    assert.equal(readFileSync(path, 'utf8'), 'not json at all');
  });
});

test('Smart Album state validation rejects valid JSON with an unusable shape', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    writeFileSync(path, 'null');

    assert.equal(validateSmartAlbumPersistentState(path).valid, false);
    await assert.rejects(makeStore(path).listJobs(), /unreadable/);
    assert.equal(readFileSync(path, 'utf8'), 'null');
  });
});

test('oversized restored Smart Album state and its backup are never fully parsed', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const oversized = Buffer.alloc(MAX_SMART_ALBUM_STATE_BYTES + 1, 0x20);
    writeFileSync(path, oversized);
    writeFileSync(`${path}.bak`, oversized);

    assert.equal(validateSmartAlbumPersistentState(path).valid, false);
    await assert.rejects(makeStore(path).listJobs(), /unreadable.*byte limit/s);
    assert.equal(lstatSync(path).size, MAX_SMART_ALBUM_STATE_BYTES + 1);
  });
});

test('compact sparse Smart Album backups remain recoverable after normalization', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const compact = JSON.stringify({
      version: 1,
      jobs: Array.from({ length: 20_000 }, (_, index) => ({ id: String(index) })),
    });
    assert.ok(Buffer.byteLength(compact) < MAX_SMART_ALBUM_STATE_BYTES);
    writeFileSync(path, 'bad');
    writeFileSync(`${path}.bak`, compact);

    assert.equal(validateSmartAlbumPersistentState(`${path}.bak`).valid, true);
    assert.equal((await makeStore(path).listJobs()).length, 20_000);
    assert.ok(lstatSync(path).size <= MAX_SMART_ALBUM_STATE_BYTES);
  });
});

test('compact sparse primary state remains persistable when schedules are quarantined', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const compact = JSON.stringify({
      version: 1,
      jobs: Array.from({ length: 20_000 }, (_, index) => ({ id: String(index), enabled: true })),
    });
    writeFileSync(path, compact);

    assert.equal(validateSmartAlbumPersistentState(path).valid, true);
    const jobs = await makeStore(path).listJobs();
    assert.equal(jobs.length, 20_000);
    assert.ok(jobs.every((job) => job.enabled === false && job.scheduleQuarantined === true));
    assert.ok(lstatSync(path).size <= MAX_SMART_ALBUM_STATE_BYTES);
  });
});

test('concurrent adds serialize: every job survives in memory, on disk, and after reload', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const store = makeStore(path);
    const ids = Array.from({ length: 20 }, (_, index) => `job-${String(index).padStart(2, '0')}`);

    await Promise.all(ids.map((id) => store.addJob(makeJob(id))));

    assert.deepEqual((await store.listJobs()).map((job) => job.id).sort(), ids);
    assert.deepEqual(
      JSON.parse(readFileSync(path, 'utf8')).jobs.map((job) => job.id).sort(),
      ids,
    );
    const reloaded = await makeStore(path).listJobs();
    assert.deepEqual(reloaded.map((job) => job.id).sort(), ids);
  });
});

test('concurrent updates to distinct jobs both survive', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const store = makeStore(path);
    await store.addJob(makeJob('one'));
    await store.addJob(makeJob('two'));

    await Promise.all([
      store.updateJob('one', () => ({ lastError: 'error-one' })),
      store.updateJob('two', () => ({ lastError: 'error-two' })),
    ]);

    for (const jobs of [await store.listJobs(), JSON.parse(readFileSync(path, 'utf8')).jobs]) {
      assert.equal(jobs.find((job) => job.id === 'one').lastError, 'error-one');
      assert.equal(jobs.find((job) => job.id === 'two').lastError, 'error-two');
    }
  });
});

test('a throwing updater rejects its caller without corrupting state or blocking the queue', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const store = makeStore(path);
    await store.addJob(makeJob('kept'));

    await assert.rejects(
      store.updateJob('kept', () => {
        throw new Error('boom');
      }),
      /boom/,
    );
    // Updating a missing job stays a null no-op, not an error.
    assert.equal(await store.updateJob('missing', () => ({ lastError: 'nope' })), null);

    // Later mutations still go through, and the failed update left no trace.
    await store.addJob(makeJob('after'));
    const jobs = JSON.parse(readFileSync(path, 'utf8')).jobs;
    assert.deepEqual(jobs.map((job) => job.id), ['kept', 'after']);
    assert.equal(jobs[0].lastError, null);
  });
});

test('every field of a stored job survives save and reload', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    // Shape mirrors the job built by createSmartAlbumJob (smartAlbums.mjs),
    // filters included, so normalizeJob is exercised against the real thing.
    const original = {
      id: 'invariant',
      albumId: 'album-invariant',
      albumName: 'Best of the Beach',
      query: 'golden hour beach',
      filters: normalizeFilters({
        people: [{ id: 'person-1', name: 'Ana' }],
        tags: [{ id: 'tag-1', name: 'Beach', value: 'beach' }],
        excludeTags: [{ id: 'tag-2', name: 'Screenshot', value: 'screenshot' }],
        peopleMatchMode: 'any',
      }),
      smart: true,
      bestOf: true,
      enabled: true,
      intervalDays: 14,
      includeAllResults: false,
      maxResults: 120,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-02T00:00:00.000Z',
      lastRunAt: '2026-07-08T00:00:00.000Z',
      lastSuccessAt: '2026-07-08T00:00:00.000Z',
      nextRunAt: '2026-07-15T00:00:00.000Z',
      lastError: null,
      lastResult: { added: 3, removed: 1 },
    };

    await makeStore(path).addJob(original);
    const reloaded = await makeStore(path).getJob('invariant');

    // Iterate the original's own keys so any field normalizeJob drops fails
    // here by name instead of silently erasing data on the next save.
    for (const key of Object.keys(original)) {
      assert.deepEqual(reloaded[key], original[key], `field "${key}" did not survive save and reload`);
    }
  });
});

test('confirmed schedules survive an ordinary restart on the same installation', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    await makeStore(path).addJob({
      ...makeJob('confirmed'),
      nextRunAt: '2026-08-24T00:00:00.000Z',
    });

    const reloaded = await makeStore(path).getJob('confirmed');
    assert.equal(reloaded.enabled, true);
    assert.equal(reloaded.scheduleQuarantined, false);
    assert.equal(Object.hasOwn(reloaded, 'scheduleConfirmation'), false);
  });
});

test('a schedule restored onto another installation is quarantined until confirmed', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    await makeStore(path).addJob({
      ...makeJob('restored'),
      nextRunAt: '2026-08-24T00:00:00.000Z',
    });

    const restored = makeStore(path, Buffer.alloc(32, 8));
    const pending = await restored.getJob('restored');
    assert.equal(pending.enabled, false);
    assert.equal(pending.scheduleQuarantined, true);
    assert.equal(pending.albumName, 'Album restored');
    assert.equal(Object.hasOwn(pending, 'scheduleConfirmation'), false);

    const stillPending = await restored.updateJob('restored', () => ({ lastError: 'manual run completed' }));
    assert.equal(stillPending.enabled, false);
    assert.equal(stillPending.scheduleQuarantined, true);

    const confirmed = await restored.updateJob(
      'restored',
      () => ({ enabled: true }),
      { confirmSchedule: true },
    );
    assert.equal(confirmed.enabled, true);
    assert.equal(confirmed.scheduleQuarantined, false);

    const restarted = await makeStore(path, Buffer.alloc(32, 8)).getJob('restored');
    assert.equal(restarted.enabled, true);
    assert.equal(restarted.scheduleQuarantined, false);
  });
});

test('altering a confirmed schedule target causes quarantine at startup', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    await makeStore(path).addJob({
      ...makeJob('tampered'),
      nextRunAt: '2026-08-24T00:00:00.000Z',
    });
    const state = JSON.parse(readFileSync(path, 'utf8'));
    state.jobs[0].albumId = 'attacker-selected-album';
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const job = await makeStore(path).getJob('tampered');
    assert.equal(job.albumId, 'attacker-selected-album');
    assert.equal(job.enabled, false);
    assert.equal(job.scheduleQuarantined, true);
  });
});

test('a failed save leaves memory and disk at the previous state', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'albums.json');
    const store = makeStore(path);
    await store.addJob(makeJob('kept'));

    // Make the directory unwritable so the next persist fails.
    chmodSync(dir, 0o555);
    await assert.rejects(store.addJob(makeJob('lost')));
    chmodSync(dir, 0o755);

    // The failed mutation did NOT stick in memory, so it cannot ride along
    // on a later unrelated save.
    assert.deepEqual((await store.listJobs()).map((job) => job.id), ['kept']);
    await store.updateJob('kept', () => ({ lastError: 'poke' }));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).jobs.map((job) => job.id), ['kept']);
  });
});
