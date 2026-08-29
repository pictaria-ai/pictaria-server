#!/usr/bin/env node
// Review-path scale bench: seeds a synthetic library into a TEMP-DIR
// database (never the configured DATABASE_PATH — this script reads no env
// and no .env) and measures the hot paths the SRV-H3 milestone bounds:
// assetsResponse, pendingGroups, and the Best-of signal build.
//
// Usage: node bin/scale-bench.mjs [--assets=10000]
//
// Budgets are hardcoded for the 10k default with ~3x headroom over measured
// values on an M4 laptop (measured: assetsResponse p50 1.4ms / p95 5.2ms,
// pendingGroups cold 118ms / warm 5.5ms, signals 11ms, max loop delay
// 127ms, peak RSS 268MB). Scale expectations: cold pendingGroups and the
// cache rebuild are O(review list) — at 30k expect ~3x the cold numbers;
// warm assetsResponse is O(view rows) and the signal build is O(candidate
// ids), so both hold steady as the library grows. Re-measure at the target
// size before tightening.

import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate as yieldLoop } from 'node:timers/promises';

import { Repository } from '../src/enrich/repository.mjs';
import { ReviewService } from '../src/enrich/reviewService.mjs';
import { RefereeService } from '../src/enrich/refereeService.mjs';
import { loadV1Taxonomy, sampleOutput } from '../test/enrich/helpers.mjs';

const BUDGETS_MS = {
  'assetsResponse p50': 15,
  'assetsResponse p95': 30,
  'pendingGroups cold': 400,
  'pendingGroups warm': 50,
  'best-of signals (500 ids)': 40,
  'max event-loop delay': 500,
};
const BUDGET_PEAK_RSS_MB = 800;

const assetCount = Number(
  (process.argv.find((arg) => arg.startsWith('--assets=')) ?? '--assets=10000').split('=')[1],
);
if (!Number.isInteger(assetCount) || assetCount < 100) {
  console.error('usage: node bin/scale-bench.mjs [--assets=10000]');
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'pictaria-scale-bench-'));
const repo = new Repository(join(dir, 'enrichment.sqlite'));
repo.initSchema();
const taxonomy = loadV1Taxonomy();
const review = new ReviewService({ repo, immich: null, taxonomy, config: {}, verifyDelayMs: 0 });
const referee = new RefereeService({
  repo,
  immich: null,
  review,
  enrichRunner: { isRunning: () => false },
  config: { enrichEnabled: true, curateRefereeEnabled: true },
});

