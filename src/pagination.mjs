export class UpstreamPaginationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpstreamPaginationError';
    this.status = 502;
    this.code = 'invalid_upstream_pagination';
  }
}

export function parseProgressingPage(value, currentPage, { label = 'upstream', maxPage = 10_000 } = {}) {
  if (value === null || value === undefined) {
    return null;
  }
  const nextPage = Number(value);
  if (
    !Number.isSafeInteger(nextPage)
    || nextPage < 1
    || nextPage > maxPage
    || nextPage <= currentPage
  ) {
    throw new UpstreamPaginationError(
      `${label} returned an invalid or non-progressing next page.`,
    );
  }
  return nextPage;
}

export function createTraversalBudget({ label, maxPages, maxItems, timeoutMs, now = Date.now }) {
  const startedAt = now();
  let pages = 0;
  let items = 0;

  function checkTime() {
    if (now() - startedAt >= timeoutMs) {
      throw new UpstreamPaginationError(`${label} exceeded its ${timeoutMs}ms traversal deadline.`);
    }
  }

  return {
    beginPage() {
      checkTime();
      if (pages >= maxPages) {
        throw new UpstreamPaginationError(`${label} exceeded its ${maxPages}-page traversal limit.`);
      }
      pages += 1;
    },
    recordItems(count) {
      checkTime();
      if (!Number.isSafeInteger(count) || count < 0 || items + count > maxItems) {
        throw new UpstreamPaginationError(`${label} exceeded its ${maxItems}-item traversal limit.`);
      }
      items += count;
    },
    status() {
      return { pages, items };
    },
  };
}
