import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupAfter, launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('one stable activity chip shows global work, accessible breakdown and mobile counts', { timeout: 45000 }, async t => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t), fixture = track(await curatePreviewFixture({ stackSize: 4, singles: 2, metadataReady: true }));
  const browser = track(await launchChrome()), page = await browser.newPage();
  const click = s => page.evaluate(`document.querySelector(${JSON.stringify(s)}).click()`);
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelector(".is-stack") && !document.querySelector("#refresh").disabled');
  await page.evaluate(`window.headerOverride={};
    const nativeFetch=fetch;window.fetch=async(...args)=>{
      const response=await nativeFetch(...args),url=String(args[0]);
      if(!response.ok || !url.includes('/api/review/curate/')) return response;
      const body=await response.json();
      if(body.groups){
        body.enrichRunning=true;body.updatesAvailable=false;body.refinement={state:'idle',remainingGroups:0};
        body.metadata={state:'idle'};
        Object.assign(body,window.headerOverride);
      }
      return new Response(JSON.stringify(body),{status:response.status,headers:{'content-type':'application/json'}});
    };`);
  const off = { state: 'off' }, idle = { state: 'idle' };
  const done = { state: 'ready', total: 80, completed: 60, incomplete: 20, remaining: 0, waitingForGrouping: 0, waitingForStack: 0, paused: 0 };
  const work = { ...done, incomplete: 8, remaining: 12 };
  const payload = (stack, photo, remaining, stackRefereeActivity = idle, photoRefereeActivity = idle, extra = {}) =>
    ({ refereeProgress: { stack, photo, remaining }, stackRefereeActivity, photoRefereeActivity, ...extra });
  const scenarios = [
    ['running', 'Checking stacks · 12 stacks left', payload(work, work, 12, { state: 'checking' })],
    ['running', 'Picking best photos · 10,932 stacks left', payload(off, { ...work, total: 11000, remaining: 10932 }, 10932, off, { state: 'checking' })],
    ['waiting', 'Waiting for Enrich · 12 stacks left', payload(done, work, 12, idle, { state: 'waiting', reason: 'shared-provider' })],
    ['attention', 'Photo Referee: model needs attention', payload(off, work, 12, off, { state: 'paused', reason: 'model-failures' })],
    ['idle', 'AI up to date', payload(done, off, 0, idle, off)],
    ['grouping', 'Grouping photos…', payload(off, off, 0, off, off, { refinement: { state: 'searching', remainingGroups: 3 } })],
    ['hidden', 'AI up to date', payload(off, off, 0, off, off)],
    ['attention', 'AI setup needed', payload(work, work, 12, { state: 'paused', reason: 'configuration' }, { state: 'paused', reason: 'provider-auth' })],
    ['attention', 'AI model needs attention', payload(work, work, 12, { state: 'paused', reason: 'model-failures' }, { state: 'paused', reason: 'model-failures' })],
    ['waiting', 'Temporarily paused', payload(work, work, 12,
      { state: 'paused', reason: 'provider-cooldown', retryAt: Date.UTC(2026, 9, 8, 12, 30) },
      { state: 'paused', reason: 'preview-cooldown', retryAt: Date.UTC(2026, 9, 8, 12, 32) })],
  ];
  const apply = async data => {
    await page.evaluate(`window.headerOverride=${JSON.stringify(data)}`);
    await click('#refresh'); await page.waitFor('!document.querySelector("#refresh").disabled');
  };
  const geometry = () => page.evaluate(`['#sections','#curate-status','.view-notices','.toolbar','#groups'].map(s=>{
    const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.width,r.height];})`);
  const screenshot = async name => {
    if (!process.env.PICTARIA_TEST_SCREENSHOTS) return;
    const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, name), Buffer.from(data, 'base64'));
  };
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width < 600 });
    await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await apply(scenarios[0][2]);
    const layout = await geometry();
    for (const [phase, text, data] of scenarios) {
      await apply(data);
      assert.equal(await page.evaluate('document.querySelector("#curate-status").dataset.phase'), phase);
      assert.equal(await page.evaluate('document.querySelector(".curate-status-chip").getAttribute("aria-label")'), text);
      assert.deepEqual(await geometry(), layout, `layout stable: ${width}/${theme}/${phase}`);
      assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
      if (phase === 'hidden') {
        assert.equal(await page.evaluate('document.querySelector(".curate-status-chip").hidden'), true);
        continue;
      }
      assert.equal(await page.evaluate(`(()=>{const chip=document.querySelector('.curate-status-chip').getBoundingClientRect(),row=document.querySelector('.view-controls').getBoundingClientRect();return Math.abs(chip.right-row.right)<1;})()`), true, 'right edge stays anchored');
      assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".curate-status-copy")).display==="none"'), width < 600);
      if (phase === 'running' && data.refereeProgress.remaining === 12)
        assert.equal(await page.evaluate('document.querySelector(".curate-status-count").textContent'), '12', 'no double counting');
      await screenshot(`curate-chip-${width}-${theme}-${phase}.png`);
    }
    // Both temporary pauses retain distinct causes and known eligibility times.
    await click('.curate-status-chip');
    await page.waitFor('!document.querySelector("#curate-status-details").hidden');
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.role-status')).every(el=>el.textContent==='Temporarily paused')`), true);
    assert.equal(await page.evaluate(`Array.from(document.querySelectorAll('.role-detail')).every(el=>el.textContent.includes('Retry eligible after'))`), true);
    assert.match(await page.evaluate('document.querySelector("[data-role=stack] .role-detail").textContent'), /AI provider/);
    assert.match(await page.evaluate('document.querySelector("[data-role=photo] .role-detail").textContent'), /Immich/);
    assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('#curate-status-details').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`), true);
    await screenshot(`curate-chip-cooldown-details-${width}-${theme}.png`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    await apply(scenarios[2][2]);
    await page.evaluate('document.querySelector(".curate-status-chip").focus()');
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await page.waitFor('!document.querySelector("#curate-status-details").hidden');
    assert.equal(await page.evaluate(`(()=>{const r=document.querySelector('#curate-status-details').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;})()`), true);
    assert.equal(await page.evaluate('document.querySelector("[data-role=photo] .role-count").textContent'), '12 left');
    assert.match(await page.evaluate('document.querySelector(".status-enrich").textContent'), /New photos may still join stacks/);
    await page.evaluate('document.querySelector("#curate-status-details a").focus()');
    // A status repaint must retain focus on the actionable settings link.
    await page.evaluate(`(async()=>{const {showCurateStatus}=await import('/curate/referee-progress.js');showCurateStatus(document.querySelector('#curate-status'),{...window.headerOverride,enrichRunning:true});})()`);
    assert.equal(await page.evaluate('document.activeElement.getAttribute("href")'), '/settings.html#sec-curate');
    await screenshot(`curate-chip-details-${width}-${theme}.png`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape' });
    assert.equal(await page.evaluate('document.querySelector("#curate-status-details").hidden'), true);
    assert.equal(await page.evaluate('document.activeElement.classList.contains("curate-status-chip")'), true);
  }
  assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
});
