import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSmartAlbumJob,
  previewSearch,
  searchBestOfAssets,
  validateCreateRequest,
} from '../../src/albums/smartAlbums.mjs';

const CONFIG = { searchPageSize: 10, maxSearchPages: 10 };

// Fake Immich smart search over predefined pages of asset ids. Each entry is
// either an id string or an object ({ id, isFavorite }).
function fakeImmichPages(pages, { calls = [] } = {}) {
  return {
    async searchSmart(body) {
      calls.push(body);
      const index = Number(body.page) - 1;
      const items = (pages[index] ?? []).map((entry) =>
        typeof entry === 'string' ? { id: entry } : entry,
      );
      return {
        assets: {
          items,
          nextPage: index + 1 < pages.length ? body.page + 1 : null,
        },
      };
    },
    async searchMetadata() {
      return { assets: { items: [], nextPage: null } };
    },
    async listTags() {
      return [];
    },
    async createAlbum() {
      return { id: 'album-1' };
    },
    async addAssetsToAlbum(albumId, assetIds) {
      return assetIds.map(() => ({ success: true }));
    },
  };
}

// Fake enrichment repository: `enriched` lists ids with a successful run
// (optionally with quality scores), `captionHits` corroborates by caption,
// `aiTags`/`frameTags` corroborate/rank by tags. The scoped methods answer
// only for the requested ids, like the real repository.
function fakeEnrichRepo({ enriched = [], captionHits = [], aiTags = {}, frameTags = {} } = {}) {
  return {
    searchCaptions() {
      return captionHits.map((assetId) => ({ assetId, caption: '', shortCaption: '' }));
    },
    loadAssetTagsFor(assetIds, { prefix } = {}) {
      const source = prefix === 'ai/' ? aiTags : frameTags;
      const grouped = {};
      for (const assetId of assetIds) {
        if (source[assetId]) {
          grouped[assetId] = source[assetId];
        }
      }
      return grouped;
    },
    latestSuccessFor(assetIds) {
      const requested = new Set(assetIds);
      return enriched
        .map((entry) => (typeof entry === 'string' ? { id: entry } : entry))
        .filter((entry) => requested.has(entry.id))
        .map((entry) => ({
          asset_id: entry.id,
          frame_score: entry.frame ?? null,
          aesthetic_score: entry.aesthetic ?? null,
        }));
    },
  };
}

function ids(prefix, count, start = 1) {
  return Array.from({ length: count }, (_, i) => `${prefix}${start + i}`);
}

test('best of keeps collecting through dense pages and stops at 3x the cap', async () => {
  // "skiing" regime: every page fully corroborated; only the cap should cut.
  const pages = [ids('a', 10), ids('b', 10), ids('c', 10), ids('d', 10)];
  const all = pages.flat();
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: all, captionHits: all }),
    query: 'skiing',
    maxResults: 5,
  });

  assert.equal(result.stats.cutoff, 'enough');
  assert.equal(result.assets.length, 15); // 3x headroom collected for exclusions
  assert.equal(result.stats.pagesScanned, 2);
  assert.equal(result.truncated, true);
});

test('best of stops after two consecutive low-corroboration pages', async () => {
  // "beach couple" regime: strong first page, decaying tail.
  const pages = [ids('a', 10), ids('b', 10), ids('c', 10), ids('d', 10)];
  const captionHits = [...ids('a', 8), ...ids('b', 3), ...ids('c', 2)];
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: pages.flat(), captionHits }),
    query: 'beach couple',
    maxResults: 50,
  });

  assert.equal(result.stats.cutoff, 'faded');
  assert.equal(result.stats.pagesScanned, 3);
  assert.equal(result.assets.length, 13);
  assert.equal(result.stats.droppedLowSignal, 17);
});

test('best of cutoff threshold rises with a very strong first page', async () => {
  // Page-1 at 100% sets the bar at 50%; pages at 45% would pass an absolute
  // 40% floor but must still read as tail noise relative to page 1.
  const pages = [ids('a', 20), ids('b', 20), ids('c', 20), ids('d', 20)];
  const captionHits = [...ids('a', 20), ...ids('b', 9), ...ids('c', 9)];
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: { searchPageSize: 20, maxSearchPages: 10 },
    enrichRepo: fakeEnrichRepo({ enriched: pages.flat(), captionHits }),
    query: 'birthday cake',
    maxResults: 200,
  });

  assert.equal(result.stats.cutoff, 'faded');
  assert.equal(result.stats.pagesScanned, 3);
  assert.equal(result.stats.firstPageRate, 1);
});

