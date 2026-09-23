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
import { LEASE_MS, MAX_LEASES, MAX_VIEW_LEASES, MAX_LEASE_BYTES } from '../../src/curate/repository.mjs';

const schema = {
  properties: {
    has_people: { type: 'boolean' },
    people_count: { type: 'string', enum: ['none', 'one', 'couple', 'group', 'unknown'] },
  },
};
const capture = (s) => new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString();
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-curate-'));
  const path = join(dir, 'enrichment.sqlite');
  const repo = new Repository(path);
  repo.initSchema();
  const service = new CurateService({ repo });
  const add = (id, seconds = 0, extra = {}) => {
    repo.reviewListAdd([id], 'test');
    repo.upsertAsset({ id, fileCreatedAt: capture(seconds), ...extra });
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

test('correction action survives restart and replay; a two-photo Remove is not inferred to be Split', async () =>
  fixture(async ({repo, service, add, path}) => {
    add('a', 0, {originalPath:'/photos/A.jpg'}); add('b', 1);
    const view = await service.openView(), c = service.comparison(view.viewId, view.groups[0].id);
    const partitions = [['a'], ['b']];
    await assert.rejects(service.separate(c.id, partitions, {kind:'remove',assetId:'b'}), /does not match/);
    assert.equal(repo.curate.corrections().corrections.length, 0);
    const receipt = await service.separate(c.id, partitions, {kind:'remove',assetId:'a'});
    assert.deepEqual(await service.separate(c.id, partitions, {kind:'remove',assetId:'a'}), receipt);
    await assert.rejects(service.separate(c.id, partitions, {kind:'split'}), /different action/);
    await service.close();
    const reopened = new Repository(path);
    try {
      reopened.initSchema();
      const action = reopened.curate.corrections().corrections[0].action;
      assert.equal(action.kind, 'remove'); assert.equal(action.photo.filename, 'A.jpg');
      reopened.curate.resetSeparation(c.id, 1);
      assert.deepEqual(reopened.curate.separate(c.id, partitions, Date.now(), {kind:'remove',assetId:'a'}), receipt);
      assert.equal(reopened.curate.correction(c.id).active, 0);
    } finally { reopened.close(); }
  }));

test('schema-14 corrections retain their original partitions without inventing action metadata', async () =>
  fixture(async ({repo, service, add, path}) => {
    add('a'); add('b', 1);
    const view=await service.openView(), c=service.comparison(view.viewId,view.groups[0].id);
    const receipt = await service.separate(c.id,[['a'],['b']]);
    await service.close();
    repo.db.exec('DROP TABLE curate_separation_actions; PRAGMA user_version=14');
    const migrated = new Repository(path);
    try {
      assert.deepEqual(migrated.initSchema().applied,[15,16]);
      assert.equal(migrated.curate.corrections().corrections[0].action, null);
      assert.deepEqual(migrated.curate.separate(c.id,[['a'],['b']]),receipt);
      assert.deepEqual(migrated.curate.separations()[0].partitions,[['a'],['b']]);
    } finally { migrated.close(); }
  }));

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
  fixture(async ({ repo, service, add, path }) => {
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
  }));
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
  fixture(async ({ repo, service, add, path }) => {
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
  }));
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
    await service.openView();
    await service.metadata.tick();
    assert.equal(max, 2);
    assert.equal(calls, 6);
    service.immich = {
      getAsset: async () => {
        throw Object.assign(Error('unauthorized'), { status: 401 });
      },
    };
    service.metadata.now = () => Date.now() + 31000;
    service.requestMetadataRefresh(['p4', 'p5']);
    await service.metadata.tick();
    assert.equal(service.metadata.status().state, 'paused');
    assert.equal(repo.db.prepare("SELECT missing_since FROM assets WHERE asset_id='p4'").get().missing_since, null);
    assert.throws(() => service.requestMetadataRefresh(['not-listed']), /review photos/);
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
    assert.throws(
      () => repo.curate.getLease(c.id, 'comparison'),
      (error) => error.code === 'curate_expired',
    );
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
      assert.deepEqual(migrated.initSchema().applied, [13, 14, 15, 16]);
      assert.equal(migrated.db.prepare('SELECT COUNT(*) n FROM curate_dirty').get().n, 2);
      await migrated.curate.flush();
      assert.equal(migrated.curate.photo('a').recognizedCount, null);
      assert.equal(migrated.initSchema().applied.length, 0);
    } finally {
      migrated.close();
    }
  }));
