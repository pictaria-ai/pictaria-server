import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test(
  'Curate choices: explicit four-way drafts, selected-photo actions, stable explanation overlay and contextual settings',
  { timeout: 60000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true });
    const browser = await launchChrome(),
      page = await browser.newPage();
    t.after(async () => {
      await browser.stop();
      await fixture.stop();
    });
    const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const key = (key) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
    const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
    const card = (n) => `#photos [data-photo-id="${fixture.id(n)}"]`;
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate(
      'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
    );
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===2 && !document.querySelector("#refresh").disabled',
    );
    assert.equal(
      await page.evaluate('document.querySelector(".p-gear").getAttribute("href")'),
      '/settings.html#sec-curate',
    );
    assert.equal(await page.evaluate('document.querySelector(".heading a")'), null);
    assert.deepEqual(
      await page.evaluate('[...document.querySelectorAll("[data-quick]")].map(b=>b.textContent)'),
      ['Yes', 'Skip', 'Fav', 'No'],
    );
    assert.doesNotMatch(
      await page.evaluate('document.querySelector("#groups").textContent'),
      /portrait|single-1|\.jpg/,
    );
    await click('.is-stack .cover');
    await page.waitFor(
      'document.querySelectorAll("#photos [data-choice]").length===16 && !document.querySelector("#apply").disabled',
    );
    assert.doesNotMatch(
      await page.evaluate('document.querySelector("#photos").textContent'),
      /portrait|\.jpg/,
    );
    // Hover opens an overlay without changing the photos' position. Escape dismisses
    // only the explanation; keyboard focus and touch have the same access.
    const top = await page.evaluate('document.querySelector("#photos").getBoundingClientRect().top');
    const point = await page.evaluate(
      '(()=>{const r=document.querySelector("#comparison-similarity .why-trigger").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    );
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await page.waitFor('!document.querySelector("#stack-reason").hidden');
    assert.equal(await page.evaluate('document.querySelector("#photos").getBoundingClientRect().top'), top);
    await key('Escape');
    assert.equal(
      await page.evaluate(
        'document.querySelector("#comparison").open && document.querySelector("#stack-reason").hidden',
      ),
      true,
    );
    await page.evaluate('document.querySelector("#comparison-similarity .why-trigger").focus()');
    assert.equal(await page.evaluate('document.querySelector("#stack-reason").hidden'), false);
    await key('Escape');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    const touch = await page.evaluate(
      '(()=>{const r=document.querySelector("#comparison-similarity .why-trigger").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()',
    );
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitFor('!document.querySelector("#stack-reason").hidden');
    assert.equal(
      await page.evaluate(
        '(()=>{const r=document.querySelector("#stack-reason").getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight})()',
      ),
      true,
    );
    await key('Escape');
    await page.send('Emulation.clearDeviceMetricsOverride');
    await click('#select-all');
    assert.equal(await page.evaluate('document.querySelectorAll("[data-compare-select]:checked").length'), 4);
    assert.equal(
      await page.evaluate('document.querySelectorAll("[data-keeper][aria-pressed=true]").length'),
      0,
      'selection alone must not mark Yes',
    );
    await click('[data-comparison-bulk=approve]');
    assert.equal(
      await page.evaluate('document.querySelectorAll("[data-keeper][aria-pressed=true]").length'),
      4,
    );
    await click('#select-none');
    for (const n of [1, 2]) await click(`${card(n)} [data-compare-select]`);
    await click('[data-comparison-bulk=favorite]');
    await click(`${card(2)} [data-choice=reject]`);
    await click(`${card(3)} [data-choice=reviewed]`);
    assert.equal(
      await page.evaluate('document.querySelector("#selection-count").textContent'),
      '1 Yes · 1 Skip · 1 Fav · 1 No',
    );
    assert.equal(operations(), 0, 'stack choices remain a draft until Save');
    await click(`${card(1)} .photo-image`);
    await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
    assert.deepEqual(
      await page.evaluate('[...document.querySelectorAll("[data-stack-choice]")].map(b=>b.textContent)'),
      ['Yes (Y)', 'Skip (S)', 'Fav (F)', 'No (N)'],
    );
    assert.equal(
      await page.evaluate(
        'document.querySelector("[data-stack-choice=favorite]").getAttribute("aria-pressed")',
      ),
      'true',
    );
    await key('s');
    assert.equal(
      await page.evaluate(
        `document.querySelector('${card(1)} [data-choice=reviewed]').getAttribute('aria-pressed')`,
      ),
      'true',
    );
    await key('ArrowLeft'); // A keyboard mark advanced to photo 2.
    await key('f');
    assert.equal(operations(), 0);
    assert.doesNotMatch(
      await page.evaluate('document.querySelector("#photo-view").innerText'),
      /target-portrait|\.jpg/,
    );
    await click('#back-comparison');
    await click('#apply');
    await page.waitFor(
      '!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled',
    );
    const tags = fixture.repo.loadAssetTagsFor([1, 2, 3, 4].map(fixture.id));
    assert.ok(tags[fixture.id(1)].includes('frame/favorite'));
    assert.ok(tags[fixture.id(2)].includes('frame/never-show'));
    assert.ok(tags[fixture.id(3)].includes('frame/reviewed'));
    assert.ok(!tags[fixture.id(3)].includes('frame/eligible'));
    assert.ok(tags[fixture.id(4)].includes('frame/eligible'));
    assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
    assert.equal(operations(), 1, 'the complete four-photo stack is one decision');
    await click('.p-gear');
    await page.waitFor('location.hash==="#sec-curate" && document.querySelector("#sec-curate")?.open');
    await page.waitFor(
      'document.querySelector("#sec-curate").textContent.includes("Group photos into Stacks")',
    );
    assert.match(
      await page.evaluate('document.querySelector("#sec-curate").textContent'),
      /Groups similar photos using capture time/,
    );
    await page.navigate(`${fixture.base}/enrich.html`);
    await page.waitFor(
      'document.querySelector(".p-gear")?.getAttribute("href")==="/settings.html#sec-enrich"',
    );
  },
);
