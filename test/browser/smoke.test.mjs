import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InsightsRepository } from '../../src/insights/repository.mjs';
import { InsightsCollector } from '../../src/insights/collector.mjs';
import { Repository } from '../../src/enrich/repository.mjs';
import { loadV1Taxonomy, sampleOutput } from '../enrich/helpers.mjs';
import { bootServer, findChrome, launchChrome, startFakeImmich } from './harness.mjs';

// Browser-level smoke coverage for the primary admin workflows (SRV-M12):
// the password gate, Insights + the lens directory search, Curate cards,
// and the Smart Album create/validate round-trip. These are the regressions
// the 400+ backend tests cannot see — the Vienna lens bug shipped past a
// fully green suite because nothing exercised the pages themselves.
//
// The server child runs against seeded temp databases (never the real data
// dir); the whole suite skips when no Chrome/Chromium binary is available
// (PICTARIA_CHROME_BIN overrides discovery).

const PASSWORD = 'smoke-secret';
const LONG_ASSET_FILENAME = '0555b531-0b53-47ee-b2f7-d26b40011e08.jpg';
const LONG_MODEL_NAME = 'qwen3-vl-32b-instruct-mlx-with-an-extra-long-unbroken-suffix';
const REVIEW_ASSET_IDS = Array.from(
  { length: 9 },
  (_, index) => `00000000-0000-0000-0000-${(index + 1).toString(16).padStart(12, '0')}`,
);
const STACK_KEEP_ID = '00000000-0000-0000-0000-000000000010';
const STACK_LEFT_ID = '00000000-0000-0000-0000-000000000011';
const ARROW_A_ID = '00000000-0000-0000-0000-000000000012';
const ARROW_B_ID = '00000000-0000-0000-0000-000000000013';

const INSIGHTS_CONFIG = {
  sweepPageSize: 100,
  maxSweepPages: 100,
  refreshIntervalHours: 24,
  topPeople: 15,
  maxTagCounts: 250,
  statConcurrency: 2,
  favoritesTagId: '',
  favoritesTagValue: '',
};

function makeAsset(id, city, country, takenAt, exifOverrides = {}, assetOverrides = {}) {
  return {
    id,
    type: 'IMAGE',
    isFavorite: false,
    isArchived: false,
    localDateTime: takenAt,
    exifInfo: {
      dateTimeOriginal: takenAt,
      city,
      state: null,
      country,
      make: 'Apple',
      model: 'iPhone 12',
      lensModel: 'wide',
      fileSizeInByte: 1000,
      ...exifOverrides,
    },
    ...assetOverrides,
  };
}

// A minimal Immich stand-in with the four calls a sweep makes. The point is
// to get a genuinely PUBLISHED snapshot generation into insights.sqlite via
// the real collector — not to hand-craft table rows.
class FakeImmich {
  constructor(assets) {
    this.assets = assets;
  }

  async searchMetadata({ page, size }) {
    const start = (page - 1) * size;
    const items = this.assets.slice(start, start + size);
    const nextPage = start + size < this.assets.length ? page + 1 : null;
    return { assets: { items, nextPage, total: this.assets.length, count: items.length } };
  }

  async getPeople() {
    return { people: [], total: 0, hasNextPage: false };
  }

  async searchStatistics() {
    return { total: 0 };
  }

  async listTags() {
    return [];
  }
}

// Eleven two-photo cities (and countries) push single-photo Vienna/Austria
// BELOW the snapshot's top-10 cutoff: the lens test can then only find them
// through the full-directory endpoints — the exact surface of the original
// Vienna lens bug. A snapshot-only fallback would make the test fail.
const FILLER_PLACES = [
  ['Chicago', 'United States'],
  ['Barcelona', 'Spain'],
  ['Tokyo', 'Japan'],
  ['Paris', 'France'],
  ['Lisbon', 'Portugal'],
  ['Rome', 'Italy'],
  ['Berlin', 'Germany'],
  ['Oslo', 'Norway'],
  ['Dublin', 'Ireland'],
  ['Prague', 'Czechia'],
  ['Sydney', 'Australia'],
];

const LIBRARY_ASSETS = [
  makeAsset(
    'vienna-1',
    'Vienna',
    'Austria',
    '2019-05-02T10:00:00.000Z',
    { fileSizeInByte: 'unknown' },
    { people: Array.from({ length: 102 }, (_, index) => ({ id: `crowd-${index}` })) },
  ),
  ...FILLER_PLACES.flatMap(([city, country], index) => [
    makeAsset(`${city.toLowerCase()}-1`, city, country, `202${index % 5}-03-0${(index % 8) + 1}T10:00:00.000Z`),
    makeAsset(`${city.toLowerCase()}-2`, city, country, `202${index % 5}-06-0${(index % 8) + 1}T10:00:00.000Z`),
  ]),
];

