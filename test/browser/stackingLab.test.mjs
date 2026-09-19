import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('stacking lab shows complete partitions, focused dimming, evidence, reset and viewer without curation writes', { timeout: 60000 }, async (t) => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 3, singles: 52 });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  fixture.repo.updateAssetVisuals(fixture.id(1), { thumbhash: Buffer.alloc(21, 0).toString('base64') });
  fixture.repo.updateAssetVisuals(fixture.id(2), { thumbhash: Buffer.alloc(21, 255).toString('base64') });
  fixture.repo.updateAssetVisuals(fixture.id(3), { thumbhash: Buffer.alloc(21, 0).toString('base64') });
  fixture.repo.saveRunConfiguration({ id: 'c'.repeat(64), inferenceId: 'd'.repeat(64), snapshot: {
    formatVersion: 1, inference: { contractVersion: 1, jsonSchema: { properties: {
      has_people: { type: 'boolean' }, people_count: { type: 'string', enum: ['none', 'one', 'couple', 'group', 'unknown'] },
    } } },
  } });
  for (const [i, category] of ['one', 'couple', 'group'].entries()) {
    const people = [['person-a'], ['person-b'], ['person-a', 'person-b']][i].map(id => ({ id }));
    fixture.assets.find(a => a.id === fixture.id(i + 1)).people = people;
    fixture.repo.curate.observe({ id: fixture.id(i + 1), people: [{ id: 'stale-cached-person' }] });
    fixture.repo.recordProcessingRun({ assetId: fixture.id(i + 1), provider: 'test', model: 'test',
      promptVersion: 'v1', taxonomyVersion: 'v1', status: 'succeeded', configurationId: 'c'.repeat(64),
      normalizedOutput: { has_people: true, people_count: category } });
  }
  const before = fixture.repo.db.prepare('SELECT * FROM manual_overrides').all();
  const denied = await fetch(`${fixture.base}/api/review/curate/lab/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
  const deniedRefresh = await fetch(`${fixture.base}/api/review/curate/lab/recognition`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(deniedRefresh.status, 401);
  const deniedRanking = await fetch(`${fixture.base}/api/review/curate/lab/ranking`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(deniedRanking.status, 401);
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===50 && !document.querySelector("#build").disabled');
  await click('#more');
  await page.waitFor('document.querySelectorAll(".group-card").length===53 && !document.querySelector("#build").disabled');
  await click('.group-card');
  await page.waitFor('document.querySelectorAll("#lab-photos .photo-card").length===3');
  await page.waitFor('!document.querySelector("#refresh-recognition").disabled');
  assert.deepEqual([...new Set(fixture.detailReads)].sort(), [fixture.id(1), fixture.id(2), fixture.id(3)]);
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /3 photos → 1 group/);
  await click('#use-hash');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /2 groups \(2 \+ 1\)/);
  await click('#lab-photos .photo-image');
  assert.equal(await page.evaluate('document.querySelectorAll("#lab-photos .dimmed").length'), 1);
  assert.equal(await page.evaluate('document.querySelectorAll("#lab-photos .photo-card").length'), 3);
  assert.match(await page.evaluate('document.querySelectorAll(".lab-distance")[1].textContent'), /1\.000/);
  await click('#lab-photos .lab-info button');
  assert.equal(await page.evaluate('document.querySelector("#lab-viewer").open'), true);
  await click('#next');
  assert.match(await page.evaluate('document.querySelector("#viewer-position").textContent'), /2 of 3/);
  assert.match(await page.evaluate('document.querySelector("#immich").href'), new RegExp(fixture.id(2)));
  await click('[data-close="lab-viewer"]');
  await click('#reset');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /1 group/);
  assert.equal(await page.evaluate('document.querySelectorAll("#lab-photos .dimmed").length'), 0);
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".lab-people")].map(n=>n.textContent)'),
    ['Enrich people: One', 'Enrich people: Couple', 'Enrich people: Group']);
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".lab-recognition")].map(n=>n.textContent)'),
    ['Immich recognized: Person 1 (may be incomplete)', 'Immich recognized: Person 2 (may be incomplete)',
      'Immich recognized: Person 1, Person 2 (may be incomplete)']);
  assert.match(await page.evaluate('document.querySelector("#recognition-status").textContent'), /loaded from Immich/);
  // A remote change cannot silently alter this experiment. Deliberate refresh
  // uses the same selected photos and retains rule settings and person labels.
  fixture.assets.find(a => a.id === fixture.id(2)).people = [{ id: 'person-a' }];
  await click('#use-identities');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /2 groups \(1 \+ 2\)/);
  assert.match(await page.evaluate('document.querySelectorAll(".lab-reason")[1].textContent'), /different recognized people/);
  await page.evaluate('Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedLabSummary = text; } } })');
  await click('#copy');
  const summary = await page.evaluate('window.copiedLabSummary');
  assert.match(summary, /Different recognized people .*: on/);
  assert.doesNotMatch(summary, /person-a|person-b|Person 1|Person 2/);
  fixture.repo.db.prepare('UPDATE curate_metadata SET last_attempt_at=0,next_at=0').run();
  await click('#refresh-recognition');
  await page.waitFor('!document.querySelector("#refresh-recognition").disabled');
  assert.equal(await page.evaluate('document.querySelector("#use-identities").checked'), true);
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /1 group/);
  assert.match(await page.evaluate('document.querySelectorAll(".lab-recognition")[1].textContent'), /Person 1/);
  assert.equal(fixture.detailReads.length, 6);
  await click('#use-people');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /3 groups \(1 \+ 1 \+ 1\)/);
  await click('#use-identities');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /3 groups \(1 \+ 1 \+ 1\)/);
  await click('#use-identities');
  await click('#reset');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /1 group/);
  assert.equal(await page.evaluate('document.querySelector("#use-identities").checked'), false);
  assert.equal(fixture.similarityReads.length, 0, 'opening and rule changes never search');
  fixture.similarityResponses.set(fixture.id(1), async () => ({ status: 200, body: { assets: {
    items: [fixture.assets[0], ...Array.from({ length: 50 }, (_, i) => ({ type: 'IMAGE',
      id: i === 9 ? fixture.id(2) : `unrelated-${i}` }))], nextPage: '2',
  } } }));
  // Highlighting a later photo affects ThumbHash only, not the search reference.
  await click('#lab-photos .photo-card:nth-child(2) .photo-image');
  await click('#check-ranking');
  await page.waitFor('document.querySelector("#check-ranking").textContent==="Ranking checked"');
  assert.deepEqual(fixture.similarityReads, [{ queryAssetId: fixture.id(1), type: 'IMAGE', visibility: 'timeline', size: 51, withExif: false }]);
  const ranks = await page.evaluate('[...document.querySelectorAll(".lab-ranking")].map(n=>n.textContent)');
  assert.deepEqual(ranks, ['Similarity search reference · earliest photo', 'Immich similarity rank: #10', 'Not in the first 50 results']);
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /50 results · Search took \d+\.\d\d s · Checked/);
  await click('#use-people'); await click('#reset');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".lab-ranking")].map(n=>n.textContent)'), ranks);
  assert.equal(fixture.similarityReads.length, 1);
  await click('#copy');
  const rankedSummary = await page.evaluate('window.copiedLabSummary');
  assert.match(rankedSummary, /Photo 2: Immich similarity rank: #10/);
  assert.doesNotMatch(rankedSummary, /unrelated-|00000000|target-portrait|person-a/);
  // Reopen and explicitly check: the shared cache supplies the same result.
  fixture.repo.db.prepare('UPDATE curate_metadata SET last_attempt_at=0,next_at=0').run();
  await page.evaluate('document.querySelector("[data-close=experiment]").click();document.querySelector(".group-card").click()');
  await page.waitFor('!document.querySelector("#refresh-recognition").disabled && !document.querySelector("#experiment-content").hidden');
  await click('#check-ranking');
  await page.waitFor('document.querySelector("#check-ranking").textContent==="Ranking checked"');
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /Reused result/);
  assert.equal(fixture.similarityReads.length, 1);
  // Invalid inputs leave the last result explicitly labelled and cannot be copied.
  await page.evaluate('document.querySelector("#gap").value="99";document.querySelector("#gap").dispatchEvent(new Event("input"))');
  assert.equal(await page.evaluate('document.querySelector("#copy").disabled'), true);
  assert.match(await page.evaluate('document.querySelector("#experiment-error").textContent'), /previous settings/);
  await click('#reset');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.querySelector("#experiment").scrollWidth <= document.querySelector("#experiment").clientWidth'), true);
  await click('[data-close="experiment"]');
  await page.evaluate('document.querySelector("#sort").value="newest"');
  await click('#build');
  await page.waitFor('document.querySelectorAll(".group-card").length===50 && !document.querySelector("#build").disabled');
  assert.match(await page.evaluate('document.querySelector(".group-card .filename").textContent'), /single-52/);
  assert.deepEqual(fixture.repo.db.prepare('SELECT * FROM manual_overrides').all(), before);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM curate_separations').get().n, 0);
});

test('similarity errors assign no ranks, back off, and clear when opening another experiment', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 2, singles: 1 });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===2');
  await click('.group-card');
  await page.waitFor('!document.querySelector("#experiment-content").hidden');
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  fixture.similarityResponses.set(fixture.id(1), async () => { entered.resolve(); await release.promise;
    return { status: 400, body: { message: 'PRIVATE_UPSTREAM_TEXT' } };
  });
  await click('#check-ranking'); await entered.promise;
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /Searching Immich/);
  release.resolve();
  await page.waitFor('!document.querySelector("#check-ranking").disabled');
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /Smart Search/);
  assert.doesNotMatch(await page.evaluate('document.body.textContent'), /PRIVATE_UPSTREAM_TEXT/);
  assert.equal(await page.evaluate('document.querySelectorAll(".lab-ranking:not([hidden])").length'), 0);
  await click('#check-ranking');
  await page.waitFor('document.querySelector("#ranking-status").textContent.includes("wait")');
  assert.equal(fixture.similarityReads.length, 1, 'failure cooldown prevents repeated upstream requests');
  await page.evaluate('document.querySelector("[data-close=experiment]").click();document.querySelector(".group-card:nth-child(2)").click()');
  await page.waitFor('document.querySelectorAll("#lab-photos .photo-card").length===1');
  assert.equal(await page.evaluate('document.querySelector("#check-ranking").disabled'), true);
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /at least two photos/);
});

test('closing an in-flight ranking search cannot populate a newly opened experiment', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 2, singles: 1 });
  const browser = await launchChrome(), page = await browser.newPage();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(async () => { release.resolve(); await browser.stop(); await fixture.stop(); });
  fixture.similarityResponses.set(fixture.id(1), async () => { entered.resolve(); await release.promise;
    return { status: 200, body: { assets: { items: fixture.assets.slice(0, 2) } } };
  });
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===2');
  await page.evaluate('document.querySelector(".group-card").click()');
  await page.waitFor('!document.querySelector("#experiment-content").hidden');
  await page.evaluate('document.querySelector("#check-ranking").click()'); await entered.promise;
  await page.evaluate('document.querySelector("[data-close=experiment]").click();document.querySelector(".group-card:nth-child(2)").click()');
  release.resolve();
  await page.waitFor('document.querySelectorAll("#lab-photos .photo-card").length===1 && !document.querySelector("#refresh-recognition").disabled');
  assert.match(await page.evaluate('document.querySelector("#ranking-status").textContent'), /at least two photos/);
  assert.equal(await page.evaluate('document.querySelectorAll(".lab-ranking:not([hidden])").length'), 0);
  assert.equal(fixture.similarityReads.length, 1);
});

test('lab distinguishes empty, omitted and failed recognition; closing a refresh cannot update another experiment', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 4, singles: 1 });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  fixture.assets[0].people = [{ id: 'person-a' }];
  delete fixture.assets[2].people;
  fixture.detailResponses.set(fixture.id(4), async () => ({ status: 404, body: {} }));
  for (let i = 1; i <= 4; i++) fixture.repo.curate.observe({ id: fixture.id(i), people: [{ id: 'stale-person' }] });
  let entered = Promise.withResolvers(), release = Promise.withResolvers();
  fixture.detailResponses.set(fixture.id(1), async () => { entered.resolve(); await release.promise; });
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===2');
  await click('.group-card');
  await entered.promise;
  assert.match(await page.evaluate('document.querySelector("#recognition-status").textContent'), /Loading recognition data/);
  assert.equal(await page.evaluate('document.querySelector("#use-identities").disabled'), true);
  assert.equal(await page.evaluate('document.querySelector("#copy").disabled'), true);
  release.resolve();
  await page.waitFor('!document.querySelector("#refresh-recognition").disabled');
  const labels = await page.evaluate('[...document.querySelectorAll(".lab-recognition")].map(n=>n.textContent)');
  assert.match(labels[0], /Person 1/);
  assert.equal(labels[1], 'No recognized people returned by Immich');
  assert.equal(labels[2], 'Recognition data not returned by Immich');
  assert.equal(labels[3], 'Couldn’t load recognition data');
  assert.match(await page.evaluate('document.querySelector("#recognition-status").textContent'), /2 of 4/);
  assert.equal(await page.evaluate('document.querySelectorAll("#lab-photos .photo-card").length'), 4);
  assert.ok((await page.evaluate('[...document.querySelectorAll(".lab-checked")].map(n=>n.textContent)')).slice(0,3).every(s => s.startsWith('Checked')));
  entered = Promise.withResolvers(); release = Promise.withResolvers();
  fixture.repo.db.prepare('UPDATE curate_metadata SET last_attempt_at=0,next_at=0').run();
  await click('#refresh-recognition'); await entered.promise;
  // Same browser turn forces the native close event to arrive after reopening.
  await page.evaluate('document.querySelector("[data-close=experiment]").click();document.querySelector(".group-card:nth-child(2)").click()');
  release.resolve();
  await page.waitFor('!document.querySelector("#refresh-recognition").disabled && document.querySelectorAll("#lab-photos .photo-card").length===1');
  assert.match(await page.evaluate('document.querySelector("#experiment-title").textContent'), /Explore 1 photo/);
  assert.equal(await page.evaluate('document.querySelector(".lab-recognition").textContent'), 'No recognized people returned by Immich');
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
});

test('multi-reference ranks stream progress, preserve partial cancellation, and feed an explicit combined experiment', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const fixture = await curatePreviewFixture({ stackSize: 3, singles: 0 });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  for (const path of ['plan', 'run']) {
    const denied = await fetch(`${fixture.base}/api/review/curate/lab/ranks/${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
  }
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".group-card")'); await click('.group-card');
  await page.waitFor('document.querySelector("#check-group-ranks") && !document.querySelector("#check-group-ranks").disabled && !document.querySelector("#refresh-recognition").disabled');
  assert.match(await page.evaluate('document.querySelector("#rank-comparison").textContent'), /3 new searches/);
  assert.equal(fixture.similarityReads.length, 0);
  await click('#combined-mode'); await click('#use-ranks');
  assert.match(await page.evaluate('document.querySelector("#combined-summary").textContent'), /3 uncertain/);
  await click('#check-group-ranks');
  await page.waitFor('document.querySelector("#rank-comparison").textContent.includes("1 of 3 new searches complete")');
  assert.equal(fixture.similarityReads.length, 1);
  await click('#rank-comparison .compare-tools button:nth-child(2)');
  await page.waitFor('document.querySelector("#rank-comparison").textContent.includes("Cancelled.") && !document.querySelector("#check-group-ranks").disabled');
  assert.match(await page.evaluate('document.querySelector("#rank-comparison").textContent'), /2 new searches/);
  assert.match(await page.evaluate('document.querySelector("#rank-comparison tbody").textContent'), /Complete.*Unqueried/s);
  await click('#check-group-ranks');
  await page.waitFor('document.querySelector("#rank-comparison").textContent.includes("Pass complete.") && document.querySelector("#check-group-ranks").disabled', { timeoutMs: 20000 });
  assert.equal(fixture.similarityReads.length, 3);
  const row = await page.evaluate('[...document.querySelectorAll("#rank-comparison tbody tr:first-child td")].map(n=>n.textContent)');
  assert.deepEqual(row.slice(0, 3), ['·', '1', '2']);
  assert.equal(await page.evaluate('document.querySelectorAll("#rank-comparison tbody tr").length'), 3);
  await click('#rank-comparison tbody tr:nth-child(2) button');
  assert.match(await page.evaluate('document.querySelector("#pair-evidence").textContent'), /Photos 1 ↔ 2.*reciprocal near ranks/s);
  assert.match(await page.evaluate('document.querySelector("#combined-summary").textContent'), /uncertain/, 'rank alone is not proof');
  const before = fixture.similarityReads.length;
  await click('#use-hash'); await click('#use-people'); await click('#use-ranks');
  assert.equal(fixture.similarityReads.length, before);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.querySelector("#experiment").scrollWidth <= document.querySelector("#experiment").clientWidth'), true);
  await page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copied=text}}})');
  await click('#copy');
  assert.match(await page.evaluate('window.copied'), /Directional ranks.*Photo 2/s);
  assert.doesNotMatch(await page.evaluate('window.copied'), /00000000|target-portrait|synthetic/);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM curate_separations').get().n, 0);
});
