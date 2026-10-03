import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';
import { CurateService } from '../../src/curate/service.mjs';
import { CurateAiInputs } from '../../src/curate/ai-inputs.mjs';
import { PHOTO_REFEREE_CONTRACT, createPhotoRefereeRequest } from '../../src/curate/photo-referee-contract.mjs';
import { planPhotoRefereeComparisons } from '../../src/curate/photo-referee-plan.mjs';
import { refereeCapability } from '../../src/curate/referee-capabilities.mjs';
import { savePhotoRefereeAnswer } from '../../src/curate/photo-referee-results.mjs';

// Persist through the real validator and API projection, without enabling a
// live provider. The browser then reads exactly the production response shape.
async function seedAdvice({ repo, assets, contextId }, keepers) {
  for (const asset of assets) {
    asset.thumbhash = Buffer.alloc(21, 0).toString('base64');
    repo.updateAssetVisuals(asset.id, { thumbhash: asset.thumbhash });
    repo.curate.mergeMetadataAsset({ ...asset, tags: asset.id === contextId ? [{ id: 'frame/eligible', value: 'frame/eligible' }] : [] });
  }
  const curate = new CurateService({ repo, candidateOptions: { enabled: true }, metadataOptions: { automatic: false } });
  try {
    await curate.refresh();
    const group = curate.current.groups.find(g => g.ids.length === 4);
    const { snapshot } = new CurateAiInputs(curate).capture({ role: 'keeper', groupId: group.id, contract: PHOTO_REFEREE_CONTRACT });
    const provider = { providerName: 'openai_compatible', modelName: 'Synthetic vision', baseUrl: 'http://synthetic/v1',
      analyzeImages: async () => { throw Error('No inference in this test'); } };
    const plan = planPhotoRefereeComparisons({ orderedIds: group.ids, capability: refereeCapability(provider),
      renditions: group.ids.map(id => ({ assetId: id, bytes: 1 })) });
    const request = createPhotoRefereeRequest({ provider, plan, inputKey: snapshot.inputKey,
      images: group.ids.map(id => ({ assetId: id, data: Buffer.from('x'), mimeType: 'image/jpeg' })) });
    const ids = ['p1', 'p2', 'p3', 'p4'];
    const answer = request.validate({ groups: [{ ids, keepers, reason: 'Alternatives of the same subject.' }],
      photos: ids.map(id => ({ id, eyes_closed: 'unsure', reason: id === 'p2' ? '<img src=x onerror=alert(1)> Natural expression.' : 'A clear view of the subject.' })) });
    repo.transaction(() => savePhotoRefereeAnswer(repo.curate, snapshot, plan, answer, { configurationKey: 'synthetic', checkCoverage: 'off' }));
  } finally { await curate.close(); }
}

for (const keepers of [[], ['p2', 'p4']]) test(`Photo Referee UI: ${keepers.length} saved recommendations, human changes and Undo`, { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true,
    prepare: data => seedAdvice(data, keepers) }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const outcomes = () => page.evaluate('[...document.querySelectorAll("#photos [data-choice][aria-pressed=true]")].map(b=>b.dataset.choice)');
  const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && document.querySelector(".is-stack").dataset.badge!=="checking" && !document.querySelector("#refresh").disabled', { timeoutMs: 35000 });
  assert.equal(await page.evaluate('document.querySelector(".is-stack .keeper-star")?.textContent ?? null'), keepers.length ? '★2' : null);
  await page.evaluate(`const fetchBefore=fetch; window.fetch=async(...a)=>{const r=await fetchBefore(...a);if(String(a[0]).endsWith('/comparisons'))window.__comparison=await r.clone().json();return r;}`);
  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply").disabled');
  assert.deepEqual(await outcomes(), keepers.length ? ['reviewed', 'approve', 'reviewed', 'approve'] : Array(4).fill('reviewed'), await page.evaluate('JSON.stringify([__comparison.photoReferee,__comparison.similarity,__comparison.photoRecommendations.unavailableReason,__comparison.route])'));
  assert.equal(operations(), 0, 'opening suggestions is not a decision');
  assert.match(await text('#photo-advice-summary'), keepers.length ? /2 suggested/ : /none suggested/, await page.evaluate('JSON.stringify([__comparison.photoReferee,__comparison.similarity,__comparison.photoRecommendations.unavailableReason,__comparison.route])'));
  assert.equal(await page.evaluate('document.querySelectorAll("#photos .suggested").length'), keepers.length);
  assert.equal(await page.evaluate('document.querySelector(".photo-advice img")'), null, 'model text is never interpreted as HTML');
  await click('#comparison-similarity .why-trigger');
  assert.match(await text('#stack-reason'), /Synthetic vision/);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await click(`#photos [data-photo-id="${fixture.id(2)}"] .photo-image`);
  await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
  assert.match(await text('#photo-assessment'), /<img src=x onerror=alert\(1\)> Natural expression/);
  assert.equal(await page.evaluate('document.querySelector("#photo-assessment img")'), null);
  await click('#back-comparison');
  await click(`#photos [data-photo-id="${fixture.id(2)}"] [data-choice=reviewed]`);
  await click(`#photos [data-photo-id="${fixture.id(1)}"] [data-choice=favorite]`);
  const edited = await outcomes();
  await page.evaluate(`window.__statusPolls=0;const original=fetch;window.fetch=async(...args)=>{
    const response=await original(...args);
    if(String(args[0]).includes('/groups/status')) window.__statusPolls++;
    return response;
  }`);
  await page.waitFor('window.__statusPolls>0');
  assert.deepEqual(await outcomes(), edited, 'status polls never replace a human draft');
  if (process.env.PICTARIA_TEST_SCREENSHOTS && keepers.length) {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'photo-referee-comparison.png'), Buffer.from(data, 'base64'));
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const phone = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'photo-referee-phone.png'), Buffer.from(phone.data, 'base64'));
    await page.send('Emulation.clearDeviceMetricsOverride');
  }
  await click('#apply');
  await page.waitFor('!document.querySelector("#comparison").open && !document.querySelector("#refresh").disabled');
  assert.equal(operations(), 1);
  const tags = fixture.repo.loadAssetTagsFor([1, 2, 3, 4].map(fixture.id));
  assert.ok(tags[fixture.id(1)].includes('frame/favorite'));
  assert.ok(tags[fixture.id(2)].includes('frame/reviewed'));
  assert.ok(!tags[fixture.id(2)].includes('frame/eligible'));
  assert.equal(tags[fixture.id(4)].includes('frame/eligible'), keepers.length > 0);
  assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
  await click('#undo');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  assert.ok([1, 2, 3, 4].every(n => fixture.repo.curate.photo(fixture.id(n)).state === 'undecided'));
});
