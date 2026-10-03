// Page wording for the reasons recorded with a grouping (src/curate/reasons.mjs),
// as short evidence rows: a mark, the signal and a value. Translate recorded
// reasons only: missing recognition is never proof of the same people, and
// supporting pairs do not imply every photo is an exact match.
export const MARKS = Object.freeze({
  support: ['✓', 'Supports'], unsure: ['?', 'Unsure'], apart: ['✗', 'Keeps apart'], info: ['·', 'Background'],
});
export const HOW_STACKS_WORK = 'https://github.com/pictaria-ai/pictaria-server/blob/main/docs/CURATE-ALGORITHM.md#how-stacks-work';
// Rows appear by mark, strongest first, then in this order.
const ROWS = {
  exact: ['support', 'Files', 'Same original file'],
  'embedding-near': ['support', 'Embeddings', 'Very similar'],
  'embedding-corroborated': ['support', 'Embeddings', 'Fairly similar, backed by people or previews'],
  'embedding-average': ['support', 'Joined', 'Close groups, similar on average'],
  thumbhash: ['support', 'Previews', 'Look alike (ThumbHash)'],
  ranks: ['support', 'Searches', 'Find each other in Immich searches'],
  'rank-recovered': ['support', 'Searches', 'One looser match, backed by several photos'],
  'embedding-undecided': ['unsure', 'Embeddings', 'Only fairly similar, and nothing confirms it'],
  provisional: ['unsure', 'Grouping', 'Together for now; similarity not established'],
  budget: ['unsure', 'Grouping', 'Too many photos to compare, so grouped by time'],
  'embedding-apart': ['apart', 'Embeddings', 'Clearly different from some nearby photos'],
  'people-apart': ['apart', 'People', 'Different people from some nearby photos'],
  'rank-contrast': ['apart', 'Searches', 'Immich searches separate some nearby photos'],
  'saved-split': ['apart', 'Your split', 'Your earlier split applies'],
  unlinked: ['info', 'Grouping', 'Nothing linked it to the nearby photos'],
  alone: ['info', 'Taken', 'No other pending photo close in time'],
  'stacks-off': ['info', 'Stacks', 'Turned off in Settings'],
  preserved: ['info', 'Grouping', 'From when you opened this view; details unavailable'],
};
export const REASON_CODES = Object.freeze(Object.keys(ROWS));
// Groupings saved before reason codes keep their sentences. Null marks a rule
// that never changes; "How stacks work" explains those instead.
const LEGACY = new Map([
  ['Stacking is off.', 'stacks-off'],
  ['Time candidates use a 90-second gap and a 3-minute total span.', null],
  ['No other pending photo within the time limits.', 'alone'],
  ['No sufficiently supported group found; this photo remains separate for review.', 'unlinked'],
  ['Provisional time group: similarity evidence is pending or incomplete.', 'provisional'],
  ['Matching original checksums and compatible renditions support grouping.', 'exact'],
  ['Close ThumbHash descriptors support visual similarity.', 'thumbhash'],
  ['Reciprocal nearby Immich search ranks support this composition.', 'ranks'],
  ['An asymmetric search match was retained through strong support from the established core.', 'rank-recovered'],
  ['Repeated Immich searches favor separate subgroups; this contrast outweighs ThumbHash similarity and provisional joins.', 'rank-contrast'],
  ['Saved human separations were respected.', 'saved-split'],
  ['Saved human separations and supported people differences were respected.', null],
  ['Distant ThumbHash values or missing search results alone are not evidence of a different subject.', null],
  ['Distant ThumbHash values or missing search results alone are not evidence of a different subject; missing image embeddings are unknown.', null],
  ['Very similar Pictaria image embeddings support this composition.', 'embedding-near'],
  ['Moderately similar image embeddings, corroborated by the same people or a similar ThumbHash, support this composition.', 'embedding-corroborated'],
  ['Groups were joined on their average image embedding similarity.', 'embedding-average'],
  ['Image embeddings and the other evidence do not settle every pair here, so this composition stays uncertain.', 'embedding-undecided'],
  ['Clearly different image embeddings separate photos taken at the same time.', 'embedding-apart'],
  ['Grouped by capture time; similarity not established.', 'budget'],
  ['Automatic composition checks are limited to 40 photos and a bounded rebuild budget.', 'budget'],
  ['Membership preserved from the opened Curate view.', 'preserved'],
  // standard-1 (src/curate/grouping.mjs), the bounded engine without candidate stacking.
  ['Same recorded original checksum.', 'exact'],
  ['No compatible alternative in the bounded search.', 'unlinked'],
  ['Comparison budget reached; stack composition is unconfirmed.', 'budget'],
  ['Different people counts corroborated by recognition separated candidates.', 'people-apart'],
]);
const ORDER = ['support', 'unsure', 'apart', 'info'];

