import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

import { createEnrichRoutes } from '../../src/routes/enrich.mjs';

// Route-level tests for the enrich queue run flow: skip-aware resolution
// advances capped slices, already-enriched photos still reach Curate,
// fully-covered items remove themselves with an honest report, and re-open
// runs keep unfiltered resolution.

function jsonRequest(method, body) {
  const request = Readable.from([Buffer.from(JSON.stringify(body ?? {}))]);
  request.method = method;
  request.headers = { 'content-type': 'application/json' };
  return request;
}

function fakeResponse() {
  const out = { statusCode: null, body: null };
  return {
    out,
    writeHead(statusCode) { out.statusCode = statusCode; },
    end(payload) { out.body = payload ? JSON.parse(payload) : null; },
  };
}

// A slice of five images, served two per page like the paged Immich search.
// `covered` ids resolve as already-successful; `stuck` ids as at the
// content-failure limit. Per-item filter behavior for run-all comes from
// `filters` (one entry per needsWorkFilter call, i.e. per queue item).
function makeHarness({
  covered = ['a1', 'a2', 'a3'],
  stuck = [],
  all = ['a1', 'a2', 'a3', 'a4', 'a5'],
  filters = null,
  currentMembers = null,
  decisionError = null,
  runnerRunningOnStart = false,
} = {}) {
  const coveredSet = new Set(covered);
  const stuckSet = new Set(stuck);
  const defaultFilter = (ids) => ({
    needy: new Set(ids.filter((id) => !coveredSet.has(id) && !stuckSet.has(id))),
    successful: new Set(ids.filter((id) => coveredSet.has(id))),
    failureLimited: new Set(ids.filter((id) => stuckSet.has(id))),
  });
  const state = {
    queue: [{ id: 88, title: 'Paris', filters: { city: 'Paris' }, estimatedCount: all.length }],
    removed: [],
    started: [],
    filterRequests: [],
    reviewListed: [],
    coveredRuns: [],
    jobRuns: [],
    searches: 0,
    runnerRunning: false,
    runnerReserved: false,
    activeQueueItemId: null,
    maintenanceProtected: [],
    decisions: [],
  };
  const startRunner = (options) => {
    state.started.push(options);
    if (runnerRunningOnStart) {
      state.runnerRunning = true;
      state.activeQueueItemId = options.queueItemId;
    }
    return { running: true };
  };
  const enrichRunner = {
    isRunning: () => state.runnerRunning,
    isBusy: () => state.runnerRunning || state.runnerReserved,
    reserve() {
      if (this.isBusy()) throw new Error('An enrichment run is already in progress.');
      state.runnerReserved = true;
      let active = true;
      return {
        start(options) {
          if (!active || !state.runnerReserved) throw new Error('The enrichment reservation is no longer active.');
          active = false;
          state.runnerReserved = false;
          return startRunner(options);
        },
        release() {
          if (!active) return false;
          active = false;
          state.runnerReserved = false;
          return true;
        },
      };
    },
    status: () => (state.runnerRunning
      ? { running: true, options: { queueItemId: state.activeQueueItemId } }
      : { running: false }),
    needsWorkFilter(options) {
      state.filterRequests.push(options);
      if (filters) {
        return filters[Math.min(state.filterRequests.length - 1, filters.length - 1)];
      }
      return defaultFilter;
    },
    recordCoveredResolution(entry) {
      state.coveredRuns.push(entry);
    },
    start: startRunner,
  };
  const handler = createEnrichRoutes({
    review: {
      applyDecision: (decision) => {
        if (decisionError) throw decisionError;
        state.decisions.push(decision);
        return { ok: true };
      },
    },
    taxonomy: {},
    captionWriteback: {},
    referee: null,
    requireImmich: () => true,
    config: { enrichEnabled: true },
    immich: {
      async searchMetadata({ page }) {
        state.searches += 1;
        const start = (page - 1) * 2;
        const items = all.slice(start, start + 2).map((id) => ({ id, type: 'IMAGE' }));
        return { assets: { items, nextPage: start + 2 < all.length ? page + 1 : null } };
      },
    },
    repo: {
      queueGet: (id) => state.queue.find((item) => item.id === id) ?? null,
      queueMaintain: ({ protectedIds = [] } = {}) => {
        state.maintenanceProtected.push([...protectedIds]);
        return 0;
      },
      queuePage: ({ afterId = 0, limit = 50 } = {}) => {
        const rows = state.queue.filter((item) => item.id > afterId).sort((a, b) => a.id - b.id);
        return {
          items: rows.slice(0, limit),
          nextAfterId: rows.length > limit ? rows[limit - 1].id : null,
          total: state.queue.length,
        };
      },
      queueRemove: (id) => {
        state.removed.push(id);
        state.queue = state.queue.filter((item) => item.id !== id);
        return true;
      },
      queueList: () => state.queue,
      libraryStats: () => ({ enrichedTotal: 0, curatedTotal: 0 }),
      recordJobRun: (row) => { state.jobRuns.push(row); },
      reviewListAdd: (assetIds, source) => {
        state.reviewListed.push({ assetIds: [...assetIds], source });
        return assetIds.length;
      },
      reviewListMembership: (assetIds) => new Set(
        assetIds.filter((assetId) => currentMembers === null || currentMembers.includes(assetId)),
      ),
    },
    enrichRunner,
  });
  return { handler, state, enrichRunner };
}

