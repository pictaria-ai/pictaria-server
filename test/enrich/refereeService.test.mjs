import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REFEREE_GROUP_BYTE_BUDGET,
  REFEREE_MAX_IMAGE_BYTES,
  RefereeService,
  buildRefereeUserPrompt,
  normalizePicks,
  refereeGroupKey,
  refereeJsonSchema,
} from '../../src/enrich/refereeService.mjs';
import { annotateBursts } from '../../src/enrich/reviewService.mjs';
import { Repository } from '../../src/enrich/repository.mjs';
import { LmStudioProvider, OpenAiCompatibleProvider, ProviderRequestError } from '../../src/enrich/providers.mjs';
import { ResponseTooLargeError } from '../../src/fetchWithTimeout.mjs';

test('refereeGroupKey is order-insensitive and membership-sensitive', () => {
  assert.equal(refereeGroupKey(['b', 'a', 'c']), refereeGroupKey(['a', 'b', 'c']));
  assert.notEqual(refereeGroupKey(['a', 'b']), refereeGroupKey(['a', 'b', 'c']));
});

test('normalizePicks defends against duplicate and missing ranks', () => {
  const members = [{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }];
  const output = {
    photos: [
      { photo: 1, rank: 2, keep: false, eyes_closed: 'no', note: 'ok' },
      { photo: 2, rank: 2, keep: true, eyes_closed: 'yes', note: 'blink' }, // duplicate rank
      // photo 3 missing entirely
    ],
  };
  const picks = normalizePicks(output, members);
  assert.deepEqual(picks.map((p) => p.assetId), ['a', 'b', 'c']);
  assert.deepEqual([...picks.map((p) => p.rank)].sort(), [1, 2, 3]);
  assert.equal(picks[0].rank, 2);
  assert.equal(picks[1].eyesClosed, 'yes');
  assert.equal(picks[2].note, null);
});

test('referee schema pins the photo count; prompt carries face counts', () => {
  const schema = refereeJsonSchema(4);
  assert.equal(schema.properties.photos.minItems, 4);
  assert.equal(schema.properties.photos.maxItems, 4);

  const prompt = buildRefereeUserPrompt([
    { assetId: 'a', capturedAt: '2026-07-01T10:00:00.000Z', aiTags: ['ai/people/couple'] },
    { assetId: 'b', capturedAt: '2026-07-01T10:00:05.000Z', aiTags: ['ai/people/none'] },
    { assetId: 'c', aiTags: [] },
  ]);
  assert.ok(prompt.includes('Photo 1: taken 2026-07-01 10:00:00 · 2 people detected'));
  assert.ok(prompt.includes('Photo 2: taken 2026-07-01 10:00:05 · no people detected'));
  assert.ok(prompt.includes('Photo 3: people unknown (not yet analyzed)'));
});

test('LM Studio analyzeImages sends every image in one request with the custom schema name', async () => {
  let captured = null;
  const provider = new LmStudioProvider({
    modelName: 'm',
    fetchImpl: async (url, options) => {
      captured = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }),
      };
    },
  });
  const images = [
    { data: Buffer.from('a'), mimeType: 'image/jpeg' },
    { data: Buffer.from('b'), mimeType: 'image/jpeg' },
    { data: Buffer.from('c'), mimeType: 'image/jpeg' },
  ];
  const { normalizedOutput } = await provider.analyzeImages(images, {
    systemPrompt: 's',
    userPrompt: 'u',
    jsonSchema: { type: 'object' },
    schemaName: 'pictaria_group_referee',
  });
  assert.deepEqual(normalizedOutput, { ok: true });
  const content = captured.messages[1].content;
  assert.equal(content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(captured.response_format.json_schema.name, 'pictaria_group_referee');
});

test('OpenAI-compatible Curate requests describe the dynamic referee schema', async () => {
  let captured = null;
  const provider = new OpenAiCompatibleProvider({
    modelName: 'm',
    baseUrl: 'http://llama.local:8080/v1',
    fetchImpl: async (url, options) => {
      captured = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"same_subject":true,"photos":[]}' } }] }),
      };
    },
  });
  const images = [
    { data: Buffer.from('a'), mimeType: 'image/jpeg' },
    { data: Buffer.from('b'), mimeType: 'image/jpeg' },
    { data: Buffer.from('c'), mimeType: 'image/jpeg' },
  ];

  await provider.analyzeImages(images, {
    systemPrompt: 's',
    userPrompt: 'Rank these photos.',
    jsonSchema: refereeJsonSchema(images.length),
    schemaName: 'pictaria_group_referee',
  });

  const promptText = captured.messages[1].content[0].text;
  assert.ok(promptText.includes('"minItems":3'));
  assert.ok(promptText.includes('"maxItems":3'));
  assert.ok(promptText.includes('"subject_group"'));
  assert.equal(captured.messages[1].content.filter((part) => part.type === 'image_url').length, 3);
  assert.equal(captured.response_format.type, 'json_object');
});

