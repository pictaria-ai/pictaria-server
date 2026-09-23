// Translate recorded reasons only. Missing recognition is never proof of the
// same people, and supporting pairs do not imply every photo is an exact match.
const copy = new Map([
  ['Stacking is off.', 'Stacking is turned off.'],
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
  ['Close ThumbHash descriptors support visual similarity.', 'Similar-looking previews support this group.'],
  [
    'Reciprocal nearby Immich search ranks support this composition.',
    'Immich’s similar-photo searches support this group.',
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
    'Grouped by capture time; similarity not established.',
    'Taken close together, but similarity has not been established.',
  ],
  [
    'Automatic composition checks are limited to 40 photos and a bounded rebuild budget.',
    'This group reached an automatic checking limit.',
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
  for (const reason of comparison.reasons ?? []) if (copy.has(reason)) result.push(copy.get(reason));
  return result.length
    ? result
    : ['The saved grouping is shown below. See details for the available explanation.'];
}
