import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test(
  'unified Curate: image inspection, single keyboard decisions, Undo, recovery, bulk scope and Decided',
  { timeout: 60000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 3, singles: 3 }),
      browser = await launchChrome(),
      page = await browser.newPage();
    t.after(async () => {
      await browser.stop();
      await fixture.stop();
    });
    const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = (expression) => page.waitFor(expression);
    const key = async (key, more = {}) =>
      page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...more });
    const photo = (id) =>
      `document.querySelector('#photo-large').getAttribute('src').includes('${fixture.id(id)}')`;
    const ready = () => wait('!document.querySelector("#refresh").disabled');
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await wait('document.querySelector(".gate-backdrop input")');
    await page.evaluate(
      'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
    );
    await wait(
      'document.querySelectorAll(".group-card").length===4 && !document.querySelector("#refresh").disabled',
    );
    assert.equal(await page.evaluate('document.querySelectorAll(".is-stack [data-select]").length'), 0);
    // Images enlarge; explicit choices update drafts. Y never commits a stack member.
    await click('.is-stack .cover');
    await wait(
      'document.querySelectorAll("#photos [data-keeper]").length===3 && !document.querySelector("#apply").disabled',
    );
    await click('#photos .photo-image');
    await wait('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'), 0);
    await key('y');
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
    assert.equal(await page.evaluate('document.querySelector("#photo-undo-hint").hidden'), true, 'drafts never announce a save');
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'), 1); // Y changes only the draft
    await key('ArrowLeft'); // Y advanced; browse back before changing that draft.
    await key('s');
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'), 0);
    await click('#back-comparison');
    await click('[data-close=comparison]');
    // Full-height desktop image and side information, followed by explicit save/advance.
    await click('.group-card:not(.is-stack) .cover');
    await wait(`document.querySelector('#photo-view').open && ${photo(1001)}`);
    assert.equal(
      await page.evaluate(
        'Math.round(document.querySelector("#photo-view").getBoundingClientRect().height)===innerHeight',
      ),
      true,
    );
    const before = fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
    await key('Y', { modifiers: 2 }); // Ctrl-Y is never a decision
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, before);
    await key('y');
    await wait(`${photo(1002)} && !document.querySelector('[data-photo-action=approve]').disabled`);
    assert.ok(fixture.repo.loadAssetTagsFor([fixture.id(1001)])[fixture.id(1001)].includes('frame/eligible'));
    await wait('!document.querySelector("#photo-undo-hint").hidden');
    assert.match(await page.evaluate('document.querySelector("#photo-undo-hint").textContent'), /Saved.*Z to undo/);
    const lightboxLayout = () => page.evaluate(`['.lightbox-stage','.lightbox-side','#photo-large'].map(s=>{
      const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height];
    })`);
    const beforeHintFades = await lightboxLayout();
    assert.equal(await page.evaluate(`(()=>{
      const hint=document.querySelector('#photo-undo-hint').getBoundingClientRect(),
        stage=document.querySelector('.lightbox-stage').getBoundingClientRect();
      return hint.left>=stage.left && hint.right<=stage.right && hint.bottom<=stage.bottom &&
        stage.bottom-hint.bottom<30;
    })()`), true, 'reminder is visible at the bottom of the modal image area');
    await wait('document.querySelector("#photo-undo-hint").hidden');
    assert.deepEqual(await lightboxLayout(), beforeHintFades, 'reminder cannot resize or move the photo');
    assert.equal(await page.evaluate('document.querySelector("#photo-undo").disabled'), false, 'Undo outlives its brief reminder');
    await click('[data-close=photo-view]');
    await click('#dismiss-receipt');
    assert.equal(await page.evaluate('document.querySelector("#receipt").hidden'), true);
    await click('.group-card:not(.is-stack) .cover');
    await wait(`${photo(1002)} && !document.querySelector('[data-photo-action=approve]').disabled`);
    // Dismissing the main-page feedback must leave the same keyboard Undo available.
    await key('z');
    await wait(`${photo(1001)} && !document.querySelector('[data-photo-action=approve]').disabled`);
    assert.ok(
      !(fixture.repo.loadAssetTagsFor([fixture.id(1001)])[fixture.id(1001)] || []).includes('frame/eligible'),
    );
    assert.equal(await page.evaluate('document.querySelector("#photo-undo-hint").hidden'), true);
    // Lost acceptance stays on the current photo and replays the same operation.
    await page.evaluate(`window.realFetch=window.fetch;window.fetch=async(...args)=>{
    const r=await window.realFetch(...args);if(String(args[0]).endsWith('/operations/apply')){
      window.fetch=window.realFetch;throw new TypeError('Synthetic lost response');}return r;}`);
    await key('f');
    await wait(
      '!document.querySelector("#photo-recovery").hidden && !document.querySelector("#photo-retry").disabled',
    );
    assert.equal(await page.evaluate(photo(1001)), true);
    assert.equal(await page.evaluate('document.querySelector("#photo-undo-hint").hidden'), true, 'uncertain acceptance must not advertise Undo');
    const operations = fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
    await key('n'); // unresolved response locks further decisions
    await click('#photo-retry');
    await wait(`${photo(1002)} && !document.querySelector('[data-photo-action=approve]').disabled`);
    assert.equal(await page.evaluate('document.querySelector("#photo-undo-hint").hidden'), false, 'a new accepted save starts another reminder');
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, operations);
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(await page.evaluate('document.querySelector("#photo-view").scrollWidth<=innerWidth'), true);
    assert.equal(await page.evaluate(`(()=>{
      const r=document.querySelector('#photo-undo-hint').getBoundingClientRect();
      return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight;
    })()`), true);
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const {data}=await page.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS,'curate-undo-hint-mobile.png'),Buffer.from(data,'base64'));
    }
    assert.equal(
      await page.evaluate(
        'document.querySelector(".lightbox-side").getBoundingClientRect().top >= document.querySelector(".lightbox-stage").getBoundingClientRect().bottom - 1',
      ),
      true,
    );
    await click('[data-close=photo-view]');
    assert.equal(await page.evaluate(`(()=>{
      const bar=document.querySelector('#receipt').getBoundingClientRect(),
        dismiss=document.querySelector('#dismiss-receipt').getBoundingClientRect();
      return bar.right<=innerWidth && Math.abs(bar.right-dismiss.right-11)<1 &&
        dismiss.left>=bar.left && dismiss.top>=bar.top && dismiss.bottom<=bar.bottom;
    })()`), true, 'dismiss stays on the right edge when receipt text wraps on mobile');
    await click('#dismiss-receipt');
    await click('#refresh');
    await ready();
    assert.equal(await page.evaluate('document.querySelector("#receipt").hidden'), true, 'refresh does not reshow dismissed feedback');
    assert.equal(await page.evaluate('document.querySelector("#undo").disabled'), false);
    await page.send('Emulation.clearDeviceMetricsOverride');
    // All keeps individual single-photo checks, without a select-all control.
    // Selecting those singles never includes the stack; the batch is atomic/undoable.
    assert.equal(await page.evaluate('document.querySelector("#bulk-label").hidden'), true);
    await page.evaluate('document.querySelectorAll(".group-card:not(.is-stack) [data-select]").forEach(input=>input.click())');
    assert.equal(
      await page.evaluate('document.querySelector("#bulk-count").textContent'),
      '2 checked',
    );
    await click('[data-bulk=reviewed]');
    await wait(
      'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
    );
    assert.equal(await page.evaluate('document.querySelector("#receipt").hidden'), false, 'the next saved action shows fresh feedback');
    assert.ok(
      !(fixture.repo.loadAssetTagsFor([fixture.id(1)])[fixture.id(1)] || []).includes('frame/reviewed'),
    );
    await click('#undo');
    await wait(
      'document.querySelectorAll(".group-card").length===3 && !document.querySelector("#refresh").disabled',
    );
    await click('[data-section=decided]');
    await ready();
    assert.equal(await page.evaluate('document.querySelector("#filters").hidden'), true);
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 2);
    await click(`.group-card[data-group-id="single:decided:${fixture.id(1001)}"] .cover`);
    await wait(`document.querySelector('#photo-view').open && ${photo(1001)}`);
    assert.equal(await page.evaluate('document.querySelector("#photo-outcome").textContent'), 'Current: Fav');
    assert.match(await page.evaluate('document.querySelector("#photo-position").textContent'), /^\d+ of \d+ photos$/);
    assert.equal(await page.evaluate(`document.querySelector('.group-card[data-group-id="single:decided:${fixture.id(1001)}"] .p-chip').hidden`), true);
    assert.equal(await page.evaluate(`document.querySelector('.group-card[data-group-id="single:decided:${fixture.id(1001)}"] [aria-pressed=true]').dataset.quick`), 'favorite');
    assert.equal(await page.evaluate('document.querySelector("[data-photo-action=approve]").classList.contains("primary")'), false);
    await key('n');
    await wait(
      `${photo(1001)} && !document.querySelector('[data-photo-action=approve]').disabled && document.querySelector('.group-card[data-group-id="single:decided:${fixture.id(1001)}"] [data-quick=reject]').getAttribute('aria-pressed')==='true'`,
    );
    // Re-open waits for the accepted decision; an older matching image is not completion.
    await wait('!document.querySelector("#photo-undo").disabled');
    assert.ok(
      fixture.repo.loadAssetTagsFor([fixture.id(1001)])[fixture.id(1001)].includes('frame/never-show'),
    );
    await key('z');
    await wait(
      'document.querySelector("#receipt-text").textContent.startsWith("Undid") && !document.querySelector("#refresh").disabled',
    );
    assert.ok(fixture.repo.loadAssetTagsFor([fixture.id(1001)])[fixture.id(1001)].includes('frame/favorite'));
  },
);

