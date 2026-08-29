import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InsightsRepository } from '../../src/insights/repository.mjs';
import { InsightsCollector } from '../../src/insights/collector.mjs';

// A refresh must publish as ONE generation: the sweep swap, people, pairs,
// tags, the favorites count, and the snapshot land in a single transaction.
// These tests inject a fault (or a cancellation) after every phase and
// assert the previous generation stays fully intact — live sweep count,
// people_stats, and the snapshot meta together, never a mix of generations.

const CONFIG = {
  dbPath: '',
  sweepPageSize: 2,
  maxSweepPages: 100,
  refreshIntervalHours: 24,
  topPeople: 15,
  maxTagCounts: 250,
  statConcurrency: 2,
  favoritesTagId: 't-fav',
  favoritesTagValue: 'favorites',
};

function makeAsset(id, overrides = {}) {
  const { exifInfo: exifOverrides, ...assetOverrides } = overrides;
  return {
    id,
    type: 'IMAGE',
    isFavorite: false,
    isArchived: false,
    localDateTime: '2020-06-01T12:00:00.000Z',
    exifInfo: {
      dateTimeOriginal: '2020-06-01T12:00:00.000Z',
      city: 'San Francisco',
      state: 'California',
      country: 'United States',
      make: 'Apple',
      model: 'iPhone 12',
      lensModel: 'wide',
      fileSizeInByte: 1000,
      ...exifOverrides,
    },
    ...assetOverrides,
  };
}

class FakeImmich {
  constructor(assets, people, tags = [], tagCounts = {}) {
    this.assets = assets;
    this.people = people;
    this.tags = tags;
    this.tagCounts = tagCounts;
  }

  async searchMetadata({ page, size }) {
    const start = (page - 1) * size;
    const items = this.assets.slice(start, start + size);
    const nextPage = start + size < this.assets.length ? page + 1 : null;
    return { assets: { items, nextPage, total: this.assets.length, count: items.length } };
  }

  async getPeople({ page }) {
    if (page > 1) {
      return { people: [], total: this.people.length, hasNextPage: false };
    }
    return { people: this.people, total: this.people.length, hasNextPage: false };
  }

  async searchStatistics(body) {
    if (body.tagIds) {
      return { total: this.tagCounts[body.tagIds[0]] ?? 0 };
    }
    return { total: 0 };
  }

  async listTags() {
    return this.tags;
  }
}

