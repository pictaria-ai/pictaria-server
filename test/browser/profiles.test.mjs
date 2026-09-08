import test from 'node:test';
import { createServer } from 'node:http';
import { sampleOutput } from '../enrich/helpers.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

test('Settings manages profiles; Enrich previews, preserves selection, pins queue revisions, and runs without losing history', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-profile-browser-'));
  let server, browser, immich, model;
  t.after(async () => {
    await Promise.allSettled([browser?.stop(), server?.stop(), immich?.stop()]);
    if (model) await new Promise(resolve => model.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const asset = { id: '00000000-0000-0000-0000-000000000001', type: 'IMAGE', originalFileName: 'test.jpg',
    localDateTime: '2026-01-01T12:00:00Z', exifInfo: { city: 'Paris' } };
  immich = await startFakeImmich({ assets: [asset], serveAssetDetails: true });
  model = createServer((request, response) => {
    request.resume(); request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] }));
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
  const fill = (id, value) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).value = ${JSON.stringify(value)}`);
  const follow = async id => page.navigate(await page.evaluate(`document.getElementById(${JSON.stringify(id)}).href`));
  assert.equal(await page.evaluate('document.querySelector("#profileEditor, #profileNew, #profileArchive")'), null);
  assert.equal(await page.evaluate('document.getElementById("taxPanel").hidden'), true);
  await click('profileView');
  await page.waitFor('!document.getElementById("taxPanel").hidden && document.querySelector("#taxBody pre")');
  assert.equal(await page.evaluate('document.getElementById("profileView").getAttribute("aria-expanded")'), 'true');
  await click('profileView');
  assert.equal(await page.evaluate('document.getElementById("taxPanel").hidden'), true);
  await follow('profileEdit');
  await page.waitFor('document.getElementById("sec-enrichment-profiles")?.open && !document.getElementById("profileEditor").hidden');
  await click('profileDuplicate'); await page.waitFor('document.getElementById("profileEditorTitle").textContent.includes("Create")');
  await fill('profileName', 'Travel <test>'); await fill('profileUser', 'Invalid template'); await click('profileSave');
  await page.waitFor('document.getElementById("profileEditorNote").textContent.includes("approved_tags")');
  assert.equal(await page.evaluate('document.querySelectorAll("#enrichProfile option").length'), 1);
  await fill('profileUser', 'Travel tags: {approved_tags}'); await click('profileValidate');
  await page.waitFor('document.getElementById("profileEditorNote").textContent.includes("valid.")');
  await click('profileSave'); await page.waitFor('document.querySelectorAll("#enrichProfile option").length === 2 && !document.getElementById("profileSave").disabled');
  const profileId = await page.evaluate('document.getElementById("enrichProfile").value');
  const queued = await page.evaluate(`fetch('/api/enrich/queue', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({title:'Travel queue', filters:{day:'2026-01-01'}, profileId:${JSON.stringify(profileId)}})}).then(r=>r.json())`);
  assert.ok(queued.id);
  await fill('profileSystem', 'New revision system prompt'); await click('profileSave');
  await page.waitFor('document.getElementById("profileEditorNote").textContent.includes("r2")');
  await follow('profileReturn');
  await page.waitFor('document.querySelector("#queueList .queue-profile")');
  assert.equal(await page.evaluate('document.getElementById("enrichProfile").value'), profileId);
  await click('profileView');
  await page.waitFor('document.getElementById("taxBody").textContent.includes("New revision system prompt")');
  assert.match(await page.evaluate('document.getElementById("queueList").textContent'), /Travel <test> · r1/);
  await page.evaluate('document.querySelector("#queueList .queue-profile").click()');
  await page.waitFor('document.getElementById("queueList").textContent.includes("Travel <test> · r2")');
  // Real browser → HTTP → Immich/provider adapters → SQLite run.
  await page.evaluate('document.querySelector("#queueList .p-btn.accent").click()');
  await page.waitFor('document.querySelector("#runsList .run-configuration")');
  assert.match(await page.evaluate('document.getElementById("runsList").textContent'), /Travel <test> · r2/);
  const runs = await page.evaluate("fetch('/api/enrich/runs').then(r=>r.json())");
  assert.equal(runs.runs[0].status, 'finished');
  assert.equal(runs.runs[0].counters.succeeded, 1);
  await follow('profileEdit');
  await page.waitFor('document.getElementById("profileSystem")?.value === "New revision system prompt"');
  assert.equal(await page.evaluate('document.getElementById("enrichProfile").value'), profileId);
  assert.match(await page.evaluate('document.getElementById("profileEditorTitle").textContent'), /Travel <test> · r2/);
  await click('profileArchive');
  await page.waitFor('document.querySelectorAll("#enrichProfile option").length === 1');
  await click('profileRestore'); await page.waitFor('document.querySelectorAll("#enrichProfile option").length === 2');
  await click('profileDefault'); await page.waitFor('document.getElementById("profileDefault").disabled');
  await click('profileNew'); await page.waitFor('document.getElementById("profileEditorTitle").textContent.includes("Create")');
  await fill('profileName', 'Built-in restored'); await click('profileSave');
  await page.waitFor('document.querySelectorAll("#enrichProfile option").length === 3');
  // Plain text rendering and a narrow viewport protect against prompt/name markup and overflow.
  assert.equal(await page.evaluate('document.querySelectorAll("#sec-enrichment-profiles test").length'), 0);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  if (process.env.PICTARIA_PROFILE_SCREENSHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    writeFileSync(process.env.PICTARIA_PROFILE_SCREENSHOT, Buffer.from(shot.data, 'base64'));
  }
  await follow('profileReturn');
  await page.waitFor('document.querySelector("#runsList .run-configuration")');
  assert.match(await page.evaluate('document.getElementById("runsList").textContent'), /Travel <test> · r2/);
  assert.equal(await page.evaluate('document.querySelectorAll("#profilePanel test, #runsList test").length'), 0);
  assert.equal(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
  // A stale edit link must not silently open the default profile for editing.
  await page.navigate(`${server.base}/settings.html?profile=missing#sec-enrichment-profiles`);
  await page.waitFor('document.getElementById("profileStatus")?.textContent.includes("unavailable")');
  assert.equal(await page.evaluate('document.getElementById("profileEditor").hidden'), true);
});