test(
  'single lightbox keeps nearby kept references read-only; Undo after refresh restores the current view',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 1, singles: 0, metadataReady: true }),
      browser = await launchChrome(),
      page = await browser.newPage();
    t.after(async () => {
      await browser.stop();
      await fixture.stop();
    });
    const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate(
      'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
    );
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
    );
    await click('.group-card .cover');
    await page.waitFor(
      'document.querySelector("#photo-view").open && !document.querySelector("#photo-context").hidden',
    );
    await click('.reference-photo');
    await page.waitFor('!document.querySelector("#back-pending-photo").hidden');
    assert.equal(await page.evaluate('document.querySelector("#single-actions").hidden'), true);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n' });
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
    await click('#back-pending-photo');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's' });
    await page.waitFor(
      '!document.querySelector("#photo-view").open && document.querySelectorAll(".group-card").length===0 && !document.querySelector("#refresh").disabled',
    );
    await click('#refresh');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    await click('#undo');
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
    );
    assert.ok(
      fixture.repo.loadAssetTagsFor([fixture.contextId])[fixture.contextId].includes('frame/eligible'),
    );
    assert.ok(
      !(fixture.repo.loadAssetTagsFor([fixture.id(1)])[fixture.id(1)] || []).includes('frame/reviewed'),
    );
  },
);