function withRepo(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-referee-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  return Promise.resolve(work(repo)).finally(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

test('referee results round-trip and surface on review rows', async () => {
  await withRepo((repo) => {
    repo.upsertAsset({ id: 'r1', originalPath: '/p/r1.jpg' });
    repo.upsertAsset({ id: 'r2', originalPath: '/p/r2.jpg' });
    repo.reviewListAdd(['r1', 'r2'], 'test');

    const key = refereeGroupKey(['r1', 'r2']);
    assert.equal(repo.refereeHasGroup(key), false);
    repo.refereeRecordGroup({
      groupKey: key,
      memberCount: 2,
      sameSubject: true,
      provider: 'local_lmstudio',
      model: 'small-vl',
      picks: [
        { assetId: 'r1', rank: 2, keep: false, eyesClosed: 'yes', note: 'blinking' },
        { assetId: 'r2', rank: 1, keep: true, eyesClosed: 'no', note: 'sharp, eyes open' },
      ],
    });
    assert.equal(repo.refereeHasGroup(key), true);
    assert.equal(repo.refereeStats().groups, 1);
    assert.equal(repo.refereeStats().photos, 2);

    const rows = repo.reviewListRows();
    const r2 = rows.find((row) => row.asset_id === 'r2');
    assert.equal(Number(r2.referee_rank), 1);
    assert.equal(Number(r2.referee_keep), 1);
    assert.equal(r2.referee_eyes_closed, 'no');
    assert.equal(r2.referee_note, 'sharp, eyes open');
  });
});

function fakeReview(rows) {
  // The real service annotates once per cached array and shares the result
  // (annotatedReviewRows); the fake mirrors that contract.
  return { annotatedReviewRows: () => annotateBursts(rows.map((row) => ({ ...row }))) };
}

function makeRows() {
  // One 3-photo burst (2 undecided) + one fully decided pair + a single.
  return [
    { assetId: 'g1', capturedAt: '2026-07-01T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.8, filename: 'g1.jpg' },
    { assetId: 'g2', capturedAt: '2026-07-01T10:00:05.000Z', state: 'undecided', aiTags: ['ai/people/one'], frameScore: 0.7, filename: 'g2.jpg' },
    { assetId: 'g3', capturedAt: '2026-07-01T10:00:10.000Z', state: 'approved', aiTags: [], frameScore: 0.9, filename: 'g3.jpg' },
    { assetId: 'd1', capturedAt: '2026-07-02T10:00:00.000Z', state: 'approved', aiTags: [], frameScore: 0.9 },
    { assetId: 'd2', capturedAt: '2026-07-02T10:00:05.000Z', state: 'reviewed', aiTags: [], frameScore: 0.8 },
    { assetId: 'solo', capturedAt: '2026-07-03T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.9 },
  ];
}

test('pendingGroups picks groups with 2+ undecided members and stable keys', async () => {
  await withRepo((repo) => {
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    const groups = service.pendingGroups();
    assert.equal(groups.length, 1); // decided pair + solo don't qualify
    assert.equal(groups[0].members.length, 3); // decided member still counts for the KEY
    assert.equal(groups[0].undecidedCount, 2);
    assert.equal(groups[0].key, refereeGroupKey(['g1', 'g2', 'g3']));
  });
});

test('pendingGroups accepts groups up to the stack cap and sees oversized moments pre-chunked', async () => {
  await withRepo((repo) => {
    // 12 undecided photos 10s apart with a 14s seam after the 7th: the
    // grouping layer chunks the moment into 7 + 5, and BOTH are refereeable.
    // (The old referee-side cap of 8 silently skipped the whole group.)
    const rows = [];
    let time = Date.parse('2026-07-05T10:00:00.000Z');
    for (let i = 0; i < 12; i++) {
      rows.push({
        assetId: `big${i}`,
        capturedAt: new Date(time).toISOString(),
        state: 'undecided',
        aiTags: [],
        frameScore: 0.5,
        filename: `big${i}.jpg`,
      });
      time += i === 6 ? 14000 : 10000;
    }
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    const groups = service.pendingGroups();
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map((group) => group.members.length).sort((a, b) => b - a), [7, 5]);
  });
});

test('tick referees the group via the provider and records per-asset picks', async () => {
  await withRepo(async (repo) => {
    const analyzed = [];
    const service = new RefereeService({
      repo,
      immich: {
        // Matches the real Immich client: requestBytes returns contentType
        // only — the referee must remap it to mimeType for the providers.
        getAssetThumbnail: async (assetId) => ({ data: Buffer.from(assetId), contentType: 'image/jpeg' }),
      },
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true, defaultProvider: 'x', providers: {} },
    });
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images, options) => {
        for (const image of images) {
          assert.equal(image.mimeType, 'image/jpeg'); // data:undefined otherwise — LM Studio 400s
        }
        analyzed.push({ count: images.length, schemaName: options.schemaName });
        return {
          normalizedOutput: {
            same_subject: true,
            photos: [
              { photo: 1, rank: 3, keep: false, eyes_closed: 'unsure', note: 'soft focus' },
              { photo: 2, rank: 1, keep: true, eyes_closed: 'no', note: 'person, sharp' },
              { photo: 3, rank: 2, keep: false, eyes_closed: 'no', note: 'empty scene' },
            ],
          },
        };
      },
    });

    await service.tick();

    assert.deepEqual(analyzed, [{ count: 3, schemaName: 'pictaria_group_referee' }]);
    const key = refereeGroupKey(['g1', 'g2', 'g3']);
    assert.equal(repo.refereeHasGroup(key), true);
    // Activity view: the verdict lands with timing and a subject count.
    const recent = repo.refereeRecentGroups(5);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].memberCount, 3);
    assert.equal(recent[0].subjects, 1); // fake provider returns no subject_group -> default 1
    assert.equal(typeof recent[0].durationMs, 'number');
    // A second tick finds nothing new to referee.
    await service.tick();
    assert.equal(analyzed.length, 1);
  });
});

