import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';
import { startFakeMl } from '../embeddings/fakeMl.mjs';

test('image embeddings are configured in Settings → Enrich, tested with draft values and shown on Home and Enrich',
  { timeout: 90000 }, async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const dir = mkdtempSync(join(tmpdir(), 'embeddings-browser-'));
    let server, browser, immich, ml;
    t.after(async () => {
      await Promise.allSettled([browser?.stop(), server?.stop(), immich?.stop(), ml?.close()]);
      rmSync(dir, { recursive: true, force: true });
    });
    immich = await startFakeImmich({ assets: [] });
    ml = await startFakeMl();
    server = await bootServer(dir, { env: { IMMICH_BASE_URL: immich.base, IMMICH_API_KEY: 'synthetic', ENRICH_ENABLED: 'true' } });
    browser = await launchChrome();
    const page = await browser.newPage();
    const input = (key) => `document.getElementById('f2-enrich-${key}')`;

    await page.navigate(`${server.base}/settings.html#sec-enrich`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor(`${input('embeddingsModel')} && document.querySelector('#sec-enrich').open`);
    // Off by default, with Immich's own model as the default.
    assert.equal(await page.evaluate(`${input('embeddingsEnabled')}.checked`), false);
    assert.equal(await page.evaluate(`${input('embeddingsModel')}.value`), 'ViT-B-32__openai');
    assert.equal(await page.evaluate(`${input('embeddingsModel')}.closest('details.sub-details').querySelector('summary .sub-head').textContent`),
      'Image embeddings');
    assert.equal(await page.evaluate(`${input('embeddingsModel')}.closest('details').contains(document.getElementById('embeddingsTools'))`), true);
    await page.waitFor('document.getElementById("embeddingsCoverage").textContent.includes("No embeddings stored")');

    // Test uses the unsaved draft values and stores nothing.
    await page.evaluate(`${input('embeddingsModel')}.closest('details').open = true; ${input('embeddingsUrl')}.value = ${JSON.stringify(ml.url)};`);
    await page.evaluate('document.getElementById("embeddingsTest").click()');
    await page.waitFor('document.getElementById("embeddingsTestNote").textContent.startsWith("Connected")');
    assert.match(await page.evaluate('document.getElementById("embeddingsTestNote").textContent'),
      /ViT-B-32__openai returned a 512-dimension embedding/);
    assert.deepEqual(ml.state.requests.map((request) => request.model), ['ViT-B-32__openai']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enrich?.embeddingsUrl, undefined);

    // A bad model name is reported without a save.
    await page.evaluate(`${input('embeddingsModel')}.value = 'Unknown__model'; document.getElementById("embeddingsTest").click()`);
    await page.waitFor('document.getElementById("embeddingsTestNote").classList.contains("bad")');
    assert.match(await page.evaluate('document.getElementById("embeddingsTestNote").textContent'), /could not process the request/);

    await page.evaluate(`${input('embeddingsModel')}.value = 'ViT-B-32__openai'; ${input('embeddingsEnabled')}.click(); document.querySelector('#save-enrich').click()`);
    await page.waitFor('document.querySelector("#note-enrich").textContent.includes("Saved")');
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enrich;
    assert.equal(saved.embeddingsEnabled, true);
    assert.equal(saved.embeddingsUrl, ml.url);
    assert.equal(Object.hasOwn(saved, 'embeddingsModel'), false, 'an unchanged default is not stored as an override');

    for (const [width, height] of [[1280, 900], [390, 844]]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 500 });
      assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `settings at ${width}px`);
    }

    await page.navigate(`${server.base}/`);
    await page.waitFor('!document.getElementById("mlStatus").hidden');
    assert.equal(await page.evaluate('document.getElementById("mlLine").textContent'), 'Machine learning connected · ViT-B-32__openai');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'home at phone width');

    await page.navigate(`${server.base}/enrich.html`);
    await page.waitFor('!document.getElementById("embeddingsRow").hidden');
    assert.match(await page.evaluate('document.getElementById("embeddingsStatus").textContent'),
      /^ViT-B-32__openai · 0 photos with current embeddings/);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'enrich at phone width');

    ml.state.pong = 'not immich';
    await page.navigate(`${server.base}/`);
    await page.waitFor('!document.getElementById("mlStatus").hidden');
    assert.equal(await page.evaluate('document.getElementById("mlLine").textContent'), 'Machine learning connected · ViT-B-32__openai',
      'the home page reuses the cached check for a minute');
  });