test(
  'loaded single selection does not grow on pagination; keyboard flow crosses a page into a stack',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 0, singles: 51 }),
      browser = await launchChrome(),
      page = await browser.newPage();
    fixture.add(2001, 51 * 600 + 1, 'last-stack-1'); // candidate merges with final single
    // This test exercises navigation, not an initial metadata refresh racing Save.
    // Material-input conflicts are covered separately; settle this fixture first.
    for (const asset of fixture.assets) fixture.repo.curate.mergeMetadataAsset({
      ...asset, tags: asset.id === fixture.contextId ? [{ id: 'frame/eligible', value: 'frame/eligible' }] : [],
    });
    t.after(async () => {
      await browser.stop();
      await fixture.stop();
    });
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate(
      'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
    );
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===50 && !document.querySelector("#refresh").disabled',
    );
    await page.evaluate(
      'document.querySelectorAll(".group-card [data-select]").forEach(input=>input.click());document.querySelector("#more").click()',
    );
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===51 && !document.querySelector("#refresh").disabled',
    );
    assert.equal(await page.evaluate('document.querySelectorAll("[data-select]:checked").length'), 50);
    await page.evaluate(
      'document.querySelector("#clear-bulk").click();document.querySelectorAll(".group-card .cover")[49].click()',
    );
    await page.waitFor(
      'document.querySelector("#photo-view").open && !document.querySelector("[data-photo-action=reviewed]").disabled',
    );
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's' });
    await page.waitFor(
      'document.querySelector("#comparison").open && !document.querySelector("#photo-view").open && document.querySelectorAll("#photos [data-keeper]").length===2',
    );
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'), 0);
  },
);