test('batchDone counts judged stacks this run and resets when the queue drains', async () => {
  await withRepo(async (repo) => {
    // Two referee-able groups (3 members + 2 members). The provider judges
    // the first, then fails on the second — the run counter must show the
    // partial progress, then reset once the queue finally drains.
    const rows = [
      ...makeRows(),
      { assetId: 'h1', capturedAt: '2026-07-04T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.5, filename: 'h1.jpg' },
      { assetId: 'h2', capturedAt: '2026-07-04T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.4, filename: 'h2.jpg' },
    ];
    let failNext = false;
    const service = new RefereeService({
      repo,
      immich: { getAssetThumbnail: async (assetId) => ({ data: Buffer.from(assetId), contentType: 'image/jpeg' }) },
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true, defaultProvider: 'x', providers: {} },
    });
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        if (failNext) throw new Error('model fell over');
        failNext = true; // succeed once, then fail
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'ok' })),
          },
        };
      },
    });

    await service.tick();
    let st = service.status();
    assert.equal(st.batchDone, 1); // one judged before the failure
    assert.equal(st.remaining, 1); // the failed group is still queued
    assert.ok(st.lastError);

    // Recovery: clear the backoff, let the provider succeed — the drain
    // ends the run and the counter goes back to zero.
    failNext = false;
    service._lastErrorAt = 0;
    await service.tick();
    st = service.status();
    assert.equal(st.remaining, 0);
    assert.equal(st.batchDone, 0);
  });
});

test('referee backoff honors a bounded Retry-After hint and otherwise keeps the five-minute fallback', async () => {
  await withRepo(async (repo) => {
    const scenarios = [
      { retryAfterMs: 120000, expectedMs: 120000, expectedLog: 'backing off for 2m' },
      { retryAfterMs: 60 * 60000, expectedMs: 5 * 60000, expectedLog: 'backing off for 5m' },
      { retryAfterMs: null, expectedMs: 5 * 60000, expectedLog: 'backing off for 5m' },
    ];

    for (const scenario of scenarios) {
      const log = [];
      let calls = 0;
      const service = new RefereeService({
        repo,
        immich: { getAssetThumbnail: async (assetId) => ({ data: Buffer.from(assetId), contentType: 'image/jpeg' }) },
        review: fakeReview(makeRows()),
        enrichRunner: { isRunning: () => false },
        config: { enrichEnabled: true, curateRefereeEnabled: true, defaultProvider: 'x', providers: {} },
        log: (message) => log.push(message),
      });
      service.makeProvider = () => ({
        providerName: 'fake',
        modelName: 'fake-vl',
        analyzeImages: async () => {
          calls += 1;
          throw new ProviderRequestError('fake request failed with status 429', {
            status: 429,
            retryAfterMs: scenario.retryAfterMs,
          });
        },
      });

      await service.tick();
      assert.equal(service._errorBackoffMs, scenario.expectedMs);
      assert.ok(log.some((line) => line.includes(scenario.expectedLog)));
      await service.tick();
      assert.equal(calls, 1, 'an immediate poll must respect the active backoff');
    }
  });
});

