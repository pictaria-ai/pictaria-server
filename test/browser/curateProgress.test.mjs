import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

test('Enrich notice follows live status and card progress replaces dates without moving controls',
  { timeout: 45000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    const fixture = await curatePreviewFixture({ stackSize: 0, singles: 1, metadataReady: true });
    const browser = await launchChrome(), page = await browser.newPage();
    t.after(async () => { await browser.stop(); await fixture.stop(); });
    await page.navigate(`${fixture.base}/curate-preview.html`);
    await page.waitFor('document.querySelector(".gate-backdrop input")');
    await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
    await page.waitFor('document.querySelector(".group-card") && !document.querySelector("#refresh").disabled');
    assert.equal(await page.evaluate('document.querySelector("#enrich-note").hidden'), true);
    // Exercise run start/stop through the normal four-second status poll,
    // without inference or library writes. The HTTP test checks the runner source.
    await page.evaluate(`window.enrichActive=false; const nativeFetch=window.fetch;
      window.fetch=async(...args)=>{
        const response=await nativeFetch(...args);
        if(String(args[0]).endsWith('/groups/status') && response.ok) {
          const body=await response.json(); body.enrichRunning=window.enrichActive;
          body.refinement={...body.refinement,state:'searching',remainingGroups:1};
          return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
        }
        return response;
      };`);
    const header = () => page.evaluate(`['#groups','#refresh','.section-tabs'].map(s=>{
      const r=document.querySelector(s).getBoundingClientRect();return [r.x,r.y,r.height];
    })`);
    const before = await header();
    await page.evaluate('window.enrichActive=true');
    await page.waitFor('!document.querySelector("#enrich-note").hidden && document.querySelector("#check-activity .similarity-indicator")');
    assert.deepEqual(await header(), before, 'starting Enrich must not move shared controls or the grid');
    assert.equal(await page.evaluate(`document.querySelector('#enrich-note').getBoundingClientRect().right <= document.querySelector('#check-activity').getBoundingClientRect().left`), true);

    // Render real card components at the minimum grid width. Synthetic photos
    // cover both singles and stacks, independently of backend check timing.
    await page.evaluate(`(async()=>{
      const {groupCard}=await import('/curate/photos.js');
      const host=document.createElement('div');host.id='progress-cards';
      host.style='display:flex;flex-wrap:wrap;gap:18px;margin-top:18px';
      window.progressCards=[1,3].map(n=>{
        const photos=Array.from({length:n},(_,i)=>({id:'synthetic-'+i,caption:'City scene',capturedAt:'2026-01-01T12:00:00Z'}));
        const card=groupCard({id:'progress-'+n,memberCount:n,photos,route:'single'},()=>{});
        card.style='width:240px;flex:none;align-self:flex-start';host.append(card);return card;
      });
      document.querySelector('main').append(host);
      await Promise.all([...host.querySelectorAll('img')].map(img=>new Promise(resolve=>{
        img.onload=resolve;img.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#527d88"/><circle cx="340" cy="220" r="100" fill="#b7d7cc"/></svg>');
      })));
      window.cardDates=window.progressCards.map(c=>c.querySelector('.capture-date').textContent);
    })()`);
    const sizes = () => page.evaluate(`window.progressCards.map(c=>({
      height:c.getBoundingClientRect().height, meta:c.querySelector('.card-meta').getBoundingClientRect().height,
      actions:c.querySelector('.card-actions')?.getBoundingClientRect().top-c.getBoundingClientRect().top || null
    }))`);
    const originalSizes = await sizes();
    for (const status of [
      { state:'waiting' }, { state:'checking', done:4, total:500 },
      { state:'updated', checking:true }, { state:'checked' },
      { state:'checked', uncertain:true }, { state:'incomplete', problem:'Similarity unavailable' },
    ]) {
      await page.evaluate(`window.progressCards.forEach(c=>c.updateSimilarity(${JSON.stringify(status)}))`);
      assert.deepEqual(await sizes(), originalSizes, `card geometry stays fixed for ${JSON.stringify(status)}`);
      const active = ['waiting','checking','updated'].includes(status.state);
      assert.deepEqual(await page.evaluate(`window.progressCards.map(c=>({
        dateHidden:c.querySelector('.capture-date').hidden,statusHidden:c.querySelector('.similarity-status').hidden
      }))`), Array(2).fill({ dateHidden:active, statusHidden:!active }));
      assert.equal(await page.evaluate('window.progressCards.every((c,i)=>c.querySelector(".capture-date").textContent===window.cardDates[i])'), true);
    }
    assert.equal(await page.evaluate('window.progressCards.every(c=>c.querySelector(".similarity-indicator").title.includes("Similarity unavailable"))'), true);
    await page.evaluate('window.progressCards.forEach(c=>c.updateSimilarity({state:"checking",done:4,total:5}))');
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format:'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-enrich-progress-desktop.png'), Buffer.from(data,'base64'));
    }
    await page.send('Emulation.setDeviceMetricsOverride', { width:375,height:950,deviceScaleFactor:1,mobile:true });
    assert.equal(await page.evaluate('document.documentElement.scrollWidth<=innerWidth'), true);
    const mobile = await header();
    if (process.env.PICTARIA_TEST_SCREENSHOTS) {
      const { data } = await page.send('Page.captureScreenshot', { format:'png' });
      writeFileSync(join(process.env.PICTARIA_TEST_SCREENSHOTS, 'curate-enrich-progress-mobile.png'), Buffer.from(data,'base64'));
    }
    await page.evaluate('window.enrichActive=false');
    await page.waitFor('document.querySelector("#enrich-note").hidden');
    assert.deepEqual(await header(), mobile, 'finishing Enrich must not move the mobile controls or grid');
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n,0);
  });
