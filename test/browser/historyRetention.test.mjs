import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Repository } from '../../src/enrich/repository.mjs';
import { bootServer, findChrome, launchChrome } from './harness.mjs';

test('Settings confirms history reduction, applies it immediately, and keeps Enrich history available while disabled', { timeout: 60000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-history-browser-'));
  let server, browser;
  t.after(async () => { await Promise.allSettled([browser?.stop(), server?.stop()]); rmSync(dir, { recursive: true, force: true }); });
  const repo = new Repository(join(dir, 'enrichment.sqlite')); repo.initSchema(); repo.setHistoryRetention({ runs: 1000, logs: 100 });
  for (let n = 0; n < 150; n++) repo.recordJobRun({ title: `Run ${n}`, provider: 'venice', status: 'finished',
    log: ['Saved log'], startedAt: '2026-09-01', finishedAt: '2026-09-01' });
  repo.close();
  server = await bootServer(dir, { env: { ENRICH_ENABLED: 'false', ENRICH_HISTORY_RUNS: '1000' } });
  browser = await launchChrome(); const page = await browser.newPage();
  await page.navigate(`${server.base}/enrich.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret"; document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('!document.querySelector(".gate-backdrop")');
  await page.navigate(`${server.base}/settings.html#sec-enrich`);
  await page.waitFor('document.getElementById("f2-enrich-historyRuns")?.value === "1000" && !document.querySelector(".gate-backdrop")');
  assert.equal(await page.evaluate('document.getElementById("f2-enrich-historyRuns").disabled'), false);
  const retained = () => page.evaluate(`(async () => { let total=0, cursor=null; do {
    const page=await (await fetch('/api/enrich/runs?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json();
    total+=page.runs.length; cursor=page.nextCursor;
  } while(cursor); return total; })()`);
  assert.equal(await retained(), 150);
  await page.evaluate(`for (const [key, value] of [['historyRuns','100'],['historyLogs','0']]) {
    const input=document.getElementById('f2-enrich-'+key); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true}));
  } window.confirm=message=>{window.confirmText=message;return false}; document.getElementById('save-enrich').click();`);
  assert.match(await page.evaluate('window.confirmText'), /permanently deletes/);
  assert.equal(await retained(), 150);
  await page.evaluate('window.confirm=()=>true; document.getElementById("save-enrich").click()');
  await page.waitFor('document.getElementById("note-enrich").textContent.includes("Saved")');
  assert.equal(await retained(), 100);
  assert.equal(await page.evaluate(`(async()=>{const p=await(await fetch('/api/enrich/runs?limit=50')).json();return p.runs.every(r=>!r.hasLog)})()`), true);
  await page.navigate(`${server.base}/settings.html?retention=saved#sec-enrich`);
  await page.waitFor('document.getElementById("f2-enrich-historyRuns")?.value === "100" && document.getElementById("f2-enrich-historyLogs")?.value === "0"');
  await page.evaluate(`const input=document.getElementById('f2-enrich-historyRuns'); for(let el=input;el;el=el.parentElement)if(el.tagName==='DETAILS')el.open=true; input.scrollIntoView({block:'center'});`);
  if (process.env.PICTARIA_HISTORY_SCREENSHOT) {
    const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(process.env.PICTARIA_HISTORY_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
  }
});
