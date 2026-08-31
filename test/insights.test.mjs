import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { InsightsRepository, MAX_INSIGHTS_KNOWN_TAGS } from '../src/insights/repository.mjs';
import {
  InsightsCollector,
  MAX_INSIGHTS_DECODED_BYTES_PER_ASSET,
  MAX_INSIGHTS_IDENTIFIER_LENGTH,
  MAX_INSIGHTS_METADATA_FIELD_BYTES,
  MAX_INSIGHTS_NESTED_ITEMS_PER_ASSET,
  MAX_INSIGHTS_PEOPLE_PER_ASSET,
  MIN_INSIGHTS_SWEEP_FREE_BYTES,
  computeSuperlatives,
  computeTrips,
  createInsightsSweepBudget,
  mapAsset,
} from '../src/insights/collector.mjs';
import { searchCitiesPage, resolveSliceAssetIds } from '../src/routes/insights.mjs';

const CONFIG = {
  dbPath: '',
  sweepPageSize: 2,
  maxSweepPages: 100,
  refreshIntervalHours: 24,
  topPeople: 15,
  maxTagCounts: 250,
  statConcurrency: 2,
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

function makeImmichPersonWithFace(index) {
  return {
    id: `person-${index}`,
    name: `Person ${index}`,
    birthDate: null,
    thumbnailPath: `upload/thumbs/person-${index}.jpeg`,
    isHidden: false,
    isFavorite: false,
    color: '#abcdef',
    updatedAt: '2026-01-01T00:00:00.000Z',
    faces: [{
      id: `face-${index}`,
      imageHeight: 3024,
      imageWidth: 4032,
      boundingBoxX1: 100,
      boundingBoxY1: 200,
      boundingBoxX2: 400,
      boundingBoxY2: 500,
      sourceType: 'machine-learning',
      personId: `person-${index}`,
    }],
  };
}

class FakeImmich {
  constructor(assets, people, pairCounts = {}, tags = [], tagCounts = {}) {
    this.assets = assets;
    this.people = people;
    this.pairCounts = pairCounts;
    this.tags = tags;
    this.tagCounts = tagCounts;
    this.searchStatisticsCalls = [];
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

  async getPersonStatistics(personId) {
    const person = this.people.find((entry) => entry.id === personId);
    return { assets: person?.count ?? 0 };
  }

  async searchStatistics(body) {
    this.searchStatisticsCalls.push(body);
    if (body.personIds) {
      const key = [...body.personIds].sort().join('+');
      return { total: this.pairCounts[key] ?? 0 };
    }
    if (body.tagIds) {
      return { total: this.tagCounts[body.tagIds[0]] ?? 0 };
    }
    return { total: 0 };
  }

  async listTags() {
    return this.tags;
  }
}

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-insights-'));
  const repo = new InsightsRepository(join(dir, 'insights.sqlite'));
  try {
    return work(repo, dir);
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runCollector(immich, { enrichRepo = null } = {}) {
  return withRepoAsync(async (repo) => {
    const collector = new InsightsCollector({ repo, immich, config: CONFIG, enrichRepo });
    collector.start();
    await waitForIdle(collector);
    return {
      snapshot: collector.snapshot(),
      status: collector.status(),
      knownTagIds: repo.getMeta('knownTagIds'),
      repo,
    };
  });
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

test('a failed sweep leaves the previous sweep and snapshot intact', async () => {
  await withRepoAsync(async (repo) => {
    const good = new FakeImmich([makeAsset('a1'), makeAsset('a2')], []);
    const first = new InsightsCollector({ repo, immich: good, config: CONFIG });
    first.start();
    await waitForIdle(first);
    assert.equal(first.status().phase, 'done');
    assert.equal(repo.sweepTotals().assetsSwept, 2);
    const goodSnapshot = repo.getMeta('snapshot');
    assert.ok(goodSnapshot);

    // Second refresh: one page lands, then Immich dies mid-sweep.
    const flaky = new FakeImmich([], []);
    flaky.searchMetadata = async ({ page }) => {
      if (page === 1) {
        return { assets: { items: [makeAsset('b1')], nextPage: 2 } };
      }
      throw new Error('immich exploded mid-sweep');
    };
    const second = new InsightsCollector({ repo, immich: flaky, config: CONFIG });
    second.start();
    await waitForIdle(second);
    assert.equal(second.status().phase, 'error');

    // The last good sweep and snapshot are fully intact — b1 never replaced
    // the library — and no staging tables linger.
    assert.equal(repo.sweepTotals().assetsSwept, 2);
    assert.deepEqual(repo.getMeta('snapshot'), goodSnapshot);
    const staging = repo.db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'")
      .get().n;
    assert.equal(staging, 0);
  });
});

test('a sweep that hits the page cap commits but is flagged truncated', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([makeAsset('a1'), makeAsset('a2'), makeAsset('a3')], []);
    const collector = new InsightsCollector({
      repo,
      immich,
      config: { ...CONFIG, sweepPageSize: 1, maxSweepPages: 2 },
    });
    collector.start();
    await waitForIdle(collector);
    assert.equal(collector.status().phase, 'done');
    assert.equal(collector.snapshot().sweepTruncated, true);
    assert.equal(repo.sweepTotals().assetsSwept, 2);
  });
});

test('collector rejects non-progressing asset pagination without publishing staging', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([], []);
    immich.searchMetadata = async () => ({
      assets: { items: [makeAsset('a1')], nextPage: 1 },
    });
    const collector = new InsightsCollector({ repo, immich, config: CONFIG });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /invalid or non-progressing next page/);
    assert.equal(collector.snapshot(), null);
    assert.equal(repo.sweepTotals().assetsSwept, 0);
  });
});

test('collector rejects an asset page larger than requested before staging insertion', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([], []);
    immich.searchMetadata = async () => ({
      assets: { items: [makeAsset('a1'), makeAsset('a2')], nextPage: null },
    });
    let insertCalls = 0;
    const originalInsert = repo.insertAssets.bind(repo);
    repo.insertAssets = (...args) => {
      insertCalls += 1;
      return originalInsert(...args);
    };
    const collector = new InsightsCollector({
      repo,
      immich,
      config: { ...CONFIG, sweepPageSize: 1 },
    });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /more than the requested 1 items/);
    assert.equal(insertCalls, 0);
    assert.equal(collector.snapshot(), null);
  });
});

test('collector people pagination stops at its aggregate page budget', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([makeAsset('a1')], []);
    let peopleCalls = 0;
    immich.getPeople = async () => {
      peopleCalls += 1;
      return { people: [{ id: 'p1', name: 'Alicia' }], total: 1, hasNextPage: true };
    };
    const collector = new InsightsCollector({ repo, immich, config: CONFIG });
    collector.start();
    await waitForIdle(collector);

    assert.equal(peopleCalls, 100);
    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /100-page traversal limit/);
    assert.equal(collector.snapshot(), null);
  });
});

test('mapAsset extracts sweep columns and tolerates missing exif', () => {
  const withPeople = mapAsset(makeAsset('a0', { people: [{ id: 'p1' }, { id: 'p1' }, { personId: 'p2' }, {}] }));
  assert.deepEqual(withPeople.personIds, ['p1', 'p2']);
  assert.deepEqual(mapAsset(makeAsset('a0b')).personIds, []);

  const full = mapAsset(makeAsset('a1', { exifInfo: { latitude: 37.77, longitude: -122.42 } }));
  assert.equal(full.year, 2020);
  assert.equal(full.day, '2020-06-01');
  assert.equal(full.city, 'San Francisco');
  assert.equal(full.fileSize, 1000);
  assert.equal(full.lat, 37.77);
  assert.equal(full.lon, -122.42);

  const bare = mapAsset({ id: 'a2', type: 'VIDEO' });
  assert.equal(bare.year, null);
  assert.equal(bare.day, null);
  assert.equal(bare.city, null);
  assert.equal(bare.fileSize, null);
  assert.equal(bare.lat, null);
  assert.equal(bare.lon, null);

  // Immich reports "no GPS" as null coordinates (and some cameras as 0,0);
  // Number(null) is 0, which would put 40k photos on Null Island.
  const noGps = mapAsset(makeAsset('a3', { exifInfo: { latitude: null, longitude: null } }));
  assert.equal(noGps.lat, null);
  assert.equal(noGps.lon, null);
  const zeroZero = mapAsset(makeAsset('a4', { exifInfo: { latitude: 0, longitude: 0 } }));
  assert.equal(zeroZero.lat, null);
  assert.equal(zeroZero.lon, null);
});

