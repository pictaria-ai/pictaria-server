import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_REVIEW_ASSET_IDS, validateAssetBatch } from '../../src/enrich/assetBatch.mjs';

function assetId(index) {
  return `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;
}

test('asset batches accept the maximum canonical set and dedupe deterministically', () => {
  const ids = Array.from({ length: MAX_REVIEW_ASSET_IDS }, (_, index) => assetId(index));
  assert.deepEqual(validateAssetBatch(ids), ids);
  assert.deepEqual(validateAssetBatch([ids[1], ids[0], ids[1]]), [ids[0], ids[1]]);
});

test('asset batches reject raw over-limit, mixed, and noncanonical identifiers atomically', () => {
  const one = assetId(1);
  const lettered = 'abcdefab-cdef-abcd-efab-cdefabcdefab';
  assert.throws(() => validateAssetBatch(Array(MAX_REVIEW_ASSET_IDS + 1).fill(one)), /At most 1000/);
  for (const invalid of [null, 7, '', ` ${one}`, lettered.toUpperCase(), 'a'.repeat(129)]) {
    assert.throws(() => validateAssetBatch([one, invalid]), /canonical lowercase UUID/);
  }
});
