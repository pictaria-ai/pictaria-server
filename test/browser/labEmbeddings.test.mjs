import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';
import { startFakeMl } from '../embeddings/fakeMl.mjs';
import { encodePng } from '../../src/embeddings/calibration.mjs';

// Unit vectors with chosen cosines: 1–2 very similar (0.970), 3 different.
const basis = (i) => Array.from({ length: 512 }, (_, k) => (k === i ? 1 : 0));
const mix = (...terms) => terms.reduce((sum, [w, v]) => sum.map((x, k) => x + w * v[k]), Array(512).fill(0));
const VECTORS = [basis(0), mix([0.97, basis(0)], [Math.sqrt(1 - 0.97 ** 2), basis(1)]), mix([0.6, basis(0)], [0.8, basis(2)])];

test('the lab computes Pictaria embeddings on request and uses them in both experiment modes', { timeout: 90000 }, async (t) => {
  if (!findChrome()) return t.skip('Chrome required');
  const ml = await startFakeMl();
  const colors = new Map();
  const thumbnail = (id) => {
    if (!colors.has(id)) colors.set(id, colors.size);
    return encodePng(1, 1, Buffer.from([40 * colors.get(id), 90, 160]));
  };
  const fixture = await curatePreviewFixture({ stacking: false, stackSize: 3, singles: 0, metadataReady: true,
    env: { IMMICH_ML_URL: ml.url }, thumbnail });
  const byBytes = new Map([1, 2, 3].map((n, i) => [thumbnail(fixture.id(n)).toString('base64'), VECTORS[i]]));
  ml.state.vectorFor = (bytes) => byBytes.get(bytes.toString('base64')) ?? null;
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); await ml.close(); });
  for (const path of ['plan', 'run']) {
    const denied = await fetch(`${fixture.base}/api/review/curate/lab/embeddings/${path}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(denied.status, 401);
  }
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  await page.navigate(`${fixture.base}/curate-stacking-lab.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".group-card")'); await click('.group-card');
  await page.waitFor('document.querySelector("#compute-embeddings") && !document.querySelector("#compute-embeddings").disabled && !document.querySelector("#refresh-recognition").disabled');
  assert.match(await text('#embedding-comparison'), /0 of 3 photos have embeddings from ViT-B-32__openai\. 3 new in the next pass/);
  assert.equal(ml.predictions(), 0, 'opening a group never contacts the service');
  await click('#use-embeddings');
  assert.match(await text('#result'), /3 groups/, 'missing embeddings cannot pass the individual rule');

  await click('#compute-embeddings');
  await page.waitFor('document.querySelector("#embedding-comparison").textContent.includes("Pass complete.")', { timeoutMs: 20000 });
  await page.waitFor('document.querySelector("#embedding-comparison").textContent.includes("3 of 3 photos have embeddings")');
  assert.equal(ml.predictions(), 4, 'calibration plus one request per photo');
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings').get().n, 3);
  assert.equal(await page.evaluate('document.querySelector("#compute-embeddings").textContent'), 'Recheck service',
    'full coverage still offers an explicit service check');
  assert.equal(await page.evaluate('getComputedStyle(document.querySelector("#embedding-table .lab-rank-scroll")).maxHeight'), 'none',
    'the whole similarity table stays visible');
  const row = await page.evaluate('[...document.querySelectorAll("#embedding-table tbody tr:first-child td")].map(n => n.textContent)');
  assert.deepEqual(row, ['·', '0.970', '0.600']);

  // Individual filters: 1–2 pass the 0.865 default, 3 does not.
  assert.match(await text('#result'), /3 photos → 2 groups \(2 \+ 1\)/);
  await page.evaluate('(() => { const s=document.querySelector("#embedding-threshold"); s.value="0.59"; s.dispatchEvent(new Event("input")); })()');
  assert.match(await text('#result'), /3 photos → 2 groups/, 'every pair must pass: 1–3 is 0.600 but 2–3 is 0.582');
  // The average rule lets photo 3 join: its mean similarity to 1–2 is 0.591.
  const rule = (value) => page.evaluate(`(() => { const r=document.querySelector("#embedding-rule"); r.value=${JSON.stringify(value)}; r.dispatchEvent(new Event("input")); })()`);
  await rule('average');
  assert.match(await text('#result'), /3 photos → 1 group/);
  await rule('every');
  assert.match(await text('#result'), /3 photos → 2 groups/);
  await page.evaluate('(() => { const s=document.querySelector("#embedding-threshold"); s.value="0.55"; s.dispatchEvent(new Event("input")); })()');
  assert.match(await text('#result'), /3 photos → 1 group/);
  // Combined: very similar embeddings support 1–2; clearly different ones separate 3.
  await click('#combined-mode');
  assert.match(await text('#result'), /3 photos → 2 groups \(2 \+ 1\)/);
  await click('#lab-photos .photo-image');
  assert.match(await text('#pair-evidence'), /Photos 1 ↔ 2: supported\. Very similar embeddings without observed conflict\..*Embedding 0\.970 \(very similar\)/s);
  assert.match(await text('#pair-evidence'), /Photos 1 ↔ 3: separation proposed\. Clearly different embeddings\..*Embedding 0\.600 \(clearly different\)/s);
  assert.match(await page.evaluate('document.querySelectorAll(".lab-distance")[1].textContent'), /Embedding similarity: 0\.970/);
  await page.evaluate('(() => { const n=document.querySelector("#far-embedding"); n.value="0.99"; n.dispatchEvent(new Event("input")); })()');
  assert.match(await text('#experiment-error'), /ordered embedding bands/);
  assert.equal(await page.evaluate('document.querySelector("#copy").disabled'), true);
  await page.evaluate('(() => { const n=document.querySelector("#far-embedding"); n.value="0.75"; n.dispatchEvent(new Event("input")); })()');
  await page.evaluate('Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.copied=text}}})');
  await click('#copy');
  assert.match(await page.evaluate('window.copied'), /Pictaria embeddings: very similar ≥ 0\.900, clearly different ≤ 0\.750/);
  assert.match(await page.evaluate('window.copied'), /Pictaria embeddings \(ViT-B-32__openai\): 3 of 3 photos covered\nPhotos 1 ↔ 2: 0\.970/);
  assert.doesNotMatch(await page.evaluate('window.copied'), /00000000|target-portrait|synthetic/);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.querySelector("#experiment").scrollWidth <= document.querySelector("#experiment").clientWidth'), true);
  // Reopening the group shows the stored evidence without another request.
  await click('[data-close="experiment"]');
  await click('.group-card');
  await page.waitFor('document.querySelector("#compute-embeddings")?.textContent === "Recheck service" && !document.querySelector("#compute-embeddings").disabled');
  assert.match(await text('#embedding-comparison'), /3 of 3 photos have embeddings/);
  assert.equal(ml.predictions(), 4);
  // A changed service under the same model name is found by Recheck service.
  ml.state.vectorFor = (bytes) => { const v = byBytes.get(bytes.toString('base64')); return v ? [...v.slice(1), v[0]] : null; };
  ml.state.variant = 1;
  await click('#compute-embeddings');
  await page.waitFor('document.querySelector("#embedding-comparison").textContent.includes("Pass complete.")', { timeoutMs: 20000 });
  assert.equal(ml.predictions(), 8, 'calibration plus all three photos in the new set');
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) AS n FROM embedding_spaces').get().n, 2);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM decision_operations').get().n, 0);
  assert.equal(fixture.repo.db.prepare('SELECT count(*) n FROM curate_separations').get().n, 0);
});
