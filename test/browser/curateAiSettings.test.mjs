import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

test('Curate settings enable Stack Referee independently, keep Photo Referee unavailable, and fit desktop and phone', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'curate-ai-browser-'));
  let server, browser, immich;
  t.after(async () => {
    await Promise.allSettled([browser?.stop(), server?.stop(), immich?.stop()]);
    rmSync(dir, { recursive: true, force: true });
  });
  immich = await startFakeImmich({ assets: [] });
  server = await bootServer(dir, { env: { IMMICH_BASE_URL: immich.base, IMMICH_API_KEY: 'synthetic',
    ENRICH_ENABLED: 'false', CURATE_REFEREE_ENABLED: 'false',
    DEFAULT_PROVIDER: 'venice', VENICE_API_KEY: 'synthetic', VENICE_MODEL: 'qwen3-vl-235b-a22b',
    OPENAI_API_KEY: 'synthetic', OPENAI_MODEL: 'gpt-4.1-mini',
    CURATE_STACK_REFEREE_ENABLED: 'true', CURATE_KEEPER_REFEREE_ENABLED: 'true' } });
  browser = await launchChrome(); const page = await browser.newPage();
  const input = key => `document.getElementById('f2-curate-${key}')`;
  const click = key => page.evaluate(`${input(key)}.click()`);
  await page.navigate(`${server.base}/settings.html#sec-curate`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor(`${input('stackRefereeEnabled')} && document.querySelector('#sec-curate').open`);
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.checked`), true);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.disabled`), false);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.value`), 'uncertain');
  assert.match(await page.evaluate('document.querySelector("#curate-stack-model").textContent'), /Venice.*qwen3-vl-235b-a22b.*10 photos/);
  assert.match(await page.evaluate('document.querySelector("#fields-curate").textContent'), /Not available in Curate Preview yet/);
  assert.equal(await page.evaluate(`${input('refereeEnabled')}.disabled`), true, 'legacy still requires Enrich');
  // Image embeddings in Stacks (PIC-392): on by default, waiting for Image embeddings.
  assert.equal(await page.evaluate(`${input('embeddingStacks')}.checked && !${input('embeddingStacks')}.disabled`), true);
  assert.match(await page.evaluate('document.querySelector("#curate-state-embeddingStacks").textContent'), /once Image embeddings is on/);
  // Master toggle pauses both preferences without erasing them.
  await click('burstGrouping');
  for (const key of ['stackRefereeEnabled', 'keeperRefereeEnabled', 'embeddingStacks']) {
    assert.equal(await page.evaluate(`${input(key)}.checked && ${input(key)}.disabled`), true);
  }
  assert.match(await page.evaluate('document.querySelector("#curate-state-embeddingStacks").textContent'), /Paused while Stacks is off/);
  assert.equal(await page.evaluate(`${input('refereeProvider')}.disabled`), true);
  await click('burstGrouping');
  // Both saved preferences can be turned off; only Stack Referee can be re-enabled.
  await click('stackRefereeEnabled'); await click('keeperRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.disabled`), false, 'unsaved opt-out can be reversed');
  await click('stackRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.checked`), true);
  await click('stackRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.closest('.field').hidden`), true);
  await click('embeddingStacks');
  await page.evaluate('document.querySelector("#save-curate").click()');
  await page.waitFor('document.querySelector("#note-curate").textContent.includes("Saved")');
  assert.equal(await page.evaluate("fetch('/api/settings').then(r => r.json()).then(s => s.curate.embeddingStacks.value)"), false,
    'the opt-out is saved');
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.disabled`), false);
  assert.equal(await page.evaluate(`${input('keeperRefereeEnabled')}.disabled`), true);
  assert.doesNotMatch(await page.evaluate('document.querySelector("#curate-state-stackRefereeEnabled").textContent'), /Your preference is saved/);
  const result = await page.evaluate(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({curate:{keeperRefereeEnabled:true}})}).then(r=>r.status)`);
  assert.equal(result, 400, 'the server also rejects unavailable activation');

  // Exercise the real Settings API; no simulated availability response.
  await click('stackRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.closest('.field').hidden`), false);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.disabled`), false);
  await page.evaluate(`${input('stackRefereeScope')}.value='all';${input('stackRefereeScope')}.dispatchEvent(new Event('change'))`);
  await page.evaluate(`${input('refereeProvider')}.value='cloud_openai';${input('refereeProvider')}.dispatchEvent(new Event('change'));${input('refereeModel')}.value='my-vision-model';${input('refereeModel')}.dispatchEvent(new Event('change'))`);
  assert.match(await page.evaluate('document.querySelector("#curate-stack-model").textContent'), /Save to apply/);
  await click('burstGrouping'); await click('burstGrouping');
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.value`), 'all');
  assert.equal(await page.evaluate(`${input('keeperRefereeEnabled')}.checked`), false);
  assert.equal(await page.evaluate(`${input('keeperRefereeEnabled')}.disabled`), true);
  assert.equal(await page.evaluate("document.querySelector('#f2-enrich-enabled').checked"), false, 'new roles are independent of Enrich');
  await page.evaluate('document.querySelector("#save-curate").click()');
  await page.waitFor('document.querySelector("#note-curate").textContent.includes("Saved")');
  await page.navigate(`${server.base}/settings.html?saved=stack#sec-curate`);
  await page.waitFor(`${input('stackRefereeEnabled')} && ${input('stackRefereeEnabled')}.checked`);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.value`), 'all');
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.disabled`), false);
  assert.equal(await page.evaluate(`${input('keeperRefereeEnabled')}.disabled`), true);
  assert.match(await page.evaluate('document.querySelector("#curate-stack-model").textContent'), /OpenAI.*my-vision-model.*10 photos/);
  assert.doesNotMatch(await page.evaluate('document.querySelector("#curate-stack-model").textContent'), /Save to apply|Venice|not supported/);
  for (const [name, width, height] of [['desktop', 1400, 1100], ['phone', 390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector("#sec-curate").scrollIntoView()');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, name);
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, `curate-ai-settings-${name}.png`), Buffer.from(data, 'base64'));
    }
  }
});
