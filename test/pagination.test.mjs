import assert from 'node:assert/strict';
import test from 'node:test';

import { createTraversalBudget, parseProgressingPage, UpstreamPaginationError } from '../src/pagination.mjs';

test('next pages must be finite positive integers that advance', () => {
  assert.equal(parseProgressingPage('2', 1), 2);
  assert.equal(parseProgressingPage(null, 1), null);
  for (const value of [1, 0, -1, 1.5, 'nope', Infinity, 10_001]) {
    assert.throws(
      () => parseProgressingPage(value, 1),
      (error) => error instanceof UpstreamPaginationError && error.code === 'invalid_upstream_pagination',
    );
  }
});

test('traversal budgets independently cap pages, items, and elapsed time', () => {
  let now = 100;
  const pageBudget = createTraversalBudget({ label: 'test', maxPages: 1, maxItems: 2, timeoutMs: 10, now: () => now });
  pageBudget.beginPage();
  assert.throws(() => pageBudget.beginPage(), /1-page traversal limit/);

  const itemBudget = createTraversalBudget({ label: 'test', maxPages: 2, maxItems: 2, timeoutMs: 10, now: () => now });
  itemBudget.recordItems(2);
  assert.throws(() => itemBudget.recordItems(1), /2-item traversal limit/);

  const timeBudget = createTraversalBudget({ label: 'test', maxPages: 2, maxItems: 2, timeoutMs: 10, now: () => now });
  now = 110;
  assert.throws(() => timeBudget.beginPage(), /10ms traversal deadline/);
});