test('date ordering spans pages, preserves whole stacks and snapshots, and places unknown dates last', async () =>
  fixture(async ({ repo, service, add, path }) => {
    // Duplicate members span the other photos' dates. The stack still sorts by
    // its earliest member, not its newest one or the order of ingestion.
    add('stack-later', 40000, { checksum: 'same', originalPath: '/photos/find-this.jpg' });
    for (let i = 55; i >= 1; i--) add(`single-${i}`, i * 600);
    add('stack-first', 0, { checksum: 'same' });
    add('undated', 0, { fileCreatedAt: null });
    const full = view => [...view.groups, ...(view.nextOffset === null ? [] :
      service.page(view.viewId, view.nextOffset).groups)];
    const asc = await service.openView();
    const ascending = full(asc);
    assert.equal(asc.sort, 'oldest');
    assert.equal(asc.groups.length, 50);
    assert.equal(asc.total, 57);
    assert.equal(ascending[0].memberCount, 2);
    assert.equal(ascending.at(-1).photos[0].id, 'undated');
    const desc = await service.openView({ sort: 'newest' });
    const descending = full(desc);
    assert.equal(desc.sort, 'newest');
    assert.deepEqual(descending.map(g => g.id), [
      ...ascending.slice(0, -1).map(g => g.id).reverse(), ascending.at(-1).id,
    ]);
    assert.equal(descending[0].photos[0].id, 'single-55');
    assert.equal(descending.at(-2).memberCount, 2);
    const stack = service.comparison(desc.viewId, descending.at(-2).id);
    assert.deepEqual(stack.ids, ['stack-first', 'stack-later']);
    assert.equal((await service.openView({ sort: 'newest', kind: 'singles' })).total, 56);
    const stacks = await service.openView({ sort: 'newest', kind: 'stacks', search: 'find-this' });
    assert.equal(stacks.total, 1);
    assert.equal(stacks.groups[0].memberCount, 2);
    // Date edits and new arrivals affect a refreshed view, never an existing page.
    add('newest-arrival', 80000);
    add('single-1', 90000);
    await service.refresh();
    assert.equal(service.page(desc.viewId).updatesAvailable, true);
    assert.deepEqual(full(desc).map(g => g.id), descending.map(g => g.id));
    const fresh = await service.openView({ sort: 'newest', replacesViewId: stacks.viewId });
    assert.equal(fresh.groups[0].photos[0].id, 'single-1');
    assert.equal(fresh.groups[1].photos[0].id, 'newest-arrival');
    assert.deepEqual(service.comparison(desc.viewId, stack.groupId).ids, stack.ids);
    await service.close();
    const reopened = new Repository(path);
    const restored = new CurateService({ repo: reopened });
    try {
      reopened.initSchema();
      assert.equal(restored.page(desc.viewId).sort, 'newest');
      assert.deepEqual(restored.page(desc.viewId, 50).groups.map(g => g.id), descending.slice(50).map(g => g.id));
      assert.deepEqual(full(asc).map(g => g.id), ascending.map(g => g.id));
    } finally { await restored.close(); reopened.close(); }
  }));

