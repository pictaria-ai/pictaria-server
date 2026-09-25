// Continue from the saved item's position, not its old array index: background
// regrouping can change both membership and the number of preceding items.
export function comesAfter(group, anchor, sort) {
  const time = (photo) => {
    const value = photo?.capturedAt ? Date.parse(photo.capturedAt) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  const a = group.photos[0],
    b = anchor;
  const ta = time(a),
    tb = time(b);
  if (ta === null && tb !== null) return true;
  if (ta !== null && tb === null) return false;
  const order = (ta === tb ? 0 : ta - tb) || a.id.localeCompare(b.id);
  return sort === 'newest' && ta !== null ? order < 0 : order > 0;
}
