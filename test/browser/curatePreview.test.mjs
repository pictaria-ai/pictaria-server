import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test(
  'Curate preview: complete scopes, stable selections, corrections, conflict and replay',
  { timeout: 90000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture();
    const browser = await launchChrome();
    const page = await browser.newPage();
    t.after(async () => {
      await browser.stop();
      await fixture.stop();
    });
    const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const wait = (expression) => page.waitFor(expression);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await wait('document.querySelector(".gate-backdrop input")');
    await page.evaluate(
      'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
    );
    await wait('document.querySelectorAll(".group-card").length===50 && !document.querySelector("#refresh").disabled');

    await t.test('paging adds cards, search matches whole stack and all 52 members load before save', async () => {
      await click('#more');
      await wait('document.querySelectorAll(".group-card").length===53');
      await page.evaluate(
        'document.querySelector("#search").value="target";document.querySelector("#search").dispatchEvent(new Event("input"))',
      );
      await wait('document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled');
      await click('.group-card');
      await wait(
        'document.querySelectorAll("#photos .photo-card").length===52 && !document.querySelector("#apply").disabled',
      );
      assert.equal(
        await page.evaluate('document.querySelectorAll("#context-photos input,#context-photos select").length'),
        0,
      );
      assert.equal(await page.evaluate('document.querySelectorAll("#context-photos .photo-card").length'), 1);
      await click('[data-keeper="' + fixture.id(1) + '"]');
      await click('[data-keeper="' + fixture.id(52) + '"]');
      assert.equal(await page.evaluate('document.querySelector("#apply").textContent'), 'Keep 2, mark 50 reviewed');
    });
    await t.test('background additions advertise updates without changing open membership or keepers', async () => {
      fixture.add(2000, 900000, 'new-unrelated');
      await wait('!document.querySelector("#updates").hidden');
      assert.equal(await page.evaluate('document.querySelectorAll("#photos .photo-card").length'), 52);
      assert.equal(await page.evaluate('document.querySelectorAll("#photos input:checked").length'), 2);
    });
    await t.test(
      'lost acceptance response recovers after reload using the original payload, then conditional Undo',
      async () => {
        await page.evaluate(
          `window.realFetch=window.fetch;window.fetch=async(...args)=>{const r=await window.realFetch(...args);if(String(args[0]).endsWith('/operations/apply')){window.fetch=window.realFetch;throw new TypeError('Synthetic lost response');}return r;}`,
        );
        await click('#apply');
        await wait(
          '!document.querySelector("#comparison-recovery").hidden && !document.querySelector("#comparison-retry").disabled',
        );
        const operationsBefore = fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
        assert.ok(operationsBefore > 0);
        await page.navigate(`${fixture.base}/curate-preview.html`);
        await wait('!document.querySelector("#recovery").hidden');
        await click('#retry-action');
        await wait('!document.querySelector("#receipt").hidden && !document.querySelector("#refresh").disabled');
        assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, operationsBefore);
        assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
        await click('#undo');
        await wait(
          'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
        );
        await click('.group-card');
        await wait(
          'document.querySelectorAll("#photos .photo-card").length===52 && !document.querySelector("#apply").disabled',
        );
      },
    );
    await t.test('narrow layout keeps all actions reachable; keyboard toggles and modal dismissal work', async () => {
      await page.send('Emulation.setDeviceMetricsOverride', {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      assert.equal(
        await page.evaluate(
          'document.querySelector("#comparison").scrollWidth<=document.querySelector("#comparison").clientWidth',
        ),
        true,
      );
      await page.evaluate('document.querySelector("[data-keeper]").focus()');
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: ' ',
        code: 'Space',
        windowsVirtualKeyCode: 32,
      });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
      assert.equal(await page.evaluate('document.querySelector("[data-keeper]").checked'), true);
      await click('#photos .photo-image');
      await wait('document.querySelector("#photo-view").open');
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await wait('!document.querySelector("#photo-view").open && document.querySelector("#comparison").open');
      await page.send('Emulation.clearDeviceMetricsOverride');
    });
    await t.test('Remove from stack persists; reset is read from current correction state', async () => {
      await click('[data-remove="' + fixture.id(1) + '"]');
      await wait('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');
      assert.equal(fixture.repo.curate.corrections().corrections.length, 1);
      assert.equal(fixture.repo.curate.photo(fixture.id(1)).state, 'undecided');
      await page.navigate(`${fixture.base}/curate-preview.html`);
      await wait('document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled');
      await click('#corrections');
      await wait('document.querySelector(".correction-row button")');
      await click('.correction-row button');
      await wait('!document.querySelector("#correction-dialog").open && !document.querySelector("#refresh").disabled');
      assert.equal(fixture.repo.curate.corrections().corrections.length, 0);
      await click('.group-card');
      await wait(
        'document.querySelectorAll("#photos .photo-card").length===52 && !document.querySelector("#apply").disabled',
      );
      await click('#split');
      await wait('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');
      assert.equal(fixture.repo.curate.corrections().corrections[0].memberCount, 52);
      await click('#undo');
      await wait('!document.querySelector("#refresh").disabled && document.querySelectorAll(".group-card").length===1');
    });
    await t.test('a duplicated tab gets its own view; refreshes do not expire the original tab', async () => {
      const oldSaved = await page.evaluate('sessionStorage.getItem("pictaria.curate.preview")');
      const other = await browser.newPage();
      await other.navigate(`${fixture.base}/`);
      await other.evaluate(`sessionStorage.setItem('pictaria.curate.preview',${JSON.stringify(oldSaved)})`);
      await other.navigate(`${fixture.base}/curate-preview.html`);
      await other.waitFor(
        'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
      );
      const saved = JSON.parse(await other.evaluate('sessionStorage.getItem("pictaria.curate.preview")'));
      assert.notEqual(saved.tabId, JSON.parse(oldSaved).tabId);
      const status = await page.evaluate(
        `(async()=>{const r=await fetch('/api/review/curate/groups?viewId=${JSON.parse(oldSaved).viewId}');return r.status})()`,
      );
      assert.equal(status, 200);
      await click('.group-card');
      await wait(
        'document.querySelectorAll("#photos .photo-card").length===52 && !document.querySelector("#apply").disabled',
      );
      await other.evaluate('document.querySelector("#refresh").click()');
      await other.waitFor('!document.querySelector("#refresh").disabled');
      assert.equal(await page.evaluate('document.querySelector("#apply").disabled'), false);
    });
    await t.test(
      'new human intent conflicts atomically; refresh then zero keepers means reviewed, never Never show',
      async () => {
        fixture.repo.setManualFrameTags({
          assetIds: [fixture.id(1)],
          addTags: ['frame/never-show'],
          removeTags: [],
          action: 'reject',
        });
        await click('#apply');
        await wait(
          '!document.querySelector("#comparison-error").hidden && !document.querySelector("#comparison-refresh").hidden',
        );
        assert.equal(fixture.repo.curate.photo(fixture.id(2)).state, 'undecided');
        await click('#comparison-refresh');
        await wait('!document.querySelector("#refresh").disabled');
        // Search matched only the now-decided first member; clear it explicitly.
        await page.evaluate(
          'document.querySelector("#search").value="portrait";document.querySelector("#search").dispatchEvent(new Event("input"))',
        );
        await wait(
          'document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled',
        );
        await click('.group-card');
        await wait(
          'document.querySelectorAll("#photos .photo-card").length===51 && !document.querySelector("#apply").disabled',
        );
        assert.equal(await page.evaluate('document.querySelector("#apply").textContent'), 'Mark all 51 reviewed');
        await click('#apply');
        await wait('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');
        const tags = fixture.repo.db
          .prepare('SELECT tag FROM asset_tags WHERE asset_id=?')
          .all(fixture.id(2))
          .map((r) => r.tag);
        assert.ok(tags.includes('frame/reviewed'));
        assert.ok(!tags.includes('frame/never-show'));
      },
    );
  },
);
