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
  for (let i = 0; i < 21; i++) repo.recordJobRun({ title: `Older run ${i}`, provider: 'venice', status: 'finished', counters: { succeeded: 0, analyzed: 0, failed: 0 }, startedAt: '2026-08-01T12:00:00Z', finishedAt: '2026-08-01T12:00:01Z' });
  seedPerformanceRun(repo, { model: 'Earlier setup', photos: [{ outcome: 'failed', requests: [{ outcome: 'timeout', ms: 60000 }] }] });
  seedPerformanceRun(repo, { model: 'Second setup', status: 'cancelled' }); seedPerformanceRun(repo, { model: 'Third setup', photos: [], skipped: 25 });
  const latest = seedPerformanceRun(repo, { title: 'Travel photos', elapsedMs: 1800000, model: 'Vision-model-with-a-long-name-that-stays-readable-on-a-narrow-phone-screen', provider: 'venice',
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
  server = await bootServer(dir, { env: { IMMICH_BASE_URL: immich.base, IMMICH_API_KEY: 'fake', IMMICH_PUBLIC_URL: 'https://photos.example.test/immich', ENRICH_ENABLED: 'true' } });
  assert.equal((await fetch(`${server.base}/api/enrich/performance`)).status, 401);
  assert.equal((await fetch(`${server.base}/api/enrich/runs/1`)).status, 401);
  browser = await launchChrome(); const page = await browser.newPage();
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret"; document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll("#runsList .qitem").length === 20');
  assert.equal(await page.evaluate('document.getElementById("performanceList")'), null);
  assert.equal(await page.evaluate('document.querySelector("#runsList .performance-more")'), null);
  assert.equal(await page.evaluate('document.querySelector(".runs-navigation a").getAttribute("href")'), '/enrich-performance.html');
  assert.equal(await page.evaluate('document.getElementById("runsPanel").open'), false);
  assert.ok(await page.evaluate('document.querySelector(".runs-navigation a").getBoundingClientRect().height > 0'));
  await page.evaluate('document.querySelector(".runs-navigation a").click()');
  await page.waitFor('document.querySelectorAll("#performanceRuns tr").length === 20');
  assert.equal(await page.evaluate('document.getElementById("compareView").hidden'), true);
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelectorAll("#runsList .qitem").length === 20');
  await page.evaluate('document.getElementById("runsPanel").open = true');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#runsList .run-actions a")).alignItems'), 'center');
  await page.evaluate('document.querySelector("#runsList .run-configuration").click()');
  await page.waitFor('document.querySelectorAll("#logPopupMeta .run-setting-row").length === 3');
  const settingsRows = await page.evaluate('[...document.querySelectorAll("#logPopupMeta .run-setting-row")].map(r=>r.textContent)');
  assert.match(settingsRows[0], /^AI provider: Venice/); assert.match(settingsRows[1], /^Profile:/); assert.match(settingsRows[2], /^Image: Preview/);
  await page.evaluate('document.getElementById("logPopupClose").click(); document.querySelector("#runsList .qitem a").click()');
  await page.waitFor('document.getElementById("photoTimingBody")?.textContent.includes("Detailed timing was not recorded")');
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  await page.waitFor('location.hash === "#runs"');
  assert.equal(await page.evaluate('document.getElementById("compareView").hidden'), true);
  await page.evaluate('document.getElementById("compareViewLink").click()');
  await page.waitFor('!document.getElementById("compareView").hidden && document.querySelectorAll(".performance-card").length === 3');
  assert.equal(await page.evaluate('document.querySelector(".performance-card h3").textContent'), 'Venice · Vision-model-with-a-long-name-that-stays-readable-on-a-narrow-phone-screen');
  await page.evaluate('document.getElementById("performanceAll").click()');
  await page.waitFor('document.querySelectorAll(".performance-card").length === 4');
  await page.evaluate('document.getElementById("performanceAll").click()');
  await page.waitFor('document.querySelectorAll(".performance-card").length === 3');
  await page.evaluate('document.getElementById("runsViewLink").click()');
  await page.waitFor('!document.getElementById("runsView").hidden');
  const openRun = async title => page.evaluate(`(() => { const link=[...document.querySelectorAll('.run-detail-link')].find(n=>n.textContent===${JSON.stringify(title)}); link.click(); })()`);
  await openRun('Expired timing'); await page.waitFor('document.getElementById("photoTimingBody").textContent.includes("Timing expired")');
  assert.match(await page.evaluate('document.getElementById("photoTimingBody").textContent'), /Throughput/);
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  await page.waitFor('location.hash === "#runs"');
  await openRun('Travel photos'); await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  assert.match(await page.evaluate('document.querySelector(".run-detail-summary").textContent'), /Total time30 min/);
  assert.match(await page.evaluate('[...document.querySelectorAll("#performanceRuns tr")].find(r=>r.textContent.includes("Travel photos")).lastChild.textContent'), /30 min.*photos\/min/);
  assert.ok(await page.evaluate('[...document.querySelectorAll(".run-status")].some(s=>s.textContent === "Cancelled")'));
  assert.equal(await page.evaluate('document.querySelector(".run-detail-summary p:nth-child(2)").textContent'), await page.evaluate('[...document.querySelectorAll("#performanceRuns tr")].find(r=>r.textContent.includes("Travel photos")).firstChild.querySelector(".performance-context").textContent'));

  assert.equal(await page.evaluate('document.querySelector(".timing-photo-info strong").textContent'), '<img src=x onerror=alert(1)>.jpg');
  assert.equal(await page.evaluate('document.querySelector(".timing-photo-info strong img")'), null);
  assert.match(await page.evaluate('document.querySelectorAll(".timing-photo")[1].textContent'), /Saved enrichment available.*timing interrupted/);
  assert.equal(await page.evaluate('document.querySelector("#photoTimingBody details")'), null);
  await page.waitFor('document.querySelector(".timing-photo ol").children.length===2');
  assert.match(await page.evaluate('document.querySelector(".timing-photo ol").textContent'), /Request 1.*Timed out.*1 min.*Request 2.*Successful response.*8 s/);
  assert.equal(await page.evaluate('document.querySelector(".timing-photo").tagName'), 'ARTICLE');
  await page.waitFor('document.querySelectorAll(".timing-photo")[3].querySelectorAll("li").length===20');
  // Request paging errors preserve the already rendered rows and recover.
  await page.evaluate(`window.requestFetch=window.fetch; window.fetch=(url,...args)=>String(url).includes('/attempts?')?Promise.resolve(new Response('{}',{status:503})):window.requestFetch(url,...args)`);
  await page.evaluate('document.querySelectorAll(".timing-photo")[3].querySelector("button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo")[3].textContent.includes("Could not load requests")');
  await page.evaluate('window.fetch=window.requestFetch; document.querySelectorAll(".timing-photo")[3].querySelector("button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo")[3].querySelectorAll("li").length===22');
  await page.evaluate('document.querySelector("#photoTimingBody > button").click()');
  await page.waitFor('document.querySelectorAll(".timing-photo").length===25');
  const photoLink = await page.evaluate(`(() => { const a=document.querySelector('.timing-photo-info a'); return {href:a.href,target:a.target,rel:a.rel,title:a.title}; })()`);
  assert.match(photoLink.href, /^https:\/\/photos\.example\.test\/immich\/photos\/fixture-photo-\d+-0$/);
  assert.equal(photoLink.target, '_blank'); assert.match(photoLink.rel, /noopener/); assert.match(photoLink.title, /Immich/);
  assert.equal(await page.evaluate('document.querySelector(".timing-photo .provider-note").textContent'), '');
  // A real backdrop click closes; clicking content and dragging out do not.
  const clickAt = async (x,y) => {
    await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});
    await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});
  };
  const rect=await page.evaluate('(() => {const r=document.getElementById("photoTimingDialog").getBoundingClientRect();return {x:r.left+20,y:r.top+20};})()');
  await clickAt(rect.x,rect.y);
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").open'),true);
  await page.send('Input.dispatchMouseEvent',{type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1});
  await page.send('Input.dispatchMouseEvent',{type:'mouseReleased',x:5,y:5,button:'left',clickCount:1});
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").open'),true);
  await clickAt(5,5);
  await page.waitFor('!document.getElementById("photoTimingDialog").open && location.hash === "#runs"');
  await page.waitFor('document.activeElement.textContent === "Travel photos"');
  await openRun('Travel photos'); await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  // Escape closes the native modal and returns focus to the invoking action.
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").open'), false);
  await page.waitFor('document.activeElement.textContent === "Travel photos"');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await openRun('Travel photos'); await page.waitFor('document.querySelectorAll(".timing-photo").length===20');
  assert.equal(await page.evaluate('document.getElementById("photoTimingDialog").getBoundingClientRect().width <= innerWidth'), true);
  assert.equal(await page.evaluate('document.getElementById("photoTimingBody").scrollWidth <= document.getElementById("photoTimingBody").clientWidth'), true);
  if (process.env.PICTARIA_PERFORMANCE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' }); writeFileSync(process.env.PICTARIA_PERFORMANCE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  await page.waitFor('location.hash === "#runs"');
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
    await performancePage.metrics.refresh();
  })()`);
  assert.match(await page.evaluate('document.getElementById("performanceList").textContent'), /Run enrichment to see/);
  assert.equal(await page.evaluate('document.getElementById("performanceAll").hidden'), true);
  await page.evaluate(`(async () => {
    const group=structuredClone(window.originalPerformance.comparisons[0]);
    group.profileName='Travel <b>profile</b>'; group.profileRevision=2; group.host='Desktop'; group.lastUsedAt='2026-09-01T12:00:00Z';
    group.metrics.truncated=true;
    Object.assign(group.metrics,{accepted:0,requests:1,timeouts:1,failures:0,photosPerMinute:0,secondsPerPhoto:null,successfulPhotos:0,throughputRuns:1,latency:{sampleCount:0,medianMs:null,meanMs:null}});
    window.performanceFixture={comparisons:[group],runs:[],totalComparisons:1,window:{runCount:1,oldestAt:'2026-09-01',newestAt:'2026-09-01'}};
    await performancePage.metrics.refresh();
  })()`);
  assert.equal(await page.evaluate('document.querySelectorAll(".performance-card").length'), 1);
  assert.match(await page.evaluate('document.querySelector(".performance-setup").textContent'), /Profile: Travel <b>profile<\/b>.*revision 2.*Host: Desktop/);
  assert.equal(await page.evaluate('document.querySelector(".performance-setup b")'), null);
  assert.match(await page.evaluate('document.querySelector(".performance-card > .performance-context").textContent'), /Last used/);
  assert.match(await page.evaluate('document.querySelector(".performance-card > .performance-warning").textContent'), /Request metrics use the remaining records/);
  assert.match(await page.evaluate('document.querySelector(".performance-card").textContent'), /No timing yet.*0 of 1 requests succeeded.*1 timed out.*0 photos\/min/);
  await page.evaluate('window.fetch=window.realFetch; performancePage.metrics.refresh()');
  await page.evaluate('document.getElementById("runsMore").click()');
  await page.waitFor('document.querySelectorAll("#performanceRuns tr").length === 27');
  assert.equal(await page.evaluate('document.getElementById("runsMore").hidden'), true);
  await page.evaluate('performancePage.refresh()');
  await page.waitFor('document.querySelectorAll("#performanceRuns tr").length === 20 && !document.getElementById("refreshPerformance").disabled');
  await page.evaluate('location.hash = "#run=1"');
  await page.waitFor('document.getElementById("photoTimingTitle").textContent === "Older run 0" && document.getElementById("photoTimingDialog").open');
  assert.match(await page.evaluate('document.getElementById("photoTimingBody").textContent'), /Detailed timing was not recorded/);
  await page.evaluate('document.getElementById("photoTimingClose").click()');
  await page.waitFor('location.hash === "#runs"');
  await page.evaluate('location.hash = "#run=999999999"');
  await page.waitFor('document.getElementById("runsError").textContent.includes("no longer available")');
  await page.navigate(`${server.base}/settings.html#sec-enrich`);
  await page.waitFor("document.querySelector('#sec-enrich a[href=\"/enrich-performance.html\"]')");
  await page.evaluate("document.querySelector('#sec-enrich a[href=\"/enrich-performance.html\"]').click()");
  await page.waitFor('document.querySelectorAll("#performanceRuns tr").length === 20');
  assert.equal(await page.evaluate('document.getElementById("compareView").hidden'), true);
});
