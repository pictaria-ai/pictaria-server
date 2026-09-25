import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

test('Curate AI settings distinguish unavailable workers, preserve preferences and lay out on desktop and phone', { timeout: 60000 }, async t => {
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
    CURATE_STACK_REFEREE_ENABLED: 'true', CURATE_KEEPER_REFEREE_ENABLED: 'true' } });
  browser = await launchChrome(); const page = await browser.newPage();
  const input = key => `document.getElementById('f2-curate-${key}')`;
  const click = key => page.evaluate(`${input(key)}.click()`);
  await page.navigate(`${server.base}/settings.html#sec-curate`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor(`${input('stackRefereeEnabled')} && document.querySelector('#sec-curate').open`);
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.checked`), true);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.disabled`), true);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.value`), 'uncertain');
  assert.match(await page.evaluate('document.querySelector("#fields-curate").textContent'), /Not available in Curate Preview yet/);
  assert.doesNotMatch(await page.evaluate('document.querySelector("#sub-curate").textContent'), /Referee on/);
  assert.equal(await page.evaluate(`${input('refereeEnabled')}.disabled`), true, 'legacy still requires Enrich');
  // Master toggle preserves both preferences, even though their workers are unavailable.
  await click('burstGrouping');
  for (const key of ['stackRefereeEnabled', 'keeperRefereeEnabled']) {
    assert.equal(await page.evaluate(`${input(key)}.checked && ${input(key)}.disabled`), true);
  }
  assert.equal(await page.evaluate(`${input('refereeProvider')}.disabled`), true);
  await click('burstGrouping');
  // Permit opting out of a previously saved/on preference before integration.
  await click('stackRefereeEnabled'); await click('keeperRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeEnabled')}.disabled`), true);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.closest('.field').hidden`), true);
  await page.evaluate('document.querySelector("#save-curate").click()');
  await page.waitFor('document.querySelector("#note-curate").textContent.includes("Saved")');
  const result = await page.evaluate(`fetch('/api/settings',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({curate:{stackRefereeEnabled:true}})}).then(r=>r.status)`);
  assert.equal(result, 400, 'the server also rejects unavailable activation');

  // Simulate future worker availability only in this renderer fixture. No AI
  // worker is activated and backend availability/migration has its own tests.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
    const realFetch=window.fetch; window.fetch=async(...args)=>{
      const response=await realFetch(...args);
      if(args[0]==='/api/settings' && (!args[1]?.method || args[1].method==='GET') && response.ok){
        const data=await response.json();
        for(const key of ['stackRefereeEnabled','keeperRefereeEnabled']){
          data.curate[key].available=true; data.curate[key].availabilityNotice='';
        }
        return new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
      } return response;
    };
  }` });
  await page.navigate(`${server.base}/settings.html?fixture=available#sec-curate`);
  await page.waitFor(`${input('stackRefereeEnabled')} && !${input('stackRefereeEnabled')}.disabled`);
  await click('stackRefereeEnabled');
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.closest('.field').hidden`), false);
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.disabled`), false);
  await page.evaluate(`${input('stackRefereeScope')}.value='all';${input('stackRefereeScope')}.dispatchEvent(new Event('change'))`);
  await click('keeperRefereeEnabled');
  await click('burstGrouping'); await click('burstGrouping');
  assert.equal(await page.evaluate(`${input('stackRefereeScope')}.value`), 'all');
  assert.equal(await page.evaluate(`${input('keeperRefereeEnabled')}.checked && !${input('keeperRefereeEnabled')}.disabled`), true);
  assert.equal(await page.evaluate("document.querySelector('#f2-enrich-enabled').checked"), false, 'new roles are independent of Enrich');
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
