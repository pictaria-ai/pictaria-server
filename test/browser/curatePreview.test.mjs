import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('Curate preview date order is global and remembered across automatic updates', { timeout: 60000 }, async (t) => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 3, singles: 52, metadataReady: true,
    prepare({ repo, assets, id }) {
      // Sorting must not race an unrelated unconfirmed -> supported route change.
      // A locally resolved small stack needs no similarity searches.
      for (let i = 1; i <= 3; i++) {
        const thumbhash = Buffer.alloc(21, 0).toString('base64');
        repo.updateAssetVisuals(id(i), { thumbhash });
        assets.find(a => a.id === id(i)).thumbhash = thumbhash;
      }
    },
  });
  const browser = await launchChrome(),
    page = await browser.newPage();
  t.after(async () => {
    await browser.stop();
    await fixture.stop();
  });
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const sort = (value) =>
    page.evaluate(
      `document.querySelector('#sort').value=${JSON.stringify(value)};document.querySelector('#sort').dispatchEvent(new Event('change'))`,
    );
  const cards = () => page.evaluate('[...document.querySelectorAll(".group-card")].map(c=>c.dataset.groupId)');
  const ready = (count) =>
    page.waitFor(
      `document.querySelectorAll('.group-card').length===${count} && !document.querySelector('#refresh').disabled`,
    );
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate(
    'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
  );
  await ready(50);
  assert.equal(await page.evaluate('document.querySelector("#sort").value'), 'oldest');
  await click('#more');
  await ready(53);
  const original = await cards();
  await sort('newest');
  await ready(50);
  assert.deepEqual(await cards(), [...original].reverse().slice(0, 50));
  await click('#more');
  await ready(53);
  assert.deepEqual(await cards(), [...original].reverse());
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await ready(50);
  assert.equal(await page.evaluate('document.querySelector("#sort").value'), 'newest');
  assert.deepEqual(await cards(), [...original].reverse().slice(0, 50));
  fixture.add(3000, 900000, 'latest-arrival');
  await page.waitFor(`document.querySelector('.group-card').dataset.groupId.includes('${fixture.id(3000)}') && !document.querySelector('#refresh').disabled`);
  await ready(50);
  assert.match((await cards())[0], new RegExp(fixture.id(3000)));
  await click('[data-kind=stacks]');
  await ready(1);
  assert.equal((await cards())[0], original[0]);
  await click('[data-kind=singles]');
  await ready(50);
  assert.match((await cards())[0], new RegExp(fixture.id(3000)));
  await page.evaluate(
    'document.querySelector("#search").value="single-52";document.querySelector("#search").dispatchEvent(new Event("input"))',
  );
  await ready(1);
  assert.match((await cards())[0], new RegExp(fixture.id(1052)));
  await page.evaluate(
    'document.querySelector("#search").value="";document.querySelector("#search").dispatchEvent(new Event("input"))',
  );
  await ready(50);
  // A failed sort replacement must not label old cards as the new order.
  await page.evaluate(`window.realFetch=window.fetch;window.fetch=(input,options)=>{
    if(String(input).endsWith('/curate/groups') && options?.method==='POST') {
      window.fetch=window.realFetch;
      return Promise.resolve(new Response(JSON.stringify({error:{message:'Sort temporarily unavailable'}}),{status:503}));
    }
    return window.realFetch(input,options);
  }`);
  const before = await cards();
  await sort('oldest');
  await page.waitFor('!document.querySelector("#error").hidden && !document.querySelector("#refresh").disabled');
  assert.equal(await page.evaluate('document.querySelector("#sort").value'), 'newest');
  assert.deepEqual(await cards(), before);
  await click('#refresh');
  await ready(50);
  await click('.group-card');
  await page.waitFor('!document.querySelector("#apply").disabled');
  await click('[data-photo-action=reviewed]');
  await ready(49);
  assert.equal(await page.evaluate('document.querySelector("#sort").value'), 'newest');
  assert.match((await cards())[0], new RegExp(fixture.id(1052)));
  await click('#photo-undo');
  await ready(50);
  await click('[data-close=photo-view]');
  assert.match((await cards())[0], new RegExp(fixture.id(3000)));
  await sort('oldest');
  await ready(50);
  assert.match((await cards())[0], new RegExp(fixture.id(1001)));
});

