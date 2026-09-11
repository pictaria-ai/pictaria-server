// PIC-359: read-only investigation, deliberately not wired into production.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export class ProofIncomplete extends Error {
  constructor(message) { super(message); this.name = 'ProofIncomplete'; }
}

// Keep sub-millisecond precision from responses. Immich's date-query DTO uses
// JavaScript Date, so split points themselves must be whole milliseconds.
export function timestamp(value) {
  const match = typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/);
  const ms = match ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms)) throw new ProofIncomplete('Missing or unsupported capture timestamp.');
  return { ms, ns: BigInt(ms) * 1_000_000n + BigInt((match[1] || '').padEnd(9, '0').slice(3)) };
}

function bound(value) {
  if (value === undefined) return null;
  const result = timestamp(value);
  if (result.ns !== BigInt(result.ms) * 1_000_000n) {
    throw new ProofIncomplete('Input date bounds must have millisecond precision.');
  }
  return result.ms;
}

function parsePage(response, size, page = 1) {
  const assets = response?.assets;
  if (!Array.isArray(assets?.items) || assets.items.length > size || !Object.hasOwn(assets, 'nextPage')) {
    throw new ProofIncomplete('Unexpected metadata-search response.');
  }
  const more = assets.nextPage !== null;
  if (more && (String(assets.nextPage) !== String(page + 1) || assets.items.length !== size)) {
    throw new ProofIncomplete('Unexpected metadata-search pagination.');
  }
  const ids = new Set();
  let previous = null;
  const items = assets.items.map(asset => {
    if (typeof asset?.id !== 'string' || !asset.id || ids.has(asset.id) || asset.type !== 'IMAGE') {
      throw new ProofIncomplete('Invalid or duplicate entry within one metadata page.');
    }
    ids.add(asset.id);
    const time = timestamp(asset.fileCreatedAt);
    if (previous !== null && time.ns > previous) throw new ProofIncomplete('Metadata results are not ordered by capture date.');
    previous = time.ns;
    return { id: asset.id, time };
  });
  return { items, more };
}

function splitPoint(items, lo, hi) {
  // Use the oldest returned timestamp to carve off roughly one page of newer
  // results. Never rely on which members of a tied timestamp were sampled.
  for (let i = items.length - 1; i >= 0; i--) {
    const value = items[i].time.ms;
    if ((lo === null || value > lo) && (hi === null || value < hi)) return value;
  }
  if (lo !== null && hi !== null) {
    if (hi - lo <= 1) throw new ProofIncomplete('More than one page falls in an indivisible millisecond interval; completeness cannot be established.');
    return lo + Math.floor((hi - lo) / 2);
  }
  // Bracket a tied endpoint. If it remains oversized, the next bounded split
  // fails explicitly instead of retrying offsets until the set looks stable.
  if (lo !== null) return lo + 1;
  if (hi !== null) return hi - 1;
  throw new ProofIncomplete('Cannot find a safe date split.');
}