async function withRepoAsync(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-insights-'));
  const repo = new InsightsRepository(join(dir, 'insights.sqlite'));
  try {
    return await work(repo, dir);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function waitForIdle(collector, timeoutMs = 5000) {
  const start = Date.now();
  while (collector.isRunning()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('collector did not finish in time');
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}

async function runOnce(repo, immich, config = CONFIG) {
  const collector = new InsightsCollector({ repo, immich, config });
  collector.start();
  await waitForIdle(collector);
  return collector;
}

// Everything a generation is made of, read from the live tables — the
// atomicity assertions compare this whole shape at once, so a run that
// commits some tables but not others can never slip through.
function captureGeneration(repo) {
  return {
    sweep: repo.sweepTotals(),
    people: repo.topPeople(50),
    pairs: repo.topPairs(50),
    tags: repo.topTags(50),
    knownTagIds: repo.getMeta('knownTagIds'),
    peopleTotals: repo.getMeta('peopleTotals'),
    favoritesTag: repo.getMeta('favoritesTag'),
    snapshot: repo.getMeta('snapshot'),
  };
}

function stagingTableCount(repo) {
  return repo.db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'")
    .get().n;
}

// Generation N: two people together on one asset, a leaf tag, a favorites
// tag — every derived table gets real rows to assert against.
function seedImmich() {
  return new FakeImmich(
    [
      makeAsset('a1', { people: [{ id: 'p1' }, { id: 'p2' }] }),
      makeAsset('a2', { people: [{ id: 'p1' }] }),
      makeAsset('a3'),
    ],
    [
      { id: 'p1', name: 'Alicia', isHidden: false },
      { id: 'p2', name: 'David', isHidden: false },
    ],
    [{ id: 't-leaf', name: 'activity', value: 'ai/activity', parentId: null }],
    { 't-leaf': 5, 't-fav': 7 },
  );
}

// Generation N+1 candidate: entirely different assets and people, so any
// partial commit is unmistakable in the assertions.
function nextImmich() {
  return new FakeImmich(
    [
      makeAsset('b1', { people: [{ id: 'p9' }] }),
      makeAsset('b2', { people: [{ id: 'p9' }] }),
    ],
    [{ id: 'p9', name: 'Noah', isHidden: false }],
    [{ id: 't-next', name: 'travel', value: 'ai/travel', parentId: null }],
    { 't-next': 3, 't-fav': 9 },
  );
}

async function seedGeneration(repo) {
  const collector = await runOnce(repo, seedImmich());
  assert.equal(collector.status().phase, 'done');
  const baseline = captureGeneration(repo);
  // Sanity: the seed produced a full generation to protect.
  assert.equal(baseline.sweep.assetsSwept, 3);
  assert.equal(baseline.people[0].name, 'Alicia');
  assert.equal(baseline.pairs[0].count, 1);
  assert.equal(baseline.tags[0].id, 't-leaf');
  assert.deepEqual(baseline.favoritesTag, { id: 't-fav', value: 'favorites', count: 7 });
  assert.ok(baseline.snapshot);
  return baseline;
}

// Run a doomed refresh and assert generation N survives it whole.
async function assertGenerationSurvives(repo, baseline, immich, expectedPhase = 'error') {
  const collector = new InsightsCollector({ repo, immich, config: CONFIG });
  immich.collector = collector; // for fault hooks that need cancel()
  collector.start();
  await waitForIdle(collector);
  assert.equal(collector.status().phase, expectedPhase);
  assert.deepEqual(captureGeneration(repo), baseline);
  assert.equal(stagingTableCount(repo), 0);
}

test('fault during the sweep leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    immich.searchMetadata = async ({ page }) => {
      if (page === 1) {
        return { assets: { items: [makeAsset('b1')], nextPage: 2 } };
      }
      throw new Error('immich exploded mid-sweep');
    };
    await assertGenerationSurvives(repo, baseline, immich);
  });
});

test('fault during the people phase leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    immich.getPeople = async () => {
      throw new Error('immich exploded listing people');
    };
    await assertGenerationSurvives(repo, baseline, immich);
  });
});

test('fault during the tags phase (after pairs) leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    immich.listTags = async () => {
      throw new Error('immich exploded listing tags');
    };
    await assertGenerationSurvives(repo, baseline, immich);
  });
});

test('fault during the favorites phase leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    const original = immich.searchStatistics.bind(immich);
    immich.searchStatistics = async (body) => {
      if (body.tagIds?.[0] === 't-fav') {
        throw new Error('immich exploded counting favorites');
      }
      return original(body);
    };
    await assertGenerationSurvives(repo, baseline, immich);
  });
});

test('fault inside the publish transaction rolls the entire generation back', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    // Fail at the very last write: the sweep swap, people, pairs, tags, and
    // favorites are already applied inside the transaction — the rollback
    // must take every one of them back out.
    const originalSetMeta = repo.setMeta.bind(repo);
    repo.setMeta = (key, value) => {
      if (key === 'snapshot') {
        throw new Error('disk exploded writing the snapshot');
      }
      return originalSetMeta(key, value);
    };
    await assertGenerationSurvives(repo, baseline, nextImmich());
    repo.setMeta = originalSetMeta;
  });
});

test('cancellation during the people phase leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    const original = immich.getPeople.bind(immich);
    immich.getPeople = async (options) => {
      immich.collector.cancel();
      return original(options);
    };
    await assertGenerationSurvives(repo, baseline, immich, 'cancelled');
  });
});