test('status resets a stale run counter when the queue empties without judging', async () => {
  await withRepo((repo) => {
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview([]), // the human decided everything themselves
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    service._batchDone = 5;
    const st = service.status();
    assert.equal(st.remaining, 0);
    assert.equal(st.batchDone, 0); // no lingering "5 of 5"

    // Disabling mid-run ends the run too — a disable → re-enable cycle
    // must not resurrect the old count (remaining is null while disabled,
    // which the empty-queue check alone can't see).
    service._batchDone = 7;
    service.config.curateRefereeEnabled = false;
    assert.equal(service.status().batchDone, 0);
    service.config.curateRefereeEnabled = true;
    assert.equal(service.status().batchDone, 0);
  });
});

test('an oversized original degrades to its preview without buffering', async () => {
  await withRepo(async (repo) => {
    const fetchedSizes = [];
    const service = new RefereeService({
      repo,
      immich: {
        // The Immich client aborts an over-cap original download with
        // ResponseTooLargeError; the referee must fall back to the preview.
        getAssetOriginal: async (assetId, { maxBytes } = {}) => {
          if (assetId === 'g1') {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.from(`${assetId}-original`), contentType: 'image/jpeg' };
        },
        getAssetThumbnail: async (assetId) => ({ data: Buffer.from(`${assetId}-preview`), contentType: 'image/webp' }),
      },
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'original',
        defaultProvider: 'x',
        providers: {},
      },
    });
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        fetchedSizes.push(...images.map((image) => image.data.toString('utf8')));
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({
              photo: index + 1,
              rank: index + 1,
              keep: index === 0,
              eyes_closed: 'no',
              note: 'n',
            })),
          },
        };
      },
    });

    await service.tick();

    assert.deepEqual(fetchedSizes, ['g1-preview', 'g2-original', 'g3-original']);
    // The degrade lands in the status diagnostics, not just the log.
    assert.deepEqual(service.status().previewFallbacks, { oversized: 1, budget: 0, thumbnail: 0 });
  });
});

// One burst of `count` undecided members, 5s apart (inside the chain window).
function makeBurstRows(count) {
  const start = Date.parse('2026-07-01T10:00:00.000Z');
  return Array.from({ length: count }, (_, index) => ({
    assetId: `b${index + 1}`,
    capturedAt: new Date(start + index * 5000).toISOString(),
    state: 'undecided',
    aiTags: [],
    frameScore: 0.5,
    filename: `b${index + 1}.jpg`,
  }));
}

