import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

async function setup(t) {
  const fixture = await curatePreviewFixture({ stackSize: 0, singles: 4, metadataReady: true });
  const browser = await launchChrome(),
    page = await browser.newPage();
  t.after(async () => {
    await browser.stop();
    await fixture.stop();
  });
  const click = (selector) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = (key) => page.send('Input.dispatchKeyEvent', { type: 'keyDown', key });
  const shown = (n) =>
    `document.querySelector('#photo-view').open && document.querySelector('#photo-large').src.includes('${fixture.id(n)}') && !document.querySelector('[data-photo-action=reviewed]').disabled`;
  const operations = () => fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n;
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate(
    'document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()',
  );
  await page.waitFor(
    'document.querySelectorAll(".group-card").length===4 && !document.querySelector("#refresh").disabled',
  );
  await page.evaluate(`window.whiteOpens=0;window.viewerCloses=0;
    const compare=document.querySelector('#comparison'), show=compare.showModal.bind(compare);
    compare.showModal=()=>{window.whiteOpens++;show();};
    document.querySelector('#photo-view').addEventListener('close',()=>window.viewerCloses++);`);
  return { fixture, page, click, key, shown, operations };
}

test(
  'single navigation and accepted decisions retain the lightbox through slow reads; a failed next read preserves Undo',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click, key, shown, operations } = await setup(t);
    await click('.group-card .cover');
    await page.waitFor(shown(1001));
    const holdNext = () =>
      page.evaluate(`{window.readStarted=false;window.releaseRead=null;
      const native=window.fetch;window.fetch=async(...args)=>{
        if(String(args[0]).endsWith('/comparisons')){
          window.fetch=native;window.readStarted=true;
          await new Promise(resolve=>window.releaseRead=resolve);
        }
        return native(...args);
      };}`);
    const stillShowing = async (n) => {
      assert.equal(
        await page.evaluate(`document.querySelector('#photo-large').src.includes('${fixture.id(n)}')`),
        true,
      );
      assert.equal(
        await page.evaluate(
          'document.querySelector("#photo-view").open && !document.querySelector("#comparison").open',
        ),
        true,
      );
      assert.equal(
        await page.evaluate('document.querySelector("[data-photo-action=reviewed]").disabled'),
        true,
      );
      assert.equal(await page.evaluate('document.querySelector("#photo-loading").hidden'), false);
      assert.equal(await page.evaluate('window.whiteOpens+window.viewerCloses'), 0);
    };
    await holdNext();
    await key('ArrowRight');
    await page.waitFor('window.readStarted');
    await stillShowing(1001);
    await key('s');
    assert.equal(operations(), 0, 'a loading next photo cannot receive a decision');
    await page.evaluate('window.releaseRead()');
    await page.waitFor(shown(1002));

    await holdNext();
    await key('s');
    await page.waitFor('window.readStarted');
    await stillShowing(1002);
    assert.equal(operations(), 1);
    assert.ok(fixture.repo.loadAssetTagsFor([fixture.id(1002)])[fixture.id(1002)].includes('frame/reviewed'));
    await key('y');
    assert.equal(operations(), 1);
    await page.evaluate('window.releaseRead()');
    await page.waitFor(shown(1003));
    assert.equal(await page.evaluate('window.whiteOpens+window.viewerCloses'), 0);

    await page.evaluate(`const native=window.fetch;window.fetch=(...args)=>{
      if(String(args[0]).endsWith('/comparisons')){window.fetch=native;throw Error('Synthetic next-photo failure');}
      return native(...args);
    };`);
    await key('s');
    await page.waitFor(
      '!document.querySelector("#error").hidden && !document.querySelector("#undo").disabled',
    );
    assert.match(
      await page.evaluate('document.querySelector("#error").textContent'),
      /Choices saved.*next photo/,
    );
    assert.equal(operations(), 2);
    assert.equal(await page.evaluate('document.querySelector("#recovery").hidden'), true);
    assert.equal(await page.evaluate('document.querySelector("#photo-view").open'), false);
    await click('#undo');
    await page.waitFor(shown(1003));
    assert.ok(
      !(fixture.repo.loadAssetTagsFor([fixture.id(1003)])[fixture.id(1003)] || []).includes('frame/reviewed'),
    );
  },
);

test(
  'slow image decoding cannot replace a closed lightbox; a failed image never displays the previous photo as the new one',
  { timeout: 45000 },
  async (t) => {
    if (!findChrome()) return t.skip('Chrome required');
    const { fixture, page, click, key, shown, operations } = await setup(t);
    await page.evaluate(`const decode=HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode=function(){
        if(this.src.includes('${fixture.id(1003)}'))return Promise.reject(Error('Synthetic decode failure'));
        const result=decode.call(this);
        return this.src.includes('${fixture.id(1002)}')
          ? result.then(()=>new Promise(resolve=>window.releaseImage=()=>{window.imageReleased=true;resolve();})) : result;
      };`);
    await click('.group-card .cover');
    await page.waitFor(shown(1001));
    await page.waitFor('window.releaseImage'); // Neighbor is preloaded, but not yet decoded.
    await key('ArrowRight');
    await page.waitFor('!document.querySelector("#photo-loading").hidden');
    assert.equal(
      await page.evaluate(`document.querySelector('#photo-large').src.includes('${fixture.id(1001)}')`),
      true,
    );
    await key('s');
    assert.equal(operations(), 0);
    await click('[data-close=photo-view]');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    await page.evaluate(
      'window.releaseImage();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(await page.evaluate('document.querySelector("#photo-view").open'), false);
    assert.equal(await page.evaluate('document.querySelector("#comparison").open'), false);
    await click(`.group-card[data-group-id$="${fixture.id(1003)}"] .cover`);
    await page.waitFor(shown(1003));
    assert.equal(
      await page.evaluate(
        'document.querySelector("#photo-large").hidden && !document.querySelector("#photo-image-error").hidden',
      ),
      true,
    );
    assert.equal(operations(), 0);
    await click('[data-close=photo-view]');
    await page.evaluate(`window.lateRead=false;const native=window.fetch;
      window.fetch=async(...args)=>{
        if(String(args[0]).endsWith('/comparisons')) {
          window.fetch=native;window.lateRead=true;
          await new Promise(resolve=>window.releaseLateRead=resolve);
          throw Error('Synthetic failure after closing');
        }
        return native(...args);
      };`);
    await click('.group-card .cover');
    await page.waitFor('window.lateRead');
    await click('[data-close=photo-view]');
    await page.waitFor('!document.querySelector("#refresh").disabled');
    await page.evaluate(
      'window.releaseLateRead();new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))',
    );
    assert.equal(
      await page.evaluate(
        'document.querySelector("#error").hidden && !document.querySelector("#photo-view").open',
      ),
      true,
    );
  },
);
