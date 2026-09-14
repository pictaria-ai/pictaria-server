#!/usr/bin/env node
// Synthetic, offline measurements. No .env, configured database or network.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus, tmpdir } from 'node:os';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { groupPhotos } from './grouping.mjs';
import { dataset, photo } from './fixtures.mjs';
import { DecisionSpike } from './decisions.mjs';

const cases = [[1000, 0], [10000, 0], [30000, 0], [100, 30000], [30000, 0, 'dense']];
const arg = process.argv.find(a => a.startsWith('--case='));
if (!arg) {
  const results = cases.map((_, i) => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), `--case=${i}`], { encoding: 'utf8', env: {}, maxBuffer: 1024 * 1024 });
    if (child.error || child.status !== 0) throw Error(child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout);
  });
  console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, platform: process.platform, results }, null, 2));
} else {
  const index = Number(arg.slice(7));
  if (!Number.isInteger(index) || !cases[index]) throw Error('invalid case');
  const [pending, decided, distribution = '30-photo-bursts'] = cases[index];
  const photos = distribution === 'dense'
    ? Array.from({ length: pending }, (_, i) => photo(`dense-${i}`, i / 1000, { people: i % 2, recognized: i % 2 ? ['p'] : [], tone: 80 }))
    : dataset(pending, decided);
  const ms = fn => { const start = performance.now(); const value = fn(); return { value, ms: performance.now() - start }; };
  const p95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable(); await setTimeout(20);
  // First build includes sorting, candidate work and result materialization.
  const cold = ms(() => groupPhotos(photos, { semanticVeto: true }));
  const rebuilds = [];
  for (let i = 0; i < 20; i++) { await setImmediate(); rebuilds.push(ms(() => groupPhotos(photos, { semanticVeto: true })).ms); }
  await setTimeout(20); loop.disable();
  // Warm means a prebuilt pending-group index, not the production HTTP path.
  const cache = cold.value.groups.filter(g => g.pendingIds.length);
  const pages = Array.from({ length: 100 }, () => ms(() => JSON.stringify(cache.slice(0, 50))).ms);
  const dir = mkdtempSync(join(tmpdir(), 'curate-contract-bench-')), path = join(dir, 'spike.sqlite');
  const db = new DecisionSpike(path);
  let decisions, bytes;
  try {
    db.seed(photos);
    const ids = photos.slice(0, 30).map(p => p.id);
    db.scope('scope', ids);
    decisions = Array.from({ length: 100 }, (_, i) => ms(() => db.apply({ requestId: `decision-${i}`, snapshot: db.snapshot('scope'),
      outcomes: Object.fromEntries(ids.map((id, j) => [id, j < 2 ? 'approve' : 'reviewed'])) })).ms);
    bytes = statSync(path).size;
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  const round = n => Math.round(n * 100) / 100;
  console.log(JSON.stringify({ pending, decided, distribution, groups: cold.value.groups.length, pendingGroups: cache.length,
    coldGroupingMs: round(cold.ms), rebuildP95Ms: round(p95(rebuilds)), cached50GroupsP95Ms: round(p95(pages)),
    decision30PhotosP95Ms: round(p95(decisions)), groupingLoopMaxMs: round(loop.max / 1e6),
    peakRssMiB: round(process.resourceUsage().maxRSS / 1024), sqliteBytesAfter100Decisions: bytes,
    groupingJsonBytes: Buffer.byteLength(JSON.stringify(cold.value.groups)), metrics: cold.value.metrics }));
}
