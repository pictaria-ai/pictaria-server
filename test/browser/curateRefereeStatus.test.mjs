import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('referee status updates cards and open comparisons without moving photos or changing drafts', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  // Synthetic API states only: the saved role preference stays off. The worker
  // suite separately exercises the real status, persistence and stale guards.
  await page.evaluate(`window.refereeState={state:'waiting'};window.refereeActivity={state:'waiting',queued:1};
    window.similarityState={state:'checked',uncertain:true};
    const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args), url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.updatesAvailable=false;body.refinement={state:'idle',remainingGroups:0};
        body.stackRefereeActivity=window.refereeActivity;
        for(const group of body.groups)if(group.memberCount>1){group.similarity=window.similarityState;group.stackReferee=window.refereeState;}
      }
      if(url.endsWith('/comparisons')){body.similarity=window.similarityState;body.stackReferee=window.refereeState;}
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  await click('#refresh');
  await page.waitFor('document.querySelector(".is-stack .stack-badge")?.title.includes("AI check: queued")');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .stack-badge").dataset.badge'), 'checking');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .p-chip").textContent'), 'Checking · 4 photos');
  assert.match(await page.evaluate('document.querySelector("#refinement").textContent'), /1 checking/);
  assert.match(await page.evaluate('document.querySelector("#check-activity .activity-indicator").title'), /Stack Referee queued/);
  assert.equal(await page.evaluate('document.querySelector(".is-stack .capture-date").hidden'), false, 'the date stays put');
  const cardHeight = await page.evaluate('document.querySelector(".is-stack").getBoundingClientRect().height');
  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply").disabled');
  await click('#photos [data-choice=approve]');
  const positions = () => page.evaluate(`[...document.querySelectorAll('#photos .photo-card')].map(el=>({id:el.dataset.photoId,y:el.getBoundingClientRect().y}))`);
  const before = await positions();
  const phase = value => page.waitFor(`document.querySelector('#comparison-similarity .stack-badge')?.dataset.badge===${JSON.stringify(value)}`);
  await page.evaluate("window.refereeState={state:'checking'};window.refereeActivity={state:'checking',queued:0}");
  await phase('checking');
  await page.evaluate("window.refereeState={state:'checked',reason:'<b>Same composition</b>',split:false};window.refereeActivity={state:'idle'}");
  await phase('ai-checked');
  assert.equal(await page.evaluate('document.querySelector("#comparison-similarity .stack-badge").textContent'), 'AI checked');
  assert.deepEqual(await positions(), before);
  assert.equal(await page.evaluate('document.querySelector("#photos [data-choice=approve]").getAttribute("aria-pressed")'), 'true');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .capture-date").hidden'), false);
  assert.equal(await page.evaluate('document.querySelector(".is-stack").getBoundingClientRect().height'), cardHeight);
  assert.equal(await page.evaluate('document.querySelector("#check-activity").childElementCount'), 0);
  await click('#comparison-similarity .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-reason .why-verdict").textContent'), /^AI checked$/);
  assert.match(await page.evaluate('document.querySelector("#stack-reason .why-steps").textContent'), /AI check: confirmed/);
  assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /<b>Same composition<\/b>/);
  assert.equal(await page.evaluate('document.querySelector("#stack-reason b")'), null, 'model reason is text, not markup');
  if (process.env.PICTARIA_TEST_SCREENSHOTS) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-referee-checked.png'), Buffer.from(data, 'base64'));
  }
  await click('#comparison-similarity .why-trigger');
  // A nearby arrival supersedes the shown grouping: both the card and the open
  // comparison keep the verdict for the photos they show, with a note.
  const updated = () => page.waitFor(`document.querySelector('.is-stack')?.hasAttribute('data-updated') &&
    document.querySelector('#stack-reason .why-updated')`);
  await page.evaluate("window.similarityState={state:'updated',pending:true};window.refereeState={state:'updated'}");
  await updated();
  assert.equal(await page.evaluate('document.querySelector(".is-stack").dataset.badge'), 'ai-checked');
  assert.equal(await page.evaluate('document.querySelector("#comparison-similarity .stack-badge").dataset.badge'), 'ai-checked');
  assert.match(await page.evaluate('document.querySelector("#stack-reason .why-steps").textContent'), /AI check: confirmed/);
  assert.equal(await page.evaluate(`(()=>{const probe=document.createElement('span');probe.style.color='var(--p-accent)';
    document.body.append(probe);const accent=getComputedStyle(probe).color;probe.remove();
    return getComputedStyle(document.querySelector('.is-stack')).borderTopColor===accent;})()`), true, 'the card gains the accent outline');
  assert.deepEqual(await positions(), before);
  // Current again: the note goes. Then a Stack Referee split completes while
  // the comparison stays open; finished work stops counting as checking.
  await page.evaluate("window.similarityState={state:'checked',uncertain:true};window.refereeState={state:'checking'}");
  await phase('checking');
  assert.equal(await page.evaluate('document.querySelector(".is-stack").hasAttribute("data-updated")'), false);
  await page.evaluate("window.refereeState={state:'updated'}");
  await updated();
  assert.equal(await page.evaluate('document.querySelector("#comparison-similarity .stack-badge").dataset.badge'), 'unsure');
  assert.equal(await page.evaluate('document.querySelector(".is-stack").dataset.badge'), 'unsure');
  assert.equal(await page.evaluate('document.querySelector("#photos [data-choice=approve]").getAttribute("aria-pressed")'), 'true', 'drafts stay');
  await page.evaluate("window.refereeState={state:'incomplete',reason:'unsupported-size',limit:2}");
  await phase('unsure');
  await page.waitFor('!document.querySelector(".is-stack").hasAttribute("data-updated")');
  await click('#comparison-similarity .why-trigger');
  assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /AI check: not possible, 4 photos is over the 2-photo limit/);
  assert.doesNotMatch(await page.evaluate('document.querySelector("#stack-reason").textContent'), /AI checked|Same composition/);
  await click('#comparison-similarity .why-trigger');
  await page.evaluate("window.refereeState={state:'incomplete',reason:'configuration',scope:'configuration'};window.refereeActivity={state:'paused',reason:'configuration',scope:'configuration'}");
  await page.waitFor("document.querySelector('#refinement').textContent.includes('Stack Referee paused') && document.querySelector('#comparison-similarity .why-trigger')?.getAttribute('aria-label').startsWith('Unsure')");
  assert.equal(await page.evaluate('document.querySelector(".is-stack .stack-badge").dataset.badge'), 'unsure', 'configuration problems belong to the header');
  assert.equal(await page.evaluate('document.querySelector("#check-activity .activity-indicator").dataset.phase'), 'attention');
  await page.evaluate("window.refereeState={state:'paused',reason:'model-failures',scope:'configuration'};window.refereeActivity={...window.refereeState}");
  await page.waitFor("document.querySelector('#refinement').title.includes('Choose a vision model that compares multiple images')");
  assert.match(await page.evaluate('document.querySelector("#refinement").textContent'), /Stack Referee paused/);
  assert.doesNotMatch(await page.evaluate('document.querySelector(".is-stack .stack-badge").title'), /paused|not possible/);
  await page.evaluate("window.refereeState={state:'updated'};window.refereeActivity={state:'idle'}");
  await page.waitFor('document.querySelector("#comparison-similarity .why-trigger")?.getAttribute("aria-label").startsWith("Unsure") && !document.querySelector("#check-activity").childElementCount');
  assert.deepEqual(await positions(), before);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await click('#comparison-similarity .why-trigger');
  assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('#stack-reason').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth;})()`), true);
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0, 'no draft was saved by status changes');
});