let peakRss = 0;
function sampleRss() {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

function seed() {
  const started = Date.now();
  const ids = [];
  const CHUNK = 2000;
  for (let base = 0; base < assetCount; base += CHUNK) {
    repo.transaction(() => {
      for (let i = base; i < Math.min(base + CHUNK, assetCount); i += 1) {
        const id = `bench-${String(i).padStart(6, '0')}`;
        ids.push(id);
        // Every 4th photo shoots 5s after its predecessor, forming 2-photo
        // bursts so pendingGroups has real grouping work.
        const stepMs = i % 4 === 3 ? 5000 : 45000;
        const takenAt = new Date(Date.UTC(2025, 0, 1) + i * 45000 + (i % 4 === 3 ? -40000 + stepMs : 0));
        const output = sampleOutput();
        output.quality.frame_worthy_score = 0.4 + (i % 55) / 100;
        output.quality.aesthetic_score = 0.3 + (i % 60) / 100;
        if (i % 17 === 0) {
          output.needs_review = true;
          output.exclusion_reasons = [{ tag: 'ai/exclude/private', confidence: 0.5 }];
        }
        // Dense same-day thumbhashes ensure the benchmark exercises Curate's
        // bounded large-day comparison path instead of measuring only rows
        // with no visual descriptor.
        const thumbhash = createHash('sha256').update(id).digest().subarray(0, 25).toString('base64');
        repo.upsertAsset({ id, originalPath: `/photos/${id}.jpg`, fileCreatedAt: takenAt.toISOString(), thumbhash });
        repo.recordProcessingRun({
          assetId: id, provider: 'p', model: 'm', promptVersion: 'v1',
          taxonomyVersion: 'v1', status: 'succeeded', normalizedOutput: output,
        });
        repo.replaceAssetTags({
          assetId: id,
          decisions: [
            { tag: i % 3 ? 'ai/quality/frame-worthy' : 'ai/quality/good', confidence: 0.8, source: 'ai', reason: 'bench' },
            { tag: 'ai/scene/mountains', confidence: 0.9, source: 'ai', reason: 'bench' },
            { tag: i % 2 ? 'ai/people/one' : 'ai/people/none', confidence: 0.7, source: 'ai', reason: 'bench' },
          ],
          model: 'm',
          taxonomyVersion: 'v1',
        });
      }
    });
  }
  repo.reviewListAdd(ids, 'bench');
  // ~20% decided, so decided/undecided views both have volume.
  repo.setManualFrameTags({
    assetIds: ids.filter((_, i) => i % 5 === 0),
    addTags: ['frame/eligible'],
    removeTags: [],
    action: 'approve',
  });
  console.log(`seeded ${assetCount} assets (runs + 3 ai tags + review list) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return ids;
}

function quantile(samples, q) {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

async function timed(work) {
  const started = process.hrtime.bigint();
  work();
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  sampleRss();
  await yieldLoop(); // let the event-loop-delay monitor take its sample
  return elapsed;
}

async function main() {
  const ids = seed();
  sampleRss();

  const loopDelay = monitorEventLoopDelay({ resolution: 10 });
  loopDelay.enable();

  // 30 mixed assetsResponse calls: the Curate UI's actual traffic shape.
  const queries = [];
  const views = ['candidates', 'should_review', 'unlikely', 'decided'];
  for (let i = 0; i < 30; i += 1) {
    const params = new URLSearchParams({ view: views[i % views.length], limit: '100', offset: String((i % 3) * 100) });
    if (i % 5 === 4) params.set('q', 'mountain');
    if (i % 7 === 6) params.set('group', 'stacks');
    queries.push(params);
  }
  // First call rebuilds the row cache (a decision just landed in seed()).
  const responseTimes = [];
  for (const params of queries) {
    responseTimes.push(await timed(() => review.assetsResponse(params)));
  }

  // pendingGroups cold = right after a write invalidates the cache.
  repo.setManualFrameTags({ assetIds: [ids[1]], addTags: ['frame/reviewed'], removeTags: [], action: 'reviewed' });
  const pendingCold = await timed(() => referee.pendingGroups());
  const pendingWarm = await timed(() => referee.pendingGroups());

  // Best-of signal build for a 500-candidate set: bounded caption FTS plus
  // the scoped per-id reads searchBestOfAssets issues.
  const candidates = ids.filter((_, i) => i % 7 === 0).slice(0, 500);
  const signalsTime = await timed(() => {
    repo.searchCaptions('mountain lake', { limit: 1000 });
    repo.loadAssetTagsFor(candidates, { prefix: 'ai/' });
    repo.latestSuccessFor(candidates);
    repo.loadAssetTagsFor(candidates, { prefix: 'frame/' });
  });

  loopDelay.disable();

  const results = [
    ['assetsResponse p50', quantile(responseTimes, 0.5)],
    ['assetsResponse p95', quantile(responseTimes, 0.95)],
    ['pendingGroups cold', pendingCold],
    ['pendingGroups warm', pendingWarm],
    ['best-of signals (500 ids)', signalsTime],
    ['max event-loop delay', loopDelay.max / 1e6],
  ];

  console.log(`\n${assetCount}-asset review list, ${queries.length} mixed assetsResponse calls\n`);
  console.log('metric                         measured     budget   verdict');
  console.log('---------------------------  ----------  ---------  -------');
  let failed = false;
  for (const [name, value] of results) {
    const budget = BUDGETS_MS[name];
    const pass = value <= budget;
    failed = failed || !pass;
    console.log(
      `${name.padEnd(29)}${(value.toFixed(1) + 'ms').padStart(10)}${(budget + 'ms').padStart(11)}  ${pass ? 'PASS' : 'FAIL'}`,
    );
  }
  const rssMb = peakRss / 1024 / 1024;
  const rssPass = rssMb <= BUDGET_PEAK_RSS_MB;
  failed = failed || !rssPass;
  console.log(`${'peak RSS'.padEnd(29)}${(rssMb.toFixed(0) + 'MB').padStart(10)}${(BUDGET_PEAK_RSS_MB + 'MB').padStart(11)}  ${rssPass ? 'PASS' : 'FAIL'}`);

  console.log(failed ? '\nFAIL' : '\nPASS');
  process.exitCode = failed ? 1 : 0;
}

try {
  await main();
} finally {
  repo.close();
  rmSync(dir, { recursive: true, force: true });
}