test('queue run targets only photos needing work and still sends covered ones to Curate', async () => {
  const { handler, state } = makeHarness();
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { skipAnySuccessful: true }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.started[0].assetIds, ['a4', 'a5']); // covered a1–a3 never targeted
  assert.equal(response.out.body.queuedRemaining, false);
  assert.deepEqual(state.removed, []); // removal happens on the run's clean finish
  assert.deepEqual(state.filterRequests, [{ provider: undefined, skipAnySuccessful: true }]);
  // The covered photos still land in Curate — the runner's skip path used
  // to do this before filtering kept them from ever reaching the runner.
  assert.deepEqual(state.reviewListed, [{ assetIds: ['a1', 'a2', 'a3'], source: 'enrich' }]);
});

test('queue reads and mutation responses use bounded deterministic cursor pages', async () => {
  const { handler, state } = makeHarness();
  state.queue = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    title: `Slice ${index + 1}`,
    filters: { city: `City ${index + 1}` },
    estimatedCount: null,
    requestedAt: '2026-08-25T00:00:00.000Z',
  }));

  let response = fakeResponse();
  await handler(jsonRequest('GET'), response, new URL('http://x/api/enrich/queue?limit=40'));
  assert.deepEqual(response.out.body.items.map((item) => item.id), Array.from({ length: 40 }, (_, index) => index + 1));
  assert.ok(response.out.body.nextCursor);
  assert.equal(response.out.body.total, 100);

  const cursor = encodeURIComponent(response.out.body.nextCursor);
  response = fakeResponse();
  await handler(jsonRequest('GET'), response, new URL(`http://x/api/enrich/queue?limit=40&cursor=${cursor}`));
  assert.deepEqual(response.out.body.items.map((item) => item.id), Array.from({ length: 40 }, (_, index) => index + 41));

  response = fakeResponse();
  await handler(jsonRequest('DELETE'), response, new URL('http://x/api/enrich/queue/100'));
  assert.equal(response.out.body.items.length, 50);
  assert.ok(response.out.body.nextCursor);
  assert.equal(response.out.body.total, 99);

  await assert.rejects(
    () => handler(jsonRequest('GET'), fakeResponse(), new URL('http://x/api/enrich/queue?cursor=not-a-cursor')),
    (error) => error.code === 'invalid_queue_cursor' && error.status === 400,
  );
  await assert.rejects(
    () => handler(jsonRequest('GET'), fakeResponse(), new URL('http://x/api/enrich/queue?limit=101')),
    (error) => error.code === 'invalid_queue_limit' && error.status === 400,
  );
});

test('Send to Curate off means covered photos are not review-listed', async () => {
  const { handler, state } = makeHarness();
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { skipAnySuccessful: true, sendToCurate: false }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.deepEqual(state.reviewListed, []);
  assert.equal(state.started[0].sendToCurate, false);
});

