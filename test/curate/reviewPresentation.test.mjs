import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { comesAfter } from '../../public/curate/order.js';
import { evidenceRows, reasonCodes, REASON_CODES } from '../../public/curate/explanation-copy.js';
import { REASON } from '../../src/curate/reasons.mjs';
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
  const rows = evidenceRows({
    ids: ['a', 'b'],
    photos: [{ capturedAt: '2026-01-01T00:00:00Z' }, { capturedAt: '2026-01-01T00:00:20Z' }],
    reasons: ['thumbhash', 'provisional'],
  });
  assert.deepEqual(rows.map(row => [row.mark, row.signal, row.value]), [
    ['support', 'Previews', 'Look alike (ThumbHash)'],
    ['unsure', 'Grouping', 'Together for now; similarity not established'],
    ['info', 'Taken', 'Within 20 seconds'],
  ]);
  assert.ok(rows.every(row => !/same people/i.test(row.value)));
  assert.ok(evidenceRows({ ids: ['a', 'b', 'c'], photos: [{ capturedAt: '2026-01-01' }, { capturedAt: '2026-01-02' }] })
    .every(row => row.signal !== 'Taken'), 'partial previews cannot describe the whole span');
});

test('every reason code the server records has page wording, and the algorithm records only codes', () => {
  assert.deepEqual([...Object.values(REASON)].sort(), [...REASON_CODES].sort());
  for (const code of Object.values(REASON)) {
    const [row] = evidenceRows({ ids: ['a', 'b'], reasons: [code] });
    assert.ok(row.signal && row.value && row.value !== code, `no page wording for: ${code}`);
  }
  // An English sentence recorded by candidate.mjs would bypass the codes.
  const source = readFileSync(new URL('../../src/curate/candidate.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/'([A-Z][^'\n]{20,}\.)'/g)].map(match => match[1]), []);
  assert.match(source, /why\.push\(REASON\./);
});

test('groupings saved before reason codes keep their sentences, rendered through the same wording', () => {
  // Every sentence candidate-1 to candidate-4 recorded, and the opened-view fallback.
  const saved = [
    'Stacking is off.', 'No other pending photo within the time limits.',
    'No sufficiently supported group found; this photo remains separate for review.',
    'Provisional time group: similarity evidence is pending or incomplete.',
    'Matching original checksums and compatible renditions support grouping.',
    'Close ThumbHash descriptors support visual similarity.',
    'Reciprocal nearby Immich search ranks support this composition.',
    'An asymmetric search match was retained through strong support from the established core.',
    'Repeated Immich searches favor separate subgroups; this contrast outweighs ThumbHash similarity and provisional joins.',
    'Saved human separations were respected.',
    'Very similar Pictaria image embeddings support this composition.',
    'Moderately similar image embeddings, corroborated by the same people or a similar ThumbHash, support this composition.',
    'Groups were joined on their average image embedding similarity.',
    'Image embeddings and the other evidence do not settle every pair here, so this composition stays uncertain.',
    'Clearly different image embeddings separate photos taken at the same time.',
    'Grouped by capture time; similarity not established.',
    'Automatic composition checks are limited to 40 photos and a bounded rebuild budget.',
    'Membership preserved from the opened Curate view.',
  ];
  for (const sentence of saved) assert.equal(reasonCodes([sentence]).codes.length, 1, sentence);
  // Rules that never change move behind "How stacks work".
  const rules = [
    'Time candidates use a 90-second gap and a 3-minute total span.',
    'Saved human separations and supported people differences were respected.',
    'Distant ThumbHash values or missing search results alone are not evidence of a different subject.',
    'Distant ThumbHash values or missing search results alone are not evidence of a different subject; missing image embeddings are unknown.',
  ];
  assert.deepEqual(reasonCodes(rules), { codes: [], other: [] });
  assert.deepEqual(evidenceRows({ ids: ['a', 'b'], reasons: [rules[0], saved[5], rules[3]] }).map(row => row.value), ['Look alike (ThumbHash)']);
  assert.deepEqual(reasonCodes(['A reason from a newer server.']).other, ['A reason from a newer server.'], 'unknown text stays visible');
});