test('a full group of originals degrades to previews once the group byte budget runs out', async () => {
  await withRepo(async (repo) => {
    // Under the 25MB per-image cap, so only the group budget can stop it:
    // 4 × 20MB fit in the 96MB budget, members 5-8 must fall back.
    const ORIGINAL_SIZE = 20 * 1024 * 1024;
    const originalAttempts = [];
    const fallbackCaps = [];
    const service = new RefereeService({
      repo,
      immich: {
        // Mirrors the real client: the download aborts (never buffers) as
        // soon as the body would cross the caller's maxBytes.
        getAssetOriginal: async (assetId, { maxBytes } = {}) => {
          originalAttempts.push({ assetId, maxBytes });
          if (ORIGINAL_SIZE > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(ORIGINAL_SIZE, 1), contentType: 'image/jpeg' };
        },
        getAssetThumbnail: async (assetId, size, options) => {
          fallbackCaps.push(options?.maxBytes);
          return { data: Buffer.from(`${assetId}-preview`), contentType: 'image/webp' };
        },
      },
      review: fakeReview(makeBurstRows(8)),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'original',
        defaultProvider: 'x',
        providers: {},
      },
    });
    let seenImages = null;
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        seenImages = images.map((image) => ({
          assetId: image.assetId,
          bytes: image.data.byteLength,
          preview: image.data.toString('utf8', 0, 32).includes('-preview'),
        }));
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({
              photo: index + 1,
              rank: index + 1,
              keep: index === 0,
              eyes_closed: 'no',
              note: 'n',
            })),
          },
        };
      },
    });

    await service.tick();

    // Member order is preserved: the first four carry their originals, the
    // rest degraded to previews when the next original no longer fit.
    assert.deepEqual(seenImages.map((image) => image.assetId), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8']);
    assert.deepEqual(seenImages.map((image) => image.preview), [false, false, false, false, true, true, true, true]);
    // Aggregate originals stay within the budget.
    const totalBytes = seenImages.reduce((sum, image) => sum + image.bytes, 0);
    assert.ok(totalBytes <= REFEREE_GROUP_BYTE_BUDGET);
    // Under budget the per-image cap applies untouched; past 4 × 20MB the
    // remaining budget (16MB) clamps the download cap for every later member.
    assert.equal(originalAttempts[0].maxBytes, REFEREE_MAX_IMAGE_BYTES);
    assert.equal(originalAttempts[4].maxBytes, REFEREE_GROUP_BYTE_BUDGET - 4 * ORIGINAL_SIZE);
    // Diagnostics: all four degrades are attributed to the group budget.
    assert.deepEqual(service.status().previewFallbacks, { oversized: 0, budget: 4, thumbnail: 0 });
    // The fallback previews are budget-capped too — no unbounded fetch on
    // any path (the P0 this issue fixes).
    assert.ok(fallbackCaps.length > 0);
    assert.ok(fallbackCaps.every((cap) => Number.isFinite(cap) && cap > 0));
    // The verdict still lands for all 8 members.
    assert.equal(repo.refereeHasGroup(refereeGroupKey(seenImages.map((image) => image.assetId))), true);
    assert.equal(repo.refereeStats().photos, 8);
  });
});

test('small groups of modest originals never hit the group byte budget', async () => {
  await withRepo(async (repo) => {
    const caps = [];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetOriginal: async (assetId, { maxBytes } = {}) => {
          caps.push(maxBytes);
          return { data: Buffer.from(`${assetId}-original`), contentType: 'image/jpeg' };
        },
        getAssetThumbnail: async () => {
          throw new Error('preview must not be fetched when originals fit');
        },
      },
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'original',
        defaultProvider: 'x',
        providers: {},
      },
    });
    let count = 0;
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        count = images.length;
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({
              photo: index + 1,
              rank: index + 1,
              keep: index === 0,
              eyes_closed: 'no',
              note: 'n',
            })),
          },
        };
      },
    });

    await service.tick();

    assert.equal(count, 3);
    assert.deepEqual(caps, [REFEREE_MAX_IMAGE_BYTES, REFEREE_MAX_IMAGE_BYTES, REFEREE_MAX_IMAGE_BYTES]);
    assert.deepEqual(service.status().previewFallbacks, { oversized: 0, budget: 0, thumbnail: 0 });
  });
});

test('the referee yields to enrichment and respects the toggles', async () => {
  await withRepo(async (repo) => {
    let running = true;
    let called = 0;
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => running },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    service.refereeGroup = async () => {
      called += 1;
      running = true; // enrichment grabbed the model mid-block
    };

    await service.tick(); // enrichment running → nothing happens
    assert.equal(called, 0);

    running = false;
    await service.tick(); // one group, then the block ends because enrichment resumed
    assert.equal(called, 1);

    service.config.curateRefereeEnabled = false;
    running = false;
    await service.tick();
    assert.equal(called, 1); // disabled → never called again
  });
});

test('pause is cooperative: the in-flight stack finishes, then the worker idles until resumed', async () => {
  await withRepo(async (repo) => {
    let called = 0;
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    service.refereeGroup = async () => {
      called += 1;
      service.setPaused(true); // user hits Pause while this stack is being judged
      // Mid-flight: both flags visible so the UI can say "pausing — finishing".
      assert.equal(service.status().paused, true);
      assert.equal(service.status().working, true);
    };

    await service.tick(); // in-flight stack finishes, no next stack starts
    assert.equal(called, 1);
    assert.equal(service.status().working, false);

    await service.tick(); // paused → no-op despite pending work
    assert.equal(called, 1);
    assert.equal(service.status().paused, true);
    assert.equal(service.status().yielding, false); // paused dominates yielding

    service.setPaused(false);
    assert.equal(service.status().paused, false);
    await service.tick(); // resumed → work picks back up
    assert.equal(called, 2);
  });
});