test(
  'Curate preview singles, read-only viewer, open conflicts and immediate re-entry',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 3, singles: 2 });
    const browser = await launchChrome(),
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
      'document.querySelectorAll(".group-card").length===3 && !document.querySelector("#refresh").disabled',
    );
    await click('.group-card');
    await page.waitFor(
      'document.querySelectorAll("#photos .photo-card").length===3 && !document.querySelector("#apply").disabled',
    );
    await page.evaluate(
      'document.querySelector("[data-close=comparison]").click();document.querySelector(".group-card").click()',
    );
    await page.waitFor(
      'document.querySelectorAll("#photos .photo-card").length===3 && !document.querySelector("#apply").disabled',
    );
    await click('#context-photos [data-view]');
    assert.equal(await page.evaluate('document.querySelector("#photo-keep").hidden'), true);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK' });
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'), 0);
    await click('[data-close=photo-view]');
    await click('[data-close=comparison]');
    fixture.repo.setManualFrameTags({
      assetIds: [fixture.id(1)],
      addTags: ['frame/reviewed'],
      removeTags: [],
      action: 'reviewed',
    });
    await click('.group-card');
    await page.waitFor('!document.querySelector("#comparison-error").hidden');
    assert.equal(await page.evaluate('document.querySelector("#comparison-state").textContent'), '');
    assert.equal(await page.evaluate('document.querySelector("#apply").textContent'), 'Refresh to continue');
    await click('#comparison-refresh');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    await click('[data-kind=singles]');
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===2 && !document.querySelector("#refresh").disabled',
    );
    await click('.group-card');
    await page.waitFor(
      'document.querySelectorAll("#photos .photo-card").length===1 && !document.querySelector("#apply").disabled',
    );
    for (const id of ['select-all', 'select-none'])
      assert.equal(await page.evaluate(`document.getElementById('${id}').hidden`), true);
    assert.equal(await page.evaluate('document.querySelector("#apply").textContent'), 'Save');
    assert.equal(await page.evaluate('document.querySelector("#apply").classList.contains("primary")'), false);
    await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
    await click('[data-photo-action=approve]');
    await page.waitFor('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');
    assert.ok(fixture.repo.loadAssetTagsFor([fixture.id(1001)])[fixture.id(1001)].includes('frame/eligible'));
  },
);

test(
  'Curate preview: complete scopes, stable selections, simple controls, conflict and replay',
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

    // This scenario exercises human decisions on stable inputs. On slower hosts
    // initial metadata can change between the two comparison-page reads, which
    // correctly rejects the open as stale. Wait for the fixture's pending photos
    // to finish refreshing instead of relying on the machine beating that race.
    const deadline = Date.now() + 15000;
    while (fixture.repo.db.prepare(`SELECT 1 FROM curate_photos p
      LEFT JOIN curate_metadata m ON m.asset_id=p.asset_id
      WHERE p.state='undecided' AND (m.outcome IS NULL OR m.outcome<>'refreshed') LIMIT 1`).get()) {
      assert.ok(Date.now() < deadline, 'initial fixture metadata did not finish');
      await delay(50);
    }
    await click('#refresh');
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
      assert.equal(await page.evaluate('document.querySelector("#photos").classList.contains("compact")'), true);
      assert.equal(await page.evaluate('document.querySelector("#apply").classList.contains("primary")'), false);
      assert.equal(
        await page.evaluate('document.querySelectorAll("#context-photos input,#context-photos select").length'),
        0,
      );
      assert.equal(await page.evaluate('document.querySelectorAll("#context-photos .photo-card").length'), 1);
      await click('[data-keeper="' + fixture.id(1) + '"]');
      await click('[data-keeper="' + fixture.id(52) + '"]');
      assert.equal(await page.evaluate('document.querySelector("#selection-count").textContent'), '2 Yes · 50 Skip');
    });
    await t.test('background additions advertise updates without changing open membership or keepers', async () => {
      fixture.add(2000, 900000, 'new-unrelated');
      await wait('!document.querySelector("#updates").hidden');
      assert.equal(await page.evaluate('document.querySelectorAll("#photos .photo-card").length'), 52);
      assert.equal(
        await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'),
        2,
      );
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
        assert.match(
          await page.evaluate('document.querySelector("#receipt-text").textContent'),
          /Undid choices for 52 photos/,
        );
        assert.match(await page.evaluate('document.querySelector("#sync").textContent'), /Undo/);
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
      assert.equal(await page.evaluate('document.querySelector("[data-keeper]").getAttribute("aria-pressed")'), 'true');
      await click('#photos [data-view]');
      await wait('document.querySelector("#photo-view").open && !document.querySelector("#photo-keep").disabled');
      await page.evaluate('document.querySelector("#photo-keep").focus()');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK' });
      await wait(`!document.querySelector('#photo-keep').disabled && document.querySelector('#photo-large').src.includes('${fixture.id(2)}')`);
      assert.equal(await page.evaluate('document.querySelector("#photo-keep").getAttribute("aria-pressed")'), 'false');
      // K already advanced to the next actionable photo.
      await click('#photo-keep');
      assert.equal(
        await page.evaluate('document.querySelectorAll("#photos [data-keeper][aria-pressed=true]").length'),
        1,
      );
      await click('[data-stack-choice=favorite]');
      assert.equal(
        await page.evaluate('document.querySelectorAll("#photos .photo-card")[1].querySelector("[data-choice=favorite]").getAttribute("aria-pressed")'),
        'true',
      );
      await page.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        windowsVirtualKeyCode: 27,
      });
      await wait('!document.querySelector("#photo-view").open && document.querySelector("#comparison").open');
      await page.send('Emulation.clearDeviceMetricsOverride');
    });
    await t.test('stack management is absent while decisions and read-only explanations remain', async () => {
      assert.equal(await page.evaluate('document.querySelector("#photo-remove,#split,#corrections,#correction-dialog")'), null);
      assert.equal(await page.evaluate('document.querySelector(".why-trigger")!==null'), true);
      assert.equal(fixture.repo.curate.corrections().corrections.length, 0);
      await click('[data-close=comparison]');
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
        assert.equal(await page.evaluate('document.querySelector("#selection-count").textContent'), '51 Skip');
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
