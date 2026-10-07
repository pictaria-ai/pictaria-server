import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

async function setup(t) {
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 3, singles: 2, metadataReady: true,
    prepare({ repo, assets }) {
      for (const asset of assets) {
        asset.thumbhash = Buffer.alloc(21, 0).toString('base64');
        repo.updateAssetVisuals(asset.id, { thumbhash: asset.thumbhash });
      }
    },
  }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)}); const menu=button.closest("details.photo-options"); if(menu) menu.open=true; button.click();})()`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===3 && !document.querySelector("#refresh").disabled');
  return { fixture, page, click };
}

test('an idle expired Curate view renews without reloading the tab or disabling cards', { timeout: 30000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const { fixture, page, click } = await setup(t);
  await click('.is-stack .cover');
  await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
  await click('[data-close=comparison]');
  const viewId = await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId');
  // Exercise real expiry without keeping the suite asleep for thirty minutes.
  fixture.repo.db.prepare('UPDATE curate_leases SET expires_at=? WHERE id=?').run(Date.now() - 1, viewId);
  await page.waitFor(`JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).viewId!==${JSON.stringify(viewId)} && !document.querySelector('#refresh').disabled`);
  assert.equal(await page.evaluate('[...document.querySelectorAll(".group-card .cover")].some(b=>b.disabled)'), false);
  await click('.is-stack .cover');
  await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
  await click('[data-close=comparison]');
  await click('.group-card:not(.is-stack) .cover');
  await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});

test('a late expired-view response cannot disable its healthy replacement', { timeout: 30000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const { page, click } = await setup(t);
  const viewId = await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId');
  await page.evaluate(`const originalFetch=fetch;window.fetch=(input,options)=>{
    if(String(input).endsWith('/groups/status') && JSON.parse(options.body).viewId===${JSON.stringify(viewId)}) {
      window.fetch=originalFetch;window.heldStatus=true;
      return new Promise(resolve=>{window.releaseStatus=()=>{
        const response=new Response(null,{status:409});
        response.json=async()=>{
          setTimeout(()=>{window.expiredStatusProcessed=true;},0);
          return {error:{code:'curate_expired',message:'Expired old view'}};
        };
        resolve(response);
      };});
    }
    return originalFetch(input,options);
  }`);
  await page.waitFor('window.heldStatus');
  await click('#refresh');
  await page.waitFor(`JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).viewId!==${JSON.stringify(viewId)} && !document.querySelector('#refresh').disabled`);
  await page.evaluate('window.releaseStatus()');
  // Wait for the catch handler, rather than racing the released response.
  await page.waitFor('window.expiredStatusProcessed');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .cover").disabled'), false);
  await click('.is-stack .cover');
  await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
  assert.equal(await page.evaluate('document.querySelector("#updates-copy").textContent.includes("expired")'), false);
});

test('expiry keeps an open draft intact and renews after the comparison closes', { timeout: 30000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const { fixture, page, click } = await setup(t);
  await click('.is-stack .cover');
  await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
  await click('#photos [data-choice=favorite]');
  const choices = await page.evaluate('[...document.querySelectorAll("#photos [aria-pressed=true]")].map(b=>b.dataset.choice)');
  const viewId = await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId');
  fixture.repo.db.prepare('UPDATE curate_leases SET expires_at=? WHERE id=?').run(Date.now() - 1, viewId);
  await page.waitFor('document.querySelector("#updates-copy").textContent.includes("finish reviewing")');
  assert.equal(await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId'), viewId);
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#photos [aria-pressed=true]")].map(b=>b.dataset.choice)'), choices);
  assert.equal(await page.evaluate('document.querySelector("#comparison").open'), true);
  await click('[data-close=comparison]');
  await page.waitFor(`JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).viewId!==${JSON.stringify(viewId)} && !document.querySelector('#refresh').disabled`);
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});

test('expiry preserves checked singles until cleared, then renews the view', { timeout: 30000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const { fixture, page, click } = await setup(t);
  await click('.group-card [data-select]');
  const viewId = await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId');
  fixture.repo.db.prepare('UPDATE curate_leases SET expires_at=? WHERE id=?').run(Date.now() - 1, viewId);
  await page.waitFor('document.querySelector("#updates-copy").textContent.includes("finish reviewing")');
  assert.equal(await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId'), viewId);
  assert.equal(await page.evaluate('document.querySelector(".group-card [data-select]").checked'), true);
  assert.equal(await page.evaluate('document.querySelector("#clear-bulk").disabled'), false);
  await click('#clear-bulk');
  await page.waitFor(`JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).viewId!==${JSON.stringify(viewId)} && !document.querySelector('#refresh').disabled`);
  await click('.group-card:not(.is-stack) .cover');
  await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
});