test('normalizePicks carries subject groups with a sane default', () => {
  const members = [{ assetId: 'x1' }, { assetId: 'x2' }, { assetId: 'x3' }];
  const picks = normalizePicks({
    same_subject: false,
    photos: [
      { photo: 1, rank: 1, keep: true, eyes_closed: 'no', note: 'a', subject_group: 1 },
      { photo: 2, rank: 2, keep: false, eyes_closed: 'no', note: 'b', subject_group: 2 },
      { photo: 3, rank: 3, keep: false, eyes_closed: 'no', note: 'c', subject_group: 99 }, // out of range
    ],
  }, members);
  assert.deepEqual(picks.map((p) => p.subjectGroup), [1, 2, 1]);
});

test('pendingGroups skips groups whose members are all judged (split halves stay split)', async () => {
  await withRepo((repo) => {
    const rows = makeRows().map((row) => ({ ...row, refereeRank: 1, refereeSubjectGroup: 1 }));
    const service = new RefereeService({
      repo,
      immich: {},
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true },
    });
    assert.equal(service.pendingGroups().length, 0);
  });
});

test('preview-only groups honor the aggregate ceiling, degrading to thumbnails', async () => {
  await withRepo(async (repo) => {
    // Previews of 20MB each (Immich preview size is config-dependent): the
    // default 96MB budget fits four, members 5-8 must degrade to thumbnails.
    const PREVIEW_SIZE = 20 * 1024 * 1024;
    const caps = [];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetOriginal: async () => { throw new Error('original must not be fetched in preview mode'); },
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          caps.push({ assetId, size, maxBytes });
          if (size === 'thumbnail') {
            return { data: Buffer.from(`${assetId}-thumb`), contentType: 'image/webp' };
          }
          if (Number.isFinite(maxBytes) && PREVIEW_SIZE > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(PREVIEW_SIZE, 1), contentType: 'image/jpeg' };
        },
      },
      review: fakeReview(makeBurstRows(8)),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true, imageSource: 'preview', defaultProvider: 'x', providers: {} },
    });
    let seenImages = null;
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        seenImages = images.map((image) => ({
          assetId: image.assetId,
          bytes: image.data.byteLength,
          thumb: image.data.toString('utf8', 0, 32).includes('-thumb'),
        }));
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'n' })),
          },
        };
      },
    });

    await service.tick();

    // The acceptance criterion: total bytes reaching the provider never
    // exceed the ceiling — in preview-only mode too.
    const totalBytes = seenImages.reduce((sum, image) => sum + image.bytes, 0);
    assert.ok(totalBytes <= REFEREE_GROUP_BYTE_BUDGET, `provider got ${totalBytes} > budget`);
    assert.deepEqual(seenImages.map((image) => image.thumb), [false, false, false, false, true, true, true, true]);
    // Every fetch carried a cap — no unbounded path.
    assert.ok(caps.every((c) => Number.isFinite(c.maxBytes) && c.maxBytes > 0));
    assert.deepEqual(service.status().previewFallbacks, { oversized: 0, budget: 0, thumbnail: 4 });
    // The verdict still lands for all 8 members.
    assert.equal(repo.refereeStats().photos, 8);
  });
});

test('a configured lower budget clamps every fetch', async () => {
  await withRepo(async (repo) => {
    const BUDGET = 4 * 1024 * 1024;
    const PREVIEW_SIZE = 3 * 1024 * 1024;
    const caps = [];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          caps.push(maxBytes);
          if (size === 'thumbnail') {
            return { data: Buffer.from(`${assetId}-thumb`), contentType: 'image/webp' };
          }
          if (Number.isFinite(maxBytes) && PREVIEW_SIZE > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(PREVIEW_SIZE, 1), contentType: 'image/jpeg' };
        },
      },
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'preview',
        curateRefereeGroupBudgetBytes: BUDGET,
        defaultProvider: 'x',
        providers: {},
      },
    });
    let totalBytes = null;
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        totalBytes = images.reduce((sum, image) => sum + image.data.byteLength, 0);
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'n' })),
          },
        };
      },
    });

    await service.tick();

    assert.ok(totalBytes !== null && totalBytes <= BUDGET, `provider got ${totalBytes} > configured ${BUDGET}`);
    assert.equal(caps[0], BUDGET); // the very first fetch is already clamped to the configured budget
    assert.ok(caps.every((cap) => Number.isFinite(cap) && cap <= BUDGET));
  });
});