test('a fully covered queue item removes itself and its photos still reach Curate', async () => {
  const { handler, state } = makeHarness({ covered: ['a1', 'a2', 'a3', 'a4', 'a5'] });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { skipAnySuccessful: true }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.fullyCovered, true);
  assert.match(response.out.body.message, /fully covered/);
  assert.equal(response.out.body.covered, 5);
  assert.equal(response.out.body.failureLimited, 0);
  assert.deepEqual(state.removed, [88]);
  assert.deepEqual(state.started, []); // no run started
  assert.deepEqual(state.reviewListed, [{ assetIds: ['a1', 'a2', 'a3', 'a4', 'a5'], source: 'enrich' }]);
  assert.deepEqual(response.out.body.items, []);
  // The outcome is durable: a run-history record carries the counts.
  assert.deepEqual(state.coveredRuns, [{ title: 'Paris', provider: undefined, covered: 5, failureLimited: 0, discarded: 0 }]);
});

test('photos stuck at the failure limit are reported, not called covered', async () => {
  const { handler, state } = makeHarness({ covered: ['a1', 'a2', 'a3'], stuck: ['a4', 'a5'] });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { skipAnySuccessful: true }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.fullyCovered, true);
  assert.match(response.out.body.message, /3 already enriched, 2 at the failure limit/);
  assert.equal(response.out.body.covered, 3);
  assert.equal(response.out.body.failureLimited, 2);
  assert.deepEqual(state.removed, [88]); // still auto-removed, but honestly
  // Only the successes go to Curate — failure-limited photos never enriched.
  assert.deepEqual(state.reviewListed, [{ assetIds: ['a1', 'a2', 'a3'], source: 'enrich' }]);
  assert.deepEqual(state.coveredRuns, [{ title: 'Paris', provider: undefined, covered: 3, failureLimited: 2, discarded: 0 }]);
});

test('a slice matching no photos stays queued with the empty_slice error', async () => {
  const { handler, state } = makeHarness({ all: [] });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { skipAnySuccessful: true }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 400);
  assert.equal(response.out.body.error.code, 'empty_slice');
  assert.deepEqual(state.removed, []); // could be transient — never auto-removed
});

test('re-open runs resolve unfiltered so the finish clears decisions on the whole slice', async () => {
  const { handler, state } = makeHarness();
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { reopenDecided: true, skipAnySuccessful: false }),
    response,
    new URL('http://x/api/enrich/queue/88/run'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.deepEqual(state.filterRequests, []); // the needs-work filter is bypassed
  assert.deepEqual(state.started[0].assetIds, ['a1', 'a2', 'a3', 'a4', 'a5']);
  assert.equal(state.started[0].skipAnySuccessful, false);
  assert.equal(state.started[0].reopenDecided, true);
  assert.deepEqual(state.reviewListed, []); // no covered ids in unfiltered resolution
  state.started[0].onFinished();
  assert.deepEqual(state.decisions, [{ action: 'clear', assetIds: ['a1', 'a2', 'a3', 'a4', 'a5'] }]);
  assert.deepEqual(state.removed, [88]);
});

test('re-open clears only current Curate members and preserves the queue item if sync admission fails', async () => {
  const current = makeHarness({ currentMembers: ['a1', 'a2'] });
  await current.handler(
    jsonRequest('POST', { reopenDecided: true, skipAnySuccessful: false }),
    fakeResponse(),
    new URL('http://x/api/enrich/queue/88/run'),
  );
  current.state.started[0].onFinished();
  assert.deepEqual(current.state.decisions, [{ action: 'clear', assetIds: ['a1', 'a2'] }]);
  assert.deepEqual(current.state.removed, [88]);

  const blocked = makeHarness({ decisionError: Object.assign(new Error('backlog full'), { code: 'review_sync_backlog_full' }) });
  await blocked.handler(
    jsonRequest('POST', { reopenDecided: true, skipAnySuccessful: false }),
    fakeResponse(),
    new URL('http://x/api/enrich/queue/88/run'),
  );
  assert.throws(() => blocked.state.started[0].onFinished(), /backlog full/);
  assert.deepEqual(blocked.state.removed, []);
});

