import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { Repository } from '../../src/enrich/repository.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { METADATA_LIMITS } from '../../src/curate/metadata.mjs';
import { ImmichClient } from '../../src/immich.mjs';
import { createCurateRoutes } from '../../src/routes/curate.mjs';

const deferred = () => Promise.withResolvers();
const asset = (id, extra = {}) => ({ id, fileCreatedAt: '2026-01-01T00:00:00Z', people: [], ...extra });
async function fixture(work) {
  const dir = mkdtempSync(join(tmpdir(), 'curate-metadata-'));
  const path = join(dir, 'enrichment.sqlite');
  const repo = new Repository(path);
  repo.initSchema();
  let now = Date.now();
  const service = new CurateService({ repo, metadataOptions: { now: () => now, automatic: false } });
  const add = (id, extra = {}) => {
    repo.reviewListAdd([id], 'test');
    repo.upsertAsset(asset(id, extra));
  };
  const open = async () => {
    const view = await service.openView();
    clearInterval(service.timer);
    return view;
  };
  try {
    await work({
      repo,
      service,
      add,
      open,
      path,
      advance: (ms) => {
        now += ms;
      },
      now: () => now,
    });
  } finally {
    await service.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
async function httpServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('one batch admits 500 reads with two in flight; freshness survives restart and page opens', async () =>
  fixture(async (f) => {
    let active = 0,
      max = 0,
      calls = 0;
    f.service.immich = {
      async getAsset(id) {
        calls++;
        max = Math.max(max, ++active);
        await setImmediate();
        active--;
        return asset(id);
      },
    };
    f.repo.transaction(() => {
      for (let i = 0; i < 503; i++) f.add(`p${i}`);
    });
    await f.open();
    assert.equal((await f.service.metadata.tick()).attempted, 500);
    assert.equal(max, 2);
    assert.equal((await f.service.metadata.tick()).attempted, 3);
    await f.open();
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    const reader = new Repository(f.path);
    reader.initSchema();
    const restarted = new CurateService({
      repo: reader,
      immich: f.service.immich,
      metadataOptions: { now: f.now, automatic: false },
    });
    try {
      assert.equal((await restarted.metadata.tick()).attempted, 0);
    } finally {
      await restarted.close();
      reader.close();
    }
    assert.equal(calls, 503);
    const detail = f.repo.curate.details(['p0'])[0];
    assert.equal(detail.metadata.outcome, 'refreshed');
    assert.equal(detail.metadata.checkedAt, f.now());
  }));

test('only pending photos and bounded requested kept context are refreshed', async () =>
  fixture(async (f) => {
    const called = [];
    f.service.immich = {
      async getAsset(id) {
        called.push(id);
        return asset(id);
      },
    };
    f.add('pending');
    const kept = Array.from({ length: 1000 }, (_, i) => `kept${i}`);
    f.repo.transaction(() => {
      for (const id of kept) f.add(id);
      f.repo.recordDecision({ assetIds: kept, addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    });
    const view = await f.open();
    await f.service.metadata.tick();
    assert.deepEqual(called, ['pending']);
    const comparison = f.service.comparison(view.viewId, view.groups[0].id);
    assert.equal(comparison.context.length, 8);
    await f.service.metadata.tick();
    assert.equal(called.length, 9);
    f.service.comparison(view.viewId, view.groups[0].id);
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_metadata WHERE priority=2').get().n, 0);
  }));

for (const status of [401, 403, 429, 503, undefined])
  test(`metadata ${status ?? 'transport'} failure pauses globally and persists one-probe recovery`, async () =>
    fixture(async (f) => {
      let calls = 0,
        failing = true;
      f.service.immich = {
        async getAsset(id) {
          calls++;
          if (failing) throw Object.assign(Error('private remote diagnostic'), { status });
          return asset(id);
        },
      };
      for (let i = 0; i < 10; i++) f.add(`p${i}`);
      await f.open();
      await f.service.metadata.tick();
      assert.ok(calls <= 2);
      const initial = calls;
      assert.equal(f.service.metadata.status().state, 'paused');
      assert.equal(f.service.metadata.status().problem, [401, 403].includes(status) ? 'permission' : 'connection');
      assert.ok(!JSON.stringify(f.service.metadata.status()).includes('private'));
      assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM assets WHERE missing_since IS NOT NULL').get().n, 0);
      const reader = new Repository(f.path);
      reader.initSchema();
      const restarted = new CurateService({
        repo: reader,
        immich: f.service.immich,
        metadataOptions: { now: f.now, automatic: false },
      });
      try {
        assert.equal((await restarted.metadata.tick()).attempted, 0);
      } finally {
        await restarted.close();
        reader.close();
      }
      f.advance(30000);
      assert.equal((await f.service.metadata.tick()).attempted, 1);
      assert.equal(f.repo.curate.metadata.control().retry_at, f.now() + 60000);
      f.advance(60000);
      failing = false;
      assert.equal((await f.service.metadata.tick()).attempted, 1);
      assert.equal(f.service.metadata.status().problem, null);
      await f.service.metadata.tick();
      assert.equal(calls, initial + 11);
    }));

test('404/410 are per-photo unavailability; invalid responses do not mutate identity or retry in a loop', async () =>
  fixture(async (f) => {
    const replies = {
      missing: 404,
      gone: 410,
      wrong: { id: 'different', people: [] },
      empty: { id: 'empty' },
      good: asset('good'),
      malformed: new SyntaxError('invalid JSON'),
    };
    f.service.immich = {
      async getAsset(id) {
        const r = replies[id];
        if (r instanceof Error) throw r;
        if (typeof r === 'number') throw Object.assign(Error('missing'), { status: r });
        return r;
      },
    };
    for (const id of Object.keys(replies)) f.add(id, { checksum: 'original' });
    await f.open();
    await f.service.metadata.tick();
    for (const id of ['missing', 'gone']) assert.equal(f.repo.curate.metadata.row(id).outcome, 'unavailable');
    for (const id of ['wrong', 'empty', 'malformed']) {
      assert.equal(f.repo.curate.metadata.row(id).outcome, 'invalid-response');
      assert.equal(f.repo.db.prepare('SELECT checksum FROM assets WHERE asset_id=?').get(id).checksum, 'original');
    }
    assert.equal(f.repo.curate.metadata.row('good').outcome, 'refreshed');
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    f.advance(31000);
    replies.missing = asset('missing');
    f.service.requestMetadataRefresh(['missing']);
    await f.service.metadata.tick();
    assert.equal(
      f.repo.db.prepare('SELECT missing_since FROM assets WHERE asset_id=?').get('missing').missing_since,
      null,
    );
  }));

test('partial metadata preserves image identity; explicit empty dimensions and visual fields invalidate it', async () =>
  fixture(async (f) => {
    f.add('p', {
      checksum: 'known',
      width: 900,
      height: 600,
      thumbhash: 'known',
      duplicateId: 'set',
      exifInfo: { orientation: 1 },
    });
    await f.open();
    const merge = (fields) => {
      f.repo.curate.mergeMetadataAsset({ id: 'p', ...fields });
      f.repo.curate.flushIds(['p']);
      return f.repo.db.prepare('SELECT * FROM assets WHERE asset_id=?').get('p');
    };
    let row = merge({ people: [] });
    assert.equal(row.checksum, 'known');
    assert.equal(row.width, 900);
    row = merge({ exifInfo: { imageWidth: 800 } });
    assert.equal(row.width, 800);
    assert.equal(row.height, 600);
    row = merge({ exifInfo: { exifImageWidth: null } });
    assert.equal(row.width, null);
    row = merge({ thumbhash: null, duplicateId: null, exifInfo: null });
    assert.equal(row.thumbhash, null);
    assert.equal(row.duplicate_id, null);
    assert.equal(row.height, null);
  }));

test('in-flight observations cannot overwrite changed source images or resurrect removed review members', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred();
    let count = 0;
    f.service.immich = {
      async getAsset(id) {
        if (++count === 2) waiting.resolve();
        await release.promise;
        return asset(id, { checksum: 'old', people: [{ id: 'old-person' }] });
      },
    };
    f.add('a', { checksum: 'old' });
    f.add('b', { checksum: 'old' });
    await f.open();
    const task = f.service.metadata.tick();
    await waiting.promise;
    f.repo.upsertAsset(asset('a', { checksum: 'new' }));
    f.repo.db.prepare('DELETE FROM review_list WHERE asset_id=?').run('b');
    release.resolve();
    const result = await task;
    assert.equal(result.discarded, 2);
    assert.equal(f.repo.db.prepare('SELECT checksum FROM assets WHERE asset_id=?').get('a').checksum, 'new');
    assert.equal(f.repo.curate.metadata.row('b'), undefined);
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM review_list WHERE asset_id=?').get('b').n, 0);
    assert.equal((await f.service.metadata.tick()).attempted, 0);
  }));

test('a human decision during metadata refresh is preserved and does not discard unchanged image evidence', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred();
    f.service.immich = {
      async getAsset(id) {
        waiting.resolve();
        await release.promise;
        return asset(id, { isEdited: true });
      },
    };
    f.add('a');
    await f.open();
    const task = f.service.metadata.tick();
    await waiting.promise;
    f.repo.recordDecision({ assetIds: ['a'], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    release.resolve();
    assert.equal((await task).updated, 1);
    assert.equal(f.repo.curate.photo('a').state, 'approved');
    assert.equal(f.repo.curate.metadata.row('a').priority, 0);
  }));

test('newer locally observed edit/recognition evidence rejects a late detail response', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred();
    f.service.immich = {
      async getAsset(id) {
        waiting.resolve();
        await release.promise;
        return asset(id, { isEdited: false });
      },
    };
    f.add('a', { isEdited: false });
    await f.open();
    const task = f.service.metadata.tick();
    await waiting.promise;
    f.repo.upsertAsset(asset('a', { isEdited: true, people: [{ id: 'new-person' }] }));
    release.resolve();
    assert.equal((await task).discarded, 1);
    assert.equal(f.repo.curate.photo('a').recognizedCount, 1);
  }));