export async function collectByDate({ search, filters = {}, size = 1000, maxRequests = 500,
  maxItems = 500_000, timeoutMs = 300_000, now = () => performance.now() }) {
  if (!Number.isInteger(size) || size < 1 || size > 1000) throw new ProofIncomplete('Invalid page size.');
  const { takenAfter, takenBefore, page, order, ...base } = filters;
  if (page !== undefined || order !== undefined || Object.hasOwn(base, 'size')) {
    throw new ProofIncomplete('Probe filters must not override pagination or ordering.');
  }
  const lo = bound(takenAfter), hi = bound(takenBefore);
  if (lo !== null && hi !== null && lo > hi) throw new ProofIncomplete('Invalid date interval.');
  const pending = [{ lo, hi }];
  const found = new Map();
  const started = now();
  const stats = { requests: 0, returnedItems: 0, completeWindows: 0, boundaryRepeats: 0 };
  function deadline() {
    if (now() - started >= timeoutMs) throw new ProofIncomplete('Read-only traversal deadline reached.');
  }
  while (pending.length) {
    deadline();
    if (stats.requests >= maxRequests) throw new ProofIncomplete('Read-only traversal request limit reached.');
    const range = pending.pop();
    stats.requests++;
    const response = await search({ ...base, type: 'IMAGE', order: 'desc', page: 1, size,
      ...(range.lo === null ? {} : { takenAfter: new Date(range.lo).toISOString() }),
      ...(range.hi === null ? {} : { takenBefore: new Date(range.hi).toISOString() }),
    });
    deadline();
    const result = parsePage(response, size);
    stats.returnedItems += result.items.length;
    if (stats.returnedItems > maxItems) throw new ProofIncomplete('Read-only traversal response-item limit reached.');
    const lowNs = range.lo === null ? null : BigInt(range.lo) * 1_000_000n;
    const highNs = range.hi === null ? null : BigInt(range.hi) * 1_000_000n;
    for (const { time } of result.items) {
      if ((lowNs !== null && time.ns < lowNs) || (highNs !== null && time.ns > highNs)) {
        throw new ProofIncomplete('Upstream returned an entry outside the requested date bounds.');
      }
    }
    if (result.more) {
      const pivot = splitPoint(result.items, range.lo, range.hi);
      // Closed, overlapping intervals cover the parent without a precision gap.
      // Discard the partial parent response; only terminal windows contribute.
      pending.push({ lo: range.lo, hi: pivot }, { lo: pivot, hi: range.hi });
      continue;
    }
    stats.completeWindows++;
    for (const { id, time } of result.items) {
      const atBoundary = time.ns === lowNs || time.ns === highNs;
      const previous = found.get(id);
      if (previous) {
        if (previous.ns !== time.ns || !previous.atBoundary || !atBoundary) {
          throw new ProofIncomplete('Unexpected overlap or changing metadata between complete windows.');
        }
        stats.boundaryRepeats++;
      } else found.set(id, { ns: time.ns, atBoundary });
    }
  }
  // A complete covering traversal under a static source, NOT a cross-request
  // snapshot guarantee. No partial set is returned on any failure.
  return { ids: new Set(found.keys()), ...stats };
}

async function request(base, key, method, path, body) {
  if (!((method === 'GET' && ['/server/version', '/tags'].includes(path)) ||
    (method === 'POST' && path === '/search/metadata'))) throw new Error('Read-only route restriction.');
  let response;
  try {
    response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ProofIncomplete('Read-only request failed or timed out.'); }
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProofIncomplete(`Read-only request failed (HTTP ${response.status}).`);
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 32 * 1024 * 1024) throw new ProofIncomplete('Read-only response exceeded 32 MiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new ProofIncomplete('Read-only response was not JSON.'); }
}

async function main() {
  const args = process.argv.slice(2);
  const compareOffset = args.includes('--compare-offset');
  if (compareOffset) args.splice(args.indexOf('--compare-offset'), 1);
  if (args.length && !(args.length === 2 && args[0] === '--filters-file')) {
    throw new ProofIncomplete('Usage: node --env-file=/private/probe.env scripts/probes/immich-legacy-pagination.mjs [--filters-file /private/filters.json] [--compare-offset]');
  }
  const key = process.env.IMMICH_API_KEY;
  const url = new URL(process.env.IMMICH_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !key) {
    throw new ProofIncomplete('Set IMMICH_BASE_URL and IMMICH_API_KEY in a private environment file.');
  }
  const base = url.href.replace(/\/+$/, '').replace(/\/api$/, '') + '/api';
  const call = (method, path, body) => request(base, key, method, path, body);
  const version = await call('GET', '/server/version');
  if (![version.major, version.minor, version.patch].every(Number.isInteger)) throw new ProofIncomplete('Unexpected server version response.');
  let filters;
  if (args.length) {
    filters = JSON.parse(await readFile(args[1], 'utf8'));
    const allowed = new Set(['tagIds', 'personIds', 'albumIds', 'visibility', 'isTrashed', 'withDeleted', 'withStacked',
      'takenAfter', 'takenBefore', 'city', 'state', 'country', 'make', 'model', 'isFavorite']);
    if (!filters || Array.isArray(filters) || typeof filters !== 'object' || Object.keys(filters).some(k => !allowed.has(k))) {
      throw new ProofIncomplete('Unsupported probe filter.');
    }
  } else {
    const tags = await call('GET', '/tags');
    if (!Array.isArray(tags)) throw new ProofIncomplete('Unexpected tag-list response.');
    const matches = tags.filter(tag => tag.value === 'frame/eligible');
    if (matches.length !== 1 || typeof matches[0].id !== 'string') throw new ProofIncomplete('Cannot uniquely resolve frame/eligible.');
    filters = { tagIds: [matches[0].id], visibility: 'timeline' };
  }
  const search = body => call('POST', '/search/metadata', body);
  const results = [];
  for (let run = 1; run <= 2; run++) {
    const result = await collectByDate({ search, filters: { ...filters, withExif: false } });
    results.push(result);
    const { ids, ...stats } = result;
    console.log(JSON.stringify({ run, immichVersion: `${version.major}.${version.minor}.${version.patch}`, matched: ids.size, ...stats }));
  }
  const firstOnly = [...results[0].ids].filter(id => !results[1].ids.has(id)).length;
  const secondOnly = [...results[1].ids].filter(id => !results[0].ids.has(id)).length;
  console.log(JSON.stringify({ sameSet: !firstOnly && !secondOnly, firstOnly, secondOnly,
    snapshotGuaranteed: false, mutations: 0 }));
  if (firstOnly || secondOnly) process.exitCode = 2;
  if (compareOffset) {
    const baseline = await inspectOffset({ search, filters: { ...filters, withExif: false }, expectedIds: results[1].ids });
    console.log(JSON.stringify({ offsetComparison: baseline }));
    if (baseline.missingFromDate || baseline.offsetOnly) process.exitCode = 2;
  }
}