test('run-all removes covered items, reports them, and starts the first item with work', async () => {
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(), successful: new Set(ids), failureLimited: new Set() }),
      (ids) => ({
        needy: new Set(ids.filter((id) => !['a1', 'a2', 'a3'].includes(id))),
        successful: new Set(ids.filter((id) => ['a1', 'a2', 'a3'].includes(id))),
        failureLimited: new Set(),
      }),
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    response,
    new URL('http://x/api/enrich/queue/run-all'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.deepEqual(state.removed, [88]); // covered item removed mid-chain
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.started[0].assetIds, ['a4', 'a5']);
  // The removed item's counts ride along so the UI can report it, and
  // planned reflects what will actually run — not the raw selection.
  assert.equal(response.out.body.planned, 1);
  assert.equal(response.out.body.selected, 2);
  assert.equal(response.out.body.coveredRemoved, 1);
  assert.equal(response.out.body.covered, 5);
  assert.equal(response.out.body.failureLimited, 0);
});

test('run-all protects every remaining planned item while the chain is active', async () => {
  const { handler, state } = makeHarness({
    covered: [],
    runnerRunningOnStart: true,
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Lyon' }, estimatedCount: 5 });

  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    response,
    new URL('http://x/api/enrich/queue/run-all'),
  );

  assert.equal(response.out.statusCode, 202);
  assert.deepEqual(state.maintenanceProtected.at(-1).sort((a, b) => a - b), [88, 89]);

  const queueResponse = fakeResponse();
  await handler(jsonRequest('GET'), queueResponse, new URL('http://x/api/enrich/queue'));
  assert.deepEqual(state.maintenanceProtected.at(-1).sort((a, b) => a - b), [88, 89]);
});

test('run-all with every item covered removes them all and reports it without an error', async () => {
  const { handler, state } = makeHarness({ covered: ['a1', 'a2', 'a3', 'a4', 'a5'] });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    response,
    new URL('http://x/api/enrich/queue/run-all'),
  );

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.planned, 0);
  assert.equal(response.out.body.coveredRemoved, 2);
  assert.equal(response.out.body.covered, 10); // 5 photos per item
  assert.equal(response.out.body.failureLimited, 0);
  assert.deepEqual(state.removed, [88, 89]);
  assert.deepEqual(state.started, []);
  assert.deepEqual(response.out.body.items, []);
});

test('run-all aggregates failure-limited counts instead of calling stuck photos covered', async () => {
  const { handler, state } = makeHarness({ covered: ['a1', 'a2', 'a3'], stuck: ['a4', 'a5'] });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    response,
    new URL('http://x/api/enrich/queue/run-all'),
  );

  assert.equal(response.out.statusCode, 200);
  assert.equal(response.out.body.planned, 0);
  assert.equal(response.out.body.coveredRemoved, 2);
  assert.equal(response.out.body.covered, 6); // 3 enriched per item
  assert.equal(response.out.body.failureLimited, 4); // 2 stuck per item — reported, not hidden
  assert.deepEqual(state.removed, [88, 89]);
  assert.deepEqual(state.started, []);
});

test('a failure-limited item removed mid-chain after the response still lands in run history', async () => {
  // Plan: item 88 needs work, item 89 holds only failure-limited photos.
  // 89 resolves after 88's run finishes — long after the HTTP response —
  // so its outcome must survive somewhere durable: the run history.
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() }),
      (ids) => ({ needy: new Set(), successful: new Set(), failureLimited: new Set(ids) }),
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  const response = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    response,
    new URL('http://x/api/enrich/queue/run-all'),
  );

  // Response covers only what was knowable when 88 started.
  assert.equal(response.out.statusCode, 202);
  assert.equal(response.out.body.planned, 2);
  assert.equal(response.out.body.coveredRemoved, 0);
  assert.deepEqual(state.coveredRuns, []);

  // 88 finishes cleanly → the chain advances to 89 asynchronously.
  state.started[0].onFinished();
  for (let i = 0; i < 20 && !state.removed.includes(89); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(state.removed, [88, 89]); // 88 by clean finish, 89 as exhausted
  assert.equal(state.started.length, 1); // no run ever started for 89
  // The silent-removal trap: 89's outcome is durable in run history.
  assert.deepEqual(state.coveredRuns, [{ title: 'Lyon', provider: undefined, covered: 0, failureLimited: 5, discarded: 0 }]);
  assert.deepEqual(state.reviewListed, []); // nothing successful to send to Curate
});

