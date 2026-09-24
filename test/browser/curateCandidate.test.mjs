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
    assert.match(await page.evaluate('document.querySelector("#stack-reasons").textContent'), /distinguish this group/);
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
    assert.match(await page.evaluate('document.querySelector("#refinement").textContent'), /Checking stacks/);
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
    assert.equal(await page.evaluate('document.querySelector(".group-card .similarity-indicator")'), null);
    await click('#refresh');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    await click('.group-card'); await page.waitFor('document.querySelectorAll("#photos [data-keeper]").length===5');
    await click('#comparison-similarity .why-trigger');
    assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /Candidate algorithm 3/);
    assert.match(await page.evaluate('document.querySelector("#stack-reasons").textContent'), /several photos support/);
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
    const progress = () => page.evaluate('document.querySelector("#refinement").textContent');
    assert.equal(await progress(), 'Checking stacks · 1 remaining');
    // Global work stays visible even when every displayed card is outside it.
    await click('[data-kind=singles]');
    await page.waitFor('!document.querySelector("#refresh").disabled && document.querySelectorAll(".group-card").length===1');
    assert.equal(await page.evaluate('document.querySelector(".is-stack")'), null);
    assert.equal(await progress(), 'Checking stacks · 1 remaining');
    await click('[data-section=decided]');
    await page.waitFor('!document.querySelector("#refresh").disabled && document.querySelector("[data-section=decided].active")');
    assert.equal(await progress(), 'Checking stacks · 1 remaining');
    await click('[data-section=pending]');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    await click('[data-kind=all]');
    await page.waitFor('!document.querySelector("#refresh").disabled && document.querySelectorAll(".group-card").length===2');
    const gridTop = await page.evaluate('document.querySelector("#groups").getBoundingClientRect().top');
    assert.equal(await page.evaluate(`(() => {
      const count = document.querySelector('#count').getBoundingClientRect();
      const status = document.querySelector('#refinement').getBoundingClientRect();
      const spinner = document.querySelector('#check-activity').getBoundingClientRect();
      const refresh = document.querySelector('#refresh').getBoundingClientRect();
      return Math.abs(count.top - status.top) < 2 && Math.abs((spinner.top+spinner.bottom)/2 - (refresh.top+refresh.bottom)/2) < 2;
    })()`), true);

    assert.equal(await page.evaluate('document.querySelector("#groups .similarity-indicator[data-phase=done]")'), null);
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-checking-desktop.png'), Buffer.from(data, 'base64'));
    }
    release();
    await page.waitFor('document.querySelector(".group-card[data-similarity=paused]")');
    assert.equal(await progress(), 'Checking stacks · 1 remaining · 1 need attention');
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
    assert.equal(await progress(), '', 'completed checks no longer contribute to remaining work');
  });

test('missing embeddings show actionable attention without view changes resetting backoff',
  { timeout: 40000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    let missing = true;
    const fixture = await curatePreviewFixture({ stackSize: 3, singles: 0, metadataReady: true,
      prepare(f) {
        for (let n = 1; n <= 3; n++) f.similarityResponses.set(f.id(n), async () => missing && n === 1
          ? { status: 400, body: { message: `Asset ${f.id(1)} has no embedding private-upstream-detail` } }
          : { status: 200, body: { assets: { items: [1,2,3].map(i => ({ id: f.id(i), type: 'IMAGE' })) } } });
      },
    });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { await browser.stop(); await fixture.stop(); });
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelector("#refinement")?.textContent==="Checks waiting · 1 remaining · 1 need attention"', { timeoutMs: 15000 });
    assert.equal(fixture.similarityReads.length, 3, 'other references were checked after one failed');
    const diagnostic = await page.evaluate('document.querySelector("#check-activity .similarity-indicator").title');
    assert.match(diagnostic, /Immich has no search embedding/); assert.match(diagnostic, /Next scheduled retry/);
    assert.doesNotMatch(diagnostic, /private-upstream-detail|00000000/);
    assert.equal(await page.evaluate('document.querySelector("#check-activity .similarity-indicator").dataset.phase'), 'attention');
    await click('[data-section=decided]'); await page.waitFor('!document.querySelector("#refresh").disabled');
    await click('[data-section=pending]'); await page.waitFor('!document.querySelector("#refresh").disabled && document.querySelector(".is-stack")');
    assert.equal(fixture.similarityReads.length, 3);
    await click('.is-stack');
    await page.waitFor('document.querySelector("#comparison-similarity .why-trigger")');
    await click('#comparison-similarity .why-trigger');
    const explanation = await page.evaluate('document.querySelector("#comparison-similarity").textContent');
    assert.match(explanation, /waiting for Immich Smart Search/);
    assert.match(explanation, /Next retry:/); assert.match(explanation, /still choose/);
    assert.equal(await page.evaluate('document.querySelector("#photos [data-keeper]").disabled'), false);
    await click('[data-close=comparison]');
    missing = false;
    await click('#refresh');
    await page.waitFor('!document.querySelector("#refinement").textContent && !document.querySelector("#refresh").disabled', { timeoutMs: 12000 });
    assert.deepEqual(fixture.similarityReads.map(r => r.queryAssetId), [fixture.id(1), fixture.id(2), fixture.id(3), fixture.id(1)]);
    assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
  });
