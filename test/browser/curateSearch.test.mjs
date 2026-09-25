import test from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome, findChrome } from './harness.mjs';
import { curatePreviewFixture } from './curatePreviewFixture.mjs';

async function setup(t) {
  const fixture = await curatePreviewFixture({ stackSize: 0, singles: 12, metadataReady: true });
  const browser = await launchChrome(), page = await browser.newPage();
  t.after(async () => { await browser.stop(); await fixture.stop(); });
  await page.navigate(`${fixture.base}/curate-preview.html`);
  await page.waitFor('document.querySelector(".gate-backdrop input")');
  await page.evaluate('document.querySelector(".gate-backdrop input").value="smoke-secret";document.querySelector(".gate-backdrop button").click()');
  await page.waitFor('document.querySelectorAll(".group-card").length===12 && !document.querySelector("#refresh").disabled');
  await page.evaluate(`window.searchRequests=[]; const originalFetch=window.fetch;
    window.fetch=async(input,options)=>{
      if(String(input).endsWith('/curate/groups') && options?.method==='POST') {
        window.searchRequests.push(JSON.parse(options.body).search);
        const gate=window.searchGate; window.searchGate=null;
        if(gate) {
          await new Promise(resolve=>{window.releaseSearch=resolve;});
          window.releaseSearch=null;
          if(gate.fail) return new Response(JSON.stringify({error:{message:'Search temporarily unavailable'}}),{status:503});
        }
      }
      return originalFetch(input,options);
    };`);
  const type = text => page.send('Input.insertText', { text });
  const replace = async text => {
    await page.evaluate('document.querySelector("#search").focus();document.querySelector("#search").select()');
    await type(text);
  };
  const gate = fail => page.evaluate(`window.searchGate={fail:${Boolean(fail)}}`);
  const blocked = () => page.waitFor('typeof window.releaseSearch==="function"');
  const release = () => page.evaluate('window.releaseSearch()');
  const debounce = () => page.evaluate('new Promise(resolve=>setTimeout(resolve,350))');
  const ready = query => page.waitFor(`JSON.parse(sessionStorage.getItem('pictaria.curate.preview')).filters.search===${JSON.stringify(query)} && !document.querySelector('#refresh').disabled`);
  const input = () => page.evaluate(`(()=>{const s=document.querySelector('#search');return {value:s.value,focused:document.activeElement===s,disabled:s.disabled,start:s.selectionStart,end:s.selectionEnd}})()`);
  return { page, fixture, type, replace, gate, blocked, release, debounce, ready, input };
}

test('Curate search keeps focus and caret, coalesces typing and clearing during slow results, and never steals focus',
  { timeout: 45000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    const { page, type, replace, gate, blocked, release, debounce, ready, input } = await setup(t);
    await gate(); await replace('s'); await blocked();
    assert.deepEqual(await input(), { value:'s', focused:true, disabled:false, start:1, end:1 });
    await type('ingle-2'); await debounce();
    assert.deepEqual(await page.evaluate('window.searchRequests'), ['s'], 'keep replacements serialized while typing');
    await page.evaluate('document.querySelector("#search").setSelectionRange(7,8)');
    await type('1'); await debounce();
    await release(); await ready('single-1');
    assert.deepEqual(await input(), { value:'single-1', focused:true, disabled:false, start:8, end:8 });
    assert.deepEqual(await page.evaluate('window.searchRequests'), ['s','single-1'], 'only the latest queued text is searched');
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 4);

    await gate(); await replace('single-2'); await blocked();
    await page.evaluate('document.querySelector(".page-tools summary").focus()');
    await release(); await ready('single-2');
    assert.equal(await page.evaluate('document.activeElement.matches(".page-tools summary")'), true);

    await gate(); await replace('single-'); await blocked();
    await page.evaluate('document.querySelector("#search").select()');
    await page.send('Input.dispatchKeyEvent', { type:'keyDown', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8 });
    await page.send('Input.dispatchKeyEvent', { type:'keyUp', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8 });
    await debounce(); await release(); await ready('');
    assert.deepEqual(await input(), { value:'', focused:true, disabled:false, start:0, end:0 });
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 12);
  });

test('an earlier search failure preserves newer typing; a failed query stays editable and Refresh retries it',
  { timeout: 45000 }, async t => {
    if (!findChrome()) return t.skip('Chrome required');
    const { page, fixture, type, replace, gate, blocked, release, debounce, ready, input } = await setup(t);
    await gate(true); await replace('s'); await blocked();
    await type('ingle-2'); await debounce();
    await release(); await ready('single-2');
    assert.deepEqual(await input(), { value:'single-2', focused:true, disabled:false, start:8, end:8 });
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
    assert.deepEqual(await page.evaluate('window.searchRequests'), ['s','single-2']);

    await gate(true); await replace('single-3'); await blocked(); await release();
    await page.waitFor('!document.querySelector("#error").hidden && !document.querySelector("#refresh").disabled');
    assert.deepEqual(await input(), { value:'single-3', focused:true, disabled:false, start:8, end:8 });
    await debounce();
    assert.deepEqual(await page.evaluate('window.searchRequests'), ['s','single-2','single-3'], 'failure alone does not retry');
    await page.evaluate('document.querySelector("#refresh").click()'); await ready('single-3');
    assert.deepEqual(await page.evaluate('window.searchRequests'), ['s','single-2','single-3','single-3']);
    assert.equal(await page.evaluate('document.querySelector("#error").hidden'), true);
    assert.equal(await page.evaluate('document.querySelectorAll(".group-card").length'), 1);
    assert.equal(fixture.repo.db.prepare('SELECT COUNT(*) n FROM decision_operations').get().n, 0);
  });