test('status reports resolvingSlice while a Run-all chain decides its next item', async () => {
  // The Enrich page polls /api/enrich/status and stops when a run ends.
  // While the chain is still resolving the next item — which can take a
  // while on a big covered slice — resolvingSlice must hold the polling
  // open, or a retirement landing after the last run stays invisible
  // until a manual page reload.
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() }),
      async (ids) => {
        await gateB; // B's slice resolution is slow
        return { needy: new Set(), successful: new Set(), failureLimited: new Set(ids) };
      },
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });

  const status = async () => {
    const response = fakeResponse();
    await handler(jsonRequest('GET'), response, new URL('http://x/api/enrich/status'));
    return response.out.body;
  };

  const runAll = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    runAll,
    new URL('http://x/api/enrich/queue/run-all'),
  );
  assert.equal(runAll.out.statusCode, 202);
  assert.equal((await status()).resolvingSlice, false); // A is running; no walk in flight

  // A finishes → the chain starts resolving B and blocks on the slow slice.
  state.started[0].onFinished();
  assert.equal((await status()).resolvingSlice, true); // the poll signal to stay alive

  releaseB();
  for (let i = 0; i < 20 && !state.removed.includes(89); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal((await status()).resolvingSlice, false); // chain settled
  assert.deepEqual(state.removed, [88, 89]);
  assert.deepEqual(state.coveredRuns, [{ title: 'Lyon', provider: undefined, covered: 0, failureLimited: 5, discarded: 0 }]);
});

test('competing starts are rejected while a slice resolution is in flight', async () => {
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() }),
      async (ids) => {
        await gateB;
        return { needy: new Set(), successful: new Set(), failureLimited: new Set(ids) };
      },
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });

  const post = async (path, body) => {
    const response = fakeResponse();
    await handler(jsonRequest('POST', body), response, new URL(`http://x${path}`));
    return response.out;
  };

  assert.equal((await post('/api/enrich/queue/run-all', { plan: [{ id: 88 }, { id: 89 }] })).statusCode, 202);
  state.started[0].onFinished(); // chain now resolving B, blocked on the gate
  assert.equal(state.runnerReserved, true, 'the shared runner slot stays reserved during resolution');

  // Every start route holds the line while the resolution owns the queue.
  const single = await post('/api/enrich/queue/89/run', {});
  assert.equal(single.statusCode, 409);
  assert.equal(single.body.error.code, 'enrich_run_conflict');
  const sweep = await post('/api/enrich/run', {});
  assert.equal(sweep.statusCode, 409);
  const secondChain = await post('/api/enrich/queue/run-all', { plan: [{ id: 89 }] });
  assert.equal(secondChain.statusCode, 409);

  releaseB();
  for (let i = 0; i < 20 && !state.removed.includes(89); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  // The original chain finished untouched: one run, one retirement, once.
  assert.equal(state.started.length, 1);
  assert.deepEqual(state.coveredRuns, [{ title: 'Lyon', provider: undefined, covered: 0, failureLimited: 5, discarded: 0 }]);
  assert.deepEqual(state.jobRuns, []); // no chain-stop record — nothing went wrong
  assert.equal(state.runnerReserved, false);
});

