import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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
    // Read on every request, so photos can be added once the settings are saved.
    const assets = [];
    immich = await startFakeImmich({ assets, serveAssetDetails: true });
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
    await page.waitFor('document.getElementById("embeddingsCoverage").textContent.includes("0 of 0 enriched photos have embeddings")');

    // Test uses the unsaved draft values and stores nothing.
    await page.evaluate(`${input('embeddingsModel')}.closest('details').open = true; ${input('embeddingsUrl')}.value = ${JSON.stringify(ml.url)};`);
    await page.evaluate('document.getElementById("embeddingsTest").click()');
    await page.waitFor('document.getElementById("embeddingsTestNote").textContent.startsWith("Connected")');
    assert.match(await page.evaluate('document.getElementById("embeddingsTestNote").textContent'), /^Connected in \d+ ms\. Save to use these settings\.$/);
    assert.equal(await page.evaluate('document.getElementById("embeddingsTestNote").className'), 'save-note ok');
    assert.deepEqual(ml.state.requests.map((request) => request.model), ['ViT-B-32__openai']);
    assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enrich?.embeddingsUrl, undefined);

    // A bad model name is reported without a save.
    await page.evaluate(`${input('embeddingsModel')}.value = 'Unknown__model'; document.getElementById("embeddingsTest").click()`);
    await page.waitFor('document.getElementById("embeddingsTestNote").classList.contains("bad")');
    assert.equal(await page.evaluate('document.getElementById("embeddingsTestNote").classList.contains("ok")'), false);
    assert.match(await page.evaluate('document.getElementById("embeddingsTestNote").textContent'), /could not process the request/);

    await page.evaluate(`${input('embeddingsModel')}.value = 'ViT-B-32__openai'; ${input('embeddingsEnabled')}.click(); document.querySelector('#save-enrich').click()`);
    await page.waitFor('document.querySelector("#note-enrich").textContent.includes("Saved")');
    const saved = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).enrich;
    assert.equal(saved.embeddingsEnabled, true);
    assert.equal(saved.embeddingsUrl, ml.url);
    assert.equal(Object.hasOwn(saved, 'embeddingsModel'), false, 'an unchanged default is not stored as an override');

    // Embed enriched photos (PIC-391): three photos enriched earlier, one press.
    const text = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
    const db = new DatabaseSync(join(dir, 'enrichment.sqlite'));
    db.exec('PRAGMA busy_timeout = 5000');
    const now = new Date().toISOString();
    for (let i = 1; i <= 3; i++) {
      const asset = { id: `00000000-0000-4000-8000-00000000000${i}`, type: 'IMAGE', originalFileName: `photo-${i}.jpg`,
        checksum: `sum-${i}`, thumbhash: `hash-${i}`, fileCreatedAt: `2026-09-0${i}T12:00:00.000Z` };
      assets.push(asset);
      db.prepare(`INSERT OR IGNORE INTO assets (asset_id, checksum, thumbhash, file_created_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(asset.id, asset.checksum, asset.thumbhash, asset.fileCreatedAt, now, now);
      db.prepare('INSERT OR REPLACE INTO latest_success (asset_id, run_id) VALUES (?, ?)').run(asset.id, i);
    }
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 2_100)); // enriched counts are cached for two seconds
    // A query string makes this a real reload rather than a same-page hash change.
    await page.navigate(`${server.base}/settings.html?embed=1#sec-enrich`);
    await page.waitFor(`document.getElementById("embeddingsBackfillStart")?.textContent === "Embed 3 enriched photos"
      && !document.getElementById("embeddingsBackfillStart").disabled`);
    assert.match(await text('embeddingsCoverage'), /^ViT-B-32__openai: 0 of 3 enriched photos have embeddings\./);
    // One status check fails mid-job (a restart, a dropped connection): the
    // panel says so, keeps checking and catches up on its own.
    ml.state.slowAfter = ml.state.requests.length + 1; // the calibration answers at once, each photo takes 1.5 s
    ml.state.slowMs = 1500;
    await page.evaluate(`(() => {
      const realFetch = window.fetch;
      let checks = 0;
      window.failedStatusChecks = 0;
      window.fetch = (url, options) => {
        if (url === '/api/enrich/embeddings' && ++checks === 2) {
          window.failedStatusChecks++;
          return Promise.reject(new TypeError('Failed to fetch'));
        }
        return realFetch(url, options);
      };
    })()`);
    await page.evaluate('document.getElementById("embeddingsBackfillStart").click()');
    await page.waitFor('document.getElementById("embeddingsBackfillNote").textContent.startsWith("Could not get progress from Pictaria Server.")');
    assert.equal(await page.evaluate('document.getElementById("embeddingsBackfillNote").className'), 'save-note bad');
    assert.equal(await page.evaluate('document.getElementById("embeddingsBackfillStop").hidden'), false, 'the job is still running');
    await page.waitFor('document.getElementById("embeddingsBackfillNote").textContent.includes("3 embedded")', { timeoutMs: 20000 });
    ml.state.slowMs = 0;
    assert.equal(await page.evaluate('window.failedStatusChecks'), 1);
    assert.equal(await page.evaluate('document.getElementById("embeddingsBackfillNote").className'), 'save-note ok');
    assert.match(await text('embeddingsBackfillNote'), /^3 embedded · finished /);
    assert.match(await text('embeddingsCoverage'), /^ViT-B-32__openai: 3 of 3 enriched photos have embeddings\./);
    assert.equal(await page.evaluate('document.getElementById("embeddingsBackfillStart").hidden'), true, 'nothing left to embed');
    assert.equal(await page.evaluate('document.getElementById("embeddingsBackfillStop").hidden'), true);
    // Stored embedding sets (PIC-390).
    const rows = await page.evaluate('[...document.querySelectorAll("#embeddingsSets tbody tr")].map((row) => [...row.cells].map((cell) => cell.textContent))');
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0][0], rows[0][1], rows[0][2], rows[0][3], rows[0][5]], ['ViT-B-32__openai', '512', '3', '0', 'In use']);

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
      /^ViT-B-32__openai · 3 photos with current embeddings/);
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'enrich at phone width');

    ml.state.pong = 'not immich';
    await page.navigate(`${server.base}/`);
    await page.waitFor('!document.getElementById("mlStatus").hidden');
    assert.equal(await page.evaluate('document.getElementById("mlLine").textContent'), 'Machine learning connected · ViT-B-32__openai',
      'the home page reuses the cached check for a minute');
  });
