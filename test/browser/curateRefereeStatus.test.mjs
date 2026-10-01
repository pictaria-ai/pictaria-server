import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('referee status updates cards and open comparisons without moving photos or changing drafts', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  // Synthetic API states only: production availability stays off. The worker
  // suite separately exercises the real status, persistence and stale guards.
  await page.evaluate(`window.refereeState={state:'waiting'};window.refereeActivity={state:'waiting',queued:1};
    const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args), url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.updatesAvailable=false;body.refinement={state:'idle',remainingGroups:0};
        body.stackRefereeActivity=window.refereeActivity;
        for(const group of body.groups)if(group.memberCount>1){group.similarity={state:'checked',uncertain:true};group.stackReferee=window.refereeState;}
      }
      if(url.endsWith('/comparisons')){body.similarity={state:'checked',uncertain:true};body.stackReferee=window.refereeState;}
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  await click('#refresh');
  await page.waitFor('document.querySelector(".is-stack .similarity-indicator")?.title.includes("Stack Referee queued")');
  assert.match(await page.evaluate('document.querySelector("#refinement").textContent'), /Stack Referee queued/);
  assert.equal(await page.evaluate('document.querySelector(".is-stack .capture-date").hidden'), true);
  const cardHeight = await page.evaluate('document.querySelector(".is-stack").getBoundingClientRect().height');
  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply").disabled');
  await click('#photos [data-choice=approve]');
  const positions = () => page.evaluate(`[...document.querySelectorAll('#photos .photo-card')].map(el=>({id:el.dataset.photoId,y:el.getBoundingClientRect().y}))`);
  const before = await positions();
  const phase = value => page.waitFor(`document.querySelector('#comparison-similarity .similarity-indicator')?.dataset.phase===${JSON.stringify(value)}`);
  await page.evaluate("window.refereeState={state:'checking'};window.refereeActivity={state:'checking',queued:0}");
  await phase('checking');
  await page.evaluate("window.refereeState={state:'checked',reason:'<b>Same composition</b>'};window.refereeActivity={state:'idle'}");
  await phase('ai-checked');
  assert.deepEqual(await positions(), before);
  assert.equal(await page.evaluate('document.querySelector("#photos [data-choice=approve]").getAttribute("aria-pressed")'), 'true');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .capture-date").hidden'), false);
  assert.equal(await page.evaluate('document.querySelector(".is-stack").getBoundingClientRect().height'), cardHeight);
  assert.equal(await page.evaluate('document.querySelector("#check-activity").childElementCount'), 0);
  await click('#comparison-similarity .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /Stack Referee checked/);
  assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /<b>Same composition<\/b>/);
  assert.equal(await page.evaluate('document.querySelector("#stack-reason b")'), null, 'model reason is text, not markup');
  if (process.env.PICTARIA_TEST_SCREENSHOTS) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-referee-checked.png'), Buffer.from(data, 'base64'));
  }
  await click('#comparison-similarity .why-trigger');
  await page.evaluate("window.refereeState={state:'incomplete',reason:'unsupported-size'}");
  await phase('limited');
  await click('#comparison-similarity .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /evaluated image limit/);
  assert.doesNotMatch(await page.evaluate('document.querySelector("#stack-reason").textContent'), /Stack Referee checked/);
  await click('#comparison-similarity .why-trigger');
  await page.evaluate("window.refereeState={state:'updated'}");
  await page.waitFor('document.querySelector("#comparison-similarity .why-trigger")?.getAttribute("aria-label").startsWith("Grouped with limited evidence")');
  assert.deepEqual(await positions(), before);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await click('#comparison-similarity .why-trigger');
  assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('#stack-reason').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`), true);
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0, 'no draft was saved by status changes');
});
