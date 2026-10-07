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
async function seedAdvice({ repo, assets, contextId }, keepers, legacyGrouped = false) {
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
    if (legacyGrouped) {
      // Previously accepted subject groups must not split this stack on upgrade.
      delete answer.provenance.promptRevision;
      const [a, b, c, d] = group.ids;
      answer.result.groups = [
        { ids: [a, b], keepers: [b], reason: 'First subject.' },
        { ids: [c], keepers: [], reason: 'Poor quality.' },
        { ids: [d], keepers: [d], reason: 'Another subject.' },
      ];
    }
    repo.transaction(() => savePhotoRefereeAnswer(repo.curate, snapshot, plan, answer, { configurationKey: 'synthetic', checkCoverage: 'off' }));
  } finally { await curate.close(); }
}

for (const { keepers, legacyGrouped } of [{ keepers: [] }, { keepers: ['p2', 'p4'] }, { keepers: ['p2', 'p4'], legacyGrouped: true }]) test(`Photo Referee UI: ${keepers.length} ${legacyGrouped ? 'historically grouped' : 'saved'} recommendations, human changes and Undo`, { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true,
    prepare: data => seedAdvice(data, keepers, legacyGrouped) }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const outcomes = () => page.evaluate('[...document.querySelectorAll("#photos [data-choice][aria-pressed=true]")].map(b=>b.dataset.choice)');
  const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
  const originalTags = fixture.repo.loadAssetTagsFor([1, 2, 3, 4].map(fixture.id));
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && document.querySelector(".is-stack").dataset.badge!=="checking" && !document.querySelector("#refresh").disabled', { timeoutMs: 35000 });
  assert.equal(await page.evaluate('document.querySelectorAll(".is-stack").length'), 1);
  assert.equal(await page.evaluate('document.querySelectorAll(".group-card:not(.is-stack)").length'), 1,
    'Photo Referee must not create additional singles');
  assert.equal(await page.evaluate('document.querySelector(".is-stack .keeper-star")?.textContent ?? null'), keepers.length ? '★2' : null);
  await page.evaluate(`const fetchBefore=fetch; window.fetch=async(...a)=>{const r=await fetchBefore(...a);if(String(a[0]).endsWith('/comparisons'))window.__comparison=await r.clone().json();return r;}`);
  assert.equal(await page.evaluate('!document.querySelector(".is-stack .stack-accept").hidden'), keepers.length > 0);
  assert.equal(await page.evaluate('document.querySelector(".is-stack .cover img").src.split("/").pop()'), fixture.id(keepers.length ? 2 : 1));
  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply").disabled');
  assert.deepEqual(await outcomes(), keepers.length ? ['reviewed', 'approve', 'reviewed', 'approve'] : Array(4).fill('reviewed'), await page.evaluate('JSON.stringify([__comparison.photoReferee,__comparison.similarity,__comparison.photoRecommendations.unavailableReason,__comparison.route])'));
  assert.equal(operations(), 0, 'opening suggestions is not a decision');
  assert.match(await text('#photo-advice-summary'), keepers.length ? /2 suggested/ : /none suggested/, await page.evaluate('JSON.stringify([__comparison.photoReferee,__comparison.similarity,__comparison.photoRecommendations.unavailableReason,__comparison.route])'));
  assert.equal(await page.evaluate('document.querySelectorAll("#photos .suggested").length'), keepers.length);
  const photoWhy = `#photos [data-photo-id="${fixture.id(2)}"] .why-trigger`;
  await page.evaluate(`document.querySelector(${JSON.stringify(photoWhy)}).focus()`);
  assert.match(await text(`#photo-advice-${fixture.id(2)}`), /<img src=x onerror=alert\(1\)> Natural expression/);
  assert.equal(await page.evaluate('document.querySelector("#photos .why-content img")'), null, 'model text is never interpreted as HTML');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' });
  assert.equal(operations(), 0, 'Enter on explanation help never saves the comparison');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  assert.equal(await page.evaluate('document.querySelector("#comparison").open && !document.querySelector("#photos .why-content:not([hidden])")'), true,
    'Escape dismisses photo advice before the comparison');
  await click('#comparison-shortcuts .why-trigger');
  assert.match(await text('#comparison-shortcuts-help'), /Unmarked photos default to Skip/);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await click('#comparison-similarity .why-trigger');
  assert.match(await text('#stack-reason'), /Synthetic vision/);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
  await page.evaluate(`const captionFetch=fetch;window.fetch=(...args)=>String(args[0]).includes('/api/enrich/caption') ? Promise.resolve(new Response(JSON.stringify({caption:'Enriched caption',model:'Enrich model',provider:'Synthetic'}))) : captionFetch(...args)`);
  await click(`#photos [data-photo-id="${fixture.id(2)}"] .photo-image`);
  await page.waitFor('document.querySelector("#photo-view").open && document.querySelector("#photo-loading").hidden');
  await page.waitFor('document.querySelector("#photo-model").textContent.includes("Enrich model")');
  assert.match(await text('#photo-referee-model'), /Photo Referee · Synthetic vision/);
  assert.equal(await text('#photo-position'), '2 of 4 photos');
  assert.equal(await text('#photo-reference-count'), '1 already kept · reference only');
  assert.match(await text('#photo-assessment'), /<img src=x onerror=alert\(1\)> Natural expression/);
  assert.equal(await page.evaluate('document.querySelector("#photo-assessment img")'), null);
  await click('#back-comparison');
  await click(`#photos [data-photo-id="${fixture.id(2)}"] [data-choice=reviewed]`);
  await click(`#photos [data-photo-id="${fixture.id(1)}"] [data-choice=favorite]`);
  const edited = await outcomes();
  await page.evaluate(`window.__statusPolls=0;const original=fetch;window.fetch=async(...args)=>{
    const response=await original(...args);
    if(String(args[0]).includes('/groups/status')) {
      window.__statusPolls++; window.__lastStatus=await response.clone().json();
    }
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
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled && document.querySelector("#receipt-text").textContent.startsWith("Undid choices")');
  assert.equal(operations(), 2);
  // Undo commits tags immediately; the derived Curate projection can lag.
  assert.deepEqual(fixture.repo.loadAssetTagsFor([1, 2, 3, 4].map(fixture.id)), originalTags);
  assert.equal(await page.evaluate('document.querySelector(".is-stack .keeper-star")?.textContent ?? null'), keepers.length ? '★2' : null);
  // Advice survives immediately; wait for a fresh poll confirming that normal
  // deterministic prerequisites have settled before expecting preselection.
  await page.evaluate('window.__lastStatus=null');
  await page.waitFor('window.__lastStatus?.groups?.some(g=>g.memberCount===4 && g.photoReferee?.canApplyAll) && !document.querySelector("#refresh").disabled');
  await click('.is-stack .cover');
  await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply").disabled');
  assert.match(await text('#photo-advice-summary'), keepers.length ? /2 suggested/ : /none suggested/,
    'Undo retains accepted advice with background inference disabled');
  assert.deepEqual(await outcomes(), keepers.length ? ['reviewed', 'approve', 'reviewed', 'approve'] : Array(4).fill('reviewed'));
});

for (const keepers of [[], ['p2', 'p4']]) test(
  keepers.length ? 'Photo Referee Enter confirms the suggested draft and advances'
    : 'Photo Referee Enter leaves an untouched all-Skip draft unsaved',
  { timeout: 60000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    const track = cleanupAfter(t);
    const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true,
      prepare: data => seedAdvice(data, keepers) }));
    const browser = track(await launchChrome()), page = await browser.newPage();
    const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const enter = async (autoRepeat = false) => {
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', autoRepeat });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter' });
    };
    const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelector(".is-stack") && document.querySelector(".is-stack").dataset.badge!=="checking" && !document.querySelector("#refresh").disabled', { timeoutMs: 35000 });
    await click('.is-stack .cover');
    await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply-next").disabled');
    assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(keepers.length ? 2 : 1),
      'eligible suggestions receive initial focus without reordering photos');
    assert.equal(operations(), 0);
    assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#photos [data-choice][aria-pressed=true]")].map(b=>b.dataset.choice)'),
      keepers.length ? ['reviewed', 'approve', 'reviewed', 'approve'] : Array(4).fill('reviewed'));
    await page.evaluate(`window.issuedDecisions=0;const nativeFetch=window.fetch;
      window.fetch=async(...args)=>{if(String(args[0]).endsWith('/operations'))window.issuedDecisions++;
        const r=await nativeFetch(...args);if(String(args[0]).endsWith('/comparisons'))window.__comparison=await r.clone().json();return r;}`);
    await enter(true);
    assert.equal(await page.evaluate('window.issuedDecisions'), 0, 'held Enter never confirms a draft');
    await enter();
    if (!keepers.length) {
      await click('#select-all');
      await page.evaluate('document.querySelector("#photos .photo-card").focus()');
      await enter();
      assert.equal(await page.evaluate('window.issuedDecisions'), 0, 'zero recommendations and checked boxes do not express save intent');
      assert.equal(operations(), 0);
      assert.equal(await page.evaluate('document.querySelector("#comparison").open'), true);
      assert.ok([1, 2, 3, 4].every(n => fixture.repo.curate.photo(fixture.id(n)).state === 'undecided'));
    } else {
      await page.waitFor(`document.querySelector('#photo-view').open && document.querySelector('#photo-large').src.includes('${fixture.id(1001)}') && document.querySelector('#photo-loading').hidden && !document.querySelector('#refresh').disabled`);
      assert.equal(await page.evaluate('window.issuedDecisions'), 1);
      assert.equal(operations(), 1);
      assert.equal(await page.evaluate('document.querySelector("#comparison").open'), false);
      const tags = fixture.repo.loadAssetTagsFor([1, 2, 3, 4].map(fixture.id));
      for (const n of [1, 2, 3, 4]) {
        assert.equal(tags[fixture.id(n)].includes('frame/eligible'), n === 2 || n === 4);
        assert.equal(tags[fixture.id(n)].includes('frame/reviewed'), n === 1 || n === 3);
      }
      assert.equal(fixture.repo.curate.photo(fixture.id(1001)).state, 'undecided', 'continuation does not decide the next photo');
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ' });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ' });
      await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled && document.querySelector("#receipt-text").textContent.startsWith("Undid choices")');
      assert.equal(operations(), 2);
      assert.equal(await page.evaluate('document.querySelector(".is-stack .keeper-star")?.textContent'), '★2');
      // The retained star is immediate. Normal deterministic prerequisite work
      // can still gate preselection; restoring advice must not bypass it.
      await page.waitFor('document.querySelector(".is-stack").dataset.badge!=="checking" && !document.querySelector("#refresh").disabled');
      await click('.is-stack .cover');
      await page.waitFor('document.querySelectorAll("#photos .photo-card").length===4 && !document.querySelector("#apply-next").disabled');
      assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#photos [data-choice][aria-pressed=true]")].map(b=>b.dataset.choice)'),
        ['reviewed', 'approve', 'reviewed', 'approve'], await page.evaluate('JSON.stringify({updated:__comparison.updated,photoReferee:__comparison.photoReferee,advice:__comparison.photoRecommendations,similarity:__comparison.similarity})'));
    }
    assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
  },
);

test('grid suggestions: explicit keyboard acceptance, Undo, stale/partial fallback and phone layout', { timeout: 90000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 1, metadataReady: true,
    prepare: data => seedAdvice(data, ['p2', 'p4']) }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = selector => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
  const ready = () => page.waitFor('document.querySelector(".stack-accept:not([hidden]):not(:disabled)")');
  const enter = async (autoRepeat = false, modifiers = 0) => {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r', autoRepeat, modifiers });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers });
  };
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await ready();
  assert.equal(await page.evaluate('document.querySelector("#count").textContent'), '1 stack · 1 single photo left');
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll(".is-stack .stack-strip img")].map(i=>i.src.split("/").pop())'), [1,3,4].map(fixture.id));
  await page.evaluate('document.querySelector(".is-stack .cover").focus()');
  await enter();
  await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
  assert.equal(operations(), 0, 'Enter on cover opens, never accepts advice');
  assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(2));
  assert.deepEqual(await page.evaluate('[...document.querySelectorAll("#photos .photo-card")].map(c=>c.dataset.photoId)'), [1,2,3,4].map(fixture.id));
  assert.equal(await page.evaluate('document.querySelectorAll("#photos .photo-reason-inline").length'), 2);
  assert.equal(await page.evaluate('document.querySelector("#apply-next").textContent'), 'Keep 2 · Next');
  await click('#select-all'); await click('#comparison-bulk [data-comparison-bulk="reviewed"]');
  assert.equal(await page.evaluate('document.querySelector("#apply-next").textContent'), 'Skip all · Next');
  await click(`#photos [data-photo-id="${fixture.id(1)}"] [data-choice=reject]`);
  assert.equal(await page.evaluate('document.querySelector("#apply-next").textContent'), 'Save · Next');
  await click(`#photos [data-photo-id="${fixture.id(2)}"] [data-choice=favorite]`);
  assert.equal(await page.evaluate('document.querySelector("#apply-next").textContent'), 'Keep 1 · Next');
  await click('[data-close=comparison]');
  await ready();
  await page.evaluate('document.querySelector(".stack-accept").focus()');
  await enter(true); await enter(false, 2);
  assert.equal(operations(), 0, 'repeated or modified shortcut keys do not decide');
  await enter();
  await page.waitFor('!document.querySelector(".is-stack") && !document.querySelector("#undo").hidden && !document.querySelector("#undo").disabled');
  assert.equal(operations(), 1);
  const tags = fixture.repo.loadAssetTagsFor([1,2,3,4].map(fixture.id));
  for (const n of [1,2,3,4]) {
    assert.equal(tags[fixture.id(n)].includes('frame/eligible'), n === 2 || n === 4);
    assert.equal(tags[fixture.id(n)].includes('frame/reviewed'), n === 1 || n === 3);
  }
  assert.equal(fixture.repo.curate.photo(fixture.contextId).state, 'approved');
  await click('#undo'); await ready();
  assert.equal(operations(), 2);
  await page.evaluate(`window.__variant=''; const originalFetch=fetch; window.fetch=async(...args)=>{
    const response=await originalFetch(...args);
    if (!String(args[0]).endsWith('/comparisons') || !window.__variant) return response;
    const body=await response.json();
    if (__variant==='changed') body.photoReferee.suggestion.key='new-snapshot';
    if (__variant==='partial') { body.photoRecommendations.state='partial'; body.photoRecommendations.canApplyAll=false; }
    if (__variant==='waiting') { body.photoRecommendations.canApplyAll=false; body.photoRecommendations.unavailableReason='stack-pending'; }
    return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
  }`);
  for (const variant of ['changed','partial','waiting']) {
    await page.evaluate(`window.__variant=${JSON.stringify(variant)}`);
    await click('.stack-accept');
    await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
    assert.equal(operations(), 2, `${variant} advice requires manual review`);
    assert.match(await page.evaluate('document.querySelector("#comparison-state").textContent'), /Suggestions changed/);
    if (variant !== 'changed') {
      assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(1));
      assert.equal(await page.evaluate('document.querySelectorAll("#photos [data-choice=approve][aria-pressed=true]").length'), 0);
      assert.equal(await page.evaluate('document.querySelectorAll("#photos .photo-reason-inline").length'), 0);
    }
    await click('[data-close=comparison]'); await ready();
  }
  await page.evaluate('window.__variant=""');
  for (const [width, theme] of [[1200,'light'],[390,'light'],[390,'dark']]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
    await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await page.waitFor('document.querySelector(".stack-accept").getBoundingClientRect().width>0');
    assert.ok(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth + 1`));
    const bounds = await page.evaluate(`(()=>{const b=document.querySelector('.stack-accept').getBoundingClientRect();return {left:b.left,right:b.right,width:b.width,height:b.height}})()`);
    assert.ok(bounds.left >= 0 && bounds.right <= width && bounds.height >= 36, JSON.stringify(bounds));
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const shot=await page.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, `suggestion-grid-${width}-${theme}.png`),Buffer.from(shot.data,'base64'));
    }
    await click('.is-stack .cover');
    await page.waitFor('document.querySelector("#comparison").open && !document.querySelector("#apply").disabled');
    assert.equal(await page.evaluate('document.activeElement.dataset.photoId'), fixture.id(2));
    assert.ok(await page.evaluate(`(()=>{const c=document.activeElement.getBoundingClientRect();return c.bottom>0 && c.top<innerHeight})()`), 'suggested card visible on phone');
    assert.ok(await page.evaluate(`document.querySelector('#comparison').scrollWidth<=document.querySelector('#comparison').clientWidth+1`));
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const shot=await page.send('Page.captureScreenshot',{format:'png'});
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, `suggestion-comparison-${width}-${theme}.png`),Buffer.from(shot.data,'base64'));
    }
    await click('[data-close=comparison]'); await ready();
  }
});
