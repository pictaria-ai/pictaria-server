import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findChrome, launchChrome, ROOT } from './harness.mjs';

const pages = ['settings', 'index', 'enrich', 'remote', 'curate', 'insights', 'albums',
  'metrics', 'activity', 'curate-preview', 'curate-stacking-lab', 'enrich-performance'];

test('early 401s always have a password gate, including before the body exists', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const timers = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    if (path === '/early-gate.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><head><script src="/auth-gate.js"></script><script>window.pictariaGate.show();window.pictariaGate.show();</script></head><body>Early caller</body>');
      return;
    }
    // Only fixed same-origin public files are served. API answers are supplied
    // below as immediately resolved 401s to force the original startup race.
    if (path.includes('..')) { response.writeHead(404); response.end(); return; }
    let body;
    try { body = readFileSync(join(ROOT, 'public', path)); }
    catch { response.writeHead(404); response.end(); return; }
    const send = () => {
      response.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript'
        : path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
      response.end(body);
    };
    // A deferred gate loads after inline callers; a parser-blocking gate must
    // finish first. Slow only this resource, not the app or its 401 answers.
    if (path === '/auth-gate.js') {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 300);
      timers.add(timer);
    } else send();
  });
  let browser;
  t.after(async () => {
    for (const timer of timers) clearTimeout(timer);
    await browser?.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await launchChrome(); const page = await browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.startupErrors=[];
    addEventListener('error', e=>startupErrors.push(e.message));
    addEventListener('unhandledrejection', e=>startupErrors.push(String(e.reason)));
    const realFetch=window.fetch;
    window.fetch=(input,...rest)=>{
      const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
      if(path==='/api/health')return Promise.resolve(Response.json({authRequired:true}));
      if(path.startsWith('/api/'))return Promise.resolve(Response.json({error:'Unauthorized'},{status:401}));
      return realFetch(input,...rest);
    };
  ` });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const name of [...pages, 'early-gate']) {
    await page.navigate(`${base}/${name}.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")', { timeoutMs: 2000, label: `${name} login prompt` });
    assert.equal(await page.evaluate('document.querySelectorAll(".gate-backdrop").length'), 1, name);
    assert.equal(await page.evaluate('document.querySelector(".gate-backdrop").hidden'), false, name);
    assert.deepEqual(await page.evaluate('startupErrors.filter(s=>/pictariaGate|reading.*show|reading.*append/.test(s))'), [], name);
    // Duplicate 401s / head calls must not make duplicate dialogs.
    await page.evaluate('window.pictariaGate.show();window.pictariaGate.show()');
    assert.equal(await page.evaluate('document.querySelectorAll(".gate-backdrop").length'), 1, name);
    assert.equal(await page.evaluate('document.activeElement===document.querySelector(".gate-backdrop input")'), true, name);
  }
});
