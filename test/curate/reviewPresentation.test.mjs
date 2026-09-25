import test from 'node:test';
import assert from 'node:assert/strict';
import { comesAfter } from '../../public/curate/order.js';
import { plainReasons } from '../../public/curate/explanation-copy.js';
import { savedOutcome } from '../../public/curate/photos.js';

test('continuation keeps date direction, equal-date tie breaks and unknown dates last', () => {
  const photo = (id, capturedAt) => ({ id, capturedAt });
  const after = (a, b, sort) => comesAfter({ photos: [a] }, b, sort);
  const a = photo('a', '2026-01-01'),
    b = photo('b', '2026-01-01'),
    c = photo('c', '2026-02-01');
  assert.equal(after(b, a, 'oldest'), true);
  assert.equal(after(b, a, 'newest'), false);
  assert.equal(after(c, a, 'oldest'), true);
  assert.equal(after(c, a, 'newest'), false);
  assert.equal(after(a, a, 'oldest'), false);
  for (const sort of ['oldest', 'newest']) {
    assert.equal(after(photo('z', null), a, sort), true);
    assert.equal(after(a, photo('z', null), sort), false);
    assert.equal(after(photo('z', null), photo('y', null), sort), true);
  }
});
test('saved outcome favors human state and distinguishes favorites without expanding grid tags', () => {
  assert.equal(savedOutcome({ state: 'approved', favorite: true }), 'favorite');
  assert.equal(savedOutcome({ state: 'approved', tags: ['frame/favorite'] }), 'favorite');
  assert.equal(savedOutcome({ state: 'rejected', favorite: true }), 'reject');
  assert.equal(savedOutcome({ state: 'reviewed', tags: ['frame/favorite'] }), 'reviewed');
  assert.equal(savedOutcome({ state: 'undecided' }), null);
});
test('Why uses recorded supporting evidence, preserves uncertainty and avoids invented people claims', () => {
  const result = plainReasons({
    ids: ['a', 'b'],
    photos: [{ capturedAt: '2026-01-01T00:00:00Z' }, { capturedAt: '2026-01-01T00:00:20Z' }],
    reasons: [
      'Close ThumbHash descriptors support visual similarity.',
      'Provisional time group: similarity evidence is pending or incomplete.',
      'Saved human separations and supported people differences were respected.',
    ],
  });
  assert.equal(result[0], 'Taken within 20 seconds.');
  assert.ok(result.some((s) => s.includes('Similar-looking previews')));
  assert.ok(result.some((s) => s.includes('provisionally')));
  assert.ok(result.every((s) => !s.includes('same people')));
  assert.ok(
    plainReasons({
      ids: ['a', 'b', 'c'],
      photos: [{ capturedAt: '2026-01-01' }, { capturedAt: '2026-01-02' }],
    }).every((s) => !s.includes('Taken within')),
    'partial previews cannot describe the whole span',
  );
});