test('removing an item mid-resolution wins: no start, no retirement record', async () => {
  let releaseB;
  const gateB = new Promise((resolve) => { releaseB = resolve; });
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() }),
      async (ids) => {
        await gateB;
        return { needy: new Set(ids), successful: new Set(), failureLimited: new Set() };
      },
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });

  const runAll = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    runAll,
    new URL('http://x/api/enrich/queue/run-all'),
  );
  state.started[0].onFinished(); // chain resolving B, blocked

  // The user pulls B while its photos are being resolved.
  const del = fakeResponse();
  await handler(jsonRequest('DELETE'), del, new URL('http://x/api/enrich/queue/89'));
  assert.equal(del.out.statusCode, 200);

  releaseB();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(state.started.length, 1); // B never started despite resolving needy
  assert.deepEqual(state.coveredRuns, []); // and was not recorded as retired
  assert.deepEqual(state.jobRuns, []); // a user removal is not a chain failure
  assert.deepEqual(state.removed, [88, 89]); // 88 by clean finish, 89 by the user — once each
  const status = fakeResponse();
  await handler(jsonRequest('GET'), status, new URL('http://x/api/enrich/status'));
  assert.equal(status.out.body.resolvingSlice, false); // exclusivity released
});

test('a chain that dies between items records the stop in run history', async () => {
  const { handler, state } = makeHarness({
    filters: [
      (ids) => ({ needy: new Set(ids), successful: new Set(), failureLimited: new Set() }),
      async () => { throw new Error('immich exploded'); },
    ],
  });
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });

  const runAll = fakeResponse();
  await handler(
    jsonRequest('POST', { plan: [{ id: 88 }, { id: 89 }] }),
    runAll,
    new URL('http://x/api/enrich/queue/run-all'),
  );
  state.started[0].onFinished();
  for (let i = 0; i < 20 && state.jobRuns.length === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(state.jobRuns.length, 1); // not silent
  assert.equal(state.jobRuns[0].status, 'failed');
  assert.match(state.jobRuns[0].error, /immich exploded/);
  assert.match(state.jobRuns[0].log[0], /run-all chain stopped/);
  const status = fakeResponse();
  await handler(jsonRequest('GET'), status, new URL('http://x/api/enrich/status'));
  assert.equal(status.out.body.resolvingSlice, false); // exclusivity released on failure too
});

test('starts during an active run are rejected before any slice work happens', async () => {
  const { handler, state } = makeHarness();
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  state.runnerRunning = true; // a model run is live (e.g. started by run-all)

  const post = async (path, body) => {
    const response = fakeResponse();
    await handler(jsonRequest('POST', body), response, new URL(`http://x${path}`));
    return response.out;
  };

  const single = await post('/api/enrich/queue/89/run', {});
  assert.equal(single.statusCode, 409);
  assert.equal(single.body.error.code, 'enrich_run_conflict');
  assert.equal((await post('/api/enrich/queue/run-all', { plan: [{ id: 89 }] })).statusCode, 409);
  assert.equal((await post('/api/enrich/run', {})).statusCode, 409);

  // Rejected up front: no slice search, no filter, no Curate listing.
  assert.equal(state.searches, 0);
  assert.deepEqual(state.filterRequests, []);
  assert.deepEqual(state.reviewListed, []);
  assert.deepEqual(state.started, []);
});

test('the queue item behind the active run cannot be deleted; others can', async () => {
  const { handler, state } = makeHarness();
  state.queue.push({ id: 89, title: 'Lyon', filters: { city: 'Paris' }, estimatedCount: 5 });
  state.runnerRunning = true;
  state.activeQueueItemId = 88; // the run is walking item 88's slice

  // The active item is load-bearing (capped/failed runs continue from it).
  const del88 = fakeResponse();
  await handler(jsonRequest('DELETE'), del88, new URL('http://x/api/enrich/queue/88'));
  assert.equal(del88.out.statusCode, 409);
  assert.equal(del88.out.body.error.code, 'queue_item_running');
  assert.ok(state.queue.some((item) => item.id === 88)); // row preserved
  assert.deepEqual(state.removed, []);

  // Unrelated items stay freely removable during the run.
  const del89 = fakeResponse();
  await handler(jsonRequest('DELETE'), del89, new URL('http://x/api/enrich/queue/89'));
  assert.equal(del89.out.statusCode, 200);
  assert.deepEqual(state.removed, [89]);
});