test('best of dies fast when even the first page is mostly noise', async () => {
  // "dog" regime: nothing much matches anywhere.
  const pages = [ids('a', 10), ids('b', 10), ids('c', 10)];
  const captionHits = ids('a', 3);
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: pages.flat(), captionHits }),
    query: 'dog',
    maxResults: 50,
  });

  assert.equal(result.stats.cutoff, 'faded');
  assert.equal(result.stats.pagesScanned, 2);
  assert.equal(result.assets.length, 3);
});

test('best of counts unenriched photos honestly without letting them vote on density', async () => {
  const pages = [
    [...ids('e', 5), ...ids('u', 5)], // 5 enriched+corroborated, 5 unenriched
    [...ids('f', 5), ...ids('v', 5)],
  ];
  const enriched = [...ids('e', 5), ...ids('f', 5)];
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched, captionHits: enriched }),
    query: 'garden',
    maxResults: 50,
  });

  assert.equal(result.stats.cutoff, 'exhausted');
  assert.equal(result.stats.notEnriched, 10);
  assert.equal(result.stats.firstPageRate, 1);
  assert.equal(result.assets.length, 10);
});

test('best of corroborates via ai tags including simple plural stems', async () => {
  const pages = [['tagged', 'plural', 'unrelated']];
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({
      enriched: ['tagged', 'plural', 'unrelated'],
      aiTags: {
        tagged: ['ai/activity/skiing'],
        plural: ['ai/subject/dog'],
        unrelated: ['ai/setting/indoor'],
      },
    }),
    query: 'skiing with dogs',
    maxResults: 50,
  });

  assert.deepEqual(result.assetIds.sort(), ['plural', 'tagged']);
});

test('best of ranks favorites, then kept, then scores; reviewed sinks and never-show is out', async () => {
  const pages = [[
    { id: 'high-score' },
    { id: 'favorite' },
    { id: 'kept' },
    { id: 'reviewed', isFavorite: true },
    { id: 'banned' },
    { id: 'low-score' },
  ]];
  const enriched = [
    { id: 'high-score', frame: 0.95, aesthetic: 0.9 },
    { id: 'favorite', frame: 0.5 },
    { id: 'kept', frame: 0.6 },
    { id: 'reviewed', frame: 0.99 },
    { id: 'banned', frame: 0.99 },
    { id: 'low-score', frame: 0.7, aesthetic: 0.4 },
  ];
  const allIds = enriched.map((entry) => entry.id);
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({
      enriched,
      captionHits: allIds,
      frameTags: {
        favorite: ['frame/favorite'],
        kept: ['frame/eligible'],
        reviewed: ['frame/reviewed'],
        banned: ['frame/never-show'],
      },
    }),
    query: 'sunset',
    maxResults: 50,
  });

  assert.deepEqual(result.assetIds, ['favorite', 'kept', 'high-score', 'low-score', 'reviewed']);
});

test('excluded assets do not consume best-of collection headroom', async () => {
  // First two pages entirely blanket-excluded; eligible photos start on
  // page 3. Collection must read past the excluded head instead of counting
  // it toward the collect limit.
  const pages = [ids('x', 10), ids('x', 10, 11), ids('b', 10), ids('c', 10), ids('d', 10)];
  const all = pages.flat();
  const result = await searchBestOfAssets({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: all, captionHits: all }),
    query: 'skiing',
    maxResults: 5,
    excludedAssetIds: new Set(ids('x', 20)),
  });

  assert.equal(result.assets.length, 15); // full 3x headroom, all eligible
  assert.ok(result.assetIds.every((id) => !id.startsWith('x')));
  assert.equal(result.stats.droppedExcluded, 20);
  assert.equal(result.stats.cutoff, 'enough');
  // Excluded photos also must not vote on page density: two all-excluded
  // pages would otherwise read as a corroboration collapse and end the scan.
  assert.equal(result.stats.firstPageRate, 1);
});

