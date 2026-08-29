import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { CaptionWritebackService } from '../../src/enrich/captionWriteback.mjs';
import { ImmichApiError } from '../../src/immich.mjs';

async function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-capwb-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  try {
    return await work(repo);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function enrich(repo, assetId, caption) {
  repo.upsertAsset({ id: assetId });
  repo.recordProcessingRun({
    assetId,
    provider: 'local_lmstudio',
    model: 'qwen-vl',
    promptVersion: 'v1',
    taxonomyVersion: 'v1',
    status: 'succeeded',
    normalizedOutput: { caption, short_caption: caption.slice(0, 12) },
  });
}

function fakeImmich({ descriptions = {}, missing = [] } = {}) {
  const updates = [];
  const reads = [];
  return {
    updates,
    reads,
    async getAsset(assetId) {
      reads.push(assetId);
      if (missing.includes(assetId)) {
        throw new ImmichApiError(`GET /assets/${assetId} failed with status 404`, 404);
      }
      return { id: assetId, exifInfo: { description: descriptions[assetId] ?? '' } };
    },
    async updateAsset(assetId, body) {
      updates.push({ assetId, ...body });
      descriptions[assetId] = body.description;
      return { id: assetId };
    },
  };
}

function service(repo, immich, { enabled = true } = {}) {
  return new CaptionWritebackService({ repo, immich, config: { captionWriteback: enabled } });
}

// --- repository queue ---

test('enqueue queues once and resets non-pending rows', async () => {
  await withRepo((repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    assert.equal(repo.captionWritebackEnqueue(['a1']), 1);
    assert.equal(repo.captionWritebackEnqueue(['a1']), 0); // already pending

    repo.captionWritebackMark('a1', { status: 'written', writtenDescription: 'A dog on a beach.' });
    assert.equal(repo.captionWritebackEnqueue(['a1']), 1); // written → pending again
    assert.equal(repo.captionWritebackCounts().pending, 1);
  });
});

test('backfill queues captioned assets, retries failures, re-queues changed captions only', async () => {
  await withRepo((repo) => {
    enrich(repo, 'a1', 'First caption.');
    enrich(repo, 'a2', 'Second caption.');
    enrich(repo, 'a3', ''); // enriched but no caption
    assert.equal(repo.captionWritebackBackfill(), 2);

    repo.captionWritebackMark('a1', { status: 'written', writtenDescription: 'First caption.' });
    repo.captionWritebackMark('a2', { status: 'skipped', note: 'existing description kept' });
    assert.equal(repo.captionWritebackBackfill(), 0); // written unchanged + skipped stay put

    enrich(repo, 'a1', 'First caption, improved.'); // re-enrichment changed the caption
    repo.captionWritebackMark('a1', { status: 'written', writtenDescription: 'First caption.' });
    assert.equal(repo.captionWritebackBackfill(), 1); // only the changed one re-queues

    repo.captionWritebackMark('a1', { status: 'failed', note: 'boom' });
    assert.equal(repo.captionWritebackBackfill(), 1); // failed rows retry
  });
});

test('failure rotates to the back and gives up after maxAttempts', async () => {
  await withRepo((repo) => {
    enrich(repo, 'a1', 'Caption one.');
    enrich(repo, 'a2', 'Caption two.');
    repo.captionWritebackEnqueue(['a1', 'a2']);

    assert.equal(repo.captionWritebackNext(1)[0].assetId, 'a1');
    repo.captionWritebackFailure('a1', 'immich down', { maxAttempts: 2 });
    assert.equal(repo.captionWritebackNext(1)[0].assetId, 'a2'); // a1 rotated back

    repo.captionWritebackFailure('a1', 'immich down again', { maxAttempts: 2 });
    const counts = repo.captionWritebackCounts();
    assert.equal(counts.failed, 1);
    assert.equal(counts.pending, 1);
  });
});

test('next carries the current caption and prior write', async () => {
  await withRepo((repo) => {
    enrich(repo, 'a1', 'A mountain lake.');
    repo.captionWritebackEnqueue(['a1']);
    const [item] = repo.captionWritebackNext(5);
    assert.equal(item.caption, 'A mountain lake.');
    assert.equal(item.writtenDescription, null);
  });
});

// --- worker push semantics ---

test('pushOne fills an empty description and records what it wrote', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    repo.captionWritebackEnqueue(['a1']);
    const immich = fakeImmich();
    await service(repo, immich).pushOne(repo.captionWritebackNext(1)[0]);

    assert.deepEqual(immich.reads, ['a1']);
    assert.deepEqual(immich.updates, [{ assetId: 'a1', description: 'A dog on a beach.' }]);
    assert.equal(repo.captionWritebackCounts().written, 1);
    repo.captionWritebackEnqueue(['a1']);
    assert.equal(repo.captionWritebackNext(1)[0].writtenDescription, 'A dog on a beach.');
  });
});