test('asset metadata and relationships enforce exact per-asset boundaries before persistence', () => {
  const exactlyMaxPeople = Array.from(
    { length: MAX_INSIGHTS_PEOPLE_PER_ASSET },
    (_, index) => makeImmichPersonWithFace(index),
  );
  const budget = createInsightsSweepBudget();
  const mapped = mapAsset(makeAsset('bounded-asset', { people: exactlyMaxPeople }), { budget });
  assert.equal(mapped.personIds.length, MAX_INSIGHTS_PEOPLE_PER_ASSET);
  assert.equal(mapped.omittedPeopleRelationships, 0);
  assert.equal(budget.status().nestedItems, 108);
  assert.equal(budget.status().generatedRows, 1 + MAX_INSIGHTS_PEOPLE_PER_ASSET);

  const barePersonBudget = createInsightsSweepBudget();
  const expandedPersonBudget = createInsightsSweepBudget();
  mapAsset(makeAsset('same-person-id', { people: [{ id: 'p1' }] }), { budget: barePersonBudget });
  const expandedPerson = mapAsset(makeAsset('same-person-id', {
    people: [{
      id: 'p1',
      detail: Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [`field${index}`, index])),
    }],
  }), { budget: expandedPersonBudget });
  assert.deepEqual(expandedPerson.personIds, ['p1']);
  assert.deepEqual(
    expandedPersonBudget.status(),
    barePersonBudget.status(),
    'unused PersonWithFaces fields do not consume the retained-data sweep budget',
  );

  const duplicateBudget = createInsightsSweepBudget();
  const duplicateMapped = mapAsset(makeAsset('duplicate-people', {
    people: Array.from({ length: MAX_INSIGHTS_PEOPLE_PER_ASSET }, () => ({ id: 'p1' })),
  }), { budget: duplicateBudget });
  assert.deepEqual(duplicateMapped.personIds, ['p1']);
  assert.equal(duplicateMapped.omittedPeopleRelationships, 0);
  assert.equal(duplicateBudget.status().generatedRows, 2, 'raw duplicates generate one relationship row');

  const crowd = mapAsset(makeAsset('crowd-photo', {
    people: Array.from(
      { length: MAX_INSIGHTS_PEOPLE_PER_ASSET + 250 },
      (_, index) => ({ id: `crowd-${index}` }),
    ),
  }));
  assert.equal(crowd.personIds.length, MAX_INSIGHTS_PEOPLE_PER_ASSET);
  assert.deepEqual(crowd.personIds, Array.from(
    { length: MAX_INSIGHTS_PEOPLE_PER_ASSET },
    (_, index) => `crowd-${index}`,
  ));
  assert.equal(crowd.omittedPeopleRelationships, 250);

  for (const row of [
    mapAsset(makeAsset('oversized-person-row', {
      people: [{ id: 'p1', name: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1) }],
    })),
    mapAsset(makeAsset('nested-person-row', {
      people: [{
        id: 'p1',
        detail: Object.fromEntries(
          Array.from({ length: MAX_INSIGHTS_NESTED_ITEMS_PER_ASSET + 1 }, (_, index) => [`field${index}`, index]),
        ),
      }],
    })),
    mapAsset(makeAsset('decoded-person-row', {
      people: [{
        id: 'p1',
        ...Object.fromEntries(
          Array.from({ length: 33 }, (_, index) => [`field${index}`, 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES)]),
        ),
      }],
    })),
  ]) {
    assert.deepEqual(row.personIds, ['p1']);
    assert.equal(row.omittedPeopleRelationships, 0);
  }
  assert.throws(
    () => mapAsset(makeAsset('invalid-person-id', { people: [{ id: 'not valid!' }] })),
    /invalid person relationship on asset invalid-person-id identifier/,
  );
  const unusedExif = Object.fromEntries(
    Array.from({ length: 256 }, (_, index) => [`unusedField${index}`, 'x'.repeat(8192)]),
  );
  const cleanBudget = createInsightsSweepBudget();
  const unusedBudget = createInsightsSweepBudget();
  mapAsset(makeAsset('same-size-id', { exifInfo: {} }), { budget: cleanBudget });
  const ignored = mapAsset(makeAsset('same-size-id', {
    exifInfo: {
      ...unusedExif,
      description: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1),
      profileDescription: 'y'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1),
    },
  }), { budget: unusedBudget });
  assert.equal(ignored.city, 'San Francisco');
  assert.deepEqual(
    unusedBudget.status(),
    cleanBudget.status(),
    'unused EXIF fields do not consume the retained-data sweep budget',
  );

  const exactUtf8 = '🙂'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES / 4);
  assert.equal(mapAsset(makeAsset('utf8-exact', { exifInfo: { city: exactUtf8 } })).city, exactUtf8);
  assert.throws(
    () => mapAsset(makeAsset('utf8-over', { exifInfo: { city: `${exactUtf8}🙂` } })),
    /oversized or empty city/,
  );
  assert.throws(
    () => mapAsset(makeAsset('malformed-city', { exifInfo: { city: { nested: true } } })),
    /invalid city on asset malformed-city/,
  );
  const malformedNumbers = mapAsset(makeAsset('malformed-numbers', {
    exifInfo: {
      latitude: 'north',
      longitude: 181,
      fileSizeInByte: 'unknown',
    },
  }));
  assert.equal(malformedNumbers.lat, null);
  assert.equal(malformedNumbers.lon, null);
  assert.equal(malformedNumbers.fileSize, null);
  assert.deepEqual(
    malformedNumbers.omittedMetadataFields,
    ['fileSizeInByte', 'latitude', 'longitude'],
  );

  for (const asset of [
    makeAsset('../bad'),
    makeAsset('bad id'),
    makeAsset('a'.repeat(MAX_INSIGHTS_IDENTIFIER_LENGTH + 1)),
    makeAsset('valid', { people: [{ id: 'bad person' }] }),
  ]) {
    assert.throws(() => mapAsset(asset), /invalid .* identifier/);
  }

});

test('collector publishes assets with oversized unused EXIF fields', async () => {
  await withRepoAsync(async (repo) => {
    const asset = makeAsset('long-unused-exif', {
      exifInfo: {
        description: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES * 4),
        profileDescription: 'y'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES * 4),
      },
    });
    const collector = new InsightsCollector({ repo, immich: new FakeImmich([asset], []), config: CONFIG });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'done');
    assert.equal(repo.sweepTotals().assetsSwept, 1);
    assert.deepEqual(collector.snapshot().metadataOmissions, { total: 0, fields: {} });
  });
});

test('collector keeps crowd photos, caps people relationships, and publishes a durable notice', async () => {
  await withRepoAsync(async (repo) => {
    const people = Array.from(
      { length: MAX_INSIGHTS_PEOPLE_PER_ASSET + 250 },
      (_, index) => ({ id: `crowd-${index}`, name: `Person ${index}` }),
    );
    const messages = [];
    const collector = new InsightsCollector({
      repo,
      immich: new FakeImmich([makeAsset('crowd', { people }), makeAsset('neighbor')], []),
      config: CONFIG,
      log: (message) => messages.push(message),
    });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'done');
    assert.equal(collector.status().progress.peopleRelationshipsOmitted, 250);
    assert.equal(repo.sweepTotals().assetsSwept, 2);
    assert.deepEqual(collector.snapshot().peopleTruncation, {
      assets: 1,
      relationshipsOmitted: 250,
      perAssetLimit: MAX_INSIGHTS_PEOPLE_PER_ASSET,
    });
    assert.ok(messages.some((message) => /limited people relationships on 1 asset.*250 relationship entries/.test(message)));
  });
});

test('collector omits malformed numeric EXIF, counts it, and still publishes every asset', async () => {
  await withRepoAsync(async (repo) => {
    const assets = [
      makeAsset('invalid-numbers', {
        exifInfo: { latitude: 'north', longitude: 181, fileSizeInByte: 'unknown' },
      }),
      makeAsset('valid-neighbor'),
    ];
    const messages = [];
    const collector = new InsightsCollector({
      repo,
      immich: new FakeImmich(assets, []),
      config: CONFIG,
      log: (message) => messages.push(message),
    });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'done');
    assert.equal(collector.status().progress.metadataOmissions, 3);
    assert.equal(repo.sweepTotals().assetsSwept, 2);
    assert.deepEqual(collector.snapshot().metadataOmissions, {
      total: 3,
      fields: { fileSizeInByte: 1, latitude: 1, longitude: 1 },
    });
    assert.ok(messages.some((message) => /omitted 3 invalid metadata values/.test(message)));
  });
});

