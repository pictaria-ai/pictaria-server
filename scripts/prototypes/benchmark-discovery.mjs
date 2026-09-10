// Standalone synthetic experiment, never connects to Immich or a provider.
import { performance } from 'node:perf_hooks';
import { library, sandbox, SyntheticSource, history, finish, key } from './discovery-fixture.mjs';
for (const size of [10000, 100000, 150000]) {
  const rows = library(size);
  for (const mode of ['enrich', 'insights-with-eligibility-columns']) {
    const box = sandbox();
    try {
      box.repo.transaction(() => { for (const row of rows.slice(0, size - 50)) history(box.repo, row); });
      const index = box.index(mode), source = new SyntheticSource(rows, mode);
      index.begin(); const start = performance.now();
      const batches = await finish(index, source, { maxPages: 2 });
      const buildMs = performance.now() - start;
      const samples = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); index.candidates({ runKey: key }); samples.push(performance.now() - t); }
      const full = { ...source.calls };
      index.begin('delta'); const deltaSteps = await finish(index, source);
      const chosen = await index.select(source, { runKey: key, limit: 50 });
      box.repo.transaction(() => { for (const row of chosen.selected) history(box.repo, row); });
      const afterProcessing = index.candidates({ runKey: key }).length;
      console.log(JSON.stringify({ size, mode, inventoryRows: index.db.prepare('SELECT COUNT(*) AS n FROM prototype_inventory').get().n,
        fullPages: full.pages, fullRows: full.rows, batches, buildMs: Math.round(buildMs),
        sqlMedianMs: Math.round(samples.sort((a, b) => a - b)[2] * 10) / 10,
        // Includes the overlapped boundary row; these are metadata requests.
        overlapPages: source.calls.pages - full.pages, deltaSteps,
        selected: chosen.selected.length, validations: chosen.validated, afterProcessing }));
    } finally { box.close(); }
  }
}