test('previewSearch fills the cap when exclusions cover the leading pages', async () => {
  const pages = [ids('x', 10), ids('x', 10, 11), ids('b', 10)];
  const all = pages.flat();
  const excludedIds = ids('x', 20);
  const immich = fakeImmichPages(pages);
  immich.listTags = async () => [{ id: 'tag-never-show', value: 'frame/never-show' }];
  immich.searchMetadata = async (body) => {
    if (Array.isArray(body.tagIds) && body.tagIds.includes('tag-never-show')) {
      const start = (body.page - 1) * body.size;
      const pageIds = excludedIds.slice(start, start + body.size);
      return {
        assets: {
          items: pageIds.map((id) => ({ id })),
          nextPage: start + body.size < excludedIds.length ? body.page + 1 : null,
        },
      };
    }
    return { assets: { items: [], nextPage: null } };
  };

  const preview = await previewSearch({
    immich,
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: all, captionHits: all }),
    query: 'skiing',
    bestOf: true,
    includeAllResults: false,
    maxResults: 5,
  });

  // Before exclusion-aware collection this underfilled to 0: the loop
  // stopped at 3x the cap inside the excluded head, then the filter emptied it.
  assert.equal(preview.rankedCount, 5);
  assert.ok(preview.assets.every((asset) => !asset.id.startsWith('x')));
  assert.equal(preview.bestOf.droppedExcluded, 20);
});

test('best of rejects a page-cap cutoff instead of returning a destructive partial set', async () => {
  await assert.rejects(
    searchBestOfAssets({
      immich: fakeImmichPages([ids('a', 10), ids('b', 10)]),
      config: { searchPageSize: 10, maxSearchPages: 1 },
      enrichRepo: fakeEnrichRepo({ enriched: [], captionHits: [] }),
      query: 'skiing',
      maxResults: 50,
    }),
    (error) => error?.code === 'invalid_upstream_pagination' && /page traversal limit/.test(error.message),
  );
});

test('best of returns a non-reconciling prefix when an All-results traversal reaches its page cap', async () => {
  const firstPage = ids('a', 10);
  const result = await searchBestOfAssets({
    immich: fakeImmichPages([firstPage, ids('b', 10)]),
    config: { searchPageSize: 10, maxSearchPages: 1 },
    enrichRepo: fakeEnrichRepo({ enriched: firstPage, captionHits: firstPage }),
    query: 'skiing',
    maxResults: null,
  });

  assert.deepEqual(result.assetIds, firstPage);
  assert.equal(result.stats.cutoff, 'page-limit');
  assert.equal(result.truncated, true);
  assert.equal(result.reconciliationComplete, false);
});

test('createSmartAlbumJob best-of run stores the flag, ranks, caps, and reports stats', async () => {
  const pages = [ids('a', 10), ids('b', 10), ids('c', 10)];
  const all = pages.flat();
  const store = {
    jobs: [],
    async addJob(job) {
      this.jobs.push(job);
      return job;
    },
    async updateJob(jobId, updater) {
      const index = this.jobs.findIndex((job) => job.id === jobId);
      this.jobs[index] = { ...this.jobs[index], ...updater(this.jobs[index]) };
      return this.jobs[index];
    },
  };
  const added = [];
  const immich = fakeImmichPages(pages);
  immich.addAssetsToAlbum = async (albumId, assetIds) => {
    added.push(...assetIds);
    return assetIds.map(() => ({ success: true }));
  };

  const job = await createSmartAlbumJob({
    immich,
    store,
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: all, captionHits: all }),
    input: {
      query: 'skiing',
      albumName: 'Best skiing',
      smart: false,
      bestOf: true,
      intervalDays: 0,
      includeAllResults: false,
      maxResults: 6,
      filters: {},
    },
  });

  assert.equal(job.bestOf, true);
  assert.equal(added.length, 6);
  assert.equal(job.lastResult.rankedCount, 6);
  assert.equal(job.lastResult.bestOf.cutoff, 'enough');
  assert.ok(job.lastResult.bestOf.corroborated >= 6);
});

test('previewSearch reports best-of mode and stats', async () => {
  const pages = [ids('a', 10)];
  const preview = await previewSearch({
    immich: fakeImmichPages(pages),
    config: CONFIG,
    enrichRepo: fakeEnrichRepo({ enriched: ids('a', 10), captionHits: ids('a', 5) }),
    query: 'skiing',
    bestOf: true,
    includeAllResults: false,
    maxResults: 50,
  });

  assert.equal(preview.mode, 'best-of');
  assert.equal(preview.rankedCount, 5);
  assert.equal(preview.bestOf.droppedLowSignal, 5);
});

test('validateCreateRequest rejects best of without a text search', () => {
  const validation = validateCreateRequest({
    albumName: 'People only',
    bestOf: true,
    filters: { personIds: ['p1'] },
  });

  assert.match(validation.error, /Best of needs an Immich text search/);
});