test('equal capture dates and unknown dates have deterministic order in both directions', async () =>
  fixture(async ({ service, add }) => {
    service.config.curateBurstGrouping = false;
    add('b', 0); add('a', 0); add('z', 0, {fileCreatedAt: null}); add('y', 0, {fileCreatedAt: null});
    const ids = view => view.groups.map(g => g.photos[0].id);
    assert.deepEqual(ids(await service.openView({sort: 'oldest'})), ['a', 'b', 'y', 'z']);
    assert.deepEqual(ids(await service.openView({sort: 'newest'})), ['b', 'a', 'y', 'z']);
    assert.deepEqual(ids(await service.openView({sort: 'newest'})), ['b', 'a', 'y', 'z']);
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
      for (const sort of ['score', '', 42, null, [], {}])
        assert.equal((await post('groups', { sort })).status, 400);
      assert.equal((await fetch(base + 'groups?sort=score')).status, 400);
      assert.equal((await (await fetch(base + 'groups?sort=newest')).json()).sort, 'newest');
      assert.equal((await (await post('groups', {sort: 'newest'})).json()).sort, 'newest');
      const v = await (await fetch(base + 'groups')).json();
      assert.equal(v.groups[0].memberCount, 2);
      assert.equal(v.groups[0].photos.length, 1);
      assert.ok(v.groups[0].photos.every(p => !Object.hasOwn(p, 'evidence')));
      assert.equal((await post('comparisons', null)).status, 400);
      const c = await (await post('comparisons', { viewId: v.viewId, groupId: v.groups[0].id })).json();
      assert.equal((await post('separations', { comparisonId: c.id, partitions: [['a'], ['a']] })).status, 400);
      assert.equal((await post('separations', { comparisonId: c.id, partitions: [['a'], ['b']] })).status, 200);
      const corrections = await (await fetch(base + 'separations')).json();
      assert.equal(corrections.corrections[0].id, c.id);
      assert.equal(corrections.corrections[0].memberCount, 2);
      assert.equal((await fetch(base + 'separations?limit=51')).status, 400);
      const second = await (await post('groups', {})).json();
      assert.equal(second.total, 2);
      assert.equal((await fetch(base + 'groups?replacesViewId=' + v.viewId)).status, 400);
      assert.equal((await fetch(base + 'groups?viewId=' + v.viewId)).status, 200);
      const replacement = await (await post('groups', { replacesViewId: v.viewId, kind: 'singles' })).json();
      assert.equal(replacement.total, 2);
      const retry = await (await post('groups', { replacesViewId: v.viewId, kind: 'singles' })).json();
      assert.equal(retry.total, 2);
      assert.equal((await fetch(base + 'groups?viewId=' + replacement.viewId)).status, 409);
      assert.equal((await fetch(base + 'groups?viewId=' + retry.viewId)).status, 200);
      assert.equal((await fetch(base + 'groups?viewId=' + v.viewId)).status, 409);
      assert.equal((await fetch(base + 'groups?viewId=' + second.viewId)).status, 200);
      assert.equal((await post('separations', { comparisonId: c.id, partitions: [['a'], ['b']] })).status, 200);
      const otherComparison = await (
        await post('comparisons', { viewId: second.viewId, groupId: second.groups[0].id })
      ).json();
      assert.equal((await post('groups', { replacesViewId: otherComparison.id })).status, 400);
      assert.equal((await post('comparisons/photos', { comparisonId: otherComparison.id })).status, 200);
      for (const replacesViewId of [[], {}, 42, '', 'x'.repeat(129)])
        assert.equal((await post('groups', { replacesViewId })).status, 400);
      assert.equal((await post('groups', null)).status, 400);
      assert.equal((await fetch(base + 'groups?viewId=missing')).status, 409);
      assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
      const reset = await (await post('separations/reset', {id:c.id, revision:1})).json();
      assert.equal(reset.revision, 2);
      assert.equal((await (await fetch(base + 'separations')).json()).corrections.length, 0);
      const currentCorrection = await (await fetch(base + 'separations?id='+c.id)).json();
      assert.equal(currentCorrection.correction.active, 0);
      assert.equal(currentCorrection.correction.revision, 2);
      const replay = await (await post('separations', {comparisonId:c.id, partitions:[['a'],['b']]})).json();
      assert.equal(replay.revision, 1, 'immutable receipt must not be mistaken for current active state');
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

test('30k UUID singles share compact immutable snapshots across tabs, retries and filters', async () =>
  fixture(async ({ repo, service }) => {
    const ids = Array.from({ length: 30000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const insert = repo.db.prepare(
      'INSERT INTO assets(asset_id,file_created_at,first_seen_at,last_seen_at) VALUES(?,?,?,?)',
    );
    repo.transaction(() => {
      ids.forEach((id, i) => insert.run(id, capture(i * 60), 'now', 'now'));
      repo.reviewListAdd(ids, 'test');
    });
    // Concurrent opens cannot see a half-written shared snapshot.
    const views = await Promise.all([service.openView(), service.openView(), service.openView({ kind: 'singles' })]);
    for (const view of views) {
      assert.equal(view.total, 30000);
      const last = service.page(view.viewId, 29950);
      assert.equal(last.groups.length, 50);
      assert.equal(last.groups.at(-1).id, `single:standard-1:${ids.at(-1)}`);
    }
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_groups').get().n, 30000);
    const bytes = repo.db
      .prepare(`SELECT (SELECT SUM(bytes) FROM curate_view_snapshots) + (SELECT SUM(bytes) FROM curate_leases) n`)
      .get().n;
    assert.ok(bytes < 2 * 1024 * 1024);
    assert.ok(bytes < MAX_LEASE_BYTES);
    const compare = service.comparison(views[1].viewId, views[1].groups[0].id);
    assert.deepEqual(compare.ids, [ids[0]]);
    repo.curate.releaseLease(views[0].viewId);
    assert.equal(service.page(views[1].viewId).total, 30000);
    // A new generation gets its own snapshot; prior pages retain their order.
    repo.recordDecision({ assetIds: [ids[0]], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    const next = await service.openView();
    assert.equal(next.total, 29999);
    assert.equal(service.page(views[1].viewId).groups[0].id, `single:standard-1:${ids[0]}`);
    assert.equal(service.page(views[1].viewId).updatesAvailable, true);
    for (const view of [...views, next]) repo.curate.releaseLease(view.viewId);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_groups').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_leases').get().n, 0);
  }));

test('a long session replaces only its own comparison and repeated opens preserve the operation ID', async () =>
  fixture(async ({ repo, service, add }) => {
    repo.transaction(() => {
      for (let i = 0; i < 250; i++) {
        add(`a${i}`, i * 60);
        add(`b${i}`, i * 60 + 1);
      }
    });
    const first = await service.openView(),
      other = await service.openView();
    const otherComparison = service.comparison(other.viewId, other.groups[0].id);
    let old;
    for (let offset = 0; offset < first.total; offset += 50) {
      for (const group of service.page(first.viewId, offset).groups) {
        const comparison = service.comparison(first.viewId, group.id);
        assert.equal(service.comparison(first.viewId, group.id).id, comparison.id);
        if (old)
          assert.throws(
            () => repo.curate.getLease(old, 'comparison'),
            (error) => error.code === 'curate_expired',
          );
        old = comparison.id;
      }
    }
    assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='comparison'").get().n, 2);
    assert.equal(service.comparisonPhotos(otherComparison.id).total, 2);
    repo.curate.releaseLease(first.viewId);
    assert.equal(service.comparisonPhotos(otherComparison.id).total, 2);
    assert.throws(
      () => service.comparisonPhotos(old),
      (error) => error.code === 'curate_expired',
    );
  }));

test('view and comparison counts are separate but all scope bytes share the same bound', async () =>
  fixture(async ({ repo }) => {
    for (let i = 0; i < MAX_LEASES; i++) repo.curate.lease('comparison', { i }, 0);
    for (let i = 0; i < MAX_VIEW_LEASES; i++) repo.curate.lease('view', { i }, 0);
    assert.throws(
      () => repo.curate.lease('view', {}, 0),
      (error) => error.code === 'curate_capacity',
    );
    assert.throws(
      () => repo.curate.lease('comparison', {}, 0),
      (error) => error.code === 'curate_capacity',
    );
    // Expiry releases capacity, but oversized scopes are refused without evicting a live one.
    const live = repo.curate.lease('view', { kept: true }, LEASE_MS);
    assert.throws(
      () => repo.curate.lease('comparison', { large: 'x'.repeat(MAX_LEASE_BYTES) }, LEASE_MS),
      (error) => error.code === 'curate_capacity',
    );
    assert.equal(repo.curate.getLease(live.id, 'view', LEASE_MS).kept, true);
  }));

test('correction receipts replay after expiry, lease deletion, reset and restart without new mutations', async () =>
  fixture(async ({ repo, service, add, path }) => {
    add('a');
    add('b', 1);
    const view = await service.openView(),
      comparison = service.comparison(view.viewId, view.groups[0].id);
    const parts = [['a'], ['b']];
    const receipt = await service.separate(comparison.id, parts);
    repo.db.prepare('UPDATE curate_leases SET expires_at=0').run();
    const generation = repo.curate.generation();
    assert.deepEqual(await service.separate(comparison.id, parts), receipt);
    assert.equal(repo.curate.generation(), generation);
    repo.curate.releaseLease(view.viewId);
    assert.deepEqual(await service.separate(comparison.id, parts), receipt);
    await assert.rejects(service.separate(comparison.id, [['b'], ['a']]), /already used/);
    await service.reset(receipt.id, receipt.revision);
    const afterReset = repo.curate.generation();
    assert.deepEqual(await service.separate(comparison.id, parts), receipt);
    assert.equal(repo.curate.generation(), afterReset);
    assert.equal(repo.curate.correction(receipt.id).active, 0);
    const reader = new Repository(path);
    reader.initSchema();
    const restarted = new CurateService({ repo: reader });
    try {
      restarted.refresh = async () => {
        throw Error('Receipt replay must not rebuild');
      };
      assert.deepEqual(await restarted.separate(comparison.id, parts), receipt);
      assert.equal(reader.curate.correction(receipt.id).active, 0);
      assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
      assert.throws(
        () => reader.curate.separate('unknown-id', parts),
        (error) => error.code === 'curate_expired',
      );
    } finally {
      await restarted.close();
      reader.close();
    }
  }));

test('interrupted snapshot writes are discarded on restart while published views survive', async () =>
  fixture(async ({ repo, service, add, path }) => {
    add('a');
    const view = await service.openView();
    const incomplete = repo.curate.lease('view', { snapshotId: 'unfinished', total: 5 });
    repo.db.prepare('INSERT INTO curate_view_snapshots VALUES(?,?,0)').run('unfinished', 100);
    repo.db.prepare('INSERT INTO curate_view_groups VALUES(?,?,?,?,?)').run('unfinished', 0, 'partial', '', 'single');
    const reader = new Repository(path);
    try {
      reader.initSchema();
      assert.throws(
        () => reader.curate.getLease(incomplete.id, 'view'),
        (error) => error.code === 'curate_expired',
      );
      assert.equal(reader.curate.viewGroups(view.viewId, 0, 50)[0].ids[0], 'a');
      assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots WHERE ready=0').get().n, 0);
      assert.equal(
        reader.db.prepare("SELECT COUNT(*) n FROM curate_view_groups WHERE view_id='unfinished'").get().n,
        0,
      );
    } finally {
      reader.close();
    }
  }));

test('discovery stores no extra rows for unlisted assets or duplicated source columns', async () =>
  fixture(async ({ repo, service, add }) => {
    const asset = {
      id: 'unlisted',
      fileCreatedAt: capture(0),
      checksum: 'original',
      thumbhash: 'thumb',
      people: [{ id: 'person' }],
      isEdited: false,
      isTrashed: false,
      isOffline: false,
      exifInfo: { orientation: '1', exifImageWidth: 100, exifImageHeight: 200 },
    };
    repo.upsertAsset(asset);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_observations').get().n, 0);
    add('listed', 1);
    repo.upsertAsset({
      id: 'listed',
      fileCreatedAt: capture(1),
      checksum: 'original',
      thumbhash: 'thumb',
      width: 100,
      height: 200,
    });
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_observations').get().n, 0);
    repo.reviewListAdd(['unlisted'], 'test');
    repo.upsertAsset(asset);
    const json = JSON.parse(
      repo.db.prepare("SELECT json FROM curate_observations WHERE asset_id='unlisted'").get().json,
    );
    assert.deepEqual(
      Object.keys(json).sort(),
      ['version', 'recognition', 'orientation', 'isEdited', 'isTrashed', 'isOffline'].sort(),
    );
    await service.refresh();
    assert.equal(repo.curate.photo('unlisted').recognizedCount, 1);
    // Partial metadata leaves the recognition observation intact; visual refresh
    // comes from the source columns rather than a stale duplicate JSON field.
    repo.updateAssetVisuals('unlisted', { thumbhash: 'new-thumb', duplicateId: 'dup' });
    await service.refresh();
    assert.equal(repo.curate.details(['unlisted'])[0].evidence.image.thumbhash, 'new-thumb');
    assert.equal(repo.curate.photo('unlisted').duplicateId, 'dup');
    repo.upsertAsset({ ...asset, thumbhash: null, duplicateId: null });
    await service.refresh();
    assert.equal(repo.curate.details(['unlisted'])[0].evidence.image.thumbhash, null);
    assert.equal(repo.curate.photo('unlisted').duplicateId, null);
    assert.equal(repo.curate.photo('unlisted').renditionKey, null);
    assert.equal(repo.curate.photo('unlisted').recognizedCount, 1);
    repo.db.prepare("DELETE FROM review_list WHERE asset_id='unlisted'").run();
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_observations').get().n, 0);
  }));

test('unchanged sync queues no work; every grouping source column still invalidates atomically', async () =>
  fixture(async ({ repo, service, add }) => {
    const assets = Array.from({ length: 200 }, (_, i) => ({
      id: 'p' + i,
      fileCreatedAt: capture(i * 60),
      checksum: 'c' + i,
      fileModifiedAt: capture(i),
      width: 100,
      height: 200,
      thumbhash: 't',
      duplicateId: 'd' + i,
      people: [],
      isEdited: false,
    }));
    repo.transaction(() => {
      for (const asset of assets) add(asset.id, 0, asset);
    });
    await service.refresh();
    const generation = repo.curate.generation(),
      current = service.current;
    repo.transaction(() => assets.forEach((asset) => repo.upsertAsset({ ...asset, updatedAt: capture(10000) })));
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_dirty').get().n, 0);
    await service.refresh();
    assert.equal(repo.curate.generation(), generation);
    assert.equal(service.current, current);
    for (const column of [
      'checksum',
      'file_created_at',
      'file_modified_at',
      'width',
      'height',
      'thumbhash',
      'duplicate_id',
      'missing_since',
    ]) {
      repo.db.prepare(`UPDATE assets SET ${column}=NULL WHERE asset_id='p0'`).run();
      if (column === 'missing_since')
        repo.db.prepare("UPDATE assets SET missing_since='missing' WHERE asset_id='p0'").run();
      assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM curate_dirty WHERE asset_id='p0'").get().n, 1, column);
      await service.refresh();
    }
    const before = repo.curate.photo('p1').materialKey;
    assert.throws(
      () =>
        repo.transaction(() => {
          repo.upsertAsset({ ...assets[1], checksum: 'changed', people: [{ id: 'new' }] });
          throw Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_dirty').get().n, 0);
    assert.equal(repo.curate.photo('p1').materialKey, before);
  }));

test('limited discovery leaves semantic evidence unknown until the explicit asset-detail adapter runs', async () =>
  fixture(async ({ repo, service, add, enrich }) => {
    add('land', 0);
    add('solo', 1);
    enrich('land', 0);
    enrich('solo', 1);
    assert.equal((await service.openView()).total, 1);
    assert.equal(repo.curate.photo('land').recognizedCount, null);
    let calls = 0;
    service.immich = {
      getAsset: async (id) => {
        calls++;
        return {
          id,
          fileCreatedAt: capture(id === 'land' ? 0 : 1),
          people: id === 'land' ? [] : [{ id: 'person' }],
          isEdited: false,
        };
      },
    };
    service.requestMetadataRefresh(['land', 'solo']);
    await service.metadata.tick();
    assert.equal(calls, 2);
    assert.equal((await service.openView()).total, 2);
    assert.equal(repo.curate.photo('land').recognizedCount, 0);
    assert.equal(repo.curate.photo('solo').recognizedCount, 1);
  }));

test('30k-photo decisions can replace their view at capacity without releasing other tabs', async () =>
  fixture(async ({ repo, service }) => {
    const ids = Array.from({ length: 30000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const insert = repo.db.prepare(
      'INSERT INTO assets(asset_id,file_created_at,first_seen_at,last_seen_at) VALUES(?,?,?,?)',
    );
    repo.transaction(() => {
      ids.forEach((id, i) => insert.run(id, capture(i * 60), 'now', 'now'));
      repo.reviewListAdd(ids, 'test');
    });
    const decide = (i) =>
      repo.recordDecision({ assetIds: [ids[i]], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    const firstTab = await service.openView();
    decide(0);
    const secondTab = await service.openView();
    decide(1);
    let current = await service.openView();
    decide(2);
    await assert.rejects(service.openView(), (error) => error.code === 'curate_capacity');
    for (let i = 2; i < 12; i++) {
      if (i > 2) decide(i);
      const oldId = current.viewId;
      current = await service.openView({ replacesViewId: oldId, kind: 'singles' });
      if (i === 2) {
        // The replacement succeeded, but its response never reached the client.
        // Retrying the old ID must supersede that successor, not retain an orphan.
        const lostId = current.viewId;
        current = await service.openView({ replacesViewId: oldId, kind: 'singles' });
        assert.throws(
          () => service.page(lostId),
          (error) => error.code === 'curate_expired',
        );
      }
      assert.equal(current.total, 30000 - i - 1);
      assert.throws(
        () => service.page(oldId),
        (error) => error.code === 'curate_expired',
      );
      assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 3);
      assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='view'").get().n, 3);
      assert.equal(service.page(firstTab.viewId).total, 30000);
      assert.equal(service.page(secondTab.viewId).total, 29999);
      assert.equal(service.page(current.viewId, current.total - 1, 1).groups[0].id, `single:standard-1:${ids.at(-1)}`);
      const used = repo.db
        .prepare(
          `SELECT (SELECT SUM(bytes) FROM curate_leases) + (SELECT SUM(bytes) FROM curate_view_snapshots)
          + (SELECT COALESCE(SUM(bytes),0) FROM curate_view_replacements) n`,
        )
        .get().n;
      assert.ok(used <= MAX_LEASE_BYTES);
    }
    repo.curate.releaseLease(firstTab.viewId);
    repo.curate.releaseLease(secondTab.viewId);
    const lastId = current.viewId;
    current = await service.openView({ replacesViewId: lastId });
    assert.equal(current.total, 29988);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 1);
  }));

test('replacement capacity rejection rolls back its old view, comparison and shared snapshot', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    const old = await service.openView(),
      other = await service.openView();
    const comparison = service.comparison(old.viewId, old.groups[0].id);
    for (let i = 0; i < 100; i++) add(`far-${i}`, 10000 + i * 60);
    const used = repo.db
      .prepare(`SELECT (SELECT SUM(bytes) FROM curate_leases) + (SELECT SUM(bytes) FROM curate_view_snapshots) n`)
      .get().n;
    const filled = repo.curate.lease('comparison', {
      padding: 'x'.repeat(MAX_LEASE_BYTES - used - Buffer.byteLength(JSON.stringify({ padding: '' }))),
    });
    await assert.rejects(service.openView({ replacesViewId: old.viewId }), (error) => error.code === 'curate_capacity');
    assert.equal(service.page(old.viewId).total, 1);
    assert.equal(service.comparisonPhotos(comparison.id).total, 2);
    assert.equal(service.page(other.viewId).total, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 1);
    repo.curate.releaseLease(filled.id);
    const next = await service.openView({ replacesViewId: old.viewId });
    assert.equal(next.total, 101);
    assert.throws(
      () => service.comparisonPhotos(comparison.id),
      (error) => error.code === 'curate_expired',
    );
    assert.equal(service.page(other.viewId).total, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
  }));

test('replacement retries resolve the latest successor after restart without extending old IDs', async () =>
  fixture(async ({ repo, service, add, path }) => {
    add('a');
    add('b', 1);
    const original = await service.openView(),
      other = await service.openView();
    const first = await service.openView({ replacesViewId: original.viewId });
    const second = await service.openView({ replacesViewId: first.viewId });
    const comparison = service.comparison(second.viewId, second.groups[0].id);
    const alias = repo.db.prepare('SELECT * FROM curate_view_replacements WHERE id=?').get(original.viewId);
    assert.equal(alias.expires_at, original.expiresAt);
    const plan = repo.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM curate_leases WHERE kind='view' AND json_extract(json,'$.replacementRootId')=? AND expires_at>?",
      )
      .all(alias.root_id, Date.now());
    assert.match(JSON.stringify(plan), /idx_curate_view_replacement_root/);
    const reader = new Repository(path);
    reader.initSchema();
    const restarted = new CurateService({ repo: reader });
    try {
      const retry = await restarted.openView({ replacesViewId: original.viewId });
      assert.equal(retry.total, 1);
      assert.equal(restarted.page(other.viewId).total, 1);
      for (const id of [original.viewId, first.viewId, second.viewId])
        assert.throws(
          () => restarted.page(id),
          (error) => error.code === 'curate_expired',
        );
      assert.throws(
        () => restarted.comparisonPhotos(comparison.id),
        (error) => error.code === 'curate_expired',
      );
      assert.equal(reader.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='view'").get().n, 2);
      assert.deepEqual(
        repo.db.prepare('SELECT * FROM curate_view_replacements WHERE id=?').get(original.viewId),
        alias,
      );
      const again = await restarted.openView({ replacesViewId: first.viewId });
      assert.throws(
        () => restarted.page(retry.viewId),
        (error) => error.code === 'curate_expired',
      );
      assert.equal(again.total, 1);
    } finally {
      await restarted.close();
      reader.close();
    }
  }));

test('replacement aliases expire independently, count against capacity and roll back with stale-ID rejection', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    const old = await service.openView();
    const live = await service.openView({ replacesViewId: old.viewId });
    const comparison = service.comparison(live.viewId, live.groups[0].id);
    const aliasBytes = repo.db.prepare('SELECT SUM(bytes) n FROM curate_view_replacements').get().n;
    assert.ok(aliasBytes > 0);
    const used = repo.db
      .prepare(
        `SELECT (SELECT SUM(bytes) FROM curate_leases)
      + (SELECT SUM(bytes) FROM curate_view_snapshots) + (SELECT SUM(bytes) FROM curate_view_replacements) n`,
      )
      .get().n;
    const paddingBytes = MAX_LEASE_BYTES - used - Buffer.byteLength(JSON.stringify({ padding: '' }));
    assert.throws(
      () => repo.curate.lease('comparison', { padding: 'x'.repeat(paddingBytes + 1) }),
      (error) => error.code === 'curate_capacity',
    );
    const padding = repo.curate.lease('comparison', { padding: 'x'.repeat(paddingBytes) });
    for (let i = 0; i < 10; i++) add('far' + i, 10000 + i * 60);
    await assert.rejects(service.openView({ replacesViewId: old.viewId }), (error) => error.code === 'curate_capacity');
    assert.equal(service.page(live.viewId).total, 1);
    assert.equal(service.comparisonPhotos(comparison.id).total, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_replacements').get().n, 1);
    repo.curate.releaseLease(padding.id);
    repo.db.prepare('UPDATE curate_view_replacements SET expires_at=0 WHERE id=?').run(old.viewId);
    const fresh = await service.openView({ replacesViewId: old.viewId });
    // An expired historical handle no longer authorizes replacing its successor.
    assert.equal(service.page(live.viewId).total, 1);
    assert.equal(fresh.total, 11);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_replacements').get().n, 0);
  }));

test('a concurrent retry with different filters waits for its successor snapshot before replacing it', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    const old = await service.openView();
    add('b', 60);
    const started = Promise.withResolvers(),
      release = Promise.withResolvers();
    const write = repo.curate.writeViewSnapshot.bind(repo.curate);
    let writes = 0;
    repo.curate.writeViewSnapshot = async (...args) => {
      if (++writes === 1) {
        started.resolve();
        await release.promise;
      }
      return write(...args);
    };
    const first = service.openView({ replacesViewId: old.viewId });
    await started.promise;
    const retry = service.openView({ replacesViewId: old.viewId, kind: 'stacks' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(writes, 1);
    release.resolve();
    const [lost, next] = await Promise.all([first, retry]);
    assert.equal(next.total, 0);
    assert.throws(
      () => service.page(lost.viewId),
      (error) => error.code === 'curate_expired',
    );
    assert.equal(repo.db.prepare("SELECT COUNT(*) n FROM curate_leases WHERE kind='view'").get().n, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 1);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_groups').get().n, 0);
  }));

test('failed replacement snapshot writes release their reservation and allow retry with the prior ID', async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    const old = await service.openView();
    add('b', 60);
    const write = repo.curate.writeViewSnapshot;
    repo.curate.writeViewSnapshot = async () => {
      throw Error('synthetic write failure');
    };
    await assert.rejects(service.openView({ replacesViewId: old.viewId }), /synthetic write failure/);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_view_snapshots').get().n, 0);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM curate_leases').get().n, 0);
    repo.curate.writeViewSnapshot = write;
    const next = await service.openView({ replacesViewId: old.viewId });
    assert.equal(next.total, 2);
    assert.equal(repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
  }));

test("waiting for a predecessor cannot expose another tab's still-building target snapshot", async () =>
  fixture(async ({ repo, service, add }) => {
    add('a');
    add('b', 1);
    const old = await service.openView();
    add('c', 60);
    const predecessorStarted = Promise.withResolvers(),
      targetStarted = Promise.withResolvers();
    const predecessorRelease = Promise.withResolvers(),
      targetRelease = Promise.withResolvers();
    const write = repo.curate.writeViewSnapshot.bind(repo.curate);
    let writes = 0;
    repo.curate.writeViewSnapshot = async (...args) => {
      if (++writes === 1) {
        predecessorStarted.resolve();
        await predecessorRelease.promise;
      } else {
        targetStarted.resolve();
        await targetRelease.promise;
      }
      return write(...args);
    };
    const first = service.openView({ replacesViewId: old.viewId });
    await predecessorStarted.promise;
    let retrySettled = false;
    const retry = service.openView({ replacesViewId: old.viewId, kind: 'singles' }).finally(() => {
      retrySettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    const other = service.openView({ kind: 'singles' });
    await targetStarted.promise;
    try {
      predecessorRelease.resolve();
      await first;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(retrySettled, false);
      targetRelease.resolve();
      const [next, otherView] = await Promise.all([retry, other]);
      assert.equal(next.total, 1);
      assert.equal(next.groups.length, 1);
      assert.equal(otherView.groups.length, 1);
      assert.equal(service.page(next.viewId).groups[0].memberCount, 1);
    } finally {
      predecessorRelease.resolve();
      targetRelease.resolve();
      await Promise.allSettled([first, retry, other]);
    }
  }));


test('review category and search retain complete stacks; decided views have stable individual scope', async () =>
  fixture(async ({ repo, service, add }) => {
    add('00000000-0000-0000-0000-000000000001', 0, { originalPath: '/photos/match.jpg' });
    add('00000000-0000-0000-0000-000000000002', 1);
    add('00000000-0000-0000-0000-000000000003', 900);
    service.review = {
      taxonomy: {},
      reviewRows: () => [
        { assetId: '00000000-0000-0000-0000-000000000001', bucket: 'unlikely' },
        { assetId: '00000000-0000-0000-0000-000000000002', bucket: 'candidates' },
        { assetId: '00000000-0000-0000-0000-000000000003', bucket: 'should_review' },
      ],
    };
    const candidates = await service.openView({ category: 'candidates', search: 'match' });
    assert.equal(candidates.total, 1);
    assert.equal(candidates.groups[0].memberCount, 2);
    assert.equal((await service.openView({ category: 'unlikely' })).total, 0);
    assert.equal(
      (await service.openView({ category: 'should_review' })).groups[0].photos[0].id,
      '00000000-0000-0000-0000-000000000003',
    );
    await assert.rejects(service.selection(candidates.viewId, [candidates.groups[0].id]), /only.*single/);
    repo.setManualFrameTags({
      assetIds: ['00000000-0000-0000-0000-000000000001'],
      addTags: ['frame/eligible'],
      removeTags: [],
      action: 'approve',
    });
    const decided = await service.openView({ section: 'decided' });
    assert.equal(decided.total, 1);
    assert.equal(decided.groups[0].photos[0].state, 'approved');
    const c = service.comparison(decided.viewId, decided.groups[0].id);
    const { expiresAt, ...op } = await service.issueDecision(c.id);
    assert.equal(op.snapshot.reviewState, 'decided');
    const receipt = await service.applyDecision({
      ...op,
      outcomes: { '00000000-0000-0000-0000-000000000001': 'reject' },
    });
    assert.equal(receipt.assetCount, 1);
    assert.deepEqual(
      await service.applyDecision({ ...op, outcomes: { '00000000-0000-0000-0000-000000000001': 'reject' } }),
      receipt,
    );
    await service.applyDecision({
      operationId: receipt.undo.operationId,
      kind: 'undo',
      targetOperationId: receipt.operationId,
    });
    assert.ok(
      repo
        .loadAssetTagsFor(['00000000-0000-0000-0000-000000000001'])
        ['00000000-0000-0000-0000-000000000001'].includes('frame/eligible'),
    );
    assert.ok(
      !repo
        .loadAssetTagsFor(['00000000-0000-0000-0000-000000000001'])
        ['00000000-0000-0000-0000-000000000001'].includes('frame/never-show'),
    );
    await assert.rejects(service.issueDecision(c.id), /changed/);
    await assert.rejects(service.openView({ section: 'invalid' }), /Invalid/);
  }));

test('bulk singles cannot act on new stack membership; decided snapshots reject concurrent changes', async () =>
  fixture(async ({ repo, service, add }) => {
    add('00000000-0000-0000-0000-000000000001', 0);
    add('00000000-0000-0000-0000-000000000002', 900);
    const view = await service.openView();
    const c = await service.selection(
      view.viewId,
      view.groups.map((g) => g.id),
    );
    const { expiresAt, ...op } = await service.issueDecision(c.id);
    add('00000000-0000-0000-0000-000000000002', 1);
    await assert.rejects(
      service.selection(
        view.viewId,
        view.groups.map((g) => g.id),
      ),
      /now in a stack/,
    );
    // Previously issued bulk operation must also reject a new stack, even when
    // all new members were individually selected earlier.
    await assert.rejects(
      service.applyDecision({
        ...op,
        outcomes: {
          '00000000-0000-0000-0000-000000000001': 'approve',
          '00000000-0000-0000-0000-000000000002': 'approve',
        },
      }),
      /changed/,
    );
    repo.setManualFrameTags({
      assetIds: ['00000000-0000-0000-0000-000000000001'],
      addTags: ['frame/eligible'],
      removeTags: [],
      action: 'approve',
    });
    const decided = await service.openView({ section: 'decided' });
    const dc = service.comparison(decided.viewId, decided.groups[0].id);
    const { expiresAt: until, ...dop } = await service.issueDecision(dc.id);
    repo.setManualFrameTags({
      assetIds: ['00000000-0000-0000-0000-000000000001'],
      addTags: ['frame/favorite'],
      removeTags: [],
      action: 'favorite',
    });
    await assert.rejects(
      service.applyDecision({ ...dop, outcomes: { '00000000-0000-0000-0000-000000000001': 'reject' } }),
      /changed/,
    );
    assert.ok(
      repo
        .loadAssetTagsFor(['00000000-0000-0000-0000-000000000001'])
        ['00000000-0000-0000-0000-000000000001'].includes('frame/favorite'),
    );
  }));
