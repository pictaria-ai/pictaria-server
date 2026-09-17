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
    fixture.repo.curate.observe({ id: fixture.id(i + 1), people });
    fixture.repo.recordProcessingRun({ assetId: fixture.id(i + 1), provider: 'test', model: 'test',
      promptVersion: 'v1', taxonomyVersion: 'v1', status: 'succeeded', configurationId: 'c'.repeat(64),
      normalizedOutput: { has_people: true, people_count: category } });
  }
  const before = fixture.repo.db.prepare('SELECT * FROM manual_overrides').all();
  const denied = await fetch(`${fixture.base}/api/review/curate/lab/views`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 401);
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===50 && !document.querySelector("#build").disabled');
  await click('#more');
  await page.waitFor('document.querySelectorAll(".group-card").length===53 && !document.querySelector("#build").disabled');
  await click('.group-card');
  await page.waitFor('document.querySelectorAll("#lab-photos .photo-card").length===3');
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
  await click('#use-identities');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /2 groups \(1 \+ 2\)/);
  assert.match(await page.evaluate('document.querySelectorAll(".lab-reason")[1].textContent'), /different recognized people/);
  await page.evaluate('Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.copiedLabSummary = text; } } })');
  await click('#copy');
  const summary = await page.evaluate('window.copiedLabSummary');
  assert.match(summary, /Different recognized people .*: on/);
  assert.doesNotMatch(summary, /person-a|person-b|Person 1|Person 2/);
  await click('#use-people');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /3 groups \(1 \+ 1 \+ 1\)/);
  await click('#use-identities');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /3 groups \(1 \+ 1 \+ 1\)/);
  await click('#use-identities');
  await click('#reset');
  assert.match(await page.evaluate('document.querySelector("#result").textContent'), /1 group/);
  assert.equal(await page.evaluate('document.querySelector("#use-identities").checked'), false);
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
