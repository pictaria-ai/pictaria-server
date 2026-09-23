import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

async function setup(t, options) {
  const fixture = await curatePreviewFixture({ stackSize: 4, singles: 2, metadataReady: true, ...options });
  const browser = await launchChrome(),
    page = await browser.newPage();
  t.after(async () => {
    await browser.stop();
    await fixture.stop();
  });
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (key) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  const ready = () => page.waitFor('!document.querySelector("#refresh").disabled');
  const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate(
    'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
  );
  await page.waitFor('document.querySelector(".group-card") && !document.querySelector("#refresh").disabled');
  return { fixture, page, click, key, ready, operations };
}
async function screenshot(page, name) {
  if (!process.env.PICTARIA_TEST_SCREENSHOTS) return;
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, name), Buffer.from(data, 'base64'));
}

test(
  'stack keyboard drafts, read-only references, latest-group Save & next and exact retry',
  { timeout: 60000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click, key, ready, operations } = await setup(t);
    await click('.is-stack .cover');
    await page.waitFor(
      'document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply-next").disabled',
    );
    assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(1));
    await key('f'); // Focused card, no implicit navigation or save.
    assert.equal(operations(), 0);
    await key('ArrowRight');
    await key('y');
    assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(2));
    await click('#photos .photo-image');
    await page.waitFor('document.querySelector("#photo-view").open');
    await click('[data-stack-choice=favorite]'); // Mouse choice stays put.
    assert.equal(
      await page.evaluate('document.querySelector("#photo-large").src.includes("' + fixture.id(1) + '")'),
      true,
    );
    await key('s');
    assert.match(
      await page.evaluate('document.querySelector("#photo-large").src'),
      new RegExp(fixture.id(2)),
    );
    await key('f');
    await key('y');
    await key('n');
    assert.equal(await page.evaluate('document.querySelector("#photo-view").open'), false);
    assert.equal(operations(), 0, 'last keyboard mark returns to comparison, without saving');
    assert.equal(
      await page.evaluate('document.querySelector("#selection-count").textContent'),
      '1 Yes · 1 Skip · 1 Fav · 1 No',
    );
    await click('#context-photos .photo-image');
    await key('n');
    assert.equal(operations(), 0);
    assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
    await click('[data-close=photo-view]');

    // A future single becomes a stack while this comparison is open. Continue
    // must use the latest complete group instead of the old single's lease.
    const newcomer = fixture.add(2001, 601, 'new-neighbor');
    fixture.repo.curate.mergeMetadataAsset({ ...fixture.assets.find((a) => a.id === newcomer), tags: [] });
    await page.evaluate('document.querySelector("#photos .photo-card").focus()');
    await key('Enter');
    await page.waitFor(
      `document.querySelector('#comparison').open && document.querySelectorAll('#photos .photo-card').length===2 && document.querySelector('#photos [data-photo-id="${fixture.id(1001)}"]') && !document.querySelector('#apply-next').disabled`,
    );
    assert.equal(operations(), 1);
    assert.equal(fixture.repo.curate.photo(fixture.id(2)).state, 'approved');
    assert.ok(fixture.repo.loadAssetTagsFor([fixture.id(2)])[fixture.id(2)].includes('frame/favorite'));
    await page.evaluate(`window.realFetch=fetch;window.fetch=async(...args)=>{
    const result=await realFetch(...args);if(String(args[0]).endsWith('/operations/apply')){
      window.fetch=window.realFetch;throw new TypeError('Synthetic lost acknowledgment');}return result;}`);
    await click('#apply-next');
    await page.waitFor(
      '!document.querySelector("#comparison-recovery").hidden && !document.querySelector("#comparison-retry").disabled',
    );
    const count = operations();
    await key('Enter');
    assert.equal(operations(), count);
    await click('#comparison-retry');
    await page.waitFor(
      `document.querySelector('#photo-view').open && document.querySelector('#photo-large').src.includes('${fixture.id(1002)}') && document.querySelector('#photo-next').disabled && !document.querySelector('#refresh').disabled`,
    );
    assert.equal(operations(), count, 'retry reuses the same operation, including continuation intent');
    await click('[data-close=photo-view]');
    await click('#undo');
    await ready();
    await page.waitFor('document.querySelector(".is-stack")');
    assert.equal(fixture.repo.curate.photo(fixture.id(1001)).state, 'undecided');
  },
);

test(
  'a failed next-view read cannot turn an accepted stack save into a second decision',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click, ready, operations } = await setup(t);
    await click('.is-stack .cover');
    await page.waitFor('!document.querySelector("#apply-next").disabled');
    await click('[data-choice=favorite]');
    await page.evaluate(`window.realFetch=fetch;window.fetch=async(...args)=>{
    if(String(args[0]).endsWith('/groups') && args[1]?.method==='POST') {
      window.fetch=window.realFetch;throw new TypeError('Synthetic next-view failure');}
    return window.realFetch(...args);}`);
    await click('#apply-next');
    await page.waitFor(
      '!document.querySelector("#error").hidden && !document.querySelector("#refresh").disabled',
    );
    assert.equal(operations(), 1);
    assert.match(await page.evaluate('document.querySelector("#error").textContent'), /Choices saved/);
    assert.equal(await page.evaluate('document.querySelector("#recovery").hidden'), true);
    assert.equal(await page.evaluate('document.querySelector("#undo").hidden'), false);
    await click('#refresh');
    await ready();
    assert.equal(operations(), 1);
    await click('#undo');
    await ready();
    assert.equal(fixture.repo.curate.photo(fixture.id(1)).state, 'undecided');
  },
);

