import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { cleanupAfter, findChrome, launchChrome, ROOT } from './harness.mjs';

// The home page's Immich line, driven by fixture /api/health answers. Only
// the page's own files are served; every API answer below is made up here,
// so no Immich, key or photo is involved.

const PUBLIC = join(ROOT, 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// All fifteen permissions the Server can ask for, in the Server's order
// (IMMICH_REQUIRED_PERMISSIONS, then asset.update when write-back is on).
const ALL_PERMISSIONS = [
  'asset.read', 'asset.view', 'asset.download', 'asset.statistics',
  'person.read', 'person.statistics', 'album.read', 'album.create',
  'album.delete', 'albumAsset.create', 'albumAsset.delete',
  'tag.read', 'tag.create', 'tag.asset', 'asset.update',
];

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://fixture').pathname;
    const file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path));
    if (!file.startsWith(PUBLIC)) { response.writeHead(404); response.end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Answers the page's API calls from window.__fixtureHealth, set per case
// before each navigation. The rest of the page gets quiet, valid answers.
const FIXTURE_FETCH = `
  const realFetch = window.fetch;
  window.fetch = (input, ...rest) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
    const answers = {
      '/api/health': JSON.parse(sessionStorage.getItem('fixtureHealth')),
      '/api/session': { authenticated: true },
      '/api/support/status': {},
      '/api/enrich/status': { enabled: true, library: { enrichedTotal: 1240, curatedTotal: 312 } },
      '/api/albums/jobs': { jobs: [] },
      '/api/insights': {},
      '/api/frame/status': { frameConnected: false },
      '/api/frame/stats': { ledgerAvailable: false },
      '/api/enrich/embeddings': { enabled: false },
    };
    if (path in answers) return Promise.resolve(Response.json(answers[path]));
    if (path.startsWith('/api/')) return Promise.resolve(Response.json({ error: 'Not found' }, { status: 404 }));
    return realFetch(input, ...rest);
  };
`;

function health(immich, extra = {}) {
  return {
    ok: true,
    authRequired: true,
    immichConfigured: immich !== 'not_configured',
    serverVersion: '1.3.0',
    uptimeSeconds: 7200,
    immich,
    immichVersion: '2.1.0',
    immichMissingPermissions: [],
    ...extra,
  };
}

async function openHome(page, base, fixture) {
  await page.evaluate(`sessionStorage.setItem('fixtureHealth', ${JSON.stringify(JSON.stringify(fixture))})`);
  await page.navigate(`${base}/?case=${Math.random().toString(36).slice(2)}`);
  await page.waitFor('document.getElementById("immichLine").textContent !== "Checking Immich…"');
  return page.evaluate(`({
    text: document.getElementById('immichLine').textContent,
    dot: document.getElementById('immichDot').className,
  })`);
}

test('the home page names the permissions an Immich key is missing', { timeout: 60000 }, async (t) => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await startFixtureServer());
  const browser = track(await launchChrome());
  const page = await browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE_FETCH });
  // sessionStorage belongs to the origin, so open it once before setting cases.
  await page.navigate(`${fixture.base}/activity.html`);

  const short = await openHome(page, fixture.base, health('missing_permissions', {
    immichMissingPermissions: ['tag.create', 'tag.asset'],
  }));
  assert.deepEqual(short, { text: 'Immich key is missing permissions: tag.create, tag.asset', dot: 'p-dot warn' });

  const long = await openHome(page, fixture.base, health('missing_permissions', {
    immichMissingPermissions: ALL_PERMISSIONS,
  }));
  assert.equal(long.text, `Immich key is missing permissions: ${ALL_PERMISSIONS.join(', ')}`);
  assert.equal(long.dot, 'p-dot warn');

  // The names are written as text, never parsed as markup.
  const markup = await openHome(page, fixture.base, health('missing_permissions', {
    immichMissingPermissions: ['<b>tag.read</b>'],
  }));
  assert.equal(markup.text, 'Immich key is missing permissions: <b>tag.read</b>');

  // No list (an older Server) or an empty one keeps today's text exactly.
  const absent = health('missing_permissions');
  delete absent.immichMissingPermissions;
  for (const fixtureHealth of [absent, health('missing_permissions', { immichMissingPermissions: [] })]) {
    assert.deepEqual(await openHome(page, fixture.base, fixtureHealth),
      { text: 'Immich key is missing permissions', dot: 'p-dot warn' });
  }

  // Other statuses ignore the list, even if one were sent.
  const stray = { immichMissingPermissions: ['tag.create'] };
  for (const [status, text, dot] of [
    ['unauthorized', 'Immich rejected the API key', 'p-dot bad'],
    ['unreachable', 'Immich unreachable', 'p-dot bad'],
    ['not_configured', 'Immich not configured', 'p-dot warn'],
    ['connected', 'Immich connected · v2.1.0', 'p-dot ok'],
  ]) {
    assert.deepEqual(await openHome(page, fixture.base, health(status, stray)), { text, dot }, status);
  }
});

test('a long missing-permission list wraps inside the status panel at phone width', { timeout: 60000 }, async (t) => {
  if (!findChrome()) return t.skip('Chrome required');
  const track = cleanupAfter(t);
  const fixture = track(await startFixtureServer());
  const browser = track(await launchChrome());
  const page = await browser.newPage();
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: FIXTURE_FETCH });
  await page.navigate(`${fixture.base}/activity.html`);

  for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true], [320, 640, true]]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const { text } = await openHome(page, fixture.base, health('missing_permissions', {
      immichMissingPermissions: ALL_PERMISSIONS,
    }));
    assert.match(text, /asset\.update$/, `${width}px: the whole list is in the line`);
    const layout = await page.evaluate(`(() => {
      const panel = document.querySelector('.status-box').getBoundingClientRect();
      const line = document.getElementById('immichLine');
      const box = line.getBoundingClientRect();
      const dot = document.getElementById('immichDot').getBoundingClientRect();
      const lineHeight = parseFloat(getComputedStyle(line).lineHeight);
      return {
        pageScrolls: document.documentElement.scrollWidth > innerWidth,
        clipped: line.scrollWidth > line.clientWidth,
        insidePanel: box.left >= panel.left && box.right <= panel.right && box.bottom <= panel.bottom,
        lines: Math.round(box.height / lineHeight),
        dotBesideText: dot.right <= box.left && dot.top >= box.top - 1 && dot.bottom <= box.top + lineHeight + 1,
      };
    })()`);
    assert.equal(layout.pageScrolls, false, `${width}px: no horizontal page scroll`);
    assert.equal(layout.clipped, false, `${width}px: no cut-off text`);
    assert.equal(layout.insidePanel, true, `${width}px: the line stays inside the status panel`);
    assert.equal(layout.dotBesideText, true, `${width}px: the dot stays beside the first line of text`);
    if (width <= 390) assert.ok(layout.lines > 1, `${width}px: the list wraps (${layout.lines} lines)`);
  }
});