test('collector names malformed used EXIF fields and removes staging without replacing a snapshot', async () => {
  await withRepoAsync(async (repo) => {
    const seed = new InsightsCollector({ repo, immich: new FakeImmich([makeAsset('old')], []), config: CONFIG });
    seed.start();
    await waitForIdle(seed);
    const baseline = repo.getMeta('snapshot');

    const malformed = makeAsset('bad-city', {
      exifInfo: { city: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1) },
    });
    const collector = new InsightsCollector({ repo, immich: new FakeImmich([malformed], []), config: CONFIG });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /oversized or empty city on asset bad-city/);
    assert.deepEqual(repo.getMeta('snapshot'), baseline);
    assert.equal(repo.sweepTotals().assetsSwept, 1);
    const staging = repo.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'").get().n;
    assert.equal(staging, 0);
  });
});

test('aggregate Insights sweep budgets reject before the failing page write and clean staging', async () => {
  const cases = [
    {
      label: 'generated rows',
      assets: [
        { id: 'b1', type: 'IMAGE', people: [{ id: 'p1' }, { id: 'p2' }] },
        { id: 'b2', type: 'IMAGE', people: [{ id: 'p1' }, { id: 'p2' }] },
      ],
      limits: { maxNestedItems: 100, maxDecodedBytes: 10_000, maxGeneratedRows: 5 },
      error: /5-generated-row limit/,
    },
    {
      label: 'decoded bytes',
      assets: [{ id: 'b1', type: 'IMAGE' }, { id: 'b2', type: 'IMAGE' }],
      limits: { maxNestedItems: 100, maxDecodedBytes: 10, maxGeneratedRows: 100 },
      error: /10-decoded-byte limit/,
    },
    {
      label: 'nested items',
      assets: [
        { id: 'b1', type: 'IMAGE', exifInfo: { city: 'x' } },
        { id: 'b2', type: 'IMAGE', exifInfo: { city: 'y' } },
      ],
      limits: { maxNestedItems: 1, maxDecodedBytes: 10_000, maxGeneratedRows: 100 },
      error: /1-nested-item limit/,
    },
  ];

  for (const entry of cases) {
    await withRepoAsync(async (repo) => {
      const seed = new InsightsCollector({ repo, immich: new FakeImmich([makeAsset('old')], []), config: CONFIG });
      seed.start();
      await waitForIdle(seed);
      const baseline = repo.getMeta('snapshot');
      assert.ok(baseline, `${entry.label}: baseline`);

      const immich = new FakeImmich(entry.assets, []);
      let stagingInsertCalls = 0;
      const originalInsert = repo.insertAssets.bind(repo);
      repo.insertAssets = (rows, options) => {
        if (options?.staging) stagingInsertCalls += 1;
        return originalInsert(rows, options);
      };
      const collector = new InsightsCollector({
        repo,
        immich,
        config: { ...CONFIG, sweepPageSize: 1 },
        sweepBudgetLimits: entry.limits,
      });
      collector.start();
      await waitForIdle(collector);

      assert.equal(collector.status().phase, 'error', entry.label);
      assert.match(collector.status().error, entry.error);
      assert.equal(stagingInsertCalls, 1, `${entry.label}: only the first admitted page reaches SQLite`);
      assert.deepEqual(repo.getMeta('snapshot'), baseline, `${entry.label}: last good snapshot survives`);
      assert.equal(repo.sweepTotals().assetsSwept, 1, `${entry.label}: last good sweep survives`);
      const staging = repo.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'").get().n;
      assert.equal(staging, 0, `${entry.label}: staging is removed`);
    });
  }
});

test('people directory identifiers and names share the sweep budget', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([makeAsset('a1')], [{ id: 'bad person', name: 'Alicia' }]);
    const collector = new InsightsCollector({ repo, immich, config: CONFIG });
    collector.start();
    await waitForIdle(collector);
    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /invalid person identifier/);
    assert.equal(collector.snapshot(), null);
    const staging = repo.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'").get().n;
    assert.equal(staging, 0);
  });
});

test('hidden and duplicate people directory rows cannot escape decoded-byte accounting', async () => {
  const cases = [
    {
      people: [{ id: 'p1', name: '', isHidden: true, detail: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1) }],
      limits: null,
      error: /oversized people directory row/,
    },
    {
      people: [
        { id: 'p1', name: 'A', isHidden: false },
        { id: 'p1', name: 'A', isHidden: false },
      ],
      limits: { maxNestedItems: 100, maxDecodedBytes: 50, maxGeneratedRows: 100 },
      error: /50-decoded-byte limit/,
    },
  ];
  for (const entry of cases) {
    await withRepoAsync(async (repo) => {
      const immich = new FakeImmich([{ id: 'a1', type: 'IMAGE' }], entry.people);
      const collector = new InsightsCollector({
        repo,
        immich,
        config: CONFIG,
        sweepBudgetLimits: entry.limits,
      });
      collector.start();
      await waitForIdle(collector);
      assert.equal(collector.status().phase, 'error');
      assert.match(collector.status().error, entry.error);
      assert.equal(collector.snapshot(), null);
      const staging = repo.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_staging'").get().n;
      assert.equal(staging, 0);
    });
  }
});

test('insufficient filesystem headroom refuses before staging and preserves the live generation', async () => {
  await withRepoAsync(async (repo) => {
    const seed = new InsightsCollector({ repo, immich: new FakeImmich([makeAsset('old')], []), config: CONFIG });
    seed.start();
    await waitForIdle(seed);
    const baseline = repo.getMeta('snapshot');
    assert.ok(baseline);

    let beginCalls = 0;
    let insertCalls = 0;
    const originalBegin = repo.beginSweepStaging.bind(repo);
    const originalInsert = repo.insertAssets.bind(repo);
    repo.beginSweepStaging = () => {
      beginCalls += 1;
      return originalBegin();
    };
    repo.insertAssets = (...args) => {
      insertCalls += 1;
      return originalInsert(...args);
    };
    const collector = new InsightsCollector({
      repo,
      immich: new FakeImmich([makeAsset('new')], []),
      config: CONFIG,
      diskFreeBytes: () => BigInt(MIN_INSIGHTS_SWEEP_FREE_BYTES - 1),
    });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'error');
    assert.match(collector.status().error, /live, staging, indexed publish, and WAL headroom/);
    assert.equal(beginCalls, 0);
    assert.equal(insertCalls, 0);
    assert.deepEqual(repo.getMeta('snapshot'), baseline);
    assert.equal(repo.sweepTotals().assetsSwept, 1);
  });
});

test('repository aggregates: totals, histogram, places, cameras, dark matter', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1')),
      mapAsset(makeAsset('a2', { exifInfo: { dateTimeOriginal: '2021-01-01T00:00:00.000Z' } })),
      mapAsset(makeAsset('a3', { type: 'VIDEO', isFavorite: true })),
      mapAsset({ id: 'a4', type: 'IMAGE' }), // no exif at all
    ]);

    const totals = repo.sweepTotals();
    assert.equal(totals.assetsSwept, 4);
    assert.equal(totals.photos, 3);
    assert.equal(totals.videos, 1);
    assert.equal(totals.favorites, 1);
    assert.equal(totals.storageBytes, 3000);

    const years = repo.yearHistogram();
    assert.deepEqual(years, [
      { year: 2020, count: 2 },
      { year: 2021, count: 1 },
    ]);

    assert.equal(repo.topPlaces(5).cities[0].name, 'San Francisco');
    assert.equal(repo.topPlaces(5).cities[0].count, 3);
    assert.equal(repo.topCameras(5)[0].name, 'Apple iPhone 12');

    const dark = repo.darkMatter();
    assert.equal(dark.noLocation, 1);
    assert.equal(dark.noCamera, 1);
  });
});

