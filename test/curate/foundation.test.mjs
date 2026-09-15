import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { groupPhotos } from '../../src/curate/grouping.mjs';
import { observeAsset, producingPeopleFact, photoEvidence } from '../../src/curate/evidence.mjs';
import { validateAdvice, fingerprint } from '../../src/curate/contracts.mjs';
import { LEASE_MS, MAX_LEASES } from '../../src/curate/repository.mjs';

const schema = {
  properties: {
    has_people: { type: 'boolean' },
    people_count: { type: 'string', enum: ['none', 'one', 'couple', 'group', 'unknown'] },
  },
};
const capture = (s) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
async function fixture(work, { disk = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-curate-'));
  const path = join(dir, 'enrichment.sqlite');
  const repo = new Repository(path);
  repo.initSchema();
  const service = new CurateService({ repo });
  const add = (id, seconds = 0, extra = {}) => {
    repo.upsertAsset({ id, fileCreatedAt: capture(seconds), ...extra });
    repo.reviewListAdd([id], 'test');
  };
  const enrich = (id, count, options = {}) => {
    const config = options.config ?? {
      id: 'a'.repeat(64),
      inferenceId: 'b'.repeat(64),
      snapshot: { formatVersion: 1, inference: { contractVersion: 1, jsonSchema: schema } },
    };
    repo.saveRunConfiguration(config);
    repo.recordProcessingRun({
      assetId: id,
      provider: 'test',
      model: 'test',
      promptVersion: 'v1',
      taxonomyVersion: 'v1',
      status: 'succeeded',
      configurationId: config.id,
      normalizedOutput: {
        has_people: count !== 0,
        people_count: { 0: 'none', 1: 'one', 2: 'couple' }[count] ?? 'unknown',
        ...options.output,
      },
    });
  };
  try {
    await work({ repo, service, add, enrich, path });
  } finally {
    await service.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const row = (id, time, extra = {}) => ({
  id,
  time,
  availability: 'observed',
  checksum: null,
  duplicateId: null,
  renditionKey: null,
  inputKey: id,
  materialKey: id,
  peopleCount: null,
  recognizedCount: null,
  ...extra,
});

test('producing evidence recognizes only supported, mutually consistent counts', () => {
  for (const [value, n] of [
    ['none', 0],
    ['one', 1],
    ['couple', 2],
  ])
    assert.equal(producingPeopleFact({ has_people: n > 0, people_count: value }, schema, 'c').peopleCount, n);
  for (const value of ['group', 'unknown', 'three'])
    assert.equal(producingPeopleFact({ has_people: true, people_count: value }, schema, 'c').peopleCount, null);
  assert.equal(producingPeopleFact({ has_people: false, people_count: 'one' }, schema, 'c').peopleCount, null);
  assert.equal(producingPeopleFact({ has_people: true, people_count: 'one' }, schema, null).peopleCount, null);
  assert.equal(
    producingPeopleFact(
      { has_people: true, people_count: 'one' },
      { properties: { people_count: { type: 'number' } } },
      'custom',
    ).peopleCount,
    null,
  );
});
test('partial recognition remains unknown; explicit empty replaces old observations; evidence is bounded', () => {
  const old = observeAsset({ people: [{ id: 'p' }] });
  assert.equal(observeAsset({ id: 'a' }, old).recognition.count, 1);
  const empty = observeAsset({ people: [] }, old);
  assert.equal(empty.recognition.count, 0);
  assert.equal(empty.recognition.completeness, 'unknown');
  const large = observeAsset({ people: Array.from({ length: 100 }, (_, i) => ({ id: String(i).padEnd(120, 'x') })) });
  assert.equal(large.recognition.omitted, true);
  assert.equal(large.recognition.count, null);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 4096);
  const evidence = photoEvidence({ asset: {}, observation: large });
  assert.ok(Buffer.byteLength(JSON.stringify(evidence.evidence)) <= 4096);
});
test('bounded standard grouping preserves 30 members, stops time chains and never merges missing-time singles', () => {
  const burst = Array.from({ length: 30 }, (_, i) => row(String(i), i * 2000));
  assert.equal(groupPhotos(burst).groups[0].ids.length, 30);
  const chain = Array.from({ length: 100 }, (_, i) => row(String(i), i * 15000));
  assert.ok(groupPhotos(chain).groups.every((g) => g.ids.length <= 13));
  assert.equal(groupPhotos([row('a', null), row('b', null)]).groups.length, 2);
  assert.equal(groupPhotos(burst, { stacks: false }).groups.length, 30);
});
test('whole-group corroborated count veto separates landscape/couple/solo; missed recognition stays uncertain', () => {
  const items = [
    row('land', 0, { peopleCount: 0, recognizedCount: 0 }),
    row('couple', 1000, { peopleCount: 2, recognizedCount: 2 }),
    row('solo', 2000, { peopleCount: 1, recognizedCount: 1 }),
  ];
  const result = groupPhotos(items);
  assert.equal(result.groups.length, 3);
  assert.ok(result.groups[1].reasons.some((r) => r.includes('people counts')));
  items[1].recognizedCount = 1;
  assert.equal(groupPhotos(items).groups.length, 2);
  // An unknown bridge cannot hide a contradiction with an earlier member.
  const bridge = [items[0], row('unknown', 500), items[2]];
  assert.equal(groupPhotos(bridge).groups.length, 2);
});
test('saved human partitions defeat duplicate/time transitive bridges and soft-budget exhaustion', () => {
  const rows = [row('a', 0, { checksum: 'same' }), row('bridge', 1000), row('b', 2000, { checksum: 'same' })];
  const separated = groupPhotos(rows, {
    separations: [{ id: 's', partitions: [['a'], ['b']] }],
    limits: { gapMs: 15000, spanMs: 180000, candidates: 32, pairs: 0, comparisons: 0 },
  });
  assert.ok(!separated.groups.some((g) => g.ids.includes('a') && g.ids.includes('b')));
  assert.ok(separated.groups.some((g) => g.route === 'manual-budget'));
});
test('checksums need observed compatible renditions for bypass; thumbnails alone never join distant photos', () => {
  assert.equal(
    groupPhotos([row('a', 0, { checksum: 'same' }), row('b', 900000, { checksum: 'same' })]).groups[0].route,
    'uncertain',
  );
  assert.equal(
    groupPhotos([
      row('a', 0, { checksum: 'same', renditionKey: 'r' }),
      row('b', 900000, { checksum: 'same', renditionKey: 'r' }),
    ]).groups[0].route,
    'checksum-bypass',
  );
  assert.equal(
    groupPhotos([row('a', 0, { thumbhash: 'same' }), row('b', 900000, { thumbhash: 'same' })]).groups.length,
    2,
  );
});
test('both AI roles share exhaustive disjoint validation; zero and multiple keepers survive', () => {
  for (const keepers of [[], ['a'], ['a', 'b']])
    assert.deepEqual(
      validateAdvice(['a', 'b'], { groups: [{ ids: ['a', 'b'], keepers, reason: 'comparison' }] }, 'keeper').groups[0]
        .keepers,
      keepers,
    );
  assert.throws(() =>
    validateAdvice(
      ['a', 'b'],
      {
        groups: [
          { ids: ['a', 'b'], reason: 'one' },
          { ids: ['a'], reason: 'two' },
        ],
      },
      'check',
    ),
  );
  assert.throws(() => validateAdvice(['a', 'b'], { groups: [{ ids: ['a'], reason: 'one' }] }, 'check'));
  assert.throws(() => validateAdvice(['a'], { groups: [{ ids: ['a'], keepers: ['b'], reason: 'x' }] }, 'keeper'));
});
test('real adapter uses producing schema, not active taxonomy or arbitrary ai tags', async () =>
  fixture(async ({ repo, service, add, enrich }) => {
    add('a', 0, { people: [] });
    add('b', 1, { people: [{ id: 'p' }] });
    enrich('a', 0);
    enrich('b', 1);
    const result = await service.openView();
    assert.equal(result.total, 2);
    repo.db
      .prepare('UPDATE enrich_configurations SET snapshot_json=? WHERE id=?')
      .run(
        JSON.stringify({ formatVersion: 1, inference: { contractVersion: 1, jsonSchema: { properties: {} } } }),
        'a'.repeat(64),
      );
    // A new producing configuration, with unsupported fields, is unknown.
    const config = {
      id: 'c'.repeat(64),
      inferenceId: 'd'.repeat(64),
      snapshot: { formatVersion: 1, inference: { contractVersion: 1, jsonSchema: { properties: {} } } },
    };
    enrich('b', 1, { config });
    const unknown = await service.openView();
    assert.equal(unknown.total, 1);
    assert.equal(repo.curate.photo('b').peopleCount, null);
  }));
test('search matches through one photo but comparisons and pagination retain the whole stack', async () =>
  fixture(async ({ repo, service, add }) => {
    for (let i = 0; i < 30; i++)
      add('p' + i, i, { originalPath: i === 5 ? '/fixture/needle.jpg' : '/fixture/other.jpg' });
    add('far', 900);
    const view = await service.openView({ search: 'needle' });
    assert.equal(view.total, 1);
    assert.equal(view.groups[0].memberCount, 30);
    const compare = service.comparison(view.viewId, view.groups[0].id);
    assert.equal(compare.ids.length, 30);
    const first = service.page(view.viewId, 0, 1);
    assert.equal(first.groups.length, 1);
    add('new', 900);
    await service.refresh();
    assert.equal(service.page(view.viewId).groups[0].memberCount, 30);
    assert.equal(service.page(view.viewId).updatesAvailable, true);
  }));
test('material guards reject relevant image/tag/human changes, ignore unrelated updates and AI-only cache generations', async () =>
  fixture(async ({ repo, service, add, enrich }) => {
    add('a');
    add('b', 1);
    add('far', 900);
    const view = await service.openView();
    const g = view.groups.find((g) => g.memberCount === 2);
    const compare = service.comparison(view.viewId, g.id);
    enrich('far', 1);
    await service.refresh();
    assert.equal(repo.curate.assertComparison(compare.id).id, compare.id);
    repo.curate.bump();
    assert.equal(repo.curate.assertComparison(compare.id).id, compare.id);
    repo.upsertAsset({ id: 'a', fileCreatedAt: capture(0), fileModifiedAt: capture(10) });
    assert.throws(() => repo.curate.assertComparison(compare.id), /changed/);
    const next = await service.openView();
    const c2 = service.comparison(next.viewId, next.groups.find((g) => g.memberCount === 2).id);
    repo.recordDecision({ assetIds: ['a'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    assert.throws(() => repo.curate.assertComparison(c2.id), /changed/);
  }));
test('equivalent Enrich provenance and metadata-only updatedAt changes do not invalidate material inputs', async () =>
  fixture(async ({ repo, service, add, enrich }) => {
    add('a', 0, { people: [{ id: 'p' }] });
    add('b', 1);
    enrich('a', 1);
    const v = await service.openView();
    const c = service.comparison(v.viewId, v.groups[0].id);
    enrich('a', 1, {
      config: {
        id: 'c'.repeat(64),
        inferenceId: 'd'.repeat(64),
        snapshot: { formatVersion: 1, inference: { contractVersion: 1, jsonSchema: schema } },
      },
    });
    repo.upsertAsset({ id: 'a', fileCreatedAt: capture(0), updatedAt: capture(999) });
    await service.refresh();
    assert.equal(repo.curate.assertComparison(c.id).id, c.id);
  }));
test('corrections persist across SQLite restart, are idempotent, and do not change decisions', async () =>
  fixture(
    async ({ repo, service, add, path }) => {
      add('a');
      add('b', 1);
      add('bridge', 2);
      const v = await service.openView();
      const c = service.comparison(v.viewId, v.groups[0].id);
      const correction = await service.separate(c.id, [['a', 'bridge'], ['b']]);
      assert.deepEqual(await service.separate(c.id, [['a', 'bridge'], ['b']]), correction);
      assert.throws(() => repo.curate.separate(c.id, [['a'], ['b', 'bridge']]), /already used/);
      const reader = new Repository(path);
      reader.initSchema();
      const s2 = new CurateService({ repo: reader });
      try {
        const after = await s2.openView();
        assert.equal(after.total, 2);
        assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
        await s2.reset(correction.id, correction.revision, { undo: true });
        assert.equal((await s2.openView()).total, 1);
      } finally {
        await s2.close();
        reader.close();
      }
    },
    { disk: true },
  ));
test('capacity refuses new leases without evicting live scopes; expiry and scope lookup survive restart', async () =>
  fixture(async ({ repo }) => {
    const first = repo.curate.lease('comparison', { ids: ['a'] }, 0);
    for (let i = 1; i < MAX_LEASES; i++) repo.curate.lease('comparison', { ids: ['x' + i] }, 0);
    assert.throws(
      () => repo.curate.lease('comparison', {}, 1),
      (e) => e.code === 'curate_capacity',
    );
    assert.equal(repo.curate.getLease(first.id, 'comparison', 1).ids[0], 'a');
    assert.throws(
      () => repo.curate.getLease(first.id, 'view', 1),
      (e) => e.code === 'curate_expired',
    );
    assert.throws(
      () => repo.curate.getLease(first.id, 'comparison', LEASE_MS),
      (e) => e.code === 'curate_expired',
    );
    repo.curate.lease('view', {}, LEASE_MS);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_leases').get().n, 1);
  }));
test('context is at most eight from 64 indexed kept candidates and never actionable', async () =>
  fixture(async ({ repo, service, add }) => {
    add('pending', 100);
    for (let i = 0; i < 100; i++) {
      add('kept' + i, i + 1);
      repo.recordDecision({ assetIds: ['kept' + i], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    }
    const v = await service.openView();
    assert.equal(v.total, 1);
    const c = service.comparison(v.viewId, v.groups[0].id);
    assert.deepEqual(c.ids, ['pending']);
    assert.equal(c.contextIds.length, 8);
    assert.equal(c.contextOmitted, true);
    assert.equal(c.automaticKeeperEligible, false);
    assert.throws(() => repo.curate.separate(c.id, [['pending'], [c.contextIds[0]]]), /Partition/);
    const plan = repo.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT asset_id FROM curate_photos WHERE state='approved' AND captured_ms BETWEEN 0 AND 100 LIMIT 64",
      )
      .all();
    assert.ok(plan.some((r) => r.detail.includes('idx_curate_state_time')));
  }));
test('transaction rollback preserves source and dirty queue together; cold projection resumes on restart', async () =>
  fixture(
    async ({ repo, service, add, path }) => {
      add('a');
      await service.refresh();
      const before = repo.curate.generation();
      assert.throws(() =>
        repo.transaction(() => {
          repo.upsertAsset({ id: 'a', fileCreatedAt: capture(100) });
          throw Error('rollback');
        }),
      );
      await service.refresh();
      assert.equal(repo.curate.generation(), before);
      add('b', 1);
      const reader = new Repository(path);
      reader.initSchema();
      const other = new CurateService({ repo: reader });
      try {
        assert.equal((await other.openView()).groups[0].memberCount, 2);
      } finally {
        await other.close();
        reader.close();
      }
    },
    { disk: true },
  ));
test('metadata refresh is bounded to two calls, preserves unknown failures, and requires listed photos', async () =>
  fixture(async ({ repo, service, add }) => {
    for (let i = 0; i < 6; i++) add('p' + i, i);
    let active = 0,
      max = 0,
      calls = 0;
    service.immich = {
      getAsset: async (id) => {
        active++;
        max = Math.max(max, active);
        calls++;
        await new Promise((r) => setTimeout(r, 2));
        active--;
        return { id, fileCreatedAt: capture(Number(id.slice(1))), people: [] };
      },
    };
    await service.refreshMetadata(['p0', 'p1', 'p2', 'p3']);
    assert.equal(max, 2);
    assert.equal(calls, 4);
    service.immich = {
      getAsset: async () => {
        throw Object.assign(Error('unauthorized'), { status: 401 });
      },
    };
    await assert.rejects(service.refreshMetadata(['p4', 'p5']));
    assert.equal(repo.db.prepare("SELECT missing_since FROM assets WHERE asset_id='p4'").get().missing_since, null);
    await assert.rejects(service.refreshMetadata(['not-listed']), /review photos/);
  }));
test('stale advice cannot be saved after a source change or human separation', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    await service.refresh();
    const ids = ['a', 'b'];
    const inputKey = fingerprint(ids.map((id) => [id, repo.curate.photo(id).inputKey]));
    const payload = {
      role: 'keeper',
      ids,
      inputKey,
      schemaVersion: '1',
      result: { groups: [{ ids, keepers: ['a', 'b'], reason: 'both' }] },
    };
    repo.curate.saveAdvice(payload);
    repo.upsertAsset({ id: 'a', fileCreatedAt: capture(0), fileModifiedAt: capture(90) });
    assert.throws(() => repo.curate.saveAdvice(payload), /no longer current/);
  }));

test('overlapping advice replaces old records, preserves full keepers, and rejects stale schema or partitions', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    await service.refresh();
    const ids = ['a', 'b'];
    const save = () => {
      const inputKey = fingerprint(ids.map((id) => [id, repo.curate.photo(id).inputKey]));
      repo.curate.saveAdvice({
        role: 'keeper',
        ids,
        inputKey,
        schemaVersion: 'v1',
        result: { groups: [{ ids, keepers: ids, reason: 'both' }] },
      });
    };
    save();
    assert.equal(repo.curate.advice('keeper', ids, 'v1').groups[0].keepers.length, 2);
    assert.equal(repo.curate.advice('keeper', ids, 'v2'), null);
    repo.upsertAsset({ id: 'a', fileCreatedAt: capture(0), fileModifiedAt: capture(1) });
    await service.refresh();
    assert.equal(repo.curate.advice('keeper', ids, 'v1'), null);
    save();
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_advice').get().n, 1);
    const v = await service.openView();
    const c = service.comparison(v.viewId, v.groups[0].id);
    await service.separate(c.id, [['a'], ['b']]);
    assert.equal(repo.curate.advice('keeper', ids, 'v1'), null);
  }));
test('comparison photo pages stay bounded while retaining all IDs and lease cleanup removes saved view rows', async () =>
  fixture(async ({ repo, service, add }) => {
    for (let i = 0; i < 120; i++) add('p' + String(i).padStart(3, '0'), i);
    const view = await service.openView();
    const c = service.comparison(view.viewId, view.groups[0].id);
    assert.equal(c.ids.length, 120);
    assert.equal(c.photos.length, 50);
    assert.equal(c.photoNextOffset, 50);
    const second = service.comparisonPhotos(c.id, 50);
    assert.equal(second.photos.length, 50);
    assert.equal(second.nextOffset, 100);
    const last = service.comparisonPhotos(c.id, 100);
    assert.equal(last.photos.length, 20);
    assert.equal(last.nextOffset, null);
    repo.curate.releaseLease(view.viewId);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_groups').get().n, 0);
    assert.equal(repo.curate.getLease(c.id, 'comparison').ids.length, 120);
  }));
test('migration from schema 12 queues only review rows; corrections/evidence/views survive online backup and restore', async () =>
  fixture(async ({ repo, service, add, path }) => {
    const { backup, DatabaseSync } = await import('node:sqlite');
    add('a', 0, { people: [] });
    add('b', 1, { people: [] });
    await service.refresh();
    const v = await service.openView();
    const c = service.comparison(v.viewId, v.groups[0].id);
    await service.separate(c.id, [['a'], ['b']]);
    const target = path + '.backup';
    await backup(repo.db, target);
    const restored = new Repository(target);
    restored.initSchema();
    try {
      assert.equal(restored.curate.separations().length, 1);
      assert.equal(restored.curate.getLease(v.viewId, 'view').total, 1);
      assert.equal(restored.curate.viewGroups(v.viewId, 0, 50)[0].ids.length, 2);
      assert.equal(restored.curate.details(['a'])[0].evidence.recognition.count, 0);
    } finally {
      restored.close();
    }
    const legacy = path + '.legacy';
    await backup(repo.db, legacy);
    const db = new DatabaseSync(legacy);
    for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'curate_%'").all())
      db.exec('DROP TRIGGER ' + r.name);
    for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'curate_%'").all())
      db.exec('DROP TABLE ' + r.name);
    db.exec('PRAGMA user_version=12');
    db.close();
    const migrated = new Repository(legacy);
    try {
      assert.deepEqual(migrated.initSchema().applied, [13]);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) n FROM curate_dirty').get().n, 2);
      await migrated.curate.flush();
      assert.equal(migrated.curate.photo('a').recognizedCount, null);
      assert.equal(migrated.initSchema().applied.length, 0);
    } finally {
      migrated.close();
    }
  }));
test('foundation HTTP routes return complete groups and reject malformed or stale actions', async () =>
  fixture(async ({ repo, service, add }) => {
    const { createServer } = await import('node:http');
    const { createCurateRoutes } = await import('../../src/routes/curate.mjs');
    add('a');
    add('b', 1);
    const route = createCurateRoutes({ curate: service });
    const server = createServer(async (req, res) => {
      try {
        if (!(await route(req, res, new URL(req.url, 'http://local')))) res.writeHead(404).end();
      } catch {
        res.writeHead(500).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/review/curate/`;
    const post = (path, body) =>
      fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const v = await (await fetch(base + 'groups')).json();
      assert.equal(v.groups[0].memberCount, 2);
      assert.equal((await post('comparisons', null)).status, 400);
      const c = await (await post('comparisons', { viewId: v.viewId, groupId: v.groups[0].id })).json();
      assert.equal((await post('separations', { comparisonId: c.id, partitions: [['a'], ['a']] })).status, 400);
      assert.equal((await post('separations', { comparisonId: c.id, partitions: [['a'], ['b']] })).status, 200);
      assert.equal((await fetch(base + 'groups?viewId=missing')).status, 409);
      assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }));

test('new alternatives conflict with old comparison scope, while a machine-only split cannot expand it', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    const v = await service.openView();
    const c = service.comparison(v.viewId, v.groups[0].id);
    add('new', 2);
    await service.refresh();
    await assert.rejects(service.separate(c.id, [['a'], ['b']]), /membership changed/);
    assert.equal(repo.curate.separations().length, 0);
  }));

test('unpublished nearby arrivals cannot pass a stale comparison, but unrelated dirty imports can', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    const v = await service.openView();
    add('far', 10000);
    const c = service.comparison(v.viewId, v.groups[0].id);
    assert.deepEqual(c.ids, ['a', 'b']);
    add('new', 2);
    assert.throws(() => service.comparisonPhotos(c.id), /updating/);
  }));

test('checksum bypass requires the real Immich isEdited field and complete observed rendition evidence', () => {
  const asset = { checksum: 'original', thumbhash: 'recorded', width: 100, height: 100 };
  assert.equal(photoEvidence({ asset, observation: observeAsset({}) }).renditionKey, null);
  assert.equal(photoEvidence({ asset, observation: observeAsset({ isEdited: true }) }).renditionKey, null);
  assert.ok(photoEvidence({ asset, observation: observeAsset({ isEdited: false }) }).renditionKey);
  assert.equal(
    photoEvidence({ asset: { ...asset, width: null }, observation: observeAsset({ isEdited: false }) }).renditionKey,
    null,
  );
});