test('refresh requests coalesce and respect durable claim cooldown and daily freshness', async () =>
  fixture(async (f) => {
    let calls = 0;
    f.service.immich = {
      async getAsset(id) {
        calls++;
        return asset(id);
      },
    };
    f.add('a');
    await f.open();
    f.repo.curate.metadata.connection(f.service.metadata.connectionKey(f.service.immich));
    f.repo.curate.metadata.claim('a', f.now()); // Simulate interruption after claiming.
    f.service.requestMetadataRefresh(['a']);
    f.service.requestMetadataRefresh(['a']);
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    f.advance(30000);
    assert.equal((await f.service.metadata.tick()).attempted, 1);
    f.service.requestMetadataRefresh(['a']);
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    f.advance(30000);
    await f.service.metadata.tick();
    assert.equal(calls, 2);
    f.advance(METADATA_LIMITS.freshnessMs);
    f.repo.db.prepare('UPDATE curate_leases SET expires_at=?').run(f.now() + 30000);
    assert.equal((await f.service.metadata.tick()).attempted, 1);
    assert.equal(calls, 3);
  }));

for (const stop of ['stacks-off', 'view-closed'])
  test(`${stop} stops further reads and discards outstanding results`, async () =>
    fixture(async (f) => {
      const waiting = deferred(),
        release = deferred();
      let calls = 0;
      f.service.immich = {
        async getAsset(id) {
          if (++calls === 2) waiting.resolve();
          await release.promise;
          return asset(id);
        },
      };
      for (const id of ['a', 'b', 'c']) f.add(id);
      const view = await f.open();
      const task = f.service.metadata.tick();
      await waiting.promise;
      if (stop === 'stacks-off') {
        f.service.config.curateBurstGrouping = false;
        f.service.settingsChanged();
      } else f.repo.curate.releaseLease(view.viewId);
      release.resolve();
      assert.equal((await task).discarded, 2);
      assert.equal(calls, 2);
    }));

