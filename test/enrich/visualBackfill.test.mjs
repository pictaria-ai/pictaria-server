import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Repository } from '../../src/enrich/repository.mjs';
import { backfillAssetVisuals } from '../../src/enrich/visualBackfill.mjs';

async function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-visuals-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  try {
    return await work(repo);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('upsertAsset stores and keeps visual descriptors', async () => {
  await withRepo((repo) => {
    repo.upsertAsset({ id: 'a1', thumbhash: 'aGFzaA==', duplicateId: 'dup-9' });
    // A later payload without descriptors (e.g. a slimmer endpoint) must not erase them.
    repo.upsertAsset({ id: 'a1' });
    const row = repo.db.prepare('SELECT thumbhash, duplicate_id FROM assets WHERE asset_id = ?').get('a1');
    assert.equal(row.thumbhash, 'aGFzaA==');
    assert.equal(row.duplicate_id, 'dup-9');
  });
});

test('backfill pages the library and fills only missing rows', async () => {
  await withRepo(async (repo) => {
    repo.upsertAsset({ id: 'a1' });
    repo.upsertAsset({ id: 'a2' });
    repo.reviewListAdd(['a1', 'a2'], 'send');
    assert.equal(repo.reviewListMissingThumbhashCount(), 2);

    const pagesServed = [];
    const immich = {
      async searchMetadata({ page }) {
        pagesServed.push(page);
        if (page === 1) {
          return { assets: { items: [{ id: 'a1', thumbhash: 'aGFzaDE=' }, { id: 'unknown', thumbhash: 'eA==' }], nextPage: '2' } };
        }
        return { assets: { items: [{ id: 'a2', thumbhash: 'aGFzaDI=', duplicateId: 'dup-1' }], nextPage: null } };
      },
    };
    const result = await backfillAssetVisuals({ repo, immich });
    assert.deepEqual(pagesServed, [1, 2]);
    assert.equal(result.updated, 2); // the unknown asset isn't tracked locally
    assert.equal(result.missingAfter, 0);

    // Second run is a no-op: nothing missing, no Immich calls.
    const again = await backfillAssetVisuals({ repo, immich });
    assert.equal(again.pages, 0);
    assert.deepEqual(pagesServed, [1, 2]);
  });
});

test('backfill rejects repeated pagination and does not process duplicate IDs twice', async () => {
  await withRepo(async (repo) => {
    repo.upsertAsset({ id: 'a1' });
    repo.upsertAsset({ id: 'a2' });
    repo.reviewListAdd(['a1', 'a2'], 'send');
    let calls = 0;
    const immich = {
      async searchMetadata() {
        calls += 1;
        return {
          assets: {
            items: [{ id: 'a1', thumbhash: 'aGFzaA==' }, { id: 'a1', thumbhash: 'aGFzaA==' }],
            nextPage: 1,
          },
        };
      },
    };

    await assert.rejects(
      () => backfillAssetVisuals({ repo, immich }),
      /non-progressing next page/,
    );
    assert.equal(calls, 1);
    assert.equal(repo.reviewListMissingThumbhashCount(), 1);
  });
});

test('backfill honors cancellation before the next Immich page', async () => {
  await withRepo(async (repo) => {
    repo.upsertAsset({ id: 'a1' });
    repo.upsertAsset({ id: 'a2' });
    repo.reviewListAdd(['a1', 'a2'], 'send');
    let requests = 0;
    let checks = 0;
    const result = await backfillAssetVisuals({
      repo,
      immich: {
        async searchMetadata() {
          requests += 1;
          return { assets: { items: [{ id: 'a1', thumbhash: 'aGFzaA==' }], nextPage: 2 } };
        },
      },
      shouldStop: () => checks++ > 0,
    });

    assert.equal(result.stopped, true);
    assert.equal(requests, 1);
    assert.equal(repo.reviewListMissingThumbhashCount(), 1);
  });
});

test('backfill does not stop when unrelated tracked assets outnumber missing review assets', async () => {
  await withRepo(async (repo) => {
    repo.upsertAsset({ id: 'review-photo' });
    repo.upsertAsset({ id: 'unrelated-1' });
    repo.upsertAsset({ id: 'unrelated-2' });
    repo.reviewListAdd(['review-photo'], 'send');
    const pages = [];
    const immich = {
      async searchMetadata({ page }) {
        pages.push(page);
        if (page === 1) {
          return {
            assets: {
              items: [
                { id: 'unrelated-1', thumbhash: 'dW5yZWxhdGVkLTE=' },
                { id: 'unrelated-2', thumbhash: 'dW5yZWxhdGVkLTI=' },
              ],
              nextPage: 2,
            },
          };
        }
        return {
          assets: {
            items: [{ id: 'review-photo', thumbhash: 'cmV2aWV3' }],
            nextPage: null,
          },
        };
      },
    };

    const result = await backfillAssetVisuals({ repo, immich });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(result.missingAfter, 0);
  });
});