test(
  'compact mobile filters, fixed checked bar, member previews and uncropped comparison images',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { page, click, ready } = await setup(t);
    assert.equal(await page.evaluate('document.querySelectorAll(".stack-strip img").length'), 3);
    assert.match(
      await page.evaluate('document.querySelector(".group-caption small").textContent'),
      /\d+:\d+/,
    );
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(
      await page.evaluate('getComputedStyle(document.querySelector("#secondary-filters")).display'),
      'none',
    );
    const top = await page.evaluate('document.querySelector("#groups").getBoundingClientRect().top');
    assert.ok(top < 520, `mobile photos should be visible on the first screen (${top})`);
    await click('#select-shown');
    assert.equal(await page.evaluate('document.querySelector("#groups").getBoundingClientRect().top'), top);
    assert.equal(await page.evaluate('document.querySelector("#bulk-count").textContent'), '2 checked');
    assert.equal(
      await page.evaluate('getComputedStyle(document.querySelector("#bulk-actions")).position'),
      'fixed',
    );
    assert.ok(
      await page.evaluate('document.querySelector("#bulk-actions").getBoundingClientRect().height<160'),
      'the bottom bar must not stretch to the top',
    );
    assert.equal(await page.evaluate('document.body.scrollWidth<=innerWidth'), true);
    await screenshot(page, 'curate-polish-mobile.png');
    await click('#clear-bulk');
    await click('#toggle-filters');
    assert.equal(
      await page.evaluate('getComputedStyle(document.querySelector("#secondary-filters")).display'),
      'flex',
    );
    await page.evaluate(
      'document.querySelector("#sort").value="newest";document.querySelector("#sort").dispatchEvent(new Event("change"))',
    );
    await ready();
    await page.send('Emulation.clearDeviceMetricsOverride');
    await page.evaluate(`window.comparisonRequests=0;const nativeFetch=window.fetch;
      window.fetch=(...args)=>{if(String(args[0]).endsWith('/comparisons'))window.comparisonRequests++;return nativeFetch(...args);}`);
    await click('.is-stack .stack-strip');
    await page.waitFor('!document.querySelector("#apply").disabled');
    assert.equal(await page.evaluate('window.comparisonRequests'), 1, 'thumbnail click must not bubble into a second open');
    // Use local, generated aspect fixtures to measure portrait/landscape fit.
    await page.evaluate(`Promise.all([...document.querySelectorAll('#photos .photo-image img')].map((img,i)=>new Promise(resolve=>{
    img.onload=resolve;const w=i%2?600:1000,h=i%2?900:600;
    img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="#477e91"/><circle cx="50%" cy="45%" r="150" fill="#d9be86"/><text x="50%" y="80%" text-anchor="middle" font-size="42" fill="white">Synthetic photo '+(i+1)+'</text></svg>');
  })))`);
    assert.equal(
      await page.evaluate('getComputedStyle(document.querySelector("#photos img")).objectFit'),
      'contain',
    );
    assert.equal(
      await page.evaluate('getComputedStyle(document.querySelector("#photos .photo-image")).backgroundColor'),
      'rgba(0, 0, 0, 0)',
    );
    await screenshot(page, 'curate-polish-comparison.png');
  },
);

test(
  'Save & next crosses loaded pages and respects remembered newest order',
  { timeout: 60000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click, ready } = await setup(t, { stackSize: 0, singles: 51 });
    const id = fixture.add(2001, 50 * 600 + 1, 'neighbor-at-page-boundary');
    fixture.repo.curate.mergeMetadataAsset({ ...fixture.assets.find((a) => a.id === id), tags: [] });
    await click('#refresh');
    await ready();
    await page.waitFor('document.querySelector(".is-stack")');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 50);
    await click('.is-stack .cover');
    await page.waitFor('!document.querySelector("#apply-next").disabled');
    await click('#apply-next');
    await page.waitFor(
      `document.querySelector('#photo-view').open && document.querySelector('#photo-large').src.includes('${fixture.id(1051)}') && !document.querySelector('#refresh').disabled`,
    );
    await click('#photo-undo');
    await ready();
    await page.evaluate(
      'document.querySelector("#sort").value="newest";document.querySelector("#sort").dispatchEvent(new Event("change"))',
    );
    await ready();
    await click('.is-stack .cover');
    await page.waitFor('!document.querySelector("#apply-next").disabled');
    await click('#apply-next');
    await page.waitFor(
      `document.querySelector('#photo-view').open && document.querySelector('#photo-large').src.includes('${fixture.id(1049)}') && !document.querySelector('#refresh').disabled`,
    );
    assert.equal(await page.evaluate('document.querySelector("#sort").value'), 'newest');
  },
);
