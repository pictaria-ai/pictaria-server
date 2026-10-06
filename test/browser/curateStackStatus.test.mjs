import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

// PIC-371. Synthetic API states only: a single photo kept apart, and the
// keeper slot that the Photo Referee (PIC-116) will fill. The server suites
// exercise the real reason codes and referee states.
test('a kept-apart single and suggested keepers show in the grid, the open stack and Why', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  await page.evaluate(`const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args), url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.updatesAvailable=false;body.refinement={state:'idle',remainingGroups:0};
        for(const group of body.groups){
          group.similarity=null;
          if(group.memberCount>1){group.route='candidate-supported';group.stackReferee={state:'skipped',reason:'supported-by-grouping'};group.photoReferee={state:'complete',keepers:2};}
          else group.reasons=['people-apart'];
        }
      }
      if(url.endsWith('/comparisons')){
        body.similarity=null;
        if(body.ids.length>1){body.route='candidate-supported';body.reasons=['embedding-near'];body.stackReferee={state:'skipped',reason:'supported-by-grouping'};
          body.photoReferee={state:'complete',keepers:2};body.photoRecommendations={state:'complete',keeperIds:body.ids.slice(1,3)};}
        else{body.reasons=['people-apart'];body.nearby=2;}
      }
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  await click('#refresh');
  await page.waitFor('document.querySelector(".is-stack .keeper-star") && document.querySelector(".group-card:not(.is-stack)")?.dataset.badge==="apart"');
  assert.equal(await page.evaluate('document.querySelector(".is-stack").dataset.badge'), 'checked');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .keeper-star").getAttribute("aria-label")'), '2 keepers suggested');
  assert.equal(await text('.is-stack .keeper-star'), '★2');
  assert.equal(await text('.is-stack .stack-count'), '4 photos');
  assert.equal(await text('.group-card:not(.is-stack) .p-chip'), null);
  assert.equal(await page.evaluate('document.querySelector(".group-card:not(.is-stack) .stack-badge").getAttribute("aria-label")'), 'Kept apart');
  assert.equal(await text('#refinement'), '', 'checked and kept-apart cards need no header count');

  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && document.querySelector("#comparison-similarity .stack-badge")');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#photos .photo-card")].map(c=>c.classList.contains("suggested"))'),
    [false, true, true, false], 'stars sit on the suggested photos');
  assert.match(await page.evaluate('document.querySelector("#photos .suggested .photo-image").getAttribute("aria-label")'), /suggested keeper/);
  await click('#comparison-similarity .why-trigger');
  assert.match(await text('#stack-reason .why-steps'), /Grouping: done.*AI check: not needed.*Keepers: 2 suggested/);
  assert.match(await text('#stack-reasons'), /Embeddings.*Very similar/);
  if (process.env.PICTARIA_TEST_SCREENSHOTS) {
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-keepers-why.png'), Buffer.from(data, 'base64'));
  }
  await click('[data-close=comparison]');
  await page.waitFor('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');

  await click('.group-card:not(.is-stack) .cover');
  await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-reason .why-trigger") && !document.querySelector("#photo-reason").hidden');
  assert.equal(await text('#photo-reason .why-trigger'), 'Kept apart');
  await click('#photo-reason .why-trigger');
  assert.match(await text('#single-reason'), /Why this photo\?Kept apart/);
  assert.match(await text('#single-reasons'), /PeopleDifferent people from some nearby photos/);
  assert.match(await text('#single-reasons'), /Taken2 other photos at the same time/);
  assert.equal(await page.evaluate('document.querySelector("#single-reason .why-steps")'), null, 'single photos have no process strip');
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});
