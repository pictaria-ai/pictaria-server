#!/usr/bin/env node
// Synthetic local SQLite only. Never opens the configured app database or calls
// Immich/providers. A smoke measurement, not the complete-server release gate.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Repository } from '../src/enrich/repository.mjs';
import { CurateService } from '../src/curate/service.mjs';
const cases = ['1000', '10000', '30000', 'context', 'dense'];
const selected = process.argv[2];
if (!selected) {
  const results = cases.map((name) => {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { encoding: 'utf8' });
    if (child.status !== 0) throw Error(child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  });
  console.log(
    JSON.stringify({ node: process.version, cpu: cpus()[0]?.model, platform: process.platform, results }, null, 2),
  );
} else {
  if (!cases.includes(selected)) throw Error('Unknown benchmark fixture.');
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-curate-bench-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  const service = new CurateService({ repo });
  let sampler;
  try {
    const size = selected === 'context' ? 30100 : selected === 'dense' ? 30000 : Number(selected);
    const assets = repo.db.prepare(
      'INSERT INTO assets(asset_id,file_created_at,first_seen_at,last_seen_at) VALUES(?,?,?,?)',
    );
    const listed = repo.db.prepare('INSERT INTO review_list(asset_id,added_at,source)VALUES(?,?,?)');
    const tag = repo.db.prepare(
      "INSERT INTO asset_tags(asset_id,tag,source,created_at)VALUES(?,'frame/eligible','test','now')",
    );
    repo.transaction(() => {
      for (let i = 0; i < size; i++) {
        const id = 'photo-' + String(i).padStart(6, '0');
        assets.run(
          id,
          new Date(1700000000000 + i * (selected === 'dense' ? 1000 : 180000)).toISOString(),
          'now',
          'now',
        );
        listed.run(id, 'now', 'test');
        if (selected === 'context' && i < 30000) tag.run(id);
      }
    });
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 5);
    const loop = monitorEventLoopDelay({ resolution: 5 });
    loop.enable();
    const cold = performance.now();
    await service.refresh();
    const initialMs = performance.now() - cold;
    repo.curate.bump();
    const start = performance.now();
    await service.refresh();
    const rebuildMs = performance.now() - start;
    const open = performance.now();
    const view = await service.openView();
    const openViewMs = performance.now() - open;
    const list = [];
    for (let i = 0; i < 20; i++) {
      const before = performance.now();
      service.page(view.viewId, 0);
      list.push(performance.now() - before);
    }
    list.sort((a, b) => a - b);
    loop.disable();
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    console.log(
      JSON.stringify({
        fixture: selected,
        photos: size,
        groups: view.total,
        initialProjectionAndBuildMs: initialMs,
        rebuildMs,
        openViewMs,
        pageP95Ms: list[18],
        maxProjectionSliceMs: service.metrics.maxProjectionSliceMs,
        loopP95Ms: loop.percentile(95) / 1e6,
        loopMaxMs: loop.max / 1e6,
        baselineRssMiB: baselineRss / 1048576,
        sampledPeakRssMiB: peakRss / 1048576,
        rssIncreaseMiB: (peakRss - baselineRss) / 1048576,
      }),
    );
  } finally {
    clearInterval(sampler);
    await service.close();
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
