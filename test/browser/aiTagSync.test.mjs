import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sampleOutput } from '../enrich/helpers.mjs';
import { bootServer, findChrome, launchChrome } from './harness.mjs';

// Real dashboard -> production routes/job runner -> provider -> durable
// worker -> fake Immich. No private library or provider credentials used.
test('Enrich-only success survives tag outage and the Enrich retry button syncs without another AI call', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'pic347-browser-'));
  const assetId = '00000000-0000-0000-0000-000000000001';
  let server, browser, allowTags = false, inferenceCalls = 0;
  const tags = new Set(); const photoTags = new Set(['frame/never-show', 'holiday']);
  const fake = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fake').pathname;
    let body = ''; for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path.endsWith('/chat/completions')) { inferenceCalls++; return json({ choices: [{ message: { content: JSON.stringify(sampleOutput()) } }] }); }
    if (path.includes('/thumbnail')) { response.writeHead(200, { 'Content-Type': 'image/jpeg' }); return response.end(Buffer.from('synthetic photo')); }
    if (path === `/api/assets/${assetId}`) return json({ id: assetId, type: 'IMAGE', isArchived: false, isTrashed: false, tags: [...photoTags].map(value => ({ id: value, value })) });
    if (path.startsWith('/api/tags')) {
      if (!allowTags) return json({ message: 'Synthetic tag-service outage' }, 503);
      if (path === '/api/tags' && request.method === 'GET') return json([...tags].map(value => ({ id: value, value })));
      if (path === '/api/tags' && request.method === 'PUT') { input.tags.forEach(tag => tags.add(tag)); return json(input.tags.map(value => ({ id: value, value }))); }
      if (path === '/api/tags/assets') { input.tagIds.forEach(tag => photoTags.add(tag)); return json({ count: 1 }); }
    }
    if (path === '/api/server/version') return json({ major: 3, minor: 1, patch: 0 });
    if (path === '/api/server/ping') return json({ res: 'pong' });
    return json([]);
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await Promise.allSettled([browser?.stop(), server?.stop()]);
    fake.closeAllConnections(); await new Promise(resolve => fake.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${fake.address().port}`;
  server = await bootServer(dir, { env: { ENRICH_ENABLED: 'true', IMMICH_BASE_URL: base, IMMICH_API_KEY: 'synthetic',
    DEFAULT_PROVIDER: 'local_lmstudio', LMSTUDIO_BASE_URL: `${base}/v1`, LMSTUDIO_MODEL: 'synthetic-model' } });
  browser = await launchChrome(); const page = await browser.newPage();
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret"; document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('!document.querySelector(".gate-backdrop")');
  const result = await page.evaluate(`(async()=>{const r=await fetch('/api/enrich/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'local_lmstudio',assetIds:['${assetId}'],sendToCurate:false})});return {status:r.status,body:await r.json()}})()`);
  assert.equal(result.status, 202, JSON.stringify(result));
  await page.waitFor('document.getElementById("tagSyncStatus").textContent.includes("1 pending") && !document.getElementById("tagSyncRetry").hidden');
  assert.match(await page.evaluate('document.getElementById("tagSyncError").textContent'), /^Immich:/);
  assert.equal(inferenceCalls, 1);
  const succeeded = await page.evaluate("(async()=>{const s=await(await fetch('/api/enrich/status')).json();return s.liveCounters.succeeded})()");
  assert.equal(succeeded, 1);
  allowTags = true; await page.evaluate('document.getElementById("tagSyncRetry").click()');
  try {
  await page.waitFor('document.getElementById("tagSyncStatus").textContent.includes("0 pending") && document.getElementById("tagSyncRetry").hidden');
  } catch (error) {
    t.diagnostic(JSON.stringify(await page.evaluate("(async()=>({sync:(await(await fetch('/api/enrich/status')).json()).tagSync, text:document.getElementById('tagSyncError').textContent}))()")));
    throw error;
  }
  assert.equal(inferenceCalls, 1);
  assert.ok(photoTags.has('ai/scene/mountains')); assert.ok(photoTags.has('frame/never-show')); assert.ok(photoTags.has('holiday'));
  assert.ok(!photoTags.has('frame/eligible'));
  if (process.env.PICTARIA_SYNC_SCREENSHOT) {
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.PICTARIA_SYNC_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
});
