import test from 'node:test';
import { createServer } from 'node:http';
import { sampleOutput } from '../enrich/helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

test('Settings manages profiles; Enrich links to profiles and saved run settings, saves the active profile across tabs and freezes running work without losing history', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-profile-browser-'));
  let server, browser, immich, model, finishModelRequest, signalModelRequest;
  const modelRequestStarted = new Promise(resolve => { signalModelRequest = resolve; });
  t.after(async () => {
    t.diagnostic("Cleaning up profile browser services");
    finishModelRequest?.();
    await Promise.allSettled([browser?.stop(), server?.stop(), immich?.stop()]);
    if (model) await new Promise(resolve => model.close(resolve));
    rmSync(dir, { recursive: true, force: true });
    t.diagnostic("Profile browser services stopped");
  });
  const asset = { id: '00000000-0000-0000-0000-000000000001', type: 'IMAGE', originalFileName: 'test.jpg',
    localDateTime: '2026-01-01T12:00:00Z', exifInfo: { city: 'Paris' } };
  immich = await startFakeImmich({ assets: [asset], serveAssetDetails: true });
  model = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      finishModelRequest = () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] }));
        finishModelRequest = null;
      };
      signalModelRequest();
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  server = await bootServer(dir, { env: { ENRICH_ENABLED: 'true', DEFAULT_PROVIDER: 'local_lmstudio', IMMICH_BASE_URL: immich.base, IMMICH_API_KEY: 'fake-key', LMSTUDIO_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, LMSTUDIO_MODEL: 'test' } });
  assert.equal((await fetch(`${server.base}/api/enrich/profiles`)).status, 401);
  browser = await launchChrome(); const page = await browser.newPage();
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value = "smoke-secret"; document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector("#enrichProfile option") && !document.querySelector(".gate-backdrop")');
  const legacyPatch = await page.evaluate("fetch('/api/settings', { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enrich:{systemPrompt:'Obsolete'}})}).then(async r=>({status:r.status,body:await r.json()}))");
  assert.equal(legacyPatch.status, 400); assert.match(legacyPatch.body.error.message, /profiles/);
  const invalidProfile = await page.evaluate("fetch('/api/enrich/prompts?profileId=missing').then(r=>r.status)");
  assert.equal(invalidProfile, 400);
  const click = id => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
  const fill = (id, value) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}; document.getElementById(${JSON.stringify(id)}).dispatchEvent(new Event("input", {bubbles:true}))`);
  const follow = async id => page.navigate(await page.evaluate(`document.getElementById(${JSON.stringify(id)}).href`));
  assert.equal(await page.evaluate('document.querySelector("#profileEditor, #profileNew, #profileArchive")'), null);
  assert.equal(await page.evaluate('document.querySelector("#taxPanel, #profileView, #profileEdit")'), null);
  assert.equal(await page.evaluate('document.getElementById("profileManage").textContent'), 'View and manage profiles');
  assert.equal(await page.evaluate('document.getElementById("viewConfigurationBtn").hidden'), true);
  await follow('profileManage');
  await page.waitFor('document.getElementById("sec-enrichment-profiles")?.open && document.querySelector("#profileList .profile-row")');
  assert.equal(await page.evaluate('document.getElementById("profileEditor").hidden'), true);
  // Master-off pauses dependent features without rewriting saved choices.
  await page.evaluate(`fetch('/api/settings', {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enrich:{enabled:false, scheduledEnabled:true, captionWriteback:true}})}).then(r=>r.json())`);
  await page.navigate(`${server.base}/settings.html?test=master-off#sec-enrich`);
  await page.waitFor('document.getElementById("f2-enrich-captionWriteback")?.disabled && document.getElementById("f2-enrich-captionWriteback").checked');
  assert.equal(await page.evaluate('document.getElementById("f2-enrich-scheduledEnabled").disabled && document.getElementById("f2-enrich-scheduledEnabled").checked'), true);
  assert.match(await page.evaluate('document.getElementById("fields-enrich").textContent'), /Paused while Enrich is off/);
  assert.equal(await page.evaluate(`fetch('/api/enrich/captions/writeback/backfill', {method:'POST'}).then(r=>r.status)`), 409);
  const saved = await page.evaluate(`fetch('/api/settings').then(r=>r.json())`);
  assert.equal(saved.enrich.scheduledEnabled.value, true); assert.equal(saved.enrich.captionWriteback.value, true);
  await page.evaluate('document.getElementById("f2-enrich-enabled").checked = true; document.getElementById("f2-enrich-enabled").dispatchEvent(new Event("change"))');
  assert.equal(await page.evaluate('document.getElementById("f2-enrich-captionWriteback").disabled'), false);
  assert.equal(await page.evaluate('document.getElementById("f2-enrich-scheduledEnabled").checked'), true);
  // Restore this fixture's manual-only setup before its provider test.
  await page.evaluate(`fetch('/api/settings', {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({enrich:{enabled:true, scheduledEnabled:false, captionWriteback:false}})}).then(r=>r.json())`);
  await page.navigate(`${server.base}/settings.html#sec-enrichment-profiles`);
  await page.waitFor('document.querySelector("#profileList .profile-row")');
  const backToList = async () => {
    await click('profileBack');
    await page.waitFor('!document.getElementById("profileLibrary").hidden && !document.getElementById("profileListControls").disabled');
  };
  const rowAction = async (action, id) => {
    await page.evaluate(`(() => { const button = document.querySelector('[data-action="${action}"][data-profile-id="${id}"]'); const menu = button.closest('.profile-menu'); if (menu) menu.open = true; button.click(); })()`);
  };
  const initialId = await page.evaluate('document.querySelector("#profileList .profile-row").dataset.profileId');
  await rowAction('edit', initialId);
  await page.waitFor('!document.getElementById("profileEditor").hidden && !document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileLibrary").hidden'), false);
  assert.equal(await page.evaluate('document.getElementById("profileDialog").open'), true);
  assert.equal(await page.evaluate('document.getElementById("profileTaxonomyDetails").open'), false);
  assert.match(await page.evaluate('document.getElementById("profileTaxonomySummary").textContent'), /tags in .* categories/);
  assert.equal(await page.evaluate('document.querySelectorAll("dialog:modal").length'), 1);
  // Cancel preserves a draft unless the user explicitly discards it.
  await fill('profileName', 'Unsaved name'); await click('profileClose');
  await page.waitFor('!document.getElementById("profileDiscardDialog").hidden');
  await click('profileKeepEditing');
  await page.waitFor('!document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileName").value'), 'Unsaved name');
  assert.match(await page.evaluate('document.getElementById("profileDirty").textContent'), /Unsaved/);
  // Leaving through navigation asks too; keeping the draft stays on Settings.
  await page.evaluate('Array.from(document.querySelectorAll(".p-nav a")).find(a => a.pathname === "/enrich.html").click()');
  await page.waitFor('!document.getElementById("profileDiscardDialog").hidden');
  await click('profileKeepEditing');
  assert.equal(await page.evaluate('location.pathname'), '/settings.html');
  assert.equal(await page.evaluate('(() => { const event = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(event); return event.defaultPrevented; })()'), true);

  await click('profileClose'); await page.waitFor('!document.getElementById("profileDiscardDialog").hidden');
  await click('profileDiscard');
  await page.waitFor('!document.getElementById("profileLibrary").hidden && !document.getElementById("profileListControls").disabled');
  await rowAction('duplicate', initialId);
  await page.waitFor('!document.getElementById("profileCreate").hidden');
  assert.equal(await page.evaluate('document.getElementById("profileSource").value'), initialId);
  await click('profileCreateContinue');
  await page.waitFor('!document.getElementById("profileEditor").hidden && !document.getElementById("profileEditorControls").disabled');
  await fill('profileName', 'Travel <test>'); await fill('profileUser', 'Invalid template'); await click('profileSave');
  await page.waitFor('document.getElementById("profileUserError").textContent.includes("approved_tags")');
  assert.equal(await page.evaluate('document.querySelectorAll("#profileList .profile-row").length'), 1);
  await fill('profileUser', 'Travel tags: {approved_tags}');
  const taxonomy = await page.evaluate('document.getElementById("profileTaxonomy").value');
  await fill('profileTaxonomy', '{}'); await click('profileSave');
  await page.waitFor('document.getElementById("profileTaxonomyError").textContent && !document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileTaxonomyDetails").open'), true);
  assert.equal(await page.evaluate('document.activeElement.id'), 'profileTaxonomy');
  await fill('profileTaxonomy', taxonomy); await click('profileValidate');
  await page.waitFor('document.getElementById("profileEditorNote").textContent.includes("valid.")');
  await click('profileSave'); await page.waitFor('document.getElementById("profileStatus").textContent.includes("Saved Travel") && !document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileDialog").open'), false);
  assert.equal(await page.evaluate('location.pathname'), '/settings.html');
  assert.equal(await page.evaluate('document.getElementById("profileReturn")'), null);
  const profileId = await page.evaluate('Array.from(document.querySelectorAll("#profileList .profile-row")).find(r => r.textContent.includes("Travel <test>")).dataset.profileId');
  const queued = await page.evaluate(`fetch('/api/enrich/queue', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({title:'Travel queue', filters:{day:'2026-01-01'}, })}).then(r=>r.json())`);
  assert.ok(queued.id);
  assert.equal(await page.evaluate("fetch('/api/enrich/profiles').then(r=>r.json()).then(d=>d.activeProfileId)"), initialId);
  await rowAction('edit', profileId);
  await page.waitFor('document.getElementById("profileDialog").open && !document.getElementById("profileEditorControls").disabled');
  await fill('profileSystem', 'New revision system prompt'); await click('profileSave');
  await page.waitFor('!document.getElementById("profileDialog").open && !document.getElementById("profileEditorControls").disabled');
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('location.pathname === "/enrich.html" && document.getElementById("enrichProfile")?.value');
  await page.waitFor('document.querySelector("#queueList .qitem")');
  assert.equal(await page.evaluate('document.getElementById("enrichProfile").value'), initialId);
  await page.evaluate(`document.getElementById("enrichProfile").value=${JSON.stringify(profileId)}; document.getElementById("enrichProfile").dispatchEvent(new Event('change'));`);
  await page.waitFor('!document.getElementById("enrichProfile").disabled && document.getElementById("profileNote").textContent === "Used for all new enrichment runs."');
  assert.equal(await page.evaluate('document.querySelector(".queue-profile")'), null);
  assert.doesNotMatch(await page.evaluate('document.getElementById("queueList").textContent'), /Travel <test>/);
  await page.evaluate('document.querySelector("#queueList input[type=checkbox]").checked = false');
  // Another tab changes the active profile; polling updates this tab without overriding it.
  await page.evaluate(`fetch('/api/enrich/profiles/active', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profileId:${JSON.stringify(initialId)}})}).then(r=>r.json())`);
  await page.waitFor(`document.getElementById("enrichProfile").value === ${JSON.stringify(initialId)}`);
  await page.evaluate(`document.getElementById("enrichProfile").value=${JSON.stringify(profileId)}; document.getElementById("enrichProfile").dispatchEvent(new Event('change'));`);
  await page.waitFor(`document.getElementById("enrichProfile").value === ${JSON.stringify(profileId)} && !document.getElementById("enrichProfile").disabled && document.getElementById("profileNote").textContent.startsWith("Used for")`);
  assert.equal(await page.evaluate('document.querySelector("#queueList input[type=checkbox]").checked'), false, 'profile changes retain queue options');
  if (process.env.PICTARIA_PROFILE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(`${process.env.PICTARIA_PROFILE_SCREENSHOT}.enrich.png`, Buffer.from(shot.data, 'base64'));
  }
  t.diagnostic("Profiles created, edited, and activated across tabs");
  // Real browser → HTTP → Immich/provider adapters → SQLite run.
  await page.waitFor('document.querySelector("#queueList .p-btn.accent")?.disabled === false', { label: 'queued run ready after activation' });
  await page.evaluate('document.querySelector("#queueList .p-btn.accent").click()');
  let modelTimer;
  try {
    await Promise.race([modelRequestStarted, new Promise((_, reject) => {
      modelTimer = setTimeout(() => reject(new Error('Queued run did not reach the synthetic provider')), 15000);
    })]);
  } finally { clearTimeout(modelTimer); }
  t.diagnostic("Queued run reached the provider");
  await page.waitFor('document.getElementById("viewConfigurationBtn").textContent === "View run settings" && !document.getElementById("viewConfigurationBtn").hidden');
  await click('viewConfigurationBtn');
  await page.waitFor('!document.getElementById("logPopup").hidden');
  assert.equal(await page.evaluate('document.getElementById("logPopupTitle").textContent'), 'Current run settings');
  assert.match(await page.evaluate('document.getElementById("logPopupMeta").textContent'), /Travel <test> · r2/);
  assert.match(await page.evaluate('document.getElementById("logPopupBody").textContent'), /New revision system prompt/);
  assert.equal(await page.evaluate('document.getElementById("runSettingsTechnical").open'), false);
  assert.match(await page.evaluate('document.getElementById("runSettingsIdentifiers").textContent'), /Configuration: [a-f0-9]{64}/);
  assert.doesNotMatch(await page.evaluate('document.getElementById("logPopupBody").textContent'), /Configuration: [a-f0-9]{64}/);
  await click('logPopupClose');
  await click('viewLogBtn');
  assert.equal(await page.evaluate('document.getElementById("runSettingsTechnical").hidden'), true);
  await click('logPopupClose');
  await page.evaluate(`document.getElementById("enrichProfile").value=${JSON.stringify(initialId)}; document.getElementById("enrichProfile").dispatchEvent(new Event('change'));`);
  await page.waitFor('!document.getElementById("enrichProfile").disabled');
  finishModelRequest();
  await page.waitFor('document.querySelector("#runsList .run-configuration")');
  assert.match(await page.evaluate('document.getElementById("runsList").textContent'), /Travel <test> · r2/);
  const runs = await page.evaluate("fetch('/api/enrich/runs').then(r=>r.json())");
  assert.equal(runs.runs[0].status, 'finished');
  assert.equal(runs.runs[0].counters.succeeded, 1);
  await page.waitFor('document.getElementById("viewConfigurationBtn").textContent === "View last run settings"');
  await click('viewConfigurationBtn'); await page.waitFor('!document.getElementById("logPopup").hidden');
  assert.equal(await page.evaluate('document.getElementById("logPopupTitle").textContent'), 'Last run settings');
  await click('logPopupClose');
  assert.equal(await page.evaluate('document.querySelector("#runsList .run-configuration").textContent'), 'View run settings');
  await page.evaluate('document.querySelector("#runsList .run-configuration").click()');
  await page.waitFor('!document.getElementById("logPopup").hidden');
  assert.equal(await page.evaluate('document.getElementById("logPopupTitle").textContent'), 'Run settings');
  await click('logPopupClose');
  t.diagnostic("Run completed and immutable history verified");
  await follow('profileManage');
  await page.waitFor('document.querySelector("#profileList .profile-row")');
  assert.equal(await page.evaluate('document.getElementById("profileEditor").hidden'), true);
  await rowAction('edit', profileId);
  await page.waitFor('document.getElementById("profileSystem")?.value === "New revision system prompt"');
  assert.equal(await page.evaluate('new URL(location.href).searchParams.get("profile")'), profileId);
  assert.match(await page.evaluate('document.getElementById("profileEditorTitle").textContent'), /Edit Travel <test>/);
  await backToList();
  await rowAction('archive', profileId);
  await page.waitFor('document.querySelectorAll("#profileList .profile-row").length === 1 && !document.getElementById("profileListControls").disabled');
  await page.evaluate('document.getElementById("profileArchivedSection").open = true');
  await rowAction('restore', profileId);
  await page.waitFor('document.querySelectorAll("#profileList .profile-row").length === 2 && !document.getElementById("profileListControls").disabled');
  assert.equal(await page.evaluate('document.querySelector("[data-action=default]")'), null);
  await click('profileNew'); await page.waitFor('!document.getElementById("profileCreate").hidden');
  await fill('profileCreateName', 'Built-in restored');
  assert.equal(await page.evaluate('document.getElementById("profileSource").value'), '');
  await click('profileCreateContinue');
  await page.waitFor('!document.getElementById("profileEditor").hidden && !document.getElementById("profileEditorControls").disabled');
  await click('profileSave');
  await page.waitFor('document.getElementById("profileStatus").textContent.includes("Saved Built-in") && !document.getElementById("profileEditorControls").disabled');
  // A save from another tab must not overwrite this draft or be overwritten by it.
  const builtinId = await page.evaluate('Array.from(document.querySelectorAll("#profileList .profile-row")).find(r => r.textContent.includes("Built-in restored")).dataset.profileId');
  await rowAction('edit', builtinId);
  await page.waitFor('document.getElementById("profileDialog").open && !document.getElementById("profileEditorControls").disabled');
  await page.evaluate(`(async () => {
    const profile = await fetch('/api/enrich/profiles/${builtinId}').then(r => r.json());
    const response = await fetch('/api/enrich/profiles/${builtinId}', {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({...profile, systemPrompt:'Saved in another tab', expectedRevisionId:profile.revisionId})});
    if (!response.ok) throw new Error('Concurrent edit failed');
  })()`);
  await fill('profileSystem', 'My unsaved draft'); await click('profileSave');
  await page.waitFor('document.getElementById("profileEditorNote").textContent.includes("another window") && !document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileSystem").value'), 'My unsaved draft');
  assert.match(await page.evaluate('document.getElementById("profileDirty").textContent'), /Unsaved/);
  await click('profileClose'); await page.waitFor('!document.getElementById("profileDiscardDialog").hidden');
  await click('profileDiscard');
  await page.waitFor('!document.getElementById("profileLibrary").hidden && !document.getElementById("profileListControls").disabled');
  await rowAction('edit', builtinId);
  await page.waitFor('!document.getElementById("profileEditor").hidden && !document.getElementById("profileEditorControls").disabled');
  assert.equal(await page.evaluate('document.getElementById("profileSystem").value'), 'Saved in another tab');
  // The editor is a single modal, with the profile list retained underneath.
  assert.equal(await page.evaluate('document.querySelectorAll("dialog:modal").length'), 1);
  if (process.env.PICTARIA_PROFILE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(`${process.env.PICTARIA_PROFILE_SCREENSHOT}.desktop.png`, Buffer.from(shot.data, 'base64'));
  }
  // Plain text rendering and a narrow viewport protect against prompt/name markup and overflow.
  assert.equal(await page.evaluate('document.querySelectorAll("#sec-enrichment-profiles test").length'), 0);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  if (process.env.PICTARIA_PROFILE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(process.env.PICTARIA_PROFILE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await click('profileClose');
  await page.waitFor('!document.getElementById("profileDialog").open');
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('location.pathname === "/enrich.html" && document.getElementById("enrichProfile")?.value');
  await page.waitFor('document.querySelector("#runsList .run-configuration")');
  assert.match(await page.evaluate('document.getElementById("runsList").textContent'), /Travel <test> · r2/);
  assert.equal(await page.evaluate('document.querySelectorAll("#profilePanel test, #runsList test").length'), 0);
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  // A stale edit link must not silently open the default profile for editing.
  await page.navigate(`${server.base}/settings.html?profile=missing#sec-enrichment-profiles`);
  await page.waitFor('document.getElementById("profileStatus")?.textContent.includes("unavailable")');
  assert.equal(await page.evaluate('document.getElementById("profileEditor").hidden'), true);
});