// Codes in recorded order; unknown text stays visible as-is.
export function reasonCodes(reasons) {
  const codes = [], other = [];
  for (const reason of Array.isArray(reasons) ? reasons : []) {
    if (typeof reason !== 'string') continue;
    const code = Object.hasOwn(ROWS, reason) ? reason : LEGACY.has(reason) ? LEGACY.get(reason) : undefined;
    if (code === undefined) { if (!other.includes(reason)) other.push(reason); }
    else if (code && !codes.includes(code)) codes.push(code);
  }
  return { codes, other };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// With the process strip (`steps`), a checking limit is its Grouping step.
export function evidenceRows(comparison, { steps = false } = {}) {
  const { codes: recordedCodes, other } = reasonCodes(comparison.reasons);
  const codes = steps ? recordedCodes.filter(code => code !== 'budget') : recordedCodes;
  const single = comparison.ids?.length === 1;
  const check = comparison.stackReferee?.state === 'checked' ? comparison.stackReferee : null;
  const said = typeof check?.reason === 'string' ? check.reason.trim() : '';
  const rows = [];
  // The model's reason is plain text, rendered with textContent.
  if (check) rows.push(single ? { mark: 'apart', signal: 'AI check', value: `Split it from nearby photos${said ? `: ${said}` : ''}` }
    : { mark: 'support', signal: 'AI check', value: check.split ? `Split from a larger stack${said ? `: ${said}` : ''}` : said || 'Confirmed this stack' });
  const recorded = codes.map(code => {
    const [mark, signal, value] = ROWS[code];
    return check && code === 'provisional' ? { mark: 'info', signal, value: 'Grouped for now before the AI check' } : { mark, signal, value };
  });
  rows.push(...recorded.sort((a, b) => ORDER.indexOf(a.mark) - ORDER.indexOf(b.mark)));
  const photos = comparison.photos ?? [];
  const times = photos.map(p => (p.capturedAt ? Date.parse(p.capturedAt) : NaN));
  if (!single && photos.length > 1 && photos.length === comparison.ids?.length && times.every(Number.isFinite)) {
    const seconds = Math.ceil((Math.max(...times) - Math.min(...times)) / 1000);
    rows.push({ mark: 'info', signal: 'Taken', value: seconds <= 1 ? 'Within a second'
      : seconds < 60 ? `Within ${seconds} seconds` : `Within ${plural(Math.ceil(seconds / 60), 'minute')}` });
  }
  if (single && comparison.nearby > 0 && !codes.includes('alone'))
    rows.push({ mark: 'info', signal: 'Taken', value: `${plural(comparison.nearby, 'other photo')} at the same time` });
  // No separate raw-details panel: keep unmapped recorded reasons visible.
  rows.push(...other.map(value => ({ mark: 'info', signal: '', value })));
  return rows.length ? rows : [{ mark: 'info', signal: '', value: 'No further explanation is available for this saved view.' }];
}

export function algorithmLabel(comparison) {
  if (comparison.stackReferee?.state === 'updated' || !/^candidate-\d+$/.test(comparison.algorithm))
    return 'Grouping from this saved view';
  return `Algorithm ${comparison.algorithm.split('-')[1]}`;
}