test('a group that cannot fit even as thumbnails defers without blocking the queue', async () => {
  await withRepo(async (repo) => {
    // Two groups: the big one (8 members, judged first — most undecided)
    // cannot fit the tiny budget even as thumbnails; the small one can.
    // The big group must defer and the small one must still be judged in
    // the same tick — a pathological group never wedges the worker.
    const BUDGET = 50 * 1024;
    const rows = [
      ...makeBurstRows(8), // b1..b8 — 100KB thumbnails (too big)
      { assetId: 's1', capturedAt: '2026-07-09T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.5, filename: 's1.jpg' },
      { assetId: 's2', capturedAt: '2026-07-09T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.4, filename: 's2.jpg' },
    ];
    const thumbSize = (assetId) => (assetId.startsWith('b') ? 100 * 1024 : 10 * 1024);
    const service = new RefereeService({
      repo,
      immich: {
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          const bytes = size === 'thumbnail' ? thumbSize(assetId) : 200 * 1024; // previews always oversized here
          if (Number.isFinite(maxBytes) && bytes > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(bytes, 1), contentType: 'image/webp' };
        },
      },
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'preview',
        curateRefereeGroupBudgetBytes: BUDGET,
        defaultProvider: 'x',
        providers: {},
      },
    });
    const judged = [];
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        judged.push(images.map((image) => image.assetId));
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'n' })),
          },
        };
      },
    });

    await service.tick();

    // Only the small group reached the provider; the big one deferred.
    assert.deepEqual(judged, [['s1', 's2']]);
    const st = service.status();
    assert.equal(st.deferredGroups, 1);
    assert.equal(st.remaining, 0); // the deferred group is not "remaining" — it can't run at this budget
    assert.ok(service.activity().errors.some((e) => e.message.includes('deferred')));
    assert.equal(repo.refereeHasGroup(refereeGroupKey(['s1', 's2'])), true);
    assert.equal(repo.refereeHasGroup(refereeGroupKey(makeBurstRows(8).map((r) => r.assetId))), false);

    // A second tick does not retry the deferred group (no head-of-line churn).
    await service.tick();
    assert.equal(judged.length, 1);
  });
});

test('thumbnail-only mode still enforces the ceiling with nowhere to degrade', async () => {
  await withRepo(async (repo) => {
    const caps = [];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          caps.push({ size, maxBytes });
          return { data: Buffer.from(`${assetId}-thumb`), contentType: 'image/webp' };
        },
      },
      review: fakeReview(makeRows()),
      enrichRunner: { isRunning: () => false },
      config: { enrichEnabled: true, curateRefereeEnabled: true, imageSource: 'thumbnail', defaultProvider: 'x', providers: {} },
    });
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => ({
        normalizedOutput: {
          same_subject: true,
          photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'n' })),
        },
      }),
    });

    await service.tick();

    assert.ok(caps.length > 0);
    assert.ok(caps.every((c) => c.size === 'thumbnail' && Number.isFinite(c.maxBytes) && c.maxBytes > 0));
  });
});

