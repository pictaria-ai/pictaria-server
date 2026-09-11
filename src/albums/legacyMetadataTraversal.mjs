// Compatibility with Immich <3.1: only this module knows about unstable date
// ties, legacy visibility defaults, and inclusive date-window traversal.
// Remove its dispatcher branch in metadataSearch.mjs when that support ends.
import { UpstreamPaginationError } from '../pagination.mjs';

export function needsLegacyMetadataTraversal(version) {
  return !version || version.prerelease !== null && version.prerelease !== undefined
    || version.major < 3 || version.major === 3 && version.minor < 1;
}

export function legacyVisibilityFilters(filters) {
  // Immich 2.x defaults to timeline, including when visibility is null.
  // Exclusions and membership need every ordinary accessible visibility.
  return filters.visibility === undefined
    ? ['timeline', 'archive', 'hidden'].map(visibility => ({ ...filters, visibility }))
    : [filters];
}

export function captureTimestamp(value) {
  const match = typeof value === 'string' && value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/);
  const ms = match ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(ms)) throw new UpstreamPaginationError('Immich returned missing or unsupported capture timestamps. Album membership was left unchanged.');
  // A response may retain more precision than Date-based query bounds.
  return { ms, ns: BigInt(ms) * 1_000_000n + BigInt((match[1] || '').padEnd(9, '0').slice(3)) };
}

function bound(value) {
  if (value === undefined) return null;
  const result = captureTimestamp(value);
  if (result.ns !== BigInt(result.ms) * 1_000_000n) throw new UpstreamPaginationError('Date query bounds require millisecond precision.');
  return result.ms;
}

function splitPoint(items, lo, hi) {
  for (let i = items.length - 1; i >= 0; i--) {
    const value = items[i].time.ms;
    if ((lo === null || value > lo) && (hi === null || value < hi)) return value;
  }
  if (lo !== null && hi !== null) {
    if (hi - lo <= 1) throw new UpstreamPaginationError('More than 1,000 photos have capture times too close together to verify on this Immich version. Album membership was left unchanged.');
    return lo + Math.floor((hi - lo) / 2);
  }
  if (lo !== null) return lo + 1;
  if (hi !== null) return hi - 1;
  throw new UpstreamPaginationError('Immich metadata search could not be divided safely. Album membership was left unchanged.');
}

export async function* legacyMetadataWindows({ filters, fetchPage }) {
  const { takenAfter, takenBefore, ...base } = filters;
  const lo = bound(takenAfter), hi = bound(takenBefore);
  if (lo !== null && hi !== null && lo > hi) throw new UpstreamPaginationError('Invalid capture-date interval.');
  const pending = [{ lo, hi }], found = new Map();
  while (pending.length) {
    const range = pending.pop();
    const bounds = {
      ...(range.lo === null ? {} : { takenAfter: new Date(range.lo).toISOString() }),
      ...(range.hi === null ? {} : { takenBefore: new Date(range.hi).toISOString() }),
    };
    const { items, nextPage } = await fetchPage({ ...base, ...bounds, page: 1, size: 1000, order: 'desc' });
    const lowNs = range.lo === null ? null : BigInt(range.lo) * 1_000_000n;
    const highNs = range.hi === null ? null : BigInt(range.hi) * 1_000_000n;
    let previous = null;
    const timed = items.map(asset => {
      const time = captureTimestamp(asset.fileCreatedAt);
      if ((lowNs !== null && time.ns < lowNs) || (highNs !== null && time.ns > highNs)
        || previous !== null && time.ns > previous) {
        throw new UpstreamPaginationError('Immich returned inconsistent capture-date ordering or bounds. Album membership was left unchanged.');
      }
      previous = time.ns;
      return { asset, time };
    });
    if (nextPage !== null) {
      if (items.length !== 1000) throw new UpstreamPaginationError('Immich returned an incomplete legacy metadata page. Album membership was left unchanged.');
      const pivot = splitPoint(timed, range.lo, range.hi);
      // Inclusive overlap covers sub-millisecond timestamps without gaps.
      // Process the newer range first. Partial parent samples are discarded.
      pending.push({ lo: range.lo, hi: pivot }, { lo: pivot, hi: range.hi });
      continue;
    }
    const unique = [];
    for (const { asset, time } of timed) {
      const atBoundary = time.ns === lowNs || time.ns === highNs;
      const seen = found.get(asset.id);
      if (seen) {
        if (seen.ns !== time.ns || !seen.atBoundary || !atBoundary) {
          throw new UpstreamPaginationError('Immich metadata changed or overlapped unexpectedly. Album membership was left unchanged.');
        }
      } else {
        found.set(asset.id, { ns: time.ns, atBoundary });
        unique.push(asset);
      }
    }
    // Stable Top-N within ties; the terminal window contains the entire tie.
    unique.sort((a, b) => {
      const dateOrder = captureTimestamp(b.fileCreatedAt).ns - captureTimestamp(a.fileCreatedAt).ns;
      return dateOrder ? dateOrder > 0n ? 1 : -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    // Keep the original upper bound: counts verify all completed newer windows,
    // not just this window, because traversal always processes newest first.
    yield { items: unique, exhausted: pending.length === 0,
      coverage: { ...base, ...(range.lo === null ? {} : { takenAfter: new Date(range.lo).toISOString() }),
        ...(hi === null ? {} : { takenBefore: new Date(hi).toISOString() }) } };
  }
}
