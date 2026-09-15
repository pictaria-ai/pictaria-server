#!/usr/bin/env node
// Standalone synthetic HTTP/SQLite workload. No live app, configuration or AI.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { cpus, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { dataset, photo } from './fixtures.mjs';
import { BackgroundGroups } from './background.mjs';
import { DecisionSpike } from './decisions.mjs';

const cases = [[1000, 0], [10000, 0], [30000, 0], [100, 30000], [30000, 0, 'dense'], [30000, 0, 'gapped-triples']];
const arg = process.argv.find(a => a.startsWith('--case='));
if (!arg) {
  const results = cases.map((_, i) => {
    const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), `--case=${i}`], {
      encoding: 'utf8', env: {}, timeout: 60000, maxBuffer: 1024 * 1024,
    });
    if (child.error || child.status !== 0) throw Error(child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout);
  });
  console.log(JSON.stringify({ format: 'curate-cooperative-bench-1', node: process.version,
    cpu: cpus()[0].model, platform: process.platform, results }, null, 2));
} else {
  const index = Number(arg.slice(7));
  if (!Number.isInteger(index) || !cases[index]) throw Error('invalid case');
  const [pending, decided, distribution = '30-photo-bursts'] = cases[index];
  const rows = distribution === 'dense'
    ? Array.from({ length: pending }, (_, i) => photo(`dense-${i}`, i / 1000, { people: i % 2, recognized: i % 2 ? ['p'] : [] }))
    : distribution === 'gapped-triples'
      ? Array.from({ length: pending }, (_, i) => photo(`gapped-${i}`, Math.floor(i / 3) * 240 + [0, 5, 67][i % 3],
        { people: 1, recognized: ['synthetic-person'] }))
      : dataset(pending, decided);
  const options = { semanticVeto: true, ...(distribution === 'gapped-triples' ? { lookbackDistance: 0.05 } : {}) };
  const directory = mkdtempSync(join(tmpdir(), 'curate-cooperative-'));
  const db = new DecisionSpike(join(directory, 'spike.sqlite'));
  const slices = [], rebuilds = [], listTimes = [], decisionTimes = [];
  let peakRss = 0, counter = 0, metadataWrites = 0, measuring = false;
  const sampleRss = () => { peakRss = Math.max(peakRss, process.memoryUsage.rss()); };
  const builder = new BackgroundGroups({ runtime: { sliceMs: 4, onSlice: ms => { slices.push(ms); sampleRss(); } } });
  const ids = rows.slice(0, 30).map(p => p.id);
  const outcomes = Object.fromEntries(ids.map((id, i) => [id, i < 2 ? 'approve' : 'reviewed']));
  let timer, server;
  try {
    db.seed(rows); db.scope('comparison', ids);
    db.db.exec('CREATE TABLE enrichment_progress(id INTEGER PRIMARY KEY, updates INTEGER NOT NULL)');
    db.db.prepare('INSERT INTO enrichment_progress VALUES(1,0)').run();
    const progress = db.db.prepare('UPDATE enrichment_progress SET updates=updates+1 WHERE id=1');
    server = createServer((req, res) => {
      try {
        const output = req.url === '/list' ? builder.page()
          : req.url === '/decision' && req.method === 'POST'
            ? db.apply({ requestId: `synthetic-${++counter}`, snapshot: db.snapshot('comparison'), outcomes })
            : null;
        res.writeHead(output ? 200 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(output));
      } catch { res.writeHead(500); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = path => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port,
        path, method: path === '/decision' ? 'POST' : 'GET', agent: false }, res => {
        res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(Error('HTTP probe failed')));
      });
      req.on('error', reject); req.end();
    });
    global.gc?.();
    const baselineRss = process.memoryUsage.rss(); peakRss = baselineRss;
    const coldStart = performance.now();
    await builder.request(() => ({ rows, options, revision: 'cold' }));
    const coldMs = performance.now() - coldStart;
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable(); await setTimeout(10);
    const baselineSlices = slices.length;
    // Two HTTP clients and a recurring, local SQLite metadata update overlap
    // at least twenty rebuilds over at least one second. This deliberately
    // sustained workload gives HTTP clients more than a handful of samples.
    // It does not change this frozen input snapshot or imply normal rebuild rate.
    timer = global.setInterval(() => { progress.run(); metadataWrites++; sampleRss(); }, 5);
    measuring = true;
    const client = async (path, times) => {
      while (measuring) {
        const started = performance.now();
        await call(path);
        times.push(performance.now() - started);
        await setImmediate();
      }
    };
    const clients = Promise.allSettled([client('/list', listTimes), client('/decision', decisionTimes)]);
    const campaignStart = performance.now();
    try {
      for (let i = 0; i < 20 || performance.now() - campaignStart < 1000; i++) {
        const started = performance.now();
        await builder.request(() => ({ rows, options, revision: `build-${i}` }));
        rebuilds.push(performance.now() - started);
        await setImmediate();
      }
    } finally { measuring = false; }
    const clientResults = await clients;
    for (const result of clientResults) if (result.status === 'rejected') throw result.reason;
    const campaignMs = performance.now() - campaignStart;
    global.clearInterval(timer); timer = null;
    await setTimeout(10); loop.disable(); sampleRss();
    const round = n => Math.round(n * 100) / 100;
    const p95 = values => values.length ? round([...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]) : null;
    const liveSlices = slices.slice(baselineSlices);
    console.log(JSON.stringify({ pending, decided, distribution, options, sliceBudgetMs: 4,
      coldMs: round(coldMs), rebuildP95Ms: p95(rebuilds), rebuilds: rebuilds.length,
      listHttpSamples: listTimes.length, listHttpP95Ms: p95(listTimes),
      decisionHttpSamples: decisionTimes.length, decisionHttpP95Ms: p95(decisionTimes),
      loopP95Ms: round(loop.percentile(95) / 1e6), loopMaxMs: round(loop.max / 1e6),
      sliceP95Ms: p95(liveSlices), sliceMaxMs: round(Math.max(...slices)),
      slicesOver8Ms: slices.filter(n => n > 8).length,
      baselineRssMiB: round(baselineRss / 1024 / 1024), observedPeakRssMiB: round(peakRss / 1024 / 1024),
      observedRssIncreaseMiB: round((peakRss - baselineRss) / 1024 / 1024), gcBeforeBaseline: Boolean(global.gc),
      campaignMs: round(campaignMs), syntheticMetadataWrites: metadataWrites, syntheticDecisions: counter,
      groups: builder.current.groups.length, metrics: builder.current.metrics,
      scope: 'standalone HTTP/SQLite prototype; prepared input projection and database initialization excluded; no real Enrich/provider or full-server acceptance' }));
  } finally {
    measuring = false; if (timer) global.clearInterval(timer); builder.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    db.close(); rmSync(directory, { recursive: true, force: true });
  }
}
