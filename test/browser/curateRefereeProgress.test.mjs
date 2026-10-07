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
      waitingForGrouping:0,waitingForStack:0,paused:0};window.progressDone=false;
    const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args),url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.enrichRunning=true;body.updatesAvailable=false;
        body.refereeProgress={stack:window.progressDone?{...window.work,remaining:0,incomplete:20}:window.work,
          photo:window.progressDone?{state:'off'}:{...window.work,waitingForStack:12}};
        body.stackRefereeActivity={state:window.progressDone?'idle':'checking'};
        body.photoRefereeActivity={state:window.progressDone?'off':'waiting'};
      }
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  // A real filter change gets the next status payload; there is no permanent Refresh.
  await click('[data-kind=stacks]');
  await page.waitFor('document.querySelector("#stack-referee-progress").textContent.includes("12 stacks remaining · Working")');
  assert.match(await page.evaluate('document.querySelector("#photo-referee-progress").textContent'), /12 stacks remaining · Waiting for stack checks/);
  assert.equal(await page.evaluate('document.querySelector("#stack-referee-progress progress").value'), 0.85);
  assert.equal(await page.evaluate('document.querySelector(".page-tools")'), null);
  assert.equal(await page.evaluate('document.querySelector("#refresh").hidden'), true);
  const geometry = () => page.evaluate(`['#sections','.referee-progress','#groups'].map(s=>{
    const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.height];})`);
  const before = await geometry();
  for (const s of ['[data-kind=singles]', '[data-section=decided]', '[data-section=pending]', '[data-kind=all]']) {
    await click(s); await page.waitFor('!document.querySelector("#refresh").disabled');
    assert.match(await page.evaluate('document.querySelector("#stack-referee-progress").textContent'), /12 stacks remaining/);
    assert.deepEqual((await geometry()).slice(0, 2), before.slice(0, 2));
  }
  const screenshot = async name => {
    if (!process.env.PICTARIA_TEST_SCREENSHOTS) return;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, name), Buffer.from(data, 'base64'));
  };
  await screenshot('referee-progress-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
  assert.equal(await page.evaluate('[...document.querySelectorAll(".referee-progress-copy")].every(e=>e.scrollHeight<=e.clientHeight && e.scrollWidth<=e.clientWidth)'), true);
  const mobile = await geometry();
  await screenshot('referee-progress-mobile.png');
  await click('#stack-referee-progress .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-progress-help").textContent'), /8 finished without a full result/);
  assert.equal(await page.evaluate('(()=>{const r=document.querySelector("#stack-progress-help").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()'), true);
  await click('#stack-referee-progress .why-trigger');
  await page.evaluate('window.progressDone=true');
  await page.waitFor('document.querySelector("#stack-referee-progress .referee-progress-copy").textContent==="Up to date"');
  assert.equal(await page.evaluate('document.querySelector("#photo-referee-progress .referee-progress-copy").textContent'), 'Off');
  assert.deepEqual(await geometry(), mobile, 'completion and Off cannot move the grid');
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});