test('pushOne never touches a human-typed description', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    repo.captionWritebackEnqueue(['a1']);
    const immich = fakeImmich({ descriptions: { a1: 'Rex at Ocean Beach, 2019' } });
    await service(repo, immich).pushOne(repo.captionWritebackNext(1)[0]);

    assert.equal(immich.updates.length, 0);
    assert.equal(repo.captionWritebackCounts().skipped, 1);
  });
});

test('pushOne updates our own earlier write when the caption changed', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    repo.captionWritebackEnqueue(['a1']);
    const immich = fakeImmich();
    const worker = service(repo, immich);
    await worker.pushOne(repo.captionWritebackNext(1)[0]);

    enrich(repo, 'a1', 'A golden retriever on a beach at sunset.');
    repo.captionWritebackEnqueue(['a1']);
    await worker.pushOne(repo.captionWritebackNext(1)[0]);

    assert.equal(immich.updates.length, 2);
    assert.equal(immich.updates[1].description, 'A golden retriever on a beach at sunset.');
    assert.equal(repo.captionWritebackCounts().written, 1);
  });
});

test('pushOne treats an already-matching description as written without a call', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    repo.captionWritebackEnqueue(['a1']);
    const immich = fakeImmich({ descriptions: { a1: 'A dog on a beach.' } });
    await service(repo, immich).pushOne(repo.captionWritebackNext(1)[0]);

    assert.equal(immich.updates.length, 0);
    assert.equal(repo.captionWritebackCounts().written, 1);
  });
});

test('pushOne marks assets missing from Immich as skipped', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    repo.captionWritebackEnqueue(['a1']);
    const immich = fakeImmich({ missing: ['a1'] });
    await service(repo, immich).pushOne(repo.captionWritebackNext(1)[0]);

    assert.equal(repo.captionWritebackCounts().skipped, 1);
  });
});

test('stop resolves promptly while the worker idles', async () => {
  await withRepo(async (repo) => {
    const writeback = service(repo, fakeImmich());
    writeback.start();

    const started = Date.now();
    await writeback.stop();

    // An idle loop parks in a 5s poll sleep; stop must wake it, not wait it out.
    assert.ok(Date.now() - started < 1000, 'stop should not wait out the idle poll');
  });
});

test('stop waits for the in-flight write to finish', async () => {
  await withRepo(async (repo) => {
    enrich(repo, 'a1', 'A quiet lake at dawn.');
    repo.captionWritebackEnqueue(['a1']);
    let releaseWrite;
    let writeStarted;
    const writeRunning = new Promise((resolve) => {
      writeStarted = resolve;
    });
    const writeback = service(repo, fakeImmich());
    writeback.pushOne = () => {
      writeStarted();
      return new Promise((resolve) => {
        releaseWrite = resolve;
      });
    };

    writeback.start();
    await writeRunning;

    let stopped = false;
    const stopPromise = writeback.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, 'stop must wait for the in-flight write');

    releaseWrite();
    await stopPromise;
    assert.equal(stopped, true);
  });
});

test('status reports the live toggle and queue counts', async () => {
  await withRepo((repo) => {
    enrich(repo, 'a1', 'A dog on a beach.');
    const worker = service(repo, fakeImmich(), { enabled: false });
    assert.equal(worker.status().enabled, false);
    assert.equal(worker.backfill(), 1);
    assert.equal(worker.status().pending, 1);
  });
});
