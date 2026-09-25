// Translate recorded reasons only. Missing recognition is never proof of the
// same people, and supporting pairs do not imply every photo is an exact match.
const copy = new Map([
  ['Stacking is off.', 'Stacking is turned off.'],
  [
    'Time candidates use a 90-second gap and a 3-minute total span.',
    'Nearby photos are compared within a 90-second gap and a 3-minute total span.',
  ],
  [
    'No other pending photo within the time limits.',
    'No other pending photo was taken close enough in time.',
  ],
  [
    'No sufficiently supported group found; this photo remains separate for review.',
    'The available clues did not support grouping this photo with its neighbors.',
  ],
  [
    'Provisional time group: similarity evidence is pending or incomplete.',
    'These nearby photos are together provisionally; similarity is not yet established.',
  ],
  [
    'Matching original checksums and compatible renditions support grouping.',
    'Matching original files support this group.',
  ],
  ['Close ThumbHash descriptors support visual similarity.', 'Similar-looking previews (ThumbHash) support this group.'],
  [
    'Reciprocal nearby Immich search ranks support this composition.',
    'Matches in both directions from Immich’s similar-photo searches support this group.',
  ],
  [
    'An asymmetric search match was retained through strong support from the established core.',
    'One less consistent match was included because several photos support it.',
  ],
  [
    'Repeated Immich searches favor separate subgroups; this contrast outweighs ThumbHash similarity and provisional joins.',
    'Similar-photo searches distinguish this group from other nearby photos.',
  ],
  ['Saved human separations were respected.', 'A previously saved stack correction was respected.'],
  [
    'Saved human separations and supported people differences were respected.',
    'Grouping respects saved stack corrections and supported differences in people.',
  ],
  [
    'Distant ThumbHash values or missing search results alone are not evidence of a different subject.',
    'A different preview fingerprint or a missing search match alone does not establish a different subject.',
  ],
  [
    'Grouped by capture time; similarity not established.',
    'Taken close together, but similarity has not been established.',
  ],
  [
    'Automatic composition checks are limited to 40 photos and a bounded rebuild budget.',
    'This group reached an automatic checking limit (40 photos or the processing budget).',
  ],
  [
    'Membership preserved from the opened Curate view.',
    'This is the grouping from when you opened the view; its original explanation is unavailable.',
  ],
]);
export function plainReasons(comparison) {
  const result = [];
  const photos = comparison.photos ?? [];
  const times = photos.map((p) => (p.capturedAt ? Date.parse(p.capturedAt) : NaN));
  if (photos.length > 1 && photos.length === comparison.ids?.length && times.every(Number.isFinite)) {
    const seconds = Math.ceil((Math.max(...times) - Math.min(...times)) / 1000);
    result.push(
      seconds < 60 ? `Taken within ${seconds} seconds.` : `Taken within ${Math.ceil(seconds / 60)} minutes.`,
    );
  }
  // Keep unmapped recorded reasons visible too: there is no separate raw-details panel.
  for (const reason of comparison.reasons ?? []) result.push(copy.get(reason) ?? reason);
  return result.length
    ? [...new Set(result)]
    : ['No further grouping explanation is available for this saved view.'];
}
