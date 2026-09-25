// The matrix contains only the selected candidate's members. Removing those
// ahead of a returned target measures outside competition, not visual distance.
// Missing targets remain unknown even if all returned rows were candidates.
export function rankObservation(row, targetId) {
  const rank = row?.state === 'complete' ? row.photos.find(p => p.id === targetId)?.rank : null;
  if (!Number.isInteger(rank) || rank < 1) return null;
  const candidatesAhead = row.photos.filter(p => Number.isInteger(p.rank) && p.rank > 0 && p.rank < rank).length;
  return { rank, outsideAhead: rank - 1 - candidatesAhead };
}