test('Stacks off and absent configuration make no requests; Enrich off does not disable Curate metadata', async () =>
  fixture(async (f) => {
    f.add('a');
    await f.open();
    assert.equal((await f.service.metadata.tick()).attempted, 0);
    let calls = 0;
    f.service.immich = {
      baseUrl: '',
      apiKey: '',
      async getAsset(id) {
        calls++;
        return asset(id);
      },
    };
    await f.service.metadata.tick();
    assert.equal(calls, 0);
    f.service.immich.baseUrl = 'http://test.invalid';
    f.service.immich.apiKey = 'synthetic';
    f.service.config.curateBurstGrouping = false;
    await f.service.metadata.tick();
    assert.equal(calls, 0);
    f.service.config.curateBurstGrouping = true;
    f.service.config.enrichEnabled = false;
    await f.service.metadata.tick();
    assert.equal(calls, 1);
  }));

test('changing connection discards old results and resets permission backoff without storing the key', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred();
    f.service.immich = {
      baseUrl: 'http://test.invalid',
      apiKey: 'old-secret',
      async getAsset(id) {
        waiting.resolve();
        await release.promise;
        return asset(id, { checksum: 'old' });
      },
    };
    f.add('a');
    await f.open();
    const task = f.service.metadata.tick();
    await waiting.promise;
    f.service.immich = {
      baseUrl: 'http://test.invalid',
      apiKey: 'new-secret',
      async getAsset(id) {
        return asset(id, { checksum: 'new' });
      },
    };
    f.service.settingsChanged();
    release.resolve();
    assert.equal((await task).discarded, 1);
    f.repo.curate.metadata.fail(f.now(), 'permission');
    assert.equal((await f.service.metadata.tick()).updated, 1);
    const control = f.repo.curate.metadata.control();
    assert.equal(control.problem, null);
    assert.ok(!JSON.stringify(control).includes('secret'));
  }));

