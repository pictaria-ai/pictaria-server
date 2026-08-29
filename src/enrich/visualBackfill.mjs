// One-shot backfill of visual descriptors (thumbhash + duplicateId) for
// asset rows that predate those columns. Pages the library via
// search/metadata — ~1,000 assets per request, so a 100k library is done in
// about two minutes — and updates only rows we already track. New assets get
// their descriptors written by upsertAsset as they're fetched, so this runs
// until the review list is covered once and then finds nothing to do.
import { UpstreamPaginationError, createTraversalBudget, parseProgressingPage } from '../pagination.mjs';

export async function backfillAssetVisuals({ repo, immich, log = () => {}, maxPages = 500, shouldStop = () => false }) {
  const missing = repo.reviewListMissingThumbhashCount();
  if (missing === 0) {
    return { missing: 0, updated: 0, pages: 0 };
  }
  log(`thumbhash backfill: ${missing} review-list photo(s) missing visual descriptors; paging library`);
  let updated = 0;
  let pages = 0;
  let page = 1;
  const seenAssetIds = new Set();
  const budget = createTraversalBudget({
    label: 'Immich visual backfill',
    maxPages,
    maxItems: maxPages * 1_000,
    timeoutMs: 10 * 60 * 1000,
  });
  while (page !== null) {
    // Cooperative shutdown between pages: nothing here is lost — the next
    // boot's pass picks up whatever is still missing.
    if (shouldStop()) {
      log(`thumbhash backfill: stopping early (shutdown) after ${pages} page(s); the next boot resumes`);
      return { missing, updated, pages, stopped: true };
    }
    budget.beginPage();
    const response = await immich.searchMetadata({ page, size: 1000 });
    const items = response?.assets?.items;
    if (!Array.isArray(items) || items.length > 1_000) {
      throw new UpstreamPaginationError('Immich visual backfill returned an invalid or oversized item page.');
    }
    budget.recordItems(items.length);
    pages += 1;
    for (const item of items) {
      if (typeof item?.id === 'string' && item.id && !seenAssetIds.has(item.id) && (item.thumbhash || item.duplicateId)) {
        seenAssetIds.add(item.id);
        updated += repo.updateAssetVisuals(item.id, {
          thumbhash: item.thumbhash ?? null,
          duplicateId: item.duplicateId ?? null,
        });
      }
    }
    const next = response?.assets?.nextPage;
    page = parseProgressingPage(next, page, { label: 'Immich visual backfill' });
  }
  const missingAfter = repo.reviewListMissingThumbhashCount();
  log(`thumbhash backfill: updated ${updated} asset row(s) over ${pages} page(s); ${missingAfter} still missing`);
  return { missing, updated, pages, missingAfter };
}