// Diagnostic comparator only. Never use this offset result for reconciliation.
export async function inspectOffset({ search, filters, expectedIds, size = 1000, maxRequests = 500 }) {
  const started = performance.now();
  let requests = 0;
  const boundedSearch = async body => {
    if (++requests > maxRequests || performance.now() - started >= 300_000) {
      throw new ProofIncomplete('Offset diagnostic work limit reached.');
    }
    return search(body);
  };
  const ids = new Set(), boundaryTimes = new Set(), timestampGroups = new Map();
  let repeated = 0, previousLast = null, pages = 0;
  while (true) {
    pages++;
    const result = parsePage(await boundedSearch({ ...filters, type: 'IMAGE', order: 'desc', page: pages, size }), size, pages);
    const first = result.items[0];
    if (first && previousLast?.ms === first.time.ms) boundaryTimes.add(first.time.ms);
    for (const item of result.items) {
      if (ids.has(item.id)) { repeated++; boundaryTimes.add(item.time.ms); }
      ids.add(item.id);
      if (!timestampGroups.has(item.time.ms)) timestampGroups.set(item.time.ms, new Set());
      timestampGroups.get(item.time.ms).add(item.id);
    }
    previousLast = result.items.at(-1)?.time;
    if (previousLast) boundaryTimes.add(previousLast.ms);
    if (!result.more) break;
  }
  // Also sample up to three six-photo timestamp groups, matching the shape of
  // the reported reproduction even if today's offsets land elsewhere.
  let samples = 0;
  for (const [ms, members] of timestampGroups) {
    if (members.size === 6 && samples++ < 3) boundaryTimes.add(ms);
  }
  const checks = [];
  let missingFromDate = 0;
  for (const ms of boundaryTimes) {
    // Independent whole-bucket query includes sub-millisecond timestamps.
    // Preserve narrower caller bounds, if supplied.
    const lo = Math.max(ms, filters.takenAfter ? bound(filters.takenAfter) : -Infinity);
    const hi = Math.min(ms + 1, filters.takenBefore ? bound(filters.takenBefore) : Infinity);
    const group = parsePage(await boundedSearch({ ...filters, type: 'IMAGE', order: 'desc', page: 1, size,
      takenAfter: new Date(lo).toISOString(), takenBefore: new Date(hi).toISOString() }), size);
    if (group.more) throw new ProofIncomplete('Independent boundary group exceeds one page.');
    const absentDate = group.items.filter(a => !expectedIds.has(a.id)).length;
    const absentOffset = group.items.filter(a => !ids.has(a.id)).length;
    missingFromDate += absentDate;
    checks.push({ photos: group.items.length, missingFromDate: absentDate, missingFromOffset: absentOffset });
  }
  return { pages, requests, uniquePhotos: ids.size, repeatedEntries: repeated,
    dateOnly: [...expectedIds].filter(id => !ids.has(id)).length,
    offsetOnly: [...ids].filter(id => !expectedIds.has(id)).length,
    boundaryGroups: checks, missingFromDate };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Never echo server bodies, filter values, hostnames, credentials or assets.
    console.error(JSON.stringify({ complete: false, reason: error instanceof ProofIncomplete ? error.message : 'Probe setup or response processing failed.', mutations: 0 }));
    process.exitCode = 1;
  });
}