test('a group that greedy degradation would strand is refit at a lower tier, not deferred', async () => {
  await withRepo(async (repo) => {
    // Regression geometry: 8 MiB budget, two members whose previews
    // are 7 MiB and thumbnails 2 MiB. Greedy: member 1 keeps its 7 MiB
    // preview, leaving 1 MiB — member 2 fits nothing. All-thumbnails is
    // 4 MiB and fits comfortably; the group must be judged, not deferred.
    const BUDGET = 8 * 1024 * 1024;
    const PREVIEW_SIZE = 7 * 1024 * 1024;
    const THUMB_SIZE = 2 * 1024 * 1024;
    const rows = [
      { assetId: 'p1', capturedAt: '2026-07-08T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.5, filename: 'p1.jpg' },
      { assetId: 'p2', capturedAt: '2026-07-08T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.4, filename: 'p2.jpg' },
    ];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          const bytes = size === 'thumbnail' ? THUMB_SIZE : PREVIEW_SIZE;
          if (Number.isFinite(maxBytes) && bytes > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(bytes, size === 'thumbnail' ? 2 : 1), contentType: 'image/jpeg' };
        },
      },
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'preview',
        curateRefereeGroupBudgetBytes: BUDGET,
        defaultProvider: 'x',
        providers: {},
      },
    });
    let seenImages = null;
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async (images) => {
        seenImages = images.map((image) => ({ assetId: image.assetId, bytes: image.data.byteLength }));
        return {
          normalizedOutput: {
            same_subject: true,
            photos: images.map((_, index) => ({ photo: index + 1, rank: index + 1, keep: index === 0, eyes_closed: 'no', note: 'n' })),
          },
        };
      },
    });

    await service.tick();

    // Judged, all-thumbnail, within budget — not deferred.
    assert.deepEqual(seenImages, [
      { assetId: 'p1', bytes: THUMB_SIZE },
      { assetId: 'p2', bytes: THUMB_SIZE },
    ]);
    const total = seenImages.reduce((sum, image) => sum + image.bytes, 0);
    assert.ok(total <= BUDGET);
    const st = service.status();
    assert.equal(st.deferredGroups, 0);
    assert.equal(repo.refereeHasGroup(refereeGroupKey(['p1', 'p2'])), true);
    // The whole-tier restart is visible in the diagnostics.
    assert.equal(st.previewFallbacks.thumbnail, 2);
  });
});

test('a deferred warning clears when the stack is decided by hand or its membership changes', async () => {
  await withRepo(async (repo) => {
    // Two 2-photo bursts, both too big for a 50KB budget even as
    // thumbnails — both defer. Then burst X is decided by hand, and burst
    // Y gains a member (which mints a new group key): neither old warning
    // may survive, and Y's new group must be retryable.
    const BUDGET = 50 * 1024;
    const rows = [
      { assetId: 'x1', capturedAt: '2026-07-10T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.5, filename: 'x1.jpg' },
      { assetId: 'x2', capturedAt: '2026-07-10T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.4, filename: 'x2.jpg' },
      { assetId: 'y1', capturedAt: '2026-07-11T10:00:00.000Z', state: 'undecided', aiTags: [], frameScore: 0.5, filename: 'y1.jpg' },
      { assetId: 'y2', capturedAt: '2026-07-11T10:00:05.000Z', state: 'undecided', aiTags: [], frameScore: 0.4, filename: 'y2.jpg' },
    ];
    const service = new RefereeService({
      repo,
      immich: {
        getAssetThumbnail: async (assetId, size, { maxBytes } = {}) => {
          const bytes = size === 'thumbnail' ? 100 * 1024 : 200 * 1024; // nothing fits 50KB
          if (Number.isFinite(maxBytes) && bytes > maxBytes) {
            throw new ResponseTooLargeError('Immich', maxBytes);
          }
          return { data: Buffer.alloc(bytes, 1), contentType: 'image/webp' };
        },
      },
      review: fakeReview(rows),
      enrichRunner: { isRunning: () => false },
      config: {
        enrichEnabled: true,
        curateRefereeEnabled: true,
        imageSource: 'preview',
        curateRefereeGroupBudgetBytes: BUDGET,
        defaultProvider: 'x',
        providers: {},
      },
    });
    service.makeProvider = () => ({
      providerName: 'fake',
      modelName: 'fake-vl',
      analyzeImages: async () => { throw new Error('nothing should reach the provider in this test'); },
    });

    await service.tick();
    let st = service.status();
    assert.equal(st.deferredGroups, 2);
    assert.equal(st.remaining, 0);

    // The human decides burst X themselves; burst Y grows a member.
    rows.find((r) => r.assetId === 'x1').state = 'approved';
    rows.find((r) => r.assetId === 'x2').state = 'reviewed';
    rows.push({ assetId: 'y3', capturedAt: '2026-07-11T10:00:10.000Z', state: 'undecided', aiTags: [], frameScore: 0.3, filename: 'y3.jpg' });

    st = service.status();
    assert.equal(st.deferredGroups, 0); // both stale warnings pruned
    assert.equal(st.remaining, 1); // Y's new membership is runnable again
    // History survives pruning: the Activity view keeps the deferral trail.
    assert.equal(service.activity().errors.filter((e) => e.message.includes('deferred')).length, 2);

    // The regrown group genuinely retries — and re-defers under its new key.
    service._lastErrorAt = 0;
    await service.tick();
    st = service.status();
    assert.equal(st.deferredGroups, 1);
    assert.equal(st.remaining, 0);
  });
});
