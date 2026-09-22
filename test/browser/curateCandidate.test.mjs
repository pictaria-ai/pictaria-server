import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('candidate preview refines automatically, preserves selections, explains results and saves multiple keepers',
  { timeout: 60000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 5, singles: 0 });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { await browser.stop(); await fixture.stop(); });
    const matrix = [[null,3,5,1,2], [2,null,1,3,4], [9,2,null,23,8], [1,3,5,null,2], [1,6,5,2,null]];
    for (let i = 0; i < 5; i++) {
      const id = fixture.id(i + 1), thumbhash = Buffer.alloc(21, i * 45).toString('base64');
      fixture.repo.updateAssetVisuals(id, { thumbhash }); fixture.assets.find(a => a.id === id).thumbhash = thumbhash;
      const items = Array.from({ length: 50 }, (_, j) => ({ id: `outside-${i}-${j}`, type: 'IMAGE' }));
      matrix[i].forEach((rank, j) => { if (rank) items[rank - 1] = { id: fixture.id(j + 1), type: 'IMAGE' }; });
      fixture.similarityResponses.set(id, () => ({ status: 200, body: { assets: { items } } }));
    }
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelectorAll(".group-card").length===5 && !document.querySelector("#refresh").disabled');
    await click('.group-card');
    await page.waitFor('!document.querySelector("#apply").disabled');
    await click('[data-keeper]');
    // No per-stack rank button: the normal preview page drives bounded work.
    await page.waitFor('!document.querySelector("#updates").hidden && document.querySelector("#refinement").hidden', { timeoutMs: 40000 });
    assert.equal(fixture.similarityReads.length, 5);
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 5);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos .selected").length'), 1);
    assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-keeper]").length'), 1);
    await click('[data-close=comparison]'); await click('#refresh');
    await page.waitFor('document.querySelectorAll(".group-card").length===1 && !document.querySelector("#refresh").disabled');
    await click('.group-card'); await page.waitFor('document.querySelectorAll("#photos [data-keeper]").length===5');
    await click('#stack-reason summary');
    assert.match(await page.evaluate('document.querySelector("#stack-reason").textContent'), /Candidate algorithm 1/);
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
    assert.equal(fixture.repo.db.prepare("SELECT count(*) n FROM curate_photos WHERE state='undecided'").get().n, 5);
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
  });
