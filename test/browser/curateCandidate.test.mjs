import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

test('hash-supported stack updates automatically after closing, without changing an open selection',
  { timeout: 60000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = await curatePreviewFixture({ stackSize: 4, singles: 0, metadataReady: true,
      prepare(fixture) {
      for (let i = 0; i < 4; i++) {
        const id = fixture.id(i + 1), thumbhash = Buffer.alloc(21, 0).toString('base64');
        fixture.repo.updateAssetVisuals(id, { thumbhash }); fixture.assets.find(a => a.id === id).thumbhash = thumbhash;
        const partner = fixture.id(i % 2 ? i : i + 2);
        const items = [{ id: partner, type: 'IMAGE' }, ...Array.from({ length: 49 }, (_, n) => ({ id: `outside-${n}`, type: 'IMAGE' }))];
        fixture.similarityResponses.set(id, async () => {
        if (i === 0) await gate;
        return { status: 200, body: { assets: { items } } };
      });
      }
      },
    });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { release(); await browser.stop(); await fixture.stop(); });
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled');
    await click('.group-card');
    await page.waitFor('document.querySelectorAll("#photos [data-keeper]").length===4 && !document.querySelector("#apply").disabled');
    await click('[data-keeper]');
    release();
    await page.waitFor('!document.querySelector("#updates").hidden && !document.querySelector("#refinement").textContent', { timeoutMs: 35000 });
    assert.equal(fixture.similarityReads.length, 4, 'local ThumbHash support cannot suppress necessary verification');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos .selected").length'), 1);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper]").length'), 4);
    await click('[data-close=comparison]');
    await page.waitFor('document.querySelectorAll(".group-card").length===2 && !document.querySelector("#refresh").disabled');
    await click('.group-card');
    await page.waitFor('document.querySelectorAll("#photos [data-keeper]").length===2 && !document.querySelector("#apply").disabled');
    await click('#comparison-similarity .why-trigger');
    assert.match(await page.evaluate('document.querySelector("#stack-reasons").textContent'), /contrast outweighs/);
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
  });

test('candidate preview refines automatically, preserves selections, explains results and saves multiple keepers',
  { timeout: 60000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const fixture = await curatePreviewFixture({ stackSize: 5, singles: 0, metadataReady: true,
      prepare(fixture) {
      const matrix = [[null,3,5,1,2], [2,null,1,3,4], [9,2,null,23,8], [1,3,5,null,2], [1,6,5,2,null]];
      for (let i = 0; i < 5; i++) {
        const id = fixture.id(i + 1), thumbhash = Buffer.alloc(21, i * 45).toString('base64');
        fixture.repo.updateAssetVisuals(id, { thumbhash }); fixture.assets.find(a => a.id === id).thumbhash = thumbhash;
        const items = Array.from({ length: 50 }, (_, j) => ({ id: `outside-${i}-${j}`, type: 'IMAGE' }));
        matrix[i].forEach((rank, j) => { if (rank) items[rank - 1] = { id: fixture.id(j + 1), type: 'IMAGE' }; });
        fixture.similarityResponses.set(id, async () => {
        if (i === 0) await gate;
        return { status: 200, body: { assets: { items } } };
      });
      }
      },
    });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { release(); await browser.stop(); await fixture.stop(); });
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled');
    await page.waitFor('document.querySelector(".group-card[data-similarity=checking]")');
    assert.equal(await page.evaluate('document.querySelector(".group-card .similarity-indicator").dataset.phase'), 'checking');
    assert.match(await page.evaluate('document.querySelector(".group-card .similarity-indicator").getAttribute("aria-label")'), /Checking/);
    assert.match(await page.evaluate('document.querySelector("#refinement").textContent'), /Checks: \d+\/\d+/);
    await click('#refresh');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1, 'partial checks do not regroup on Refresh');
    await click('.group-card');
    await page.waitFor('!document.querySelector("#apply").disabled');
    await click('[data-keeper]');
    release();
    // No per-stack rank button: the server drives bounded work.
    await page.waitFor('!document.querySelector("#updates").hidden && !document.querySelector("#refinement").textContent', { timeoutMs: 40000 });
    assert.equal(fixture.similarityReads.length, 5);
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos .selected").length'), 1);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper]").length'), 5);
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card[data-similarity=updated]").length'), 1);
    assert.match(await page.evaluate('document.querySelector("#comparison-similarity").textContent'), /Updated grouping available/);
    assert.equal(await page.evaluate('document.querySelector("#show-updates")'), null);
    await click('[data-close=comparison]');
    await page.waitFor('document.querySelector(".group-card[data-similarity=checked]") && !document.querySelector("#refresh").disabled');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    assert.equal(await page.evaluate('document.querySelector(".group-card .similarity-indicator").dataset.phase'), 'done');
    await click('#refresh');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    await click('.group-card'); await page.waitFor('document.querySelectorAll("#photos [data-keeper]").length===5');
    await click('#comparison-similarity .why-trigger');
    assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /Candidate algorithm 3/);
    assert.match(await page.evaluate('document.querySelector("#stack-reasons").textContent'), /established core/);
    await click(`[data-keeper="${fixture.id(1)}"]`); await click(`[data-keeper="${fixture.id(3)}"]`);
    await click('#apply');
    await page.waitFor('!document.querySelector("#receipt").hidden && !document.querySelector("#undo").hidden && !document.querySelector("#undo").disabled && !document.querySelector("#refresh").disabled');
    assert.equal(fixture.repo.db.prepare("SELECT count(*) n FROM asset_tags WHERE tag='frame/eligible' AND asset_id<>?").get(fixture.contextId).n, 2);
    await click('#undo');
    try { await page.waitFor('document.querySelectorAll(".group-card").length>0 && !document.querySelector("#refresh").disabled'); }
    catch (error) {
      t.diagnostic(await page.evaluate('JSON.stringify({error:document.querySelector("#error").textContent,receipt:document.querySelector("#receipt").textContent,recovery:document.querySelector("#recovery").hidden,undoDisabled:document.querySelector("#undo").disabled})'));
      throw error;
    }
    await fixture.repo.curate.flush(); // local Undo no longer replaces the open view
    assert.equal(fixture.repo.db.prepare("SELECT count(*) n FROM curate_photos WHERE state='undecided'").get().n, 5);
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
  });