test('superlatives: busiest day/month, longest gap, oldest, furthest from home', () => {
  withRepo((repo) => {
    const sf = { latitude: 37.77, longitude: -122.42 };
    repo.insertAssets([
      // Three photos on one SF day → busiest day, and SF is home.
      mapAsset(makeAsset('a1', { exifInfo: { dateTimeOriginal: '2020-06-01T10:00:00.000Z', ...sf } })),
      mapAsset(makeAsset('a2', { exifInfo: { dateTimeOriginal: '2020-06-01T11:00:00.000Z', ...sf } })),
      mapAsset(makeAsset('a3', { exifInfo: { dateTimeOriginal: '2020-06-01T12:00:00.000Z', ...sf } })),
      // A Tokyo photo far away, after a long gap.
      mapAsset(makeAsset('a4', {
        exifInfo: {
          dateTimeOriginal: '2020-09-01T12:00:00.000Z',
          city: 'Tokyo',
          country: 'Japan',
          latitude: 35.68,
          longitude: 139.69,
        },
      })),
      // The oldest photo; a pre-1900 garbage date must not win.
      mapAsset(makeAsset('a5', { exifInfo: { dateTimeOriginal: '1999-03-12T09:00:00.000Z', ...sf } })),
      mapAsset(makeAsset('a6', { exifInfo: { dateTimeOriginal: '1899-01-01T00:00:00.000Z' } })),
    ]);

    const superlatives = computeSuperlatives(repo);
    assert.deepEqual(superlatives.busiestDay, { day: '2020-06-01', count: 3 });
    assert.equal(superlatives.busiestMonth.month, '2020-06');
    assert.equal(superlatives.oldest.id, 'a5');
    // 1999-03-12 → 2020-06-01 is the longest stretch without photos.
    assert.equal(superlatives.longestGap.from, '1999-03-12');
    assert.equal(superlatives.longestGap.to, '2020-06-01');
    assert.equal(superlatives.home.city, 'San Francisco');
    assert.equal(superlatives.furthest.city, 'Tokyo');
    // SF → Tokyo is ~8,270 km.
    assert.ok(superlatives.furthest.distanceKm > 8000 && superlatives.furthest.distanceKm < 8600);
  });
});

test('yearDetail aggregates months, places, and busiest day for one year', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1', { exifInfo: { dateTimeOriginal: '2020-06-01T10:00:00.000Z' } })),
      mapAsset(makeAsset('a2', { exifInfo: { dateTimeOriginal: '2020-06-01T11:00:00.000Z' } })),
      mapAsset(makeAsset('a3', { isFavorite: true, exifInfo: { dateTimeOriginal: '2020-07-04T11:00:00.000Z', city: 'Tokyo', country: 'Japan' } })),
      mapAsset(makeAsset('a4', { exifInfo: { dateTimeOriginal: '2021-01-01T00:00:00.000Z' } })),
    ]);

    const detail = repo.yearDetail(2020);
    assert.equal(detail.count, 3);
    assert.equal(detail.favorites, 1);
    assert.deepEqual(detail.months, [
      { month: 6, count: 2 },
      { month: 7, count: 1 },
    ]);
    assert.equal(detail.cities[0].name, 'San Francisco');
    assert.deepEqual(detail.busiestDay, { day: '2020-06-01', count: 2 });
    assert.equal(repo.yearDetail(1980).count, 0);
  });
});

