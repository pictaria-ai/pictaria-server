import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Repository } from '../../src/enrich/repository.mjs';
import { seedPerformanceRun } from '../enrich/performanceFixtures.mjs';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

test('Enrich compares setups and opens paginated photo/request details with honest unavailable states on desktop and phone', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-performance-browser-'));
  let server, browser, immich;
  t.after(async () => { await Promise.allSettled([browser?.stop(), server?.stop(), immich?.stop()]); rmSync(dir, { recursive: true, force: true }); });
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  seedPerformanceRun(repo, { model: 'Earlier setup', photos: [{ outcome: 'failed', requests: [{ outcome: 'timeout', ms: 60000 }] }] });
  seedPerformanceRun(repo, { model: 'Second setup' }); seedPerformanceRun(repo, { model: 'Third setup', photos: [], skipped: 25 });
  const latest = seedPerformanceRun(repo, { title: 'Travel photos', model: 'Vision-model-with-a-long-name-that-stays-readable-on-a-narrow-phone-screen', provider: 'venice',
    photos: [
      { filename: '<img src=x onerror=alert(1)>.jpg', ms: 73000, requests: [{ outcome: 'timeout', ms: 60000 }, { outcome: 'accepted', ms: 8000 }] },
      { outcome: 'interrupted', savedResult: true, ms: null, requests: [{ outcome: 'accepted', ms: 5000 }] },
      { outcome: 'failed', requests: [{ outcome: 'invalid_response', ms: 1000 }], recordedRequests: 4 },
      ...Array.from({ length: 22 }, () => ({ requests: Array.from({ length: 22 }, (_, i) => ({ outcome: i === 21 ? 'accepted' : 'http_error', ms: 10, httpStatus: i === 21 ? 200 : 503 })) })),
    ] });
  repo.recordJobRun({ title: 'Expired timing', timingRunId: 999999, provider: 'venice', status: 'finished', counters: { succeeded: 1, analyzed: 1, failed: 0 }, startedAt: latest.start, finishedAt: latest.end });
  repo.recordJobRun({ title: 'Before timing was recorded', provider: 'venice', status: 'finished', counters: { succeeded: 1, analyzed: 1, failed: 0 }, startedAt: latest.start, finishedAt: latest.end });
  const assets = repo.db.prepare('SELECT asset_id AS id FROM assets').all().map(a => ({ ...a, type: 'IMAGE' })); repo.close();
  immich = await startFakeImmich({ assets, serveAssetDetails: true });
  server = await bootServer(dir, { env: { IMMICH_BASE_URL: immich.base, IMMICH_API_KEY: 'fake', ENRICH_ENABLED: 'true' } });
  assert.equal((await fetch(`${server.base}/api/enrich/performance`)).status, 401);
  browser = await launchChrome(); const page = await browser.newPage();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret"; document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".performance-card").length === 3 && document.querySelectorAll("#runsList .qitem").length === 6');
  assert.equal(await page.evaluate('document.querySelector(".performance-card h3").textContent'), 'Venice · Vision-model-with-a-long-name-that-stays-readable-on-a-narrow-phone-screen');
  await page.evaluate('document.getElementById("performanceAll").click()');
  await page.waitFor('document.querySelectorAll(".performance-card").length === 4');
  await page.evaluate('document.getElementById("performanceAll").click()');
  await page.waitFor('document.querySelectorAll(".performance-card").length === 3');
  await page.evaluate('document.getElementById("runsPanel").open=true');
  const openRun = async title => page.evaluate(`(() => { const c=[...document.querySelectorAll('#runsList .qitem')].find(n=>n.querySelector('.t').textContent===${JSON.stringify(title)}); c.querySelector('.run-photo-details').click(); })()`);
  await openRun('Expired timing'); await page.waitFor('document.getElementById("photoTimingBody").textContent.includes("Timing expired")');
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  assert.match(await page.evaluate('document.querySelector("#runsList .qitem").textContent'), /Detailed timing was not recorded/);
  await openRun('Travel photos'); await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  assert.equal(await page.evaluate('document.querySelector(".timing-photo-info strong").textContent'), '<img src=x onerror=alert(1)>.jpg');
  assert.equal(await page.evaluate('document.querySelector(".timing-photo-info strong img")'), null);
  assert.match(await page.evaluate('document.querySelectorAll(".timing-photo")[1].textContent'), /Saved enrichment available.*timing interrupted/);
  await page.evaluate('document.querySelector(".timing-photo").open=true');
  await page.waitFor('document.querySelector(".timing-photo ol").children.length===2');
  assert.match(await page.evaluate('document.querySelector(".timing-photo ol").textContent'), /Request 1.*Timed out.*60 s.*Request 2.*Successful response.*8 s/);
  await page.evaluate('document.querySelectorAll(".timing-photo")[3].open=true');
  await page.waitFor('document.querySelectorAll(".timing-photo")[3].querySelectorAll("li").length===20');
  await page.evaluate('document.querySelectorAll(".timing-photo")[3].querySelector("button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo")[3].querySelectorAll("li").length===22');
  await page.evaluate('document.querySelector("#photoTimingBody > button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo").length===25');
  // Escape closes the native modal and returns focus to the invoking action.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").open'), false);
  await page.waitFor('document.activeElement.textContent === "View photo details"');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await openRun('Travel photos'); await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").getBoundingClientRect().width <= innerWidth'), true);
  assert.equal(await page.evaluate('document.getElementById("photoTimingBody").scrollWidth <= document.getElementById("photoTimingBody").clientWidth'), true);
  if (process.env.PICTARIA_PERFORMANCE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(process.env.PICTARIA_PERFORMANCE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  // A failed request is recoverable; opening a different run cannot show a late old response.
  await page.evaluate(`window.realFetch=window.fetch; window.fetch=(url,...args)=>String(url).includes('/photos?')?Promise.resolve(new Response('{}',{status:503})):window.realFetch(url,...args)`);
  await openRun('Travel photos'); await page.waitFor('document.getElementById("photoTimingBody").textContent.includes("Could not load photos")');
  await page.evaluate('window.fetch=window.realFetch; document.querySelector("#photoTimingBody > button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  // Read-only response fixtures cover the empty and zero-success UI without
  // altering the running server's persisted history.
  await page.evaluate(`(async () => {
    window.originalPerformance = await fetch('/api/enrich/performance?limit=100').then(r=>r.json());
    window.performanceFixture = { comparisons: [], runs: [], totalComparisons: 0, window: {runCount:0} };
    window.fetch=(url,...args)=>String(url).startsWith('/api/enrich/performance')?Promise.resolve(Response.json(window.performanceFixture)):window.realFetch(url,...args);
    await performanceUI.refresh();
  })()`);
  assert.match(await page.evaluate('document.getElementById("performanceList").textContent'), /Run enrichment to see/);
  assert.equal(await page.evaluate('document.getElementById("performanceAll").hidden'), true);
  await page.evaluate(`(async () => {
    const group=structuredClone(window.originalPerformance.comparisons[0]);
    Object.assign(group.metrics,{accepted:0,requests:1,timeouts:1,failures:0,photosPerMinute:0,secondsPerPhoto:null,successfulPhotos:0,throughputRuns:1,latency:{sampleCount:0,medianMs:null,meanMs:null}});
    window.performanceFixture={comparisons:[group],runs:[],totalComparisons:1,window:{runCount:1,oldestAt:'2026-09-01',newestAt:'2026-09-01'}};
    await performanceUI.refresh();
  })()`);
  assert.equal(await page.evaluate('document.querySelectorAll(".performance-card").length'), 1);
  assert.match(await page.evaluate('document.querySelector(".performance-card").textContent'), /No timing yet.*0 successful \/ 1.*1 timeout.*0 photos\/min/);
  await page.evaluate('window.fetch=window.realFetch; performanceUI.refresh()');
});
