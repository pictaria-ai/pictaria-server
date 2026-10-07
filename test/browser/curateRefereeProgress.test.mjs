import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('both referee bars show global stack work, keep their layout and expose details on mobile', { timeout: 45000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t), fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 2, metadataReady: true }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = s => page.evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  assert.equal(await page.evaluate('document.querySelector("#stack-referee-progress .referee-progress-copy").textContent'), 'Off');
  assert.equal(await page.evaluate('document.querySelector("#photo-referee-progress .referee-progress-copy").textContent'), 'Off');
  await page.evaluate(`window.work={state:'ready',total:80,completed:60,incomplete:8,remaining:12,
      waitingForGrouping:0,waitingForStack:0,paused:0};window.headerOverride=null;
    const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args),url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.enrichRunning=true;body.updatesAvailable=false;body.refinement={state:'idle',remainingGroups:0};
        body.refereeProgress={stack:window.work,photo:{...window.work,waitingForStack:12}};
        body.stackRefereeActivity={state:'checking'};
        body.photoRefereeActivity={state:'waiting'};
        Object.assign(body,window.headerOverride);
      }
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  // A real filter change gets the next status payload; there is no permanent Refresh.
  await click('[data-kind=stacks]');
  await page.waitFor('document.querySelector("#stack-referee-progress").textContent.includes("12 stacks left")');
  assert.equal(await page.evaluate('document.querySelector("#curate-activity-copy").textContent'), 'Stack Referee · Comparing photos');
  assert.match(await page.evaluate('document.querySelector("#photo-referee-progress").title'), /Waiting for stack checks/);
  assert.equal(await page.evaluate('document.querySelector("#check-activity .activity-indicator").dataset.phase'), 'running');
  assert.equal(await page.evaluate('document.querySelector("#stack-referee-progress progress").value'), 0.85);
  assert.equal(await page.evaluate('document.querySelector(".page-tools")'), null);
  assert.equal(await page.evaluate('document.querySelector("#refresh").hidden'), true);
  const geometry = () => page.evaluate(`['#sections','.referee-progress','#check-activity','#curate-activity-copy','#groups'].map(s=>{
    const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height];})`);
  const before = await geometry();
  for (const s of ['[data-kind=singles]', '[data-section=decided]', '[data-section=pending]', '[data-kind=all]']) {
    await click(s); await page.waitFor('!document.querySelector("#refresh").disabled');
    assert.match(await page.evaluate('document.querySelector("#stack-referee-progress").textContent'), /12 stacks left/);
    assert.deepEqual((await geometry()).slice(0, 4), before.slice(0, 4));
  }
  const screenshot = async name => {
    if (!process.env.PICTARIA_TEST_SCREENSHOTS) return;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, name), Buffer.from(data, 'base64'));
  };
  assert.equal(await page.evaluate(`(()=>{const panel=document.querySelector('.refresh-tools').getBoundingClientRect();
    const row=document.querySelector('.view-controls').getBoundingClientRect();return panel.right===row.right;})()`), true, 'panel hugs the right edge');
  await screenshot('referee-progress-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  assert.equal(await page.evaluate('[...document.querySelectorAll(".referee-progress-copy")].every(e=>e.scrollHeight<=e.clientHeight && e.scrollWidth<=e.clientWidth)'), true);
  await screenshot('referee-progress-mobile.png');
  await click('#stack-referee-progress .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-progress-help").textContent'), /8 finished without a full result/);
  assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#stack-progress-help").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()'), true);
  await click('#stack-referee-progress .why-trigger');
  const off = { state: 'off' }, done = { state: 'ready', total: 80, completed: 60, incomplete: 20, remaining: 0 };
  const work = { ...done, incomplete: 8, remaining: 12, waitingForGrouping: 0, waitingForStack: 0, paused: 0 };
  const scenarios = [
    { refereeProgress: { stack: done, photo: work }, stackRefereeActivity: { state: 'idle' }, photoRefereeActivity: { state: 'waiting', reason: 'shared-provider' }, phase: 'queued', text: 'Photo Referee · Waiting for AI' },
    { refereeProgress: { stack: off, photo: { ...work, total: 11000, remaining: 10932 } }, stackRefereeActivity: off, photoRefereeActivity: { state: 'checking' }, phase: 'running', text: 'Photo Referee · Comparing photos' },
    { refereeProgress: { stack: off, photo: work }, stackRefereeActivity: off, photoRefereeActivity: { state: 'paused', reason: 'model-failures' }, phase: 'attention', text: 'Photo Referee · Paused' },
    { refereeProgress: { stack: done, photo: off }, stackRefereeActivity: { state: 'idle' }, photoRefereeActivity: off, phase: null, text: '' },
    { refereeProgress: { stack: off, photo: off }, stackRefereeActivity: off, photoRefereeActivity: off, refinement: { state: 'searching', remainingGroups: 3 }, phase: 'running', text: 'Grouping nearby photos' },
    { refereeProgress: { stack: off, photo: off }, stackRefereeActivity: off, photoRefereeActivity: off, phase: null, text: '' },
  ];
  for (const width of [1440, 390, 320]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
    const layout = await geometry();
    for (const { phase, text, ...payload } of scenarios) {
      await page.evaluate(`window.headerOverride=${JSON.stringify(payload)}`);
      await click('#refresh'); await page.waitFor('!document.querySelector("#refresh").disabled');
      assert.equal(await page.evaluate('document.querySelector("#check-activity .activity-indicator")?.dataset.phase ?? null'), phase);
      assert.equal(await page.evaluate('document.querySelector("#curate-activity-copy").textContent'), text);
      assert.deepEqual(await geometry(), layout, `header and cards stay anchored at ${width}px: ${text || 'idle'}`);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.equal(await page.evaluate('[...document.querySelectorAll(".referee-progress-copy,#curate-activity-copy")].every(e=>e.scrollWidth<=e.clientWidth)'), true, 'compact counts and explanations fit');
      assert.equal(await page.evaluate('[...document.querySelectorAll(".referee-progress-row[data-phase=off] progress")].every(e=>e.value===0 && getComputedStyle(e).visibility==="visible")'), true);
    }
    await screenshot(`referee-progress-off-${width}.png`);
  }
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});