test('v1 insights databases gain day/lat/lon columns on open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-insights-'));
  const dbPath = join(dir, 'insights.sqlite');
  try {
    // Build a v1-shaped table, then reopen through the repository.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE swept_assets (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, taken_at TEXT, year INTEGER,
      city TEXT, state TEXT, country TEXT, make TEXT, model TEXT, lens TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0, file_size INTEGER
    )`);
    legacy.exec("INSERT INTO swept_assets (id, type) VALUES ('old1', 'IMAGE')");
    legacy.close();

    const repo = new InsightsRepository(dbPath);
    repo.insertAssets([mapAsset(makeAsset('new1', { exifInfo: { latitude: 1, longitude: 2 } }))]);
    assert.equal(repo.sweepTotals().assetsSwept, 2);
    assert.equal(repo.geoRows().length, 1);
    repo.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('collector end-to-end: sweep pages, named people from join table, pairs, leaf tags', async () => {
  // p1 appears in 3 assets, p2 in 2, together in 2. p3 (unnamed) and
  // p4 (hidden) appear but must not surface anywhere.
  const assets = [
    makeAsset('a1', { people: [{ id: 'p1' }, { id: 'p2' }] }),
    makeAsset('a2', { people: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }),
    makeAsset('a3', { people: [{ id: 'p1' }, { id: 'p4' }] }),
    makeAsset('a4', { people: [] }),
    makeAsset('a5'),
  ];
  const people = [
    { id: 'p1', name: 'Alicia', isHidden: false },
    { id: 'p2', name: 'David', isHidden: false },
    { id: 'p3', name: '', isHidden: false }, // unnamed cluster: excluded
    { id: 'p4', name: 'Hidden', isHidden: true }, // hidden: excluded
  ];
  const tags = [
    { id: 't-parent', name: 'ai', value: 'ai', parentId: null },
    { id: 't-leaf', name: 'activity', value: 'ai/activity', parentId: 't-parent' },
  ];
  const immich = new FakeImmich(assets, people, {}, tags, { 't-leaf': 7 });

  const { snapshot, status, knownTagIds } = await runCollector(immich);

  assert.equal(status.phase, 'done');
  assert.equal(snapshot.totals.assetsSwept, 5);
  assert.equal(snapshot.totals.peopleNamed, 2);
  assert.deepEqual(snapshot.people[0], { id: 'p1', name: 'Alicia', count: 3 });
  assert.deepEqual(snapshot.people[1], { id: 'p2', name: 'David', count: 2 });
  assert.deepEqual(snapshot.pairs[0], { aId: 'p1', bId: 'p2', aName: 'Alicia', bName: 'David', count: 2 });
  // No per-person or per-pair statistics calls anymore — only the tag count.
  assert.deepEqual(immich.searchStatisticsCalls.map((call) => Object.keys(call)[0]), ['tagIds']);
  // Only the leaf tag was counted, never the parent.
  assert.deepEqual(snapshot.tags, [{ id: 't-leaf', value: 'ai/activity', count: 7 }]);
  // The validation directory retains both kinds so every tag shown by the
  // UI remains eligible for a live lens, without making the parent a tile.
  assert.deepEqual(knownTagIds, ['t-parent', 't-leaf']);
  // The constellation ships in the snapshot with faces and weighted edges.
  assert.deepEqual(snapshot.graph.nodes.map((node) => node.id), ['p1', 'p2']);
  assert.deepEqual(snapshot.graph.edges, [{ a: 'p1', b: 'p2', count: 2 }]);
});

test('repository per-year lenses: person, place, and people-for-year', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2019-05-01T00:00:00.000Z' } })),
      mapAsset(makeAsset('a2', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2019-06-01T00:00:00.000Z' } })),
      mapAsset(makeAsset('a3', { people: [{ id: 'p1' }, { id: 'p2' }], exifInfo: { dateTimeOriginal: '2020-01-01T00:00:00.000Z', city: 'Tokyo' } })),
      mapAsset(makeAsset('a4', { exifInfo: { dateTimeOriginal: '2020-02-01T00:00:00.000Z' } })),
    ]);
    repo.replacePeople([
      { id: 'p1', name: 'Alicia', assetCount: 3 },
      { id: 'p2', name: 'David', assetCount: 1 },
    ]);

    assert.deepEqual(repo.personYearHistogram('p1'), [
      { year: 2019, count: 2 },
      { year: 2020, count: 1 },
    ]);
    assert.deepEqual(repo.placeYearHistogram({ city: 'San Francisco' }), [
      { year: 2019, count: 2 },
      { year: 2020, count: 1 },
    ]);
    assert.deepEqual(repo.peopleForYear(2020, 5), [
      { id: 'p1', name: 'Alicia', count: 1 },
      { id: 'p2', name: 'David', count: 1 },
    ]);
    assert.deepEqual([...repo.personCountsFor(['p1', 'p2']).entries()], [['p1', 3], ['p2', 1]]);
  });
});

test('repository month drill: monthDetail and peopleForMonth scope to one month', () => {
  withRepo((repo) => {
    repo.insertAssets([
      // Two Paris photos in May 2019 (p1 in both, p2 in one)...
      mapAsset(makeAsset('a1', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2019-05-02T00:00:00.000Z', city: 'Paris', country: 'France' } })),
      mapAsset(makeAsset('a2', { people: [{ id: 'p1' }, { id: 'p2' }], exifInfo: { dateTimeOriginal: '2019-05-20T00:00:00.000Z', city: 'Paris', country: 'France' } })),
      // ...a June 2019 photo and a May 2020 photo, both out of scope.
      mapAsset(makeAsset('a3', { people: [{ id: 'p2' }], exifInfo: { dateTimeOriginal: '2019-06-01T00:00:00.000Z' } })),
      mapAsset(makeAsset('a4', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2020-05-05T00:00:00.000Z', city: 'Paris', country: 'France' } })),
    ]);
    repo.replacePeople([
      { id: 'p1', name: 'Alicia', assetCount: 3 },
      { id: 'p2', name: 'David', assetCount: 2 },
    ]);

    const detail = repo.monthDetail(2019, 5);
    assert.equal(detail.count, 2);
    assert.equal(detail.cities.length, 1);
    assert.equal(detail.cities[0].name, 'Paris');
    assert.equal(detail.cities[0].count, 2);
    assert.deepEqual(repo.peopleForMonth(2019, 5, 5), [
      { id: 'p1', name: 'Alicia', count: 2 },
      { id: 'p2', name: 'David', count: 1 },
    ]);
    // Neighboring month and same month of another year stay separate.
    assert.equal(repo.monthDetail(2019, 6).count, 1);
    assert.deepEqual(repo.peopleForMonth(2019, 6, 5), [{ id: 'p2', name: 'David', count: 1 }]);
    assert.equal(repo.monthDetail(2020, 5).count, 1);
    // An empty month answers with empty lists, not an error.
    assert.equal(repo.monthDetail(2019, 7).count, 0);
    assert.deepEqual(repo.monthDetail(2019, 7).cities, []);
    assert.deepEqual(repo.peopleForMonth(2019, 7, 5), []);
  });
});

test('known tag directory bounds membership and clears prior-generation lens cache', () => {
  withRepo((repo) => {
    repo.replaceTags([{ id: 'counted-before-directory', value: 'old/tag', count: 2 }]);
    assert.equal(repo.hasKnownTag('counted-before-directory'), true);

    repo.replaceKnownTagIds(['known-a', 'known-a', 'x'.repeat(129)]);
    assert.equal(repo.hasKnownTag('known-a'), true);
    assert.equal(repo.hasKnownTag('unknown'), false);
    assert.equal(repo.hasKnownTag('x'.repeat(129)), false);

    repo.setMeta('tagLens:known-a', { generatedAt: 'old', years: [{ year: 2020, count: 1 }] });
    repo.replaceKnownTagIds(['known-b']);
    assert.equal(repo.getMeta('tagLens:known-a'), null);
    assert.equal(repo.hasKnownTag('known-a'), false);
    assert.equal(repo.hasKnownTag('known-b'), true);

    repo.replaceKnownTagIds(Array.from({ length: MAX_INSIGHTS_KNOWN_TAGS + 2 }, (_, index) => `tag-${index}`));
    assert.equal(repo.getMeta('knownTagIds').length, MAX_INSIGHTS_KNOWN_TAGS);
    assert.equal(repo.hasKnownTag(`tag-${MAX_INSIGHTS_KNOWN_TAGS + 1}`), false);
  });
});

test('disabling tag statistics still publishes the validation directory', async () => {
  const tags = [
    { id: 'parent', value: 'parent', parentId: null },
    { id: 'leaf', value: 'parent/leaf', parentId: 'parent' },
  ];
  const immich = new FakeImmich([makeAsset('a1')], [], {}, tags, { leaf: 7 });

  await withRepoAsync(async (repo) => {
    const collector = new InsightsCollector({ repo, immich, config: { ...CONFIG, maxTagCounts: 0 } });
    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'done');
    assert.deepEqual(collector.snapshot().tags, []);
    assert.equal(repo.hasKnownTag('parent'), true);
    assert.equal(repo.hasKnownTag('leaf'), true);
    assert.deepEqual(immich.searchStatisticsCalls, []);
  });
});

test('personDetail: span, top places, ranked connections, per-year counts', () => {
  withRepo((repo) => {
    repo.insertAssets([
      // p1 with p2 twice (Tokyo), with p3 once (SF), alone once; one garbage
      // pre-1900 date that must not pollute the span.
      mapAsset(makeAsset('a1', { people: [{ id: 'p1' }, { id: 'p2' }], exifInfo: { dateTimeOriginal: '2019-05-02T00:00:00.000Z', city: 'Tokyo' } })),
      mapAsset(makeAsset('a2', { people: [{ id: 'p1' }, { id: 'p2' }], exifInfo: { dateTimeOriginal: '2019-06-01T00:00:00.000Z', city: 'Tokyo' } })),
      mapAsset(makeAsset('a3', { people: [{ id: 'p1' }, { id: 'p3' }], exifInfo: { dateTimeOriginal: '2021-01-05T00:00:00.000Z' } })),
      mapAsset(makeAsset('a4', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '1899-01-01T00:00:00.000Z', city: null } })),
      // p4 is unnamed (not in people_stats): appears with p1 but must not
      // surface as a connection.
      mapAsset(makeAsset('a5', { people: [{ id: 'p1' }, { id: 'p4' }], exifInfo: { dateTimeOriginal: '2021-02-01T00:00:00.000Z' } })),
    ]);
    repo.replacePeople([
      { id: 'p1', name: 'Alicia', assetCount: 5 },
      { id: 'p2', name: 'David', assetCount: 2 },
      { id: 'p3', name: 'Noah', assetCount: 1 },
    ]);

    const detail = repo.personDetail('p1');
    assert.equal(detail.name, 'Alicia');
    assert.equal(detail.count, 5);
    assert.equal(detail.firstDay, '2019-05-02');
    assert.equal(detail.lastDay, '2021-02-01');
    assert.deepEqual(detail.places, [
      { name: 'San Francisco', count: 2 },
      { name: 'Tokyo', count: 2 },
    ]);
    assert.deepEqual(detail.connections, [
      { id: 'p2', name: 'David', count: 2 },
      { id: 'p3', name: 'Noah', count: 1 },
    ]);
    assert.deepEqual(detail.years, [
      { year: 1899, count: 1 },
      { year: 2019, count: 2 },
      { year: 2021, count: 2 },
    ]);
    // Connection list honors its limit.
    assert.deepEqual(repo.personDetail('p1', 1).connections, [{ id: 'p2', name: 'David', count: 2 }]);
    // Unknown or unnamed people have no card.
    assert.equal(repo.personDetail('p4'), null);
    assert.equal(repo.personDetail('nope'), null);
  });
});

test('location groups relabel every city aggregate without touching the sweep', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1', { exifInfo: { dateTimeOriginal: '2019-03-01T00:00:00.000Z' } })), // San Francisco
      mapAsset(makeAsset('a2', { exifInfo: { dateTimeOriginal: '2019-03-01T12:00:00.000Z', city: 'Burlingame' } })),
      mapAsset(makeAsset('a3', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2020-07-01T00:00:00.000Z', city: 'Burlingame' } })),
      mapAsset(makeAsset('a4', { exifInfo: { dateTimeOriginal: '2020-08-01T00:00:00.000Z', city: 'Tokyo', country: 'Japan' } })),
    ]);
    repo.replacePeople([{ id: 'p1', name: 'Alicia', assetCount: 1 }]);
    repo.setLocationGroups([{ name: 'Bay Area', cities: ['San Francisco', 'Burlingame'] }]);

    // Leaderboard: members merge under the group label, marked synthetic.
    assert.deepEqual(repo.topPlaces(5).cities, [
      { name: 'Bay Area', count: 3, isGroup: true, members: ['San Francisco', 'Burlingame'] },
      { name: 'Tokyo', count: 1 },
    ]);
    // Lens matches the group label.
    assert.deepEqual(repo.placeYearHistogram({ city: 'Bay Area' }), [
      { year: 2019, count: 2 },
      { year: 2020, count: 1 },
    ]);
    // Year drill-down cities are grouped.
    assert.deepEqual(repo.yearDetail(2019).cities, [
      { name: 'Bay Area', count: 2, isGroup: true, members: ['San Francisco', 'Burlingame'] },
    ]);
    // Timeline day labels are grouped (both 2019-03-01 photos → one label).
    const day = repo.timelineDays().find((entry) => entry.day === '2019-03-01');
    assert.equal(day.city, 'Bay Area');
    assert.equal(day.count, 2);
    // Person card places are grouped.
    assert.deepEqual(repo.personDetail('p1').places, [
      { name: 'Bay Area', count: 1, isGroup: true, members: ['San Francisco', 'Burlingame'] },
    ]);
    // Raw sweep rows are untouched; clearing groups restores raw cities.
    repo.setLocationGroups([]);
    assert.deepEqual(repo.topPlaces(5).cities.map((place) => place.name), ['Burlingame', 'San Francisco', 'Tokyo']); // count desc, then name
  });
});

test('timelinePlaces counts each photo under its own label, images only', () => {
  withRepo((repo) => {
    repo.insertAssets([
      // One day: 2 Kennebunkport images, 3 Portland images (Portland wins
      // the dominant-day contest), 1 country-only image, 1 image with no
      // location at all, 1 Kennebunkport video.
      mapAsset(makeAsset('k1', { exifInfo: { dateTimeOriginal: '2013-07-05T10:00:00.000Z', city: 'Kennebunkport' } })),
      mapAsset(makeAsset('k2', { exifInfo: { dateTimeOriginal: '2013-07-05T11:00:00.000Z', city: 'Kennebunkport' } })),
      mapAsset(makeAsset('p1', { exifInfo: { dateTimeOriginal: '2013-07-05T12:00:00.000Z', city: 'Portland' } })),
      mapAsset(makeAsset('p2', { exifInfo: { dateTimeOriginal: '2013-07-05T13:00:00.000Z', city: 'Portland' } })),
      mapAsset(makeAsset('p3', { exifInfo: { dateTimeOriginal: '2013-07-05T14:00:00.000Z', city: 'Portland' } })),
      mapAsset(makeAsset('c1', { exifInfo: { dateTimeOriginal: '2013-07-05T15:00:00.000Z', city: null, country: 'Canada' } })),
      mapAsset(makeAsset('n1', { exifInfo: { dateTimeOriginal: '2013-07-05T15:30:00.000Z', city: null, state: null, country: null } })),
      mapAsset(makeAsset('v1', { type: 'VIDEO', exifInfo: { dateTimeOriginal: '2013-07-05T16:00:00.000Z', city: 'Kennebunkport' } })),
      // A second Kennebunkport day, plus one outside the window.
      mapAsset(makeAsset('k3', { exifInfo: { dateTimeOriginal: '2013-07-08T10:00:00.000Z', city: 'Kennebunkport' } })),
      mapAsset(makeAsset('k4', { exifInfo: { dateTimeOriginal: '2014-01-01T10:00:00.000Z', city: 'Kennebunkport' } })),
    ]);

    const places = repo.timelinePlaces('2013-01-01', '2013-12-31');
    const byLabel = {};
    for (const row of places) {
      byLabel[row.label ?? 'No location'] = (byLabel[row.label ?? 'No location'] ?? 0) + row.count;
    }
    // The dominant-day rollup would hand Portland all 8 of July 5's photos;
    // per-place counts stay honest, and the video doesn't count. Photos
    // with no location at all get a NULL label so the list can show (and
    // open) a "No location" row.
    assert.deepEqual(byLabel, { Kennebunkport: 3, Portland: 3, Canada: 1, 'No location': 1 });
    assert.deepEqual(
      places.filter((row) => row.label === 'Kennebunkport').map((row) => row.day),
      ['2013-07-05', '2013-07-08'],
    );
    assert.equal(places.find((row) => row.label === 'Canada').isCity, false);
    assert.equal(places.find((row) => row.label === null).isCity, false);

    // Group labels apply here like everywhere else.
    repo.setLocationGroups([{ name: 'Maine Coast', cities: ['Kennebunkport', 'Portland'] }]);
    const grouped = repo.timelinePlaces('2013-01-01', '2013-12-31');
    assert.equal(grouped.filter((row) => row.label === 'Maine Coast').reduce((s, r) => s + r.count, 0), 6);
  });
});

test('citySummaries lists raw cities with region, centroid, and membership', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1', { exifInfo: { latitude: 37.77, longitude: -122.42 } })),
      mapAsset(makeAsset('a2', { exifInfo: { latitude: 37.79, longitude: -122.40 } })),
      mapAsset(makeAsset('a3', { exifInfo: { city: 'Tokyo', state: 'Tokyo', country: 'Japan' } })),
      mapAsset(makeAsset('a4', { exifInfo: { city: null } })),
    ]);
    repo.setLocationGroups([{ name: 'Bay Area', cities: ['San Francisco'] }]);
    const cities = repo.citySummaries();
    assert.deepEqual(cities.map((city) => city.name), ['San Francisco', 'Tokyo']);
    const sf = cities[0];
    assert.equal(sf.count, 2);
    assert.equal(sf.state, 'California');
    assert.equal(sf.country, 'United States');
    assert.ok(Math.abs(sf.lat - 37.78) < 0.001);
    assert.equal(sf.group, 'Bay Area');
    assert.equal(cities[1].group, null);
    assert.equal(cities[1].lat, null);
  });
});

test('placeDetail covers raw cities and group labels', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('a1', { people: [{ id: 'p1' }], exifInfo: { dateTimeOriginal: '2019-03-01T00:00:00.000Z' } })),
      mapAsset(makeAsset('a2', { people: [{ id: 'p1' }, { id: 'p2' }], exifInfo: { dateTimeOriginal: '2020-05-05T00:00:00.000Z', city: 'Burlingame' } })),
      mapAsset(makeAsset('a3', { people: [{ id: 'p2' }], exifInfo: { dateTimeOriginal: '2020-05-05T12:00:00.000Z', city: 'Burlingame' } })),
      mapAsset(makeAsset('a4', { exifInfo: { dateTimeOriginal: '2021-01-01T00:00:00.000Z', city: 'Tokyo', country: 'Japan' } })),
    ]);
    repo.replacePeople([
      { id: 'p1', name: 'Alicia', assetCount: 2 },
      { id: 'p2', name: 'David', assetCount: 2 },
    ]);
    repo.setLocationGroups([{ name: 'Bay Area', cities: ['San Francisco', 'Burlingame'] }]);

    const group = repo.placeDetail('Bay Area');
    assert.equal(group.isGroup, true);
    assert.equal(group.count, 3);
    assert.equal(group.firstDay, '2019-03-01');
    assert.equal(group.lastDay, '2020-05-05');
    assert.equal(group.country, 'United States');
    assert.deepEqual(group.years, [{ year: 2019, count: 1 }, { year: 2020, count: 2 }]);
    assert.deepEqual(group.people, [
      { id: 'p1', name: 'Alicia', count: 2 },
      { id: 'p2', name: 'David', count: 2 },
    ]);
    assert.deepEqual(group.busiestDay, { day: '2020-05-05', count: 2 });
    assert.deepEqual(group.members, [
      { name: 'Burlingame', count: 2 },
      { name: 'San Francisco', count: 1 },
    ]);

    const city = repo.placeDetail('Tokyo');
    assert.equal(city.isGroup, false);
    assert.equal(city.count, 1);
    assert.equal(city.members, null);
    assert.deepEqual(city.people, []);

    assert.equal(repo.placeDetail('Nowhere'), null);
  });
});

test('searchCitiesPage pages member cities sequentially, skipping empty ones', async () => {
  const byCity = { A: ['a1', 'a2', 'a3'], B: [], C: ['c1'] };
  const calls = [];
  const fake = {
    async searchMetadata({ city, page, size, cities }) {
      calls.push({ city, page, cities });
      const all = byCity[city] ?? [];
      const start = (page - 1) * size;
      const items = all.slice(start, start + size).map((id) => ({ id, type: 'IMAGE' }));
      return { assets: { items, nextPage: start + size < all.length ? page + 1 : null } };
    },
  };
  const filters = { cities: ['A', 'B', 'C'], personIds: ['p1'] };

  let result = await searchCitiesPage({ immich: fake, filters, cursor: undefined, size: 2 });
  assert.deepEqual(result.items.map((item) => item.id), ['a1', 'a2']);
  assert.deepEqual(result.nextPage, { ci: 0, p: 2 });

  result = await searchCitiesPage({ immich: fake, filters, cursor: result.nextPage, size: 2 });
  assert.deepEqual(result.items.map((item) => item.id), ['a3']);
  assert.deepEqual(result.nextPage, { ci: 1, p: 1 }); // A exhausted → hand off to B

  result = await searchCitiesPage({ immich: fake, filters, cursor: result.nextPage, size: 2 });
  assert.deepEqual(result.items.map((item) => item.id), ['c1']); // B empty, skipped inline
  assert.equal(result.nextPage, null);

  // The cities array itself never reaches Immich.
  assert.ok(calls.every((call) => call.cities === undefined));
});

test('slice filters forward explicit null city/country ("field unset") to Immich', async () => {
  const calls = [];
  const fake = {
    async searchMetadata(body) {
      calls.push(body);
      return { assets: { items: [{ id: 'x1', type: 'IMAGE' }], nextPage: null } };
    },
  };
  // A country-only location row: country set, city explicitly null.
  await resolveSliceAssetIds({ immich: fake, rawFilters: { country: 'Canada', city: null, make: null } });
  assert.equal(calls[0].country, 'Canada');
  assert.equal(calls[0].city, null);
  assert.ok('city' in calls[0]);
  assert.ok(!('make' in calls[0])); // null only means "unset" for location fields

  // The "No location" row: both null.
  await resolveSliceAssetIds({ immich: fake, rawFilters: { city: null, country: null, type: 'IMAGE' } });
  assert.equal(calls[1].city, null);
  assert.equal(calls[1].country, null);
  assert.equal(calls[1].type, 'IMAGE');
});

test('slice resolution rejects repeated and malformed upstream pagination', async () => {
  for (const nextPage of [1, 'not-a-page']) {
    const fake = {
      async searchMetadata() {
        return { assets: { items: [{ id: 'x1', type: 'IMAGE' }], nextPage } };
      },
    };
    await assert.rejects(
      resolveSliceAssetIds({ immich: fake, rawFilters: { city: 'Paris' } }),
      /invalid or non-progressing next page/,
    );
  }

  await assert.rejects(
    searchCitiesPage({
      immich: { async searchMetadata() { return { assets: { items: [], nextPage: 1 } }; } },
      filters: { cities: ['Paris'] },
      cursor: undefined,
      size: 100,
    }),
    /invalid or non-progressing next page/,
  );
});

test('computeTrips groups away days, tolerates gaps, and ends at home days', () => {
  const home = { lat: 37.77, lon: -122.42 };
  const sf = { lat: 37.77, lon: -122.42, city: 'San Francisco', country: 'USA' };
  const tokyo = { lat: 35.68, lon: 139.69, city: 'Tokyo', country: 'Japan' };
  const kyoto = { lat: 35.01, lon: 135.77, city: 'Kyoto', country: 'Japan' };
  const day = (d, place, count = 10) => ({ day: d, count, ...place });

  const days = [
    day('2022-11-01', sf),
    // Tokyo trip with a quiet gap day (11-04 no geo) and a Kyoto leg.
    day('2022-11-02', tokyo, 100),
    day('2022-11-03', tokyo, 80),
    day('2022-11-04', { lat: null, lon: null, city: null, country: null }, 5),
    day('2022-11-05', kyoto, 60),
    day('2022-11-06', tokyo, 40),
    day('2022-11-08', sf),
    // Single away day: below minDays, not a trip.
    day('2022-12-01', tokyo, 9),
    day('2022-12-02', sf),
    // Two trips separated by more than gapDays without a home day between.
    day('2023-01-01', tokyo, 20),
    day('2023-01-02', tokyo, 20),
    day('2023-01-20', kyoto, 30),
    day('2023-01-21', kyoto, 30),
  ];

  const trips = computeTrips(days, home, { awayKm: 100, gapDays: 3, minDays: 2 });
  assert.equal(trips.length, 3);
  // Newest first.
  assert.deepEqual(trips.map((trip) => [trip.start, trip.end, trip.city]), [
    ['2023-01-20', '2023-01-21', 'Kyoto'],
    ['2023-01-01', '2023-01-02', 'Tokyo'],
    ['2022-11-02', '2022-11-06', 'Tokyo'],
  ]);
  const tokyoTrip = trips[2];
  assert.equal(tokyoTrip.days, 5);
  // Includes the geo-less gap day's photos inside the window.
  assert.equal(tokyoTrip.photoCount, 100 + 80 + 5 + 60 + 40);
  assert.equal(tokyoTrip.country, 'Japan');
  assert.ok(tokyoTrip.maxDistanceKm > 8000);

  assert.deepEqual(computeTrips(days, null, {}), []);
});

test('mapAsset accepts valid calendar variants and omits impossible capture timestamps', () => {
  assert.deepEqual(
    [
      '2024-02-29T23:59:59.123Z',
      '1899-12-31T12:00:00-06:00',
      '2026-01-01T00:30:00+14:00',
      '2026-08-25T12:00:00',
    ].map((takenAt, index) => mapAsset(makeAsset(`valid-${index}`, {
      exifInfo: { dateTimeOriginal: takenAt },
    })).day),
    ['2024-02-29', '1899-12-31', '2026-01-01', '2026-08-25'],
  );

  const invalidTimestampStrings = [
    '2023-02-29T12:00:00Z',
    '2026-02-31T12:00:00Z',
    '2026-13-01T12:00:00Z',
    '2026-01-01T24:00:00Z',
    '2026-01-01T12:00:00+14:30',
    '2026-01-01 garbage',
  ];
  for (const [index, takenAt] of invalidTimestampStrings.entries()) {
    const mapped = mapAsset(makeAsset(`invalid-${index}`, {
      exifInfo: { dateTimeOriginal: takenAt },
    }));
    assert.equal(mapped.takenAt, null);
    assert.equal(mapped.day, null);
    assert.equal(mapped.year, null);
  }

  assert.throws(
    () => mapAsset(makeAsset('invalid-type', { exifInfo: { dateTimeOriginal: 20260101 } })),
    /invalid capture timestamp/,
  );
  assert.throws(
    () => mapAsset(makeAsset('oversized-date', {
      exifInfo: { dateTimeOriginal: 'x'.repeat(MAX_INSIGHTS_METADATA_FIELD_BYTES + 1) },
    })),
    /oversized (?:EXIF metadata|or empty capture time)/,
  );

  const missing = mapAsset(makeAsset('missing-date', {
    localDateTime: null,
    fileCreatedAt: null,
    exifInfo: { dateTimeOriginal: null },
  }));
  assert.equal(missing.takenAt, null);
  assert.equal(missing.day, null);
  assert.equal(missing.year, null);
});

test('collector publishes valid neighbors when one asset has an impossible capture date', async () => {
  await withRepoAsync(async (repo) => {
    const immich = new FakeImmich([
      makeAsset('invalid-date', {
        exifInfo: { dateTimeOriginal: '2026-02-31T12:00:00Z' },
      }),
      makeAsset('valid-date', {
        exifInfo: { dateTimeOriginal: '2026-02-28T12:00:00Z' },
      }),
    ], []);
    const collector = new InsightsCollector({ repo, immich, config: CONFIG });

    collector.start();
    await waitForIdle(collector);

    assert.equal(collector.status().phase, 'done');
    assert.equal(collector.snapshot().totals.assetsSwept, 2);
    assert.deepEqual(
      repo.db.prepare(`
        SELECT id, taken_at, year, day FROM swept_assets ORDER BY id
      `).all().map((row) => ({ ...row })),
      [
        { id: 'invalid-date', taken_at: null, year: null, day: null },
        { id: 'valid-date', taken_at: '2026-02-28T12:00:00Z', year: 2026, day: '2026-02-28' },
      ],
    );
  });
});

test('timeline and record-book aggregates ignore impossible restored days', () => {
  withRepo((repo) => {
    repo.insertAssets([
      mapAsset(makeAsset('valid-day', {
        exifInfo: { dateTimeOriginal: '2026-02-28T12:00:00Z', city: 'Tokyo' },
      })),
    ]);
    repo.db.prepare(`
      INSERT INTO swept_assets (id, type, taken_at, year, day, city, lat, lon)
      VALUES (?, 'IMAGE', ?, 2026, ?, 'Nowhere', 35, 139)
    `).run('legacy-invalid', '2026-02-31T12:00:00Z', '2026-02-31');

    assert.deepEqual(repo.timelineDays().map((entry) => entry.day), ['2026-02-28']);
    assert.deepEqual(repo.timelinePlaces('2026-02-01', '2026-03-31').map((entry) => entry.day), ['2026-02-28']);
    assert.deepEqual(repo.busiestDays().map((entry) => entry.day), ['2026-02-28']);
    assert.deepEqual(repo.busiestMonths().map((entry) => entry.month), ['2026-02']);
    assert.deepEqual(repo.distinctDays(), ['2026-02-28']);
    assert.equal(repo.oldestAsset().id, 'valid-day');
  });
});

test('computeTrips skips impossible legacy days without disrupting valid trips', () => {
  const home = { lat: 37.77, lon: -122.42 };
  const away = { lat: 35.68, lon: 139.69, city: 'Tokyo', country: 'Japan', count: 1 };
  const trips = computeTrips([
    { day: '2026-02-28', ...away },
    { day: '2026-02-31', ...away },
    { day: '2026-03-01', ...away },
  ], home, { minDays: 2 });
  assert.deepEqual(trips.map((trip) => [trip.start, trip.end, trip.days]), [
    ['2026-02-28', '2026-03-01', 2],
  ]);
});

test('timelineDays rolls up counts, dominant city, and dominant geo cell', () => {
  withRepo((repo) => {
    repo.insertAssets([
      // Two Tokyo photos in one ~11km cell plus a stray SF photo the same
      // day: the day's location must be the Tokyo cell, not a mid-Pacific mean.
      mapAsset(makeAsset('a1', { exifInfo: { dateTimeOriginal: '2022-11-02T01:00:00.000Z', city: 'Tokyo', country: 'Japan', latitude: 35.68, longitude: 139.69 } })),
      mapAsset(makeAsset('a2', { exifInfo: { dateTimeOriginal: '2022-11-02T02:00:00.000Z', city: 'Tokyo', country: 'Japan', latitude: 35.7, longitude: 139.71 } })),
      mapAsset(makeAsset('a3', { exifInfo: { dateTimeOriginal: '2022-11-02T03:00:00.000Z', latitude: 37.77, longitude: -122.42 } })),
      mapAsset(makeAsset('a4', { exifInfo: { dateTimeOriginal: '2022-11-03T00:00:00.000Z', city: null, country: null, latitude: null, longitude: null } })),
    ]);
    const days = repo.timelineDays();
    assert.equal(days.length, 2);
    assert.equal(days[0].day, '2022-11-02');
    assert.equal(days[0].count, 3);
    assert.equal(days[0].city, 'Tokyo');
    assert.ok(Math.abs(days[0].lat - 35.69) < 0.02);
    assert.ok(days[0].lon > 139);
    assert.equal(days[1].city, null);
    assert.equal(days[1].lat, null);
  });
});

test('collector labels the home cell via the geocode hook when provided', async () => {
  const sf = { latitude: 37.77, longitude: -122.42 };
  const assets = ['a1', 'a2'].map((id) => makeAsset(id, { exifInfo: sf }));
  const immich = new FakeImmich(assets, []);

  await withRepoAsync(async (repo) => {
    const calls = [];
    const collector = new InsightsCollector({
      repo,
      immich,
      config: CONFIG,
      geocodeHome: async (coordinates) => {
        calls.push(coordinates);
        return { area: 'Nob Hill', city: 'San Francisco', label: 'Nob Hill, San Francisco' };
      },
    });
    collector.start();
    await waitForIdle(collector);

    const home = collector.snapshot().superlatives.home;
    assert.equal(home.areaLabel, 'Nob Hill, San Francisco');
    assert.equal(calls.length, 1);
    assert.ok(Math.abs(calls[0].latitude - 37.77) < 0.01);
  });
});

test('collector refreshes the user-defined favorites tag count each sweep', async () => {
  const tags = [{ id: 't-fav', name: 'favorites', value: 'favorites', parentId: null }];
  const immich = new FakeImmich([makeAsset('a1')], [], {}, tags, { 't-fav': 7 });

  await withRepoAsync(async (repo) => {
    const config = { ...CONFIG, favoritesTagId: 't-fav', favoritesTagValue: 'favorites' };
    const collector = new InsightsCollector({ repo, immich, config });
    collector.start();
    await waitForIdle(collector);
    assert.deepEqual(repo.getMeta('favoritesTag'), { id: 't-fav', value: 'favorites', count: 7 });
  });
});

test('collector rejects concurrent runs and reports enrichment dark matter', async () => {
  const immich = new FakeImmich([makeAsset('a1')], []);
  const enrichRepo = { libraryStats: () => ({ enrichedTotal: 1, curatedTotal: 0 }) };

  await withRepoAsync(async (repo) => {
    const collector = new InsightsCollector({ repo, immich, config: CONFIG, enrichRepo });
    collector.start();
    assert.throws(() => collector.start(), /already in progress/);
    await waitForIdle(collector);

    const snapshot = collector.snapshot();
    assert.equal(snapshot.darkMatter.notEnriched, 0);
    assert.equal(collector.status().hasSnapshot, true);
  });
});

test('resolveSliceAssetIds with filterNeedsWork walks past covered pages to collect needy photos', async () => {
  // Five images served two per page; the first three are already covered.
  const all = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const covered = new Set(['a1', 'a2', 'a3']);
  const fake = {
    async searchMetadata({ page }) {
      const start = (page - 1) * 2;
      const items = all.slice(start, start + 2).map((id) => ({ id, type: 'IMAGE' }));
      return { assets: { items, nextPage: start + 2 < all.length ? page + 1 : null } };
    },
  };
  const filterNeedsWork = (ids) => ({
    needy: new Set(ids.filter((id) => !covered.has(id))),
    successful: new Set(ids.filter((id) => covered.has(id))),
    failureLimited: new Set(),
  });

  const result = await resolveSliceAssetIds({ immich: fake, rawFilters: { city: 'Paris' }, max: 2, filterNeedsWork });
  assert.deepEqual(result.assetIds, ['a4', 'a5']);
  assert.equal(result.truncated, false); // slice exhausted exactly at max
  assert.equal(result.scannedImages, 5);
  assert.deepEqual(result.coveredAssetIds, ['a1', 'a2', 'a3']); // for Curate review-listing
  assert.equal(result.failureLimitedCount, 0);
});

test('resolveSliceAssetIds with filterNeedsWork reports truncation when more needy photos remain', async () => {
  const all = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const covered = new Set(['a1']);
  const fake = {
    async searchMetadata({ page }) {
      const start = (page - 1) * 2;
      const items = all.slice(start, start + 2).map((id) => ({ id, type: 'IMAGE' }));
      return { assets: { items, nextPage: start + 2 < all.length ? page + 1 : null } };
    },
  };
  const filterNeedsWork = (ids) => ({
    needy: new Set(ids.filter((id) => !covered.has(id))),
    successful: new Set(ids.filter((id) => covered.has(id))),
    failureLimited: new Set(),
  });

  const result = await resolveSliceAssetIds({ immich: fake, rawFilters: { city: 'Paris' }, max: 2, filterNeedsWork });
  assert.deepEqual(result.assetIds, ['a2', 'a3']);
  assert.equal(result.truncated, true); // a4/a5 still need work
});

test('resolveSliceAssetIds keeps scanning past max until truncation is proven or disproven', async () => {
  // truncated must mean "more photos still need work", so filling max at a
  // page boundary keeps scanning: a needy photo later proves truncation, a
  // fully covered tail disproves it (and the covered ids still come back
  // for review-listing).
  const makeFake = (calls) => ({
    async searchMetadata({ page }) {
      calls.push(page);
      const items = page === 1
        ? [{ id: 'a1', type: 'IMAGE' }, { id: 'a2', type: 'IMAGE' }]
        : [{ id: 'a3', type: 'IMAGE' }];
      return { assets: { items, nextPage: page === 1 ? 2 : null } };
    },
  });

  // Tail photo needs work → truncated, found by scanning page 2.
  let calls = [];
  const keepAll = (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() });
  let result = await resolveSliceAssetIds({ immich: makeFake(calls), rawFilters: { city: 'Paris' }, max: 2, filterNeedsWork: keepAll });
  assert.deepEqual(result.assetIds, ['a1', 'a2']);
  assert.equal(result.truncated, true);
  assert.deepEqual(calls, [1, 2]);

  // Tail photo already covered → not truncated: the run's clean finish can
  // retire the queue item without a pointless extra Run.
  calls = [];
  const coverTail = (ids) => ({
    needy: new Set(ids.filter((id) => id !== 'a3')),
    successful: new Set(ids.filter((id) => id === 'a3')),
    failureLimited: new Set(),
  });
  result = await resolveSliceAssetIds({ immich: makeFake(calls), rawFilters: { city: 'Paris' }, max: 2, filterNeedsWork: coverTail });
  assert.deepEqual(result.assetIds, ['a1', 'a2']);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.coveredAssetIds, ['a3']);
  assert.deepEqual(calls, [1, 2]);
});

test('resolveSliceAssetIds distinguishes fully covered from empty and counts terminal failures', async () => {
  const fake = {
    async searchMetadata() {
      return {
        assets: {
          items: [
            { id: 'a1', type: 'IMAGE' },
            { id: 'a2', type: 'IMAGE' },
            { id: 'v1', type: 'VIDEO' },
          ],
          nextPage: null,
        },
      };
    },
  };
  const seenByFilter = [];
  const filterNeedsWork = (ids) => {
    seenByFilter.push(...ids);
    return {
      needy: new Set(),
      successful: new Set(ids.filter((id) => id === 'a1')),
      failureLimited: new Set(ids.filter((id) => id === 'a2')),
    };
  };

  const result = await resolveSliceAssetIds({ immich: fake, rawFilters: { city: 'Paris' }, filterNeedsWork });
  assert.deepEqual(result.assetIds, []);
  assert.equal(result.scannedImages, 2); // the video never counts
  assert.deepEqual(seenByFilter, ['a1', 'a2']); // and never reaches the filter
  assert.equal(result.truncated, false);
  assert.deepEqual(result.coveredAssetIds, ['a1']); // failure-limited is not "covered"
  assert.equal(result.failureLimitedCount, 1);

  const empty = await resolveSliceAssetIds({
    immich: { async searchMetadata() { return { assets: { items: [], nextPage: null } }; } },
    rawFilters: { city: 'Paris' },
    filterNeedsWork,
  });
  assert.deepEqual(empty.assetIds, []);
  assert.equal(empty.scannedImages, 0); // a slice matching nothing at all
});
