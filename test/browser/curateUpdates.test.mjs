import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

async function open(t, singles) {
  const fixture = await curatePreviewFixture({ stackSize: 0, singles });
  // Fixture writes use a second connection while the server builds view leases.
  // Wait for its short transactions when the full suite runs under load.
  fixture.repo.db.exec('PRAGMA busy_timeout = 5000');
  for (const asset of fixture.assets) fixture.repo.curate.mergeMetadataAsset({ ...asset, tags: [] });
  const browser = await launchChrome(),
    page = await browser.newPage();
  t.after(async () => {
    await browser.stop();
    await fixture.stop();
  });
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate(
    'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
  );
  await page.waitFor('document.querySelector(".group-card") && !document.querySelector("#refresh").disabled');
  await page.evaluate(`window.statusPolls=0;window.opens=[];const original=window.fetch;window.fetch=(url,options)=>{
    if(String(url).endsWith('/groups/status')) window.statusPolls++;
    if(String(url).endsWith('/curate/groups') && options?.method==='POST') window.opens.push(JSON.parse(options.body));
    return original(url,options);
  };`);
  return {
    fixture,
    page,
    click: (s) => page.evaluate(`document.querySelector(${JSON.stringify(s)}).click()`),
  };
}

test(
  'automatic updates wait for bulk selection, preserve loaded depth and anchor, and use one aligned Refresh menu',
  { timeout: 60000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click } = await open(t, 102);
    await click('#more');
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===100 && !document.querySelector("#refresh").disabled',
    );
    await page.evaluate('document.querySelectorAll(".group-card")[50].scrollIntoView()');
    const anchor = await page.evaluate(
      '({id:document.querySelectorAll(".group-card")[50].dataset.groupId,y:document.querySelectorAll(".group-card")[50].getBoundingClientRect().top})',
    );
    await click('#select-shown');
    const original = await page.evaluate('sessionStorage.getItem("pictaria.curate.preview")');
    for (let i = 1; i <= 5; i++) fixture.add(3000 + i, -i * 600, `new-arrival-${i}`);
    await page.waitFor('window.statusPolls>=2 && !document.querySelector("#updates").hidden');
    assert.equal(
      await page.evaluate('JSON.parse(sessionStorage.getItem("pictaria.curate.preview")).viewId'),
      JSON.parse(original).viewId,
    );
    assert.equal(await page.evaluate('document.querySelectorAll("[data-select]:checked").length'), 100);
    await click('#clear-bulk');
    await page.waitFor(
      `JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).viewId!==${JSON.stringify(JSON.parse(original).viewId)} && !document.querySelector('#refresh').disabled`,
    );
    assert.equal(
      await page.evaluate('document.querySelectorAll(".group-card").length'),
      100,
      'automatic updates must not collapse the grid to page one',
    );
    const y = await page.evaluate(
      `document.querySelector('[data-group-id="${anchor.id}"]').getBoundingClientRect().top`,
    );
    assert.ok(Math.abs(y - anchor.y) < 3, `anchor moved ${y - anchor.y}px`);
    assert.ok(await page.evaluate('window.opens.some(body=>body.retryChecks===false)'));
    assert.equal(
      await page.evaluate('document.querySelector("#show-updates,#corrections,#split,#photo-remove")'),
      null,
    );
    await page.evaluate('scrollTo(0,0)');
    await click('.page-tools summary');
    const geometry = await page.evaluate(`(()=>{
    const more=document.querySelector('.page-tools summary'), refresh=document.querySelector('#refresh');
    const m=more.getBoundingClientRect(), r=refresh.getBoundingClientRect();
    return {delta:Math.abs(m.y+m.height/2-r.y-r.height/2), display:getComputedStyle(more).display,
      items:[...document.querySelectorAll('.page-tools a')].map(e=>({display:getComputedStyle(e).display,align:getComputedStyle(e).alignItems,decoration:getComputedStyle(e).textDecorationLine}))};
  })()`);
    assert.ok(geometry.delta < 1);
    assert.equal(geometry.display, 'flex');
    assert.ok(
      geometry.items.every((i) => i.display === 'flex' && i.align === 'center' && i.decoration === 'none'),
    );
  },
);

test(
  'failed automatic replacement pauses rather than looping; explicit Refresh recovers',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click } = await open(t, 2);
    await page.evaluate(`window.autoAttempts=0;const upstream=window.fetch;window.fetch=(url,options)=>{
    if(String(url).endsWith('/curate/groups') && options?.method==='POST' && JSON.parse(options.body).retryChecks===false){
      window.autoAttempts++;return Promise.resolve(new Response(JSON.stringify({error:{message:'Synthetic update failure'}}),{status:503}));
    }return upstream(url,options);
  };`);
    fixture.add(3000, 900000, 'new-arrival');
    await page.waitFor(
      '!document.querySelector("#error").hidden && document.querySelector("#error").textContent.includes("Refresh to continue")',
    );
    const polls = await page.evaluate('window.statusPolls');
    await page.waitFor(`window.statusPolls>=${polls + 2}`);
    assert.equal(await page.evaluate('window.autoAttempts'), 1);
    assert.equal(await page.evaluate('document.querySelector(".group-card button").disabled'), true);
    assert.equal(await page.evaluate('document.querySelector("#refresh").disabled'), false);
    await click('#refresh');
    await page.waitFor(
      'document.querySelectorAll(".group-card").length===3 && !document.querySelector(".group-card button").disabled',
    );
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
  },
);
