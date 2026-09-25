import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { aiBackendKey } from '../../src/curate/ai-limits.mjs';
import { ProviderRequestError } from '../../src/enrich/providers.mjs';
import { bootServer, findChrome, launchChrome } from './harness.mjs';

test('Settings verifies a paused saved AI connection through authenticated scheduling without using library photos', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'ai-connections-browser-'));
  let server, browser, repo; const requests = [];
  const fake = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  t.after(async () => {
    await Promise.allSettled([browser?.stop(), server?.stop()]);
    repo?.close(); await new Promise(resolve => fake.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${fake.address().port}/v1`;
  const key = aiBackendKey({ providerName: 'local_lmstudio', baseUrl, modelName: 'synthetic', apiKey: 'test-key' });
  repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  const ticket = repo.curate.aiLimits.startProvider(key);
  repo.curate.aiLimits.finish(ticket, new ProviderRequestError('synthetic auth failure', { status: 401 }));
  repo.close(); repo = null;
  const env = { DEFAULT_PROVIDER: 'local_lmstudio', LMSTUDIO_BASE_URL: baseUrl, LMSTUDIO_MODEL: 'synthetic', LMSTUDIO_API_KEY: 'test-key',
    ENRICH_ENABLED: 'false', CURATE_REFEREE_ENABLED: 'false' };
  server = await bootServer(dir, { env });
  assert.equal((await fetch(`${server.base}/api/ai/connections/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'enrich' }) })).status, 401);
  await assert.rejects(bootServer(dir, { env }), /Another server may already be using it/);
  browser = await launchChrome(); const page = await browser.newPage();
  await page.navigate(`${server.base}/settings.html#sec-providers`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector("#ai-connection-enrich")?.textContent.includes("API key")');
  assert.equal(requests.length, 0, 'page/status read must not test the model');
  assert.equal(await page.evaluate(`fetch('/api/ai/connections/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:'enrich',baseUrl:'http://forbidden.test'})}).then(r=>r.status)`), 400);
  await page.evaluate('document.querySelector("#verify-ai-enrich").click()');
  await page.waitFor('document.querySelector("#ai-verification-note").textContent.includes("Connection verified")');
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /synthetic test image/);
  assert.match(await page.evaluate('document.querySelector("#ai-connection-curate").textContent'), /Ready/);
  for (const [name, width, height] of [['desktop', 1400, 1000], ['phone', 390, 844]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await page.evaluate('document.querySelector("#ai-connection-enrich").scrollIntoView({block:"center"})');
    assert.equal(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, name);
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, `ai-connections-${name}.png`), Buffer.from(data, 'base64'));
    }
  }
  await server.stop(); server = null;
  // An interrupted ordinary request gets one delayed recovery on real startup;
  // a repeated restart preserves that deadline and cannot clear the marker.
  repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema();
  assert.equal(repo.curate.aiLimits.startProvider(key).state, 'started');
  repo.close(); repo = null;
  server = await bootServer(dir, { env });
  const getStatus = () => fetch(`${server.base}/api/ai/connections`, { headers: { Authorization: 'Bearer smoke-secret' } }).then(r => r.json());
  const first = (await getStatus()).connections[0];
  assert.equal(first.state, 'cooldown'); assert.equal(first.reason, 'interrupted');
  await server.stop(); server = null;
  server = await bootServer(dir, { env });
  assert.equal((await getStatus()).connections[0].retryAt, first.retryAt);
  assert.equal(requests.length, 1, 'restarts do not initiate test requests');
});