async function seedInsights(dbPath) {
  const assets = LIBRARY_ASSETS;
  const repo = new InsightsRepository(dbPath);
  try {
    const collector = new InsightsCollector({
      repo,
      immich: new FakeImmich(assets),
      config: INSIGHTS_CONFIG,
    });
    collector.start();
    const start = Date.now();
    while (collector.isRunning()) {
      if (Date.now() - start > 10000) {
        throw new Error('insights seed sweep did not finish');
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    assert.ok(repo.getMeta('snapshot'), 'seed sweep published a snapshot');
  } finally {
    repo.close();
  }
}

function seedEnrichment(dbPath) {
  const repo = new Repository(dbPath);
  try {
    repo.initSchema();
    loadV1Taxonomy();
    // Nine photos so the pagination subtest can cross a ?limit=3 page
    // boundary twice with photos to spare.
    for (const [index, assetId] of REVIEW_ASSET_IDS.entries()) {
      const filename = index === 0 ? LONG_ASSET_FILENAME : `review-${index + 1}.jpg`;
      repo.upsertAsset({ id: assetId, originalPath: `/photos/${filename}` });
      repo.recordProcessingRun({
        assetId,
        provider: 'p',
        model: index === 0 ? LONG_MODEL_NAME : 'm',
        promptVersion: 'v1',
        taxonomyVersion: 'v1',
        status: 'succeeded',
        normalizedOutput: sampleOutput(),
      });
      repo.replaceAssetTags({
        assetId,
        decisions: [{ tag: 'ai/quality/frame-worthy', confidence: 0.9, source: 'ai', reason: 'seed' }],
        model: 'm',
        taxonomyVersion: 'v1',
      });
      repo.reviewListAdd([assetId], 'seed');
    }
    // Remnant-compare setup: stack-keep is already approved, while stack-left
    // is the undecided remnant.
    // The subtest decides stack-left, so later subtests still see exactly
    // the nine review-N photos undecided.
    for (const [assetId, label, capturedAt] of [
      [STACK_KEEP_ID, 'stack-keep', '2026-07-10T10:00:00.000Z'],
      [STACK_LEFT_ID, 'stack-left', '2026-07-10T10:00:04.000Z'],
    ]) {
      repo.upsertAsset({ id: assetId, originalPath: `/photos/${label}.jpg`, fileCreatedAt: capturedAt });
      repo.recordProcessingRun({
        assetId,
        provider: 'p',
        model: 'm',
        promptVersion: 'v1',
        taxonomyVersion: 'v1',
        status: 'succeeded',
        normalizedOutput: sampleOutput(),
      });
      repo.replaceAssetTags({
        assetId,
        decisions: [{ tag: 'ai/quality/frame-worthy', confidence: 0.9, source: 'ai', reason: 'seed' }],
        model: 'm',
        taxonomyVersion: 'v1',
      });
      repo.reviewListAdd([assetId], 'seed');
    }
    repo.setManualFrameTags({ assetIds: [STACK_KEEP_ID], addTags: ['frame/eligible'], removeTags: [], action: 'approve' });
    // An undecided pair whose CAPTURE and SCORE orders disagree: arrow-a was
    // shot first, but arrow-b scores higher. The queue is b-then-a while the
    // compare grid shows a-then-b.
    for (const [assetId, label, capturedAt, frameScore] of [
      [ARROW_A_ID, 'arrow-a', '2026-07-12T09:00:00.000Z', 0.85],
      [ARROW_B_ID, 'arrow-b', '2026-07-12T09:00:04.000Z', 0.95],
    ]) {
      repo.upsertAsset({ id: assetId, originalPath: `/photos/${label}.jpg`, fileCreatedAt: capturedAt });
      const output = sampleOutput();
      output.quality.frame_worthy_score = frameScore;
      repo.recordProcessingRun({
        assetId,
        provider: 'p',
        model: 'm',
        promptVersion: 'v1',
        taxonomyVersion: 'v1',
        status: 'succeeded',
        normalizedOutput: output,
      });
      repo.replaceAssetTags({
        assetId,
        decisions: [{ tag: 'ai/quality/frame-worthy', confidence: frameScore, source: 'ai', reason: 'seed' }],
        model: 'm',
        taxonomyVersion: 'v1',
      });
      repo.reviewListAdd([assetId], 'seed');
    }
  } finally {
    repo.close();
  }
}

test('admin UI smoke: gate, Insights lens, Curate, Smart Albums', { timeout: 120000 }, async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium found (set PICTARIA_CHROME_BIN to enable)');
    return;
  }

  // Cleanup is registered before any resource exists: if a later boot step
  // throws, whatever DID start still gets torn down (a leaked fake-Immich
  // listener would otherwise keep the whole test run alive).
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-browser-'));
  let immich;
  let server;
  let browser;
  t.after(async () => {
    // Cleanup is fail-complete: one resource's teardown failure must never
    // strand the remaining listeners and turn the useful error into a CI
    // timeout. Report every cleanup failure after all resources were tried.
    const results = await Promise.allSettled([
      browser?.stop(),
      server?.stop(),
      immich?.stop(),
    ]);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch (error) {
      results.push({ status: 'rejected', reason: error });
    }
    const failures = results
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      const detail = failures
        .map((error) => error?.stack ?? String(error))
        .join('\n---\n');
      throw new AggregateError(failures, `browser smoke cleanup failed:\n${detail}`);
    }
  });

  await seedInsights(join(dir, 'insights.sqlite'));
  seedEnrichment(join(dir, 'enrichment.sqlite'));

  immich = await startFakeImmich({ assets: LIBRARY_ASSETS });
  server = await bootServer(dir, {
    password: PASSWORD,
    env: {
      IMMICH_BASE_URL: immich.base,
      IMMICH_API_KEY: 'fake-key',
      DEFAULT_PROVIDER: 'local_lmstudio',
      LMSTUDIO_MODEL: 'smoke-vision-model',
    },
  });
  browser = await launchChrome();
  const page = await browser.newPage();

  await t.test('password gate blocks, rejects a wrong password, admits the right one', async () => {
    await page.navigate(`${server.base}/`);
    await page.waitFor(
      'document.querySelector(".gate-backdrop:not([hidden]) input")',
      { label: 'password gate visible' },
    );

    await page.evaluate(`
      document.querySelector(".gate-backdrop input").value = "wrong-password";
      document.querySelector(".gate-backdrop button").click();
    `);
    const gateError = await page.waitFor(
      'document.querySelector(".gate-err:not([hidden])")?.textContent',
      { label: 'wrong-password error' },
    );
    assert.match(gateError, /didn't match/);

    await page.evaluate(`
      document.querySelector(".gate-backdrop input").value = ${JSON.stringify(PASSWORD)};
      document.querySelector(".gate-backdrop button").click();
    `);
    // Success reloads the page with the session cookie; the gate never
    // builds on an authorized load.
    await page.waitFor(
      'document.querySelectorAll("#cards a.p-card").length >= 3 && !document.querySelector(".gate-backdrop")',
      { label: 'home cards without a gate' },
    );
  });

  await t.test('supporter badge content cannot shift the desktop navigation', async () => {
    const layout = await page.evaluate(`(async () => {
      const slot = document.querySelector('.p-supporter-slot');
      const nav = document.querySelector('.p-nav');
      // Navigation can finish before the topbar images decode on a loaded CI
      // runner. Measure only after their intrinsic widths are stable, or the
      // wordmark loading between these reads looks like badge-induced shift.
      await Promise.all(
        [...document.querySelectorAll('.p-topbar img')]
          .map((image) => image.decode().catch(() => {})),
      );
      const emptyNavLeft = nav.getBoundingClientRect().left;
      const emptySlotWidth = slot.getBoundingClientRect().width;
      const chip = document.createElement('span');
      chip.className = 'p-supporter-chip';
      const mark = document.createElement('img');
      mark.src = '/brand/mark-128.png';
      await mark.decode();
      chip.append(mark, 'Supporter');
      slot.append(chip);
      const occupiedNavLeft = nav.getBoundingClientRect().left;
      const occupiedSlotWidth = slot.getBoundingClientRect().width;
      const chipWidth = chip.getBoundingClientRect().width;
      slot.replaceChildren();
      return { emptyNavLeft, occupiedNavLeft, emptySlotWidth, occupiedSlotWidth, chipWidth };
    })()`);

    assert.equal(layout.occupiedNavLeft, layout.emptyNavLeft);
    assert.equal(layout.emptySlotWidth, 112);
    assert.equal(layout.occupiedSlotWidth, 112);
    assert.ok(
      layout.chipWidth <= layout.occupiedSlotWidth,
      `the ${layout.chipWidth}px widest badge fits its ${layout.occupiedSlotWidth}px reserved slot`,
    );
  });

  await t.test('home Status box shows the running server version and uptime', async () => {
    const line = await page.waitFor(
      'document.getElementById("healthLine")?.textContent.includes(" · Up ") && document.getElementById("healthLine").textContent',
      { label: 'health line carries the version and uptime' },
    );
    assert.match(line, /^Server healthy · v\d+\.\d+\.\d+ · Up /);

    const examples = await page.evaluate(`[
      formatUptime(0),
      formatUptime(60),
      formatUptime(59 * 60),
      formatUptime(60 * 60),
      formatUptime((3 * 60 * 60) + (4 * 60)),
      formatUptime(24 * 60 * 60),
      formatUptime((3 * 24 * 60 * 60) + (4 * 60 * 60)),
      formatUptime(-1),
    ]`);
    assert.deepEqual(examples, [
      'Up less than a minute',
      'Up 1 minute',
      'Up 59 minutes',
      'Up 1 hour',
      'Up 3 hours 4 minutes',
      'Up 1 day',
      'Up 3 days 4 hours',
      '',
    ]);
  });

  await t.test('Activity is the final home card, linked from Settings, and renders merged history', async () => {
    const finalCards = await page.evaluate(`
      [...document.querySelectorAll('#cards > a')].slice(-2).map((link) => ({
        href: new URL(link.href).pathname,
        title: link.querySelector('h2')?.textContent.trim(),
      }))
    `);
    assert.deepEqual(finalCards, [
      { href: '/settings.html', title: '⚙ Settings' },
      { href: '/activity.html', title: '◷ Activity' },
    ]);

    await page.navigate(`${server.base}/settings.html`);
    await page.waitFor(
      'document.querySelector(".quick-nav a[href=\'/activity.html\']") && !document.querySelector(".gate-backdrop")',
      { label: 'Settings Activity link' },
    );
    await page.navigate(`${server.base}/activity.html`);
    await page.waitFor(
      'document.querySelectorAll("#history .event").length > 0 && !document.querySelector(".gate-backdrop")',
      { label: 'Activity history rendered' },
    );
    assert.deepEqual(
      await page.evaluate(`
        [...document.querySelectorAll('.p-nav a')].map((link) => ({
          href: new URL(link.href).pathname,
          title: link.textContent.trim(),
        }))
      `),
      [
        { href: '/insights.html', title: 'Insights' },
        { href: '/enrich.html', title: 'Enrich' },
        { href: '/curate.html', title: 'Curate' },
        { href: '/albums.html', title: 'Albums' },
        { href: '/metrics.html', title: 'Frame' },
        { href: '/remote.html', title: 'Remote' },
      ],
      'Activity uses the standard top nav without a page-only Activity tab',
    );
    assert.ok(await page.evaluate('document.getElementById("downloadCsv") && document.getElementById("downloadJson")'));
  });

  await t.test('every interactive page links the Pictaria license and source', async () => {
    const paths = [
      '/',
      '/activity.html',
      '/albums.html',
      '/curate.html',
      '/enrich.html',
      '/insights.html',
      '/metrics.html',
      '/settings.html',
      '/remote.html',
    ];
    const expectedText = `© ${new Date().getFullYear()} Pictaria · AGPL-3.0 · Source`;

    for (const path of paths) {
      await page.navigate(`${server.base}${path}`);
      await page.waitFor(
        'document.getElementById("legalFooter") && !document.querySelector(".gate-backdrop")',
        { label: `${path} legal footer` },
      );
      const notice = await page.evaluate(`(() => {
        const footer = document.getElementById('legalFooter');
        const links = [...footer.querySelectorAll('a')];
        return {
          count: document.querySelectorAll('#legalFooter').length,
          text: footer.textContent,
          visible: getComputedStyle(footer).display !== 'none' && getComputedStyle(footer).visibility !== 'hidden',
          links: links.map((link) => ({ href: link.href, target: link.target, rel: link.rel })),
        };
      })()`);
      assert.deepEqual(notice, {
        count: 1,
        text: expectedText,
        visible: true,
        links: [
          {
            href: 'https://github.com/pictaria-ai/pictaria-server/blob/main/LICENSE',
            target: '_blank',
            rel: 'noopener',
          },
          {
            href: 'https://github.com/pictaria-ai/pictaria-server',
            target: '_blank',
            rel: 'noopener',
          },
        ],
      }, `${path} carries the one always-visible legal footer`);
    }

    const remotePlacement = await page.evaluate(`(() => {
      const footer = document.getElementById('legalFooter');
      return {
        parent: footer.parentElement.tagName,
        insideScreen: Boolean(footer.closest('.screen')),
      };
    })()`);
    assert.deepEqual(remotePlacement, { parent: 'BODY', insideScreen: false });

    const themedStyles = await page.evaluate(`(() => {
      const footer = document.getElementById('legalFooter');
      const license = footer.querySelector('a');
      return ['dark', 'light'].map((theme) => {
        document.documentElement.dataset.theme = theme;
        return {
          theme,
          footerColor: getComputedStyle(footer).color,
          linkColor: getComputedStyle(license).color,
          fontSize: getComputedStyle(footer).fontSize,
        };
      });
    })()`);
    assert.deepEqual(themedStyles.map(({ theme, fontSize }) => ({ theme, fontSize })), [
      { theme: 'dark', fontSize: '12px' },
      { theme: 'light', fontSize: '12px' },
    ]);
    assert.ok(themedStyles.every(({ footerColor, linkColor }) => footerColor === linkColor));
    assert.notEqual(themedStyles[0].footerColor, themedStyles[1].footerColor);
  });

  await t.test('Enrich and Remote load with the HttpOnly session alone', async () => {
    await page.navigate(`${server.base}/enrich.html`);
    await page.waitFor(
      '!document.getElementById("connStatus")?.hidden && !document.querySelector(".gate-backdrop")',
      { label: 'enrich page authenticated by session cookie' },
    );

    await page.navigate(`${server.base}/remote.html`);
    await page.waitFor(
      'document.getElementById("connection")?.textContent !== "Connecting" && !document.querySelector(".gate-backdrop")',
      { label: 'remote page authenticated by session cookie' },
    );
  });

  await t.test('Insights renders and the lens directory search finds cities and countries', async () => {
    await page.navigate(`${server.base}/insights.html`);
    await page.waitFor(
      'document.getElementById("lensBtn") && !document.querySelector(".gate-backdrop")',
      { label: 'insights page ready' },
    );
    assert.equal(
      await page.evaluate('document.getElementById("metadataOmissionBanner")?.textContent'),
      'Insights left 1 invalid metadata value blank while scanning (file size: 1). All photos were still counted.',
    );
    assert.equal(
      await page.evaluate('document.getElementById("peopleTruncationBanner")?.textContent'),
      'Insights limited people relationships to 100 on 1 photo and left 2 additional entries out. Every photo and all non-people statistics were still counted.',
    );

    await page.evaluate('document.getElementById("lensBtn").click()');
    await page.waitFor(
      'document.getElementById("lensPopover") && !document.getElementById("lensPopover").hidden',
      { label: 'lens popover open' },
    );

    // The exact regression class that shipped past the backend suite: a
    // typed city below the snapshot's top-10 cutoff must still be found
    // once the full directory loads.
    const searchLens = (needle) => page.evaluate(`
      document.getElementById("lensSearch").value = ${JSON.stringify(needle)};
      document.getElementById("lensSearch").dispatchEvent(new Event("input"));
    `);
    await searchLens('vien');
    await page.waitFor(
      '[...document.querySelectorAll("#lensResults button")].some((b) => b.textContent.includes("Vienna"))',
      { label: 'Vienna appears in lens results' },
    );

    await searchLens('austr');
    await page.waitFor(
      '[...document.querySelectorAll("#lensResults button")].some((b) => b.textContent.includes("Austria"))',
      { label: 'Austria appears in lens results' },
    );
  });

  await t.test('Insights keeps a first-poll refresh failure visible', async () => {
    await page.navigate(`${server.base}/insights.html`);
    await page.waitFor(
      'document.getElementById("refreshBtn") && !document.querySelector(".gate-backdrop")',
      { label: 'insights refresh controls ready' },
    );

    const result = await page.evaluate(`(async () => {
      const realFetch = window.fetch;
      const terminal = {
        running: false,
        phase: 'error',
        error: 'Immich returned an oversized city on asset test-asset.',
        progress: { assetsSwept: 0 },
      };
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname === '/api/insights/refresh') {
          return Promise.resolve(new Response(JSON.stringify({ running: true, phase: 'assets' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (url.pathname === '/api/insights/status') {
          return Promise.resolve(new Response(JSON.stringify(terminal), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        if (url.pathname === '/api/insights') {
          return Promise.resolve(new Response(JSON.stringify({
            snapshot: null,
            status: terminal,
            immichUrl: null,
            favoritesTag: null,
            locationGroups: [],
          }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }));
        }
        return realFetch(input, init);
      };
      await refresh();
      const error = document.getElementById('refreshError');
      const observed = {
        hidden: error.hidden,
        text: error.textContent,
        refreshDisabled: document.getElementById('refreshBtn').disabled,
        polling: state.polling !== null,
      };
      window.fetch = realFetch;
      await load();
      return observed;
    })()`);

    assert.deepEqual(result, {
      hidden: false,
      text: 'Refresh failed: Immich returned an oversized city on asset test-asset.',
      refreshDisabled: false,
      polling: false,
    });
  });

  await t.test('Insights month drill scopes People/Places; a failed month never wears another scope\'s data', async () => {
    await page.navigate(`${server.base}/insights.html`);
    await page.waitFor(
      'document.getElementById("histogram")?.children.length >= 1 && !document.querySelector(".gate-backdrop")',
      { label: 'insights histogram ready' },
    );

    // 2020 holds three seeded cities with photos split between March and
    // June, so the year scope counts 2 per city and each month counts 1.
    await page.evaluate('[...document.getElementById("histogram").children].find((c) => c.dataset.year === "2020").click()');
    await page.waitFor(
      'document.querySelectorAll("#yearPanel .months .mcol").length === 12',
      { label: 'year panel months render' },
    );
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel .rows.mini-rows > *")].some((r) => r.textContent.includes("Chicago") && r.textContent.includes("2"))',
      { label: 'year-scoped places render' },
    );

    // A successful month select re-scopes titles and counts.
    await page.evaluate('[...document.querySelectorAll("#yearPanel .months .mcol")][2].click()');
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel h4")].some((h) => h.textContent === "Places · Mar 2020")',
      { label: 'places title scopes to March' },
    );
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel .rows.mini-rows > *")].some((r) => r.textContent.includes("Chicago") && r.textContent.includes("1"))',
      { label: 'March-scoped place counts render' },
    );

    // June's request fails (stubbed 500): the boxes must show June-scoped
    // "couldn't load" notes — never March's lists under June's highlight.
    await page.evaluate(`
      window.__realFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("/api/insights/year/2020/month/6")) {
          return Promise.resolve(new Response("{}", { status: 500 }));
        }
        return window.__realFetch(input, init);
      };
    `);
    await page.evaluate('[...document.querySelectorAll("#yearPanel .months .mcol")][5].click()');
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel h4")].some((h) => h.textContent === "Places · Jun 2020")',
      { label: 'places title scopes to June despite the failure' },
    );
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel .freshness")].filter((n) => n.textContent.includes("load this month")).length === 2',
      { label: 'both boxes carry the unavailable note' },
    );
    assert.equal(
      await page.evaluate('[...document.querySelectorAll("#yearPanel .rows.mini-rows > *")].some((r) => r.textContent.includes("Chicago"))'),
      false,
      'March places never show under the June selection',
    );
    await page.evaluate('window.fetch = window.__realFetch');

    // Deselecting the failed month restores the year lists from the detail
    // already in hand (no refetch).
    await page.evaluate('[...document.querySelectorAll("#yearPanel .months .mcol")][5].click()');
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel h4")].some((h) => h.textContent === "Places")',
      { label: 'year titles restored after deselect' },
    );
    await page.waitFor(
      '[...document.querySelectorAll("#yearPanel .rows.mini-rows > *")].some((r) => r.textContent.includes("Chicago") && r.textContent.includes("2"))',
      { label: 'year-scoped places restored' },
    );
    await page.evaluate('document.querySelector("#yearPanel .year-close").click()');
  });

  await t.test('Curate renders cards for the seeded review list', async () => {
    await page.navigate(`${server.base}/curate.html`);
    const cardCount = await page.waitFor(
      'document.querySelectorAll("#grid img").length',
      { label: 'curate cards render' },
    );
    assert.ok(cardCount >= 3, `expected >= 3 cards, saw ${cardCount}`);
    // No active enrichment run means the stacks-may-change note stays hidden.
    assert.equal(await page.evaluate('document.getElementById("metaEnrich").hidden'), true);
  });

  await t.test('Curate offers one transient Undo for single photos and whole Stacks', async () => {
    await page.navigate(`${server.base}/curate.html`);
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"]') && !document.querySelector(".gate-backdrop")`,
      { label: 'curate ready for undo' },
    );
    const baseline = Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent'));
    const yesButton = (assetId) =>
      `[...document.querySelectorAll('[data-asset-id="${assetId}"] .card-actions button')].find((button) => button.textContent === "Yes")`;

    // Hold the first request while the second finishes: even when rapid
    // decisions complete out of order, the newest click owns the one Undo.
    await page.evaluate(`(() => {
      const realFetch = window.fetch;
      window.__firstDecisionHeld = false;
      window.fetch = (input, init) => {
        const body = init?.body ? JSON.parse(init.body) : null;
        if (
          String(input).includes('/api/review/decision')
          && body?.action === 'approve'
          && body?.asset_ids?.[0] === ${JSON.stringify(REVIEW_ASSET_IDS[0])}
        ) {
          window.__firstDecisionHeld = true;
          return new Promise((resolve, reject) => {
            window.__releaseFirstDecision = () => {
              window.fetch = realFetch;
              realFetch(input, init).then(resolve, reject);
            };
          });
        }
        return realFetch(input, init);
      };
    })()`);
    await page.evaluate(`${yesButton(REVIEW_ASSET_IDS[0])}.click()`);
    await page.waitFor(
      'window.__firstDecisionHeld',
      { label: 'first decision held in flight' },
    );
    await page.evaluate(`${yesButton(REVIEW_ASSET_IDS[1])}.click()`);
    await page.waitFor(
      `!document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[1]}"]') && !document.getElementById("toastUndo").hidden`,
      { label: 'second decision replaces pending undo' },
    );
    await page.evaluate('window.__releaseFirstDecision()');
    await page.waitFor(
      `!document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"]')`,
      { label: 'older decision completes after newest' },
    );
    assert.equal(await page.evaluate('document.getElementById("toastUndo").textContent'), 'Undo (Z)');
    const toastLayout = await page.evaluate(`(() => {
      const message = document.getElementById('toastMessage').getBoundingClientRect();
      const button = document.getElementById('toastUndo').getBoundingClientRect();
      return {
        centerDifference: Math.abs((message.top + message.height / 2) - (button.top + button.height / 2)),
        pointerEvents: getComputedStyle(document.getElementById('toast')).pointerEvents,
      };
    })()`);
    assert.ok(toastLayout.centerDifference < 1, 'Undo is vertically aligned with the confirmation');
    assert.equal(toastLayout.pointerEvents, 'auto', 'Undo remains clickable');
    await page.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "z" }))');
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[1]}"]') && document.getElementById("toastMessage").textContent === "Decision undone"`,
      { label: 'Z restores newest photo' },
    );
    assert.equal(
      await page.evaluate(`Boolean(document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"]'))`),
      false,
      'the superseded decision remains applied',
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline - 1);

    // Restore the first photo directly so this subtest leaves the shared
    // fixture unchanged for the remaining Curate flows.
    await page.evaluate(`(async () => {
      const response = await fetch('/api/review/decision', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'clear', asset_ids: [${JSON.stringify(REVIEW_ASSET_IDS[0])}] }),
      });
      if (!response.ok) throw new Error('test cleanup failed');
      await loadAssetsFresh();
    })()`);
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"]') && document.querySelector(".p-tab.active .count").textContent === "${baseline}"`,
      { label: 'single-photo test state restored' },
    );

    // Keep-best creates two different decisions under the hood (approve the
    // star, review the rest); one Undo clears and restores the exact group.
    const stack = await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('#grid .p-card.stack')]
        .find((item) => [...item.querySelectorAll('button')].some((button) => button.textContent.startsWith('★ Keep')));
      const ids = state.assets.filter((asset) => asset.burstId === card.dataset.burstId).map((asset) => asset.assetId);
      return { burstId: card.dataset.burstId, ids };
    })()`);
    assert.equal(stack.ids.length, 2, 'seeded stack has two live photos');
    await page.evaluate(`(() => {
      const card = document.querySelector('[data-burst-id="${stack.burstId}"]');
      [...card.querySelectorAll('button')].find((button) => button.textContent.startsWith('★ Keep')).click();
    })()`);
    await page.waitFor(
      `${JSON.stringify(stack.ids)}.every((id) => !state.assets.some((asset) => asset.assetId === id)) && !document.getElementById("toastUndo").hidden`,
      { label: 'stack decision offers one undo' },
    );
    await page.evaluate('document.getElementById("toastUndo").click()');
    await page.waitFor(
      `${JSON.stringify(stack.ids)}.every((id) => state.assets.some((asset) => asset.assetId === id)) && document.getElementById("toastMessage").textContent === "Decision undone"`,
      { label: 'button restores whole stack' },
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline);
  });

  await t.test('Curate Undo preserves bucket counts under search and restores lightbox identity', async () => {
    await page.navigate(`${server.base}/curate.html`);
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[2]}"]') && !document.querySelector(".gate-backdrop")`,
      { label: 'curate ready for filtered undo' },
    );
    const baseline = Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent'));

    // The tab is the complete bucket count even while the grid total follows
    // a search. Undo must adjust that tab relatively, not replace it with 1.
    await page.evaluate(`(() => {
      const search = document.getElementById('search');
      search.value = 'review-3.jpg';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.waitFor(
      `state.total === 1 && document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[2]}"]')`,
      { label: 'search narrows Curate to one photo' },
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline);
    await page.evaluate(`
      [...document.querySelectorAll('[data-asset-id="${REVIEW_ASSET_IDS[2]}"] .card-actions button')]
        .find((button) => button.textContent === 'Yes').click()
    `);
    await page.waitFor(
      `!document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[2]}"]') && !document.getElementById('toastUndo').hidden`,
      { label: 'filtered decision offers undo' },
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline - 1);
    await page.evaluate('document.getElementById("toastUndo").click()');
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[2]}"]') && document.getElementById('toastMessage').textContent === 'Decision undone'`,
      { label: 'filtered photo restored' },
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline);

    await page.evaluate(`(() => {
      const search = document.getElementById('search');
      search.value = '';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.waitFor(
      `state.total === ${baseline} && document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[3]}"]')`,
      { label: 'full Curate bucket restored' },
    );

    // A lightbox decision advances immediately. Undo must reopen the restored
    // photo so the image, index, and next keyboard decision all agree.
    await page.evaluate(`document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[3]}"] img').click()`);
    await page.waitFor(
      `document.getElementById('lbImage').src.includes('${REVIEW_ASSET_IDS[3]}')`,
      { label: 'undo target opens in lightbox' },
    );
    await page.evaluate('document.querySelector(\'[data-lb="approve"]\').click()');
    await page.waitFor(
      `!document.getElementById('lbImage').src.includes('${REVIEW_ASSET_IDS[3]}') && !document.getElementById('toastUndo').hidden`,
      { label: 'lightbox advances after decision' },
    );
    await page.evaluate('document.getElementById("toastUndo").click()');
    await page.waitFor(
      `document.getElementById('lbImage').src.includes('${REVIEW_ASSET_IDS[3]}') && state.assets[state.lightboxIndex]?.assetId === '${REVIEW_ASSET_IDS[3]}'`,
      { label: 'lightbox image and state return to undone photo' },
    );
    await page.evaluate('document.getElementById("lbClose").click()');
  });

  await t.test('Curate keeps a live Undo when its background append fails', async () => {
    await page.navigate(`${server.base}/curate.html?limit=5`);
    await page.waitFor(
      'state.assets.length === 5 && !document.querySelector(".gate-backdrop")',
      { label: 'short Curate page ready' },
    );
    const baseline = Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent'));
    const targetId = await page.evaluate(`(() => {
      const asset = state.assets.find((item) => document.querySelector('[data-asset-id="' + item.assetId + '"]'));
      return asset.assetId;
    })()`);

    // The decision succeeds, but the low-water append it starts returns an
    // ordinary load error. The error replaces the message, not the Undo.
    await page.evaluate(`(() => {
      const realFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname === '/api/review/assets' && Number(url.searchParams.get('offset')) > 0) {
          window.fetch = realFetch;
          return Promise.resolve(new Response(JSON.stringify({ error: { message: 'append blocked' } }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return realFetch(input, init);
      };
    })()`);
    await page.evaluate(`
      [...document.querySelectorAll('[data-asset-id="${targetId}"] .card-actions button')]
        .find((button) => button.textContent === 'Yes').click()
    `);
    await page.waitFor(
      `document.getElementById('toastMessage').textContent === 'append blocked' && !document.getElementById('toastUndo').hidden`,
      { label: 'append error retains undo action' },
    );
    await page.evaluate('document.getElementById("toastUndo").click()');
    await page.waitFor(
      `state.assets.some((asset) => asset.assetId === '${targetId}') && document.getElementById('toastMessage').textContent === 'Decision undone'`,
      { label: 'undo survives append error' },
    );
    assert.equal(Number(await page.evaluate('document.querySelector(".p-tab.active .count").textContent')), baseline);
  });

  await t.test('Curate lightbox contains long filenames and model names inside its sidebar', async () => {
    await page.navigate(`${server.base}/curate.html`);
    await page.waitFor(
      `document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"] img') && !document.querySelector(".gate-backdrop")`,
      { label: 'long-filename curate card ready' },
    );
    await page.evaluate(`document.querySelector('[data-asset-id="${REVIEW_ASSET_IDS[0]}"] img').click()`);
    await page.waitFor(
      'document.getElementById("lightbox").classList.contains("open") && !document.getElementById("lbModel").hidden',
      { label: 'long-content lightbox ready' },
    );

    const layout = await page.evaluate(`(() => {
      const side = document.querySelector('.lb-side');
      const file = document.getElementById('lbFile');
      const sideRect = side.getBoundingClientRect();
      const overflowingChild = [...side.querySelectorAll('*')].find((node) => {
        const rect = node.getBoundingClientRect();
        if (node.hidden || (rect.width === 0 && rect.height === 0)) return false;
        return rect.left < sideRect.left || rect.right > sideRect.right + 0.5;
      });
      return {
        sideClientWidth: side.clientWidth,
        sideScrollWidth: side.scrollWidth,
        sideScrollLeft: side.scrollLeft,
        overflowX: getComputedStyle(side).overflowX,
        overflowingChild: overflowingChild?.id || overflowingChild?.className || null,
        filename: file.textContent,
        filenameTruncated: file.scrollWidth > file.clientWidth,
        filenameOverflow: getComputedStyle(file).overflow,
        filenameEllipsis: getComputedStyle(file).textOverflow,
        model: document.getElementById('lbModel').textContent,
      };
    })()`);

    assert.equal(layout.filename, LONG_ASSET_FILENAME);
    assert.match(layout.model, new RegExp(LONG_MODEL_NAME));
    assert.equal(layout.overflowX, 'hidden');
    assert.equal(layout.sideScrollLeft, 0);
    assert.equal(layout.sideScrollWidth, layout.sideClientWidth, 'sidebar must have no horizontal overflow');
    assert.equal(layout.overflowingChild, null, 'every visible lightbox child stays inside the sidebar');
    assert.equal(layout.filenameTruncated, true, 'long filename should truncate');
    assert.equal(layout.filenameOverflow, 'hidden');
    assert.equal(layout.filenameEllipsis, 'ellipsis');
    await page.evaluate('document.getElementById("lbClose").click()');
  });

  await t.test('Curate remnant: honest badge, compare with decided sibling, apply-to-all hidden', async () => {
    await page.navigate(`${server.base}/curate.html`);
    await page.waitFor(
      'document.querySelectorAll("#grid img").length >= 1 && !document.querySelector(".gate-backdrop")',
      { label: 'curate ready' },
    );

    // The remnant carries the context note, not a "best of N" star claim.
    const remnantCard = '[...document.querySelectorAll("#grid .p-card")].find((c) => c.querySelector(".p-badge")?.textContent === "1 of 2 decided")';
    await page.waitFor(remnantCard, { label: 'remnant badge renders' });

    // Clicking it opens the compare view with the decided sibling dimmed
    // and labeled with its outcome.
    await page.evaluate(`${remnantCard}.querySelector("img").click()`);
    await page.waitFor(
      'document.getElementById("burstbox").classList.contains("open")',
      { label: 'compare view opens' },
    );
    assert.equal(await page.evaluate('document.querySelectorAll("#bbGrid .bb-cell").length'), 2);
    const outcome = await page.waitFor(
      'document.querySelector("#bbGrid .bb-cell.decided .p-badge")?.textContent',
      { label: 'decided sibling labeled' },
    );
    assert.equal(outcome, '✓ kept');
    // The stub isn't in the candidates payload. Its filename must ride the
    // stack annotation, or the label degrades to the raw asset id.
    assert.equal(
      await page.evaluate('document.querySelector("#bbGrid .bb-cell.decided .card-file").textContent'),
      'stack-keep.jpg',
      'decided stub is labeled with its filename',
    );
    assert.match(await page.evaluate('document.getElementById("bbTitle").textContent'), /1 of 2 photos left/);

    // Zoom the live remnant: the "apply to all" checkbox must be hidden —
    // it may never overwrite the decided sibling.
    await page.evaluate('document.querySelector("#bbGrid .bb-cell:not(.decided) img").click()');
    await page.waitFor(
      'document.getElementById("lightbox").classList.contains("open")',
      { label: 'zoomed from compare' },
    );
    assert.equal(await page.evaluate('document.getElementById("lbBurst").hidden'), true);
    await page.evaluate('document.getElementById("lbClose").click()');

    // Decide the remnant from the compare view; with nothing live left the
    // compare view closes itself.
    const approveRemnant = '[...document.querySelectorAll("#bbGrid .bb-cell:not(.decided) .card-actions button")].find((b) => b.textContent === "Yes")';
    await page.waitFor(approveRemnant, { label: 'remnant actions available' });
    await page.evaluate(`${approveRemnant}.click()`);
    await page.waitFor(
      '!document.getElementById("burstbox").classList.contains("open")',
      { label: 'compare closes when the moment is fully decided' },
    );
    await page.waitFor(
      'document.querySelector(".p-tab.active .count").textContent === "11"',
      { label: 'review photos + the arrow pair remain for later subtests' },
    );
  });

  await t.test('Curate compare zoom: arrows follow the displayed capture order', async () => {
    await page.navigate(`${server.base}/curate.html`);
    await page.waitFor(
      'document.querySelectorAll("#grid img").length >= 1 && !document.querySelector(".gate-backdrop")',
      { label: 'curate ready' },
    );

    // Open the arrow pair's stack card and zoom the LEFT compare cell
    // (arrow-a: shot first, lower score — the queue would order it second).
    await page.evaluate('[...document.querySelectorAll("#grid .p-card.stack img.card-thumb")][0].click()');
    await page.waitFor(
      'document.getElementById("burstbox").classList.contains("open")',
      { label: 'compare view opens' },
    );
    const leftCell = 'document.querySelector("#bbGrid .bb-cell img")';
    assert.match(await page.evaluate(`${leftCell}.src`), new RegExp(ARROW_A_ID), 'compare shows capture order: arrow-a leftmost');
    await page.evaluate(`${leftCell}.click()`);
    await page.waitFor(
      'document.getElementById("lightbox").classList.contains("open")',
      { label: 'zoomed from compare' },
    );
    assert.match(await page.evaluate('document.getElementById("lbImage").src'), new RegExp(ARROW_A_ID));
    assert.equal(await page.evaluate('document.getElementById("lbImmich").hidden'), false, 'Open in Immich shows when an Immich URL is configured');
    assert.match(await page.evaluate('document.getElementById("lbImmich").href'), new RegExp(`/photos/.*${ARROW_A_ID}`), 'Open in Immich targets the zoomed photo');

    // → moves to the cell on the RIGHT (arrow-b), never out of the moment;
    // ← comes back. Before the fix, → walked the queue's score order and
    // appeared to go backwards.
    const press = (key) => page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)} }))`);
    await press('ArrowRight');
    await page.waitFor(`document.getElementById("lbImage").src.includes("${ARROW_B_ID}")`, { label: '→ goes right' });
    await press('ArrowRight');
    assert.match(await page.evaluate('document.getElementById("lbImage").src'), new RegExp(ARROW_B_ID), '→ at the end stays inside the moment');
    await press('ArrowLeft');
    await page.waitFor(`document.getElementById("lbImage").src.includes("${ARROW_A_ID}")`, { label: '← comes back left' });
    await press('Escape');

    // Keep-best cleans the pair up so later subtests see exactly nine.
    await page.evaluate('document.getElementById("bbKeepBest").click()');
    await page.waitFor(
      'document.querySelector(".p-tab.active .count").textContent === "9"',
      { label: 'arrow pair decided; nine remain' },
    );
  });

  await t.test('Curate keeps top and bottom Load more controls synchronized', async () => {
    await page.navigate(`${server.base}/curate.html?limit=3`);
    await page.waitFor(
      'document.querySelectorAll("#grid img").length === 3 && !document.querySelector(".gate-backdrop")',
      { label: 'first Curate page renders' },
    );

    const firstPage = await page.evaluate(`(() => ({
      topDisabled: document.getElementById('loadMore').disabled,
      bottomDisabled: document.getElementById('loadMoreBottom').disabled,
      bottomHidden: document.getElementById('loadMoreBottomRow').hidden,
    }))()`);
    assert.deepEqual(firstPage, { topDisabled: false, bottomDisabled: false, bottomHidden: false });

    await page.evaluate('document.getElementById("loadMoreBottom").click()');
    await page.waitFor(
      'document.querySelectorAll("#grid img").length === 6 && !document.getElementById("loadMore").disabled',
      { label: 'bottom control appends the second page' },
    );
    await page.evaluate('document.getElementById("loadMore").click()');
    await page.waitFor(
      'document.querySelectorAll("#grid img").length === 9 && document.getElementById("loadMore").disabled',
      { label: 'top control appends the final page' },
    );

    const finalPage = await page.evaluate(`(() => ({
      topDisabled: document.getElementById('loadMore').disabled,
      bottomDisabled: document.getElementById('loadMoreBottom').disabled,
      bottomHidden: document.getElementById('loadMoreBottomRow').hidden,
    }))()`);
    assert.deepEqual(finalPage, { topDisabled: true, bottomDisabled: true, bottomHidden: true });
  });

  await t.test('Curate flows across page boundaries: auto-append + lightbox continuity', async () => {
    // A 3-photo page against the 9-photo queue: deciding must auto-append the
    // next page and keep the lightbox open across the boundary. A false "all
    // done" screen must never appear mid-queue.
    await page.navigate(`${server.base}/curate.html?limit=3`);
    await page.waitFor(
      'document.querySelectorAll("#grid img").length >= 1 && !document.querySelector(".gate-backdrop")',
      { label: 'first page renders' },
    );
    await page.evaluate('document.querySelector("#grid img").click()');
    await page.waitFor(
      'document.getElementById("lightbox").classList.contains("open")',
      { label: 'lightbox open' },
    );

    // Approve through the boundary: five decisions against a 3-photo page.
    for (let decided = 1; decided <= 5; decided++) {
      await page.evaluate('document.querySelector(\'[data-lb="approve"]\').click()');
      await page.waitFor(
        `document.querySelector(".p-tab.active .count").textContent === "${9 - decided}"`,
        { label: `decision ${decided} lands` },
      );
    }
    const stillOpen = await page.evaluate('document.getElementById("lightbox").classList.contains("open")');
    assert.equal(stillOpen, true, 'lightbox must stay open across page boundaries');

    // Drain the rest: at the TRUE end the lightbox closes and the empty
    // state says done (never the mid-queue false-empty).
    for (let decided = 6; decided <= 9; decided++) {
      await page.evaluate('document.querySelector(\'[data-lb="approve"]\').click()');
      await page.waitFor(
        `document.querySelector(".p-tab.active .count").textContent === "${9 - decided}"`,
        { label: `decision ${decided} lands` },
      );
    }
    await page.waitFor(
      '!document.getElementById("lightbox").classList.contains("open")',
      { label: 'lightbox closes at the true end' },
    );
    const emptyText = await page.waitFor(
      'document.querySelector("#grid .empty")?.textContent',
      { label: 'empty state renders' },
    );
    assert.match(emptyText, /Queue is empty/);
    assert.equal(await page.evaluate('document.getElementById("loadMore").disabled'), true);
    assert.equal(await page.evaluate('document.getElementById("loadMoreBottomRow").hidden'), true);
  });

  await t.test('Smart Albums: multi-country album round-trips through the form', async () => {
    await page.navigate(`${server.base}/albums.html`);
    await page.waitFor(
      'document.getElementById("createForm") && !document.querySelector(".gate-backdrop")',
      { label: 'albums page ready' },
    );

    assert.deepEqual(
      await page.evaluate(`
        (() => {
          const panel = document.getElementById("createAlbumPanel");
          return {
            open: panel.open,
            title: panel.querySelector("summary h2").textContent,
            chevronHidden: panel.querySelector("summary .chev").getAttribute("aria-hidden"),
          };
        })()
      `),
      { open: true, title: 'Create Filtered Album', chevronHidden: 'true' },
      'creation panel starts open with an accessible native disclosure header',
    );
    await page.evaluate(`
      document.getElementById("albumNameInput").value = "Preserved while collapsed";
      document.querySelector("#createAlbumPanel > summary").click();
    `);
    assert.equal(
      await page.evaluate('document.getElementById("createAlbumPanel").open'),
      false,
      'creation panel collapses',
    );
    await page.navigate(`${server.base}/albums.html`);
    await page.waitFor(
      'document.getElementById("createForm") && !document.querySelector(".gate-backdrop")',
      { label: 'albums page ready after remembered collapse' },
    );
    assert.equal(
      await page.evaluate('document.getElementById("createAlbumPanel").open'),
      false,
      'creation panel remembers its collapsed state across page visits',
    );
    await page.evaluate('document.querySelector("#createAlbumPanel > summary").click()');
    assert.equal(
      await page.evaluate('document.getElementById("createAlbumPanel").open'),
      true,
      'creation panel reopens',
    );
    await page.navigate(`${server.base}/albums.html`);
    await page.waitFor(
      'document.getElementById("createForm") && !document.querySelector(".gate-backdrop")',
      { label: 'albums page ready after remembered expansion' },
    );
    assert.equal(
      await page.evaluate('document.getElementById("createAlbumPanel").open'),
      true,
      'creation panel remembers its expanded state across page visits',
    );

    await page.evaluate(`
      document.getElementById("albumNameInput").value = "Browser Smoke AT+JP";
      document.getElementById("countryInput").value = "Austria, Japan";
      document.getElementById("createForm").requestSubmit();
    `);
    const toast = await page.waitFor(
      'document.getElementById("toast").classList.contains("visible") && document.getElementById("toast").textContent',
      { label: 'create toast' },
    );
    assert.match(toast, /Created Browser Smoke AT\+JP/);

    const jobsText = await page.waitFor(
      'document.getElementById("jobsList").textContent.includes("Browser Smoke AT+JP") && document.getElementById("jobsList").textContent',
      { label: 'album appears in the list' },
    );
    assert.match(jobsText, /Austria OR Japan/);
  });

  await t.test('Smart Albums: countries + city is rejected with the server message', async () => {
    await page.evaluate(`
      document.getElementById("albumNameInput").value = "Bad Combo";
      document.getElementById("countryInput").value = "Austria, Japan";
      document.getElementById("cityInput").value = "Vienna";
      document.getElementById("createForm").requestSubmit();
    `);
    const toast = await page.waitFor(
      'document.getElementById("toast").textContent.includes("cannot be combined") && document.getElementById("toast").textContent',
      { label: 'validation toast' },
    );
    assert.match(toast, /Multiple countries cannot be combined with a city or state/);
  });

  await t.test('Settings: AI Providers groups reusable connections without changing persistence', async () => {
    await page.navigate(`${server.base}/settings.html`);
    await page.waitFor(
      'document.querySelector("#fields-providers .field") && !document.querySelector(".gate-backdrop")',
      { label: 'settings forms built' },
    );
    assert.deepEqual(
      await page.evaluate('[...document.querySelectorAll(".quick-nav a")].slice(0, 2).map((link) => link.textContent)'),
      ['Server', 'AI Providers'],
      'AI Providers is the second Settings section',
    );
    assert.deepEqual(
      await page.evaluate(`
        [
          "save-server", "save-providers", "save-insights", "save-enrich",
          "save-curate", "voiceSave", "save-prompts", "save-ambient", "save-backup",
        ].map((id) => document.getElementById(id).textContent)
      `),
      [
        'Save Server settings',
        'Save AI Providers settings',
        'Save Insights settings',
        'Save Enrich settings',
        'Save Curate settings',
        'Save Voice TTS settings',
        'Save Prompts settings',
        'Save Location Names settings',
        'Save Backups settings',
      ],
      'save buttons mirror their Settings section titles',
    );
    assert.equal(await page.evaluate('document.getElementById("sub-providers").textContent'), '1 configured');

    assert.equal(
      await page.evaluate('document.querySelectorAll("#fields-enrich details.sub-details").length'),
      1,
      'Enrich retains only its advanced prompt and taxonomy subsection',
    );
    assert.equal(
      await page.evaluate('!!document.getElementById("f2-enrich-defaultProvider")'),
      false,
      'Settings does not duplicate the provider picker owned by the Enrich page',
    );
    assert.equal(
      await page.evaluate('document.querySelectorAll("#fields-providers .field").length'),
      16,
      'all provider key/model/URL fields live in AI Providers',
    );
    assert.ok(
      await page.evaluate('!!document.querySelector("#fields-providers #f2-providers-openAiApiKey")'),
      'the shared OpenAI key moved out of Server',
    );
    assert.ok(
      await page.evaluate('!!document.querySelector("#fields-providers #f2-providers-veniceModel")'),
      'provider defaults moved out of Enrich',
    );
    assert.equal(
      await page.evaluate('document.querySelectorAll("#fields-providers > .sub-head").length'),
      8,
      'all eight providers have headings',
    );
    assert.deepEqual(
      await page.evaluate('[...document.querySelectorAll("#fields-providers > .provider-division > .provider-division-title")].map((node) => node.textContent)'),
      ['Local Models', 'Cloud Models'],
      'local and cloud providers have prominent divisions',
    );
    assert.equal(
      await page.evaluate('document.querySelectorAll("#fields-providers > .provider-division.separated").length'),
      1,
      'the Cloud Models division carries the visual separator',
    );
    const promptGroup = 'document.querySelector("#fields-enrich details.sub-details")';
    assert.equal(await page.evaluate(`${promptGroup}.open`), false, 'prompt group starts collapsed');
    assert.ok(
      await page.evaluate(`!!${promptGroup}.querySelector("#f2-enrich-systemPrompt")`),
      'prompt overrides remain under Enrich',
    );
    assert.equal(
      await page.evaluate(`${promptGroup}.querySelectorAll(".field").length`),
      3,
      'system prompt, per-photo prompt, and taxonomy overrides fill the prompt group',
    );
    // render() reads the original backend sections through the presentation
    // mapping; no key is configured, so the secret placeholder is honest.
    assert.equal(
      await page.evaluate('document.getElementById("f2-providers-veniceApiKey").placeholder'),
      'not set',
      'provider fields are populated from their existing settings metadata',
    );

    // Settings → Server carries the running build's version.
    const versionLine = await page.waitFor(
      '!document.getElementById("server-version-line").hidden && document.getElementById("server-version-line").textContent',
      { label: 'server version line in Settings' },
    );
    assert.match(versionLine, /^Pictaria Server v\d+\.\d+\.\d+$/);

    // One UI save splits values back into the unchanged server/enrich API
    // sections. Secrets stay redacted when the updated settings render.
    await page.evaluate(`
      window.__settingsPatch = null;
      const settingsFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        if (String(input) === '/api/settings' && init.method === 'PATCH') {
          window.__settingsPatch = JSON.parse(init.body);
        }
        return settingsFetch(input, init);
      };
      const model = document.getElementById("f2-providers-veniceModel");
      model.value = "qwen-test";
      model.dispatchEvent(new Event("input"));
      const key = document.getElementById("f2-providers-openAiApiKey");
      key.value = "phase-one-test-key";
      key.dispatchEvent(new Event("input"));
      const ttsKey = document.getElementById("f2-providers-elevenLabsApiKey");
      ttsKey.value = "phase-one-elevenlabs-key";
      ttsKey.dispatchEvent(new Event("input"));
    `);
    await page.waitFor(
      '!document.getElementById("secdirty-providers").hidden',
      { label: 'AI Providers shows unsaved changes' },
    );
    await page.evaluate('document.getElementById("save-providers").click()');
    await page.waitFor(
      'document.getElementById("note-providers").textContent.startsWith("Saved")',
      { label: 'AI Providers saved' },
    );
    assert.deepEqual(
      await page.evaluate('window.__settingsPatch'),
      {
        enrich: { veniceModel: 'qwen-test' },
        server: { openAiApiKey: 'phase-one-test-key' },
        voice: { elevenLabsApiKey: 'phase-one-elevenlabs-key' },
      },
      'saving providers sends only dirty fields and preserves environment/default provenance',
    );
    const persisted = await page.evaluate(`
      fetch('/api/settings').then((response) => response.json()).then((settings) => ({
        openAi: settings.server.openAiApiKey,
        veniceModel: settings.enrich.veniceModel.value,
        elevenLabs: settings.voice.elevenLabsApiKey,
      }))
    `);
    assert.equal(persisted.openAi.configured, true);
    assert.equal(persisted.openAi.value, '', 'the shared key remains redacted');
    assert.equal(persisted.veniceModel, 'qwen-test');
    assert.equal(persisted.elevenLabs.configured, true);
    assert.equal(persisted.elevenLabs.value, '', 'the ElevenLabs key remains redacted');
    assert.equal(await page.evaluate('document.getElementById("sub-providers").textContent'), '3 configured');
  });

  await t.test('Enrich remembers its provider selection through server settings', async () => {
    await page.navigate(`${server.base}/enrich.html`);
    await page.waitFor(
      'document.getElementById("enrichProvider")?.options.length > 0 && !document.querySelector(".gate-backdrop")',
      { label: 'enrichment providers loaded' },
    );
    assert.equal(await page.evaluate('document.getElementById("enrichProvider").value'), 'local_lmstudio');
    assert.match(
      await page.evaluate('document.getElementById("providerNote").textContent'),
      /selection is remembered/,
    );

    await page.evaluate(`
      const select = document.getElementById("enrichProvider");
      select.value = "cloud_openai";
      select.dispatchEvent(new Event("change"));
    `);
    await page.waitFor(
      'document.getElementById("toast").textContent.includes("Enrichment provider set") && !document.getElementById("enrichProvider").disabled',
      { label: 'provider choice persisted' },
    );
    assert.equal(
      await page.evaluate(`fetch('/api/settings').then((response) => response.json()).then((settings) => settings.enrich.defaultProvider.value)`),
      'cloud_openai',
    );

    await page.navigate(`${server.base}/remote.html`);
    await page.navigate(`${server.base}/enrich.html`);
    await page.waitFor(
      'document.getElementById("enrichProvider")?.value === "cloud_openai"',
      { label: 'remembered provider restored after navigation' },
    );

    // A remembered provider can become unavailable later (for example, its
    // key is removed). The page must explain the state and refuse to start —
    // never silently run a different configured provider.
    await page.evaluate(`fetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enrich: { defaultProvider: 'venice' } }),
    })`);
    await page.navigate(`${server.base}/remote.html`);
    await page.navigate(`${server.base}/enrich.html`);
    await page.waitFor(
      'document.getElementById("enrichProvider")?.value === "venice" && document.getElementById("providerNote")?.classList.contains("bad")',
      { label: 'unconfigured remembered provider identified' },
    );
    assert.equal(await page.evaluate('document.getElementById("enrichStart").disabled'), true);

    // Restore a configured choice for the remaining shared-server tests.
    await page.evaluate(`
      const select = document.getElementById("enrichProvider");
      select.value = "cloud_openai";
      select.dispatchEvent(new Event("change"));
    `);
    await page.waitFor(
      'document.getElementById("toast").textContent.includes("Enrichment provider set") && !document.getElementById("enrichProvider").disabled',
      { label: 'configured provider restored' },
    );
    // The following Settings subtests intentionally share one loaded page.
    await page.navigate(`${server.base}/settings.html`);
    await page.waitFor(
      'document.getElementById("ttsSpeak") && !document.querySelector(".gate-backdrop")',
      { label: 'settings restored for subsequent tests' },
    );
    assert.equal(
      await page.evaluate('document.querySelector("#f2-curate-refereeProvider option[value=\'\']").textContent'),
      'Follow Enrich provider (OpenAI)',
      'Curate names the Enrich provider it will follow',
    );
    assert.match(
      await page.evaluate('document.querySelector("label[for=f2-curate-refereeModel]").textContent'),
      /Referee model override/,
    );
    assert.match(
      await page.evaluate('document.getElementById("f2-curate-refereeModel").closest(".field").querySelector(".setting-desc").textContent'),
      /must also be valid for every provider/,
      'the cross-provider model override caveat is visible',
    );
  });

  await t.test('Settings: the Voice TTS tester uses the authenticated JSON POST route', async () => {
    await page.evaluate(`
      window.__ttsRequest = null;
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init = {}) => {
        if (String(input) === '/api/voice/tts') {
          window.__ttsRequest = {
            url: String(input),
            method: init.method,
            headers: init.headers,
            body: init.body,
          };
          return new Response(
            JSON.stringify({ error: { message: 'TTS test intercepted' } }),
            { status: 501, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return realFetch(input, init);
      };
      document.getElementById('ttsText').value = 'Browser TTS check';
      document.getElementById('ttsSpeak').click();
    `);

    const request = await page.waitFor(
      'window.__ttsRequest && document.getElementById("ttsResult").textContent === "TTS test intercepted" && window.__ttsRequest',
      { label: 'TTS tester emits a POST request' },
    );
    assert.equal(request.url, '/api/voice/tts');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), { text: 'Browser TTS check' });
  });
});