test('local storage failure drains the other request before releasing the two-call lane', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred();
    let count = 0;
    f.service.immich = {
      async getAsset(id) {
        count++;
        waiting.resolve();
        await release.promise;
        return asset(id);
      },
    };
    for (const id of ['a', 'b', 'c']) f.add(id);
    await f.open();
    const claim = f.repo.curate.metadata.claim.bind(f.repo.curate.metadata);
    let claims = 0;
    f.repo.curate.metadata.claim = (...args) => {
      if (++claims === 2) throw Error('storage unavailable');
      return claim(...args);
    };
    const task = f.service.metadata.tick();
    await waiting.promise;
    await setImmediate();
    assert.equal(f.service.metadata.tick(), task);
    assert.equal(count, 1);
    release.resolve();
    await assert.rejects(task, /storage unavailable/);
    assert.equal(f.service.metadata.status().problem, 'storage-error');
    assert.equal((await f.service.metadata.tick()).attempted, 0);
  }));

test('expired context is retired in a bounded indexed page, without scanning decided history', async () =>
  fixture(async (f) => {
    for (let i = 0; i < 600; i++) f.add(`p${i}`);
    await f.open();
    f.repo.db.prepare('UPDATE curate_metadata SET priority=2,context_until=0').run();
    assert.deepEqual(f.repo.curate.metadata.next(f.now()), []);
    assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM curate_metadata WHERE priority=2').get().n, 100);
    const plan = f.repo.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT asset_id,context_until FROM curate_metadata WHERE priority=? AND next_at<=? ORDER BY next_at,asset_id LIMIT ?',
      )
      .all(2, f.now(), 500);
    assert.match(JSON.stringify(plan), /idx_curate_metadata_due/);
  }));

test('HTTP group response precedes background Immich reads; material changes preserve opened membership', async () =>
  fixture(async (f) => {
    const waiting = deferred(),
      release = deferred(),
      finished = deferred();
    let calls = 0;
    const remote = await httpServer(async (req, res) => {
      assert.equal(req.method, 'GET');
      assert.match(req.url, /^\/api\/assets\//);
      calls++;
      waiting.resolve();
      await release.promise;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(asset(req.url.split('/').pop(), { isEdited: true, people: [{ id: 'recognized' }] })));
      finished.resolve();
    });
    f.service.immich = new ImmichClient({ baseUrl: remote.url, apiKey: 'synthetic' });
    f.service.metadata.automatic = true;
    f.add('a');
    f.add('b');
    const routes = createCurateRoutes({ curate: f.service });
    const local = await httpServer((req, res) => {
      void routes(req, res, new URL(req.url, 'http://local')).catch((error) => {
        res.statusCode = 500;
        res.end(error.message);
      });
    });
    try {
      const response = await fetch(`${local.url}/api/review/curate/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(response.status, 200);
      const view = await response.json();
      await waiting.promise;
      assert.equal(view.groups[0].memberCount, 2);
      release.resolve();
      await finished.promise;
      await f.service.metadata.tick();
      await f.service.refresh();
      const saved = f.service.page(view.viewId);
      assert.equal(saved.groups[0].memberCount, 2);
      assert.equal(saved.updatesAvailable, true);
      assert.equal(f.repo.curate.photo('a').recognizedCount, 1);
      assert.equal(calls, 2);
      assert.equal(f.repo.db.prepare('SELECT COUNT(*) n FROM manual_overrides').get().n, 0);
    } finally {
      release.resolve();
      await local.close();
      await remote.close();
    }
  }));

test('shutdown aborts a real stalled Immich response body; metadata byte caps are enforced', async () =>
  fixture(async (f) => {
    const waiting = deferred();
    let oversized = false;
    const remote = await httpServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (oversized) res.end(JSON.stringify(asset('a', { padding: 'x'.repeat(METADATA_LIMITS.responseBytes) })));
      else {
        res.write('{');
        waiting.resolve();
      }
    });
    f.service.immich = new ImmichClient({ baseUrl: remote.url, apiKey: 'synthetic' });
    f.add('a');
    await f.open();
    try {
      const task = f.service.metadata.tick();
      await waiting.promise;
      await f.service.close();
      assert.equal((await task).discarded, 1);
      oversized = true;
      await assert.rejects(
        f.service.immich.getAsset('a', { maxBytes: METADATA_LIMITS.responseBytes }),
        (error) => error.name === 'ResponseTooLargeError',
      );
    } finally {
      await remote.close();
    }
  }));