test('background status markers and inline progress remain stable on desktop and mobile',
  { timeout: 60000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    let release, first = true;
    const fixture = await curatePreviewFixture({ stackSize: 3, singles: 1, metadataReady: true,
      prepare(fixture) {
        for (let i = 1; i <= 3; i++) fixture.similarityResponses.set(fixture.id(i), async () => {
          if (first) {
            first = false;
            await new Promise(resolve => { release = resolve; });
            return { status: 503, body: {} };
          }
          return { status: 200, body: { assets: { items: [] } } };
        });
      },
    });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { release?.(); await browser.stop(); await fixture.stop(); });
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    try { await page.waitFor('document.querySelector(".similarity-indicator[data-phase=checking]")'); }
    catch (error) {
      t.diagnostic(await page.evaluate('JSON.stringify({groups:document.querySelector("#groups").innerHTML,error:document.querySelector("#error").textContent,progress:document.querySelector("#refinement").textContent})'));
      t.diagnostic(JSON.stringify({ searches: fixture.similarityReads, details: fixture.detailReads }));
      throw error;
    }
    assert.match(await page.evaluate('document.querySelector("#count").textContent'), /1 of 1 stack · 1 of 1 single photo shown/);
    assert.equal(await page.evaluate('document.querySelector("[data-section=pending]").textContent'), 'Pending');
    assert.equal(await page.evaluate('document.querySelector(".is-stack .card-actions")'), null);
    const gridTop = await page.evaluate('document.querySelector("#groups").getBoundingClientRect().top');
    assert.equal(await page.evaluate(`(() => {
      const count = document.querySelector('#count').getBoundingClientRect();
      const status = document.querySelector('#refinement').getBoundingClientRect();
      const spinner = document.querySelector('#check-activity').getBoundingClientRect();
      const refresh = document.querySelector('#refresh').getBoundingClientRect();
      return Math.abs(count.top - status.top) < 2 && Math.abs((spinner.top+spinner.bottom)/2 - (refresh.top+refresh.bottom)/2) < 2;
    })()`), true);

    assert.match(await page.evaluate('document.querySelector(".similarity-indicator[data-phase=done]").title'), /no similarity search needed/);
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-checking-desktop.png'), Buffer.from(data, 'base64'));
    }
    release();
    await page.waitFor('document.querySelector(".group-card[data-similarity=paused]")');
    assert.equal(await page.evaluate('document.querySelector("#groups").getBoundingClientRect().top'), gridTop,
      'changing progress to a paused message cannot move the grid');

    assert.equal(await page.evaluate('document.querySelector(".group-card[data-similarity=paused] .similarity-indicator").dataset.phase'), 'attention');
    await click('.group-card[data-similarity=paused]');
    await page.waitFor('document.querySelector("#comparison-similarity .similarity-indicator[data-phase=attention]")');
    assert.match(await page.evaluate('document.querySelector("#comparison-similarity").textContent'), /paused/);
    await click('[data-close=comparison]');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".similarity-indicator")).animationName'), 'none');
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-paused-mobile.png'), Buffer.from(data, 'base64'));
    }
    // Explicit refresh resumes after the shared failure cooldown, without a
    // retry loop. Successful empty results stay amber, never confident green.
    await click('#refresh');
    await page.waitFor('document.querySelector(".group-card[data-similarity=checked]")', { timeoutMs: 42000 });
    assert.equal(fixture.similarityReads.length, 4);
    assert.equal(await page.evaluate('document.querySelector(".group-card[data-similarity=checked] .similarity-indicator").dataset.phase'), 'attention');
    assert.match(await page.evaluate('document.querySelector(".group-card[data-similarity=checked] .similarity-status").textContent'), /uncertain/);
  });