test('cancellation just before publish leaves the previous generation fully intact', async () => {
  await withRepoAsync(async (repo) => {
    const baseline = await seedGeneration(repo);
    const immich = nextImmich();
    const original = immich.searchStatistics.bind(immich);
    immich.searchStatistics = async (body) => {
      if (body.tagIds?.[0] === 't-fav') {
        // The favorites count is the last phase before publish; cancelling
        // here exercises the final pre-publish cancellation check.
        immich.collector.cancel();
      }
      return original(body);
    };
    await assertGenerationSurvives(repo, baseline, immich, 'cancelled');
  });
});

test('a successful refresh publishes every table and the snapshot at once', async () => {
  await withRepoAsync(async (repo) => {
    await seedGeneration(repo);
    const collector = await runOnce(repo, nextImmich());
    assert.equal(collector.status().phase, 'done');

    const next = captureGeneration(repo);
    // The whole generation moved together: sweep, derived tables, and meta.
    assert.equal(next.sweep.assetsSwept, 2);
    assert.deepEqual(next.people, [{ id: 'p9', name: 'Noah', count: 2 }]);
    assert.deepEqual(next.pairs, []); // Noah appears alone
    assert.deepEqual(next.tags, [{ id: 't-next', value: 'ai/travel', count: 3 }]);
    assert.deepEqual(next.peopleTotals, { named: 1, total: 1 });
    assert.deepEqual(next.favoritesTag, { id: 't-fav', value: 'favorites', count: 9 });
    assert.equal(next.snapshot.totals.assetsSwept, 2);
    assert.deepEqual(next.snapshot.people, [{ id: 'p9', name: 'Noah', count: 2 }]);
    assert.equal(stagingTableCount(repo), 0);
  });
});

test('pairs derived at publish time see the new generation, not the old one', async () => {
  await withRepoAsync(async (repo) => {
    await seedGeneration(repo);
    // p1 and p2 still exist but now share TWO assets — the pair count must
    // come from the just-swapped sweep, not the previous one.
    const immich = new FakeImmich(
      [
        makeAsset('c1', { people: [{ id: 'p1' }, { id: 'p2' }] }),
        makeAsset('c2', { people: [{ id: 'p1' }, { id: 'p2' }] }),
      ],
      [
        { id: 'p1', name: 'Alicia', isHidden: false },
        { id: 'p2', name: 'David', isHidden: false },
      ],
      [],
      { 't-fav': 1 },
    );
    const collector = await runOnce(repo, immich);
    assert.equal(collector.status().phase, 'done');
    assert.deepEqual(repo.topPairs(5), [
      { aId: 'p1', bId: 'p2', aName: 'Alicia', bName: 'David', count: 2 },
    ]);
    assert.deepEqual(collector.snapshot().pairs[0].count, 2);
  });
});

test('repository transactions are re-entrant and roll back as one', async () => {
  await withRepoAsync(async (repo) => {
    repo.replacePeople([{ id: 'p1', name: 'Alicia', assetCount: 1 }]);
    assert.throws(() => repo.transaction(() => {
      // replacePeople opens its own transaction — it must compose into this
      // one, and the outer failure must undo it.
      repo.replacePeople([{ id: 'p2', name: 'David', assetCount: 2 }]);
      assert.equal(repo.topPeople(5)[0].id, 'p2'); // inner write is visible
      throw new Error('outer failure');
    }), /outer failure/);
    assert.deepEqual(repo.topPeople(5), [{ id: 'p1', name: 'Alicia', count: 1 }]);
    // The depth counter reset: a fresh transaction still works.
    repo.transaction(() => repo.replacePeople([{ id: 'p3', name: 'Noah', assetCount: 3 }]));
    assert.equal(repo.topPeople(5)[0].id, 'p3');
  });
});
