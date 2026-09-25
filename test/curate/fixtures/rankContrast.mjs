// Anonymized positions transcribed from the owner's nine-photo lab table.
// Photos 1–3 and 7–9 should be separate. Row 9 was NOT queried; tests must
// explicitly supply any synthetic completion and must not call it observed.
export const observedRanks = [
  [null,1,4,3,2,13,28,null,null],
  [2,null,1,4,3,5,null,null,null],
  [4,1,null,6,9,14,null,null,null],
  [3,2,4,null,1,5,30,null,null],
  [2,4,22,3,null,1,5,null,null],
  [25,4,17,7,1,null,5,null,45],
  [null,null,null,null,3,9,null,2,1],
  [null,null,null,null,null,null,2,null,1],
  null,
];

export function searchItems(ranks, ids) {
  const items = Array.from({ length: 50 }, (_, n) => ({ id: `outside-${n}`, type: 'IMAGE' }));
  ranks.forEach((rank, n) => { if (rank !== null) items[rank - 1] = { id: ids[n], type: 'IMAGE' }; });
  return items;
}

export function retainedEvidence(matrix, ids) {
  const rows = {}, coverage = {}, selected = new Set(ids);
  matrix.forEach((ranks, n) => {
    if (ranks === null) return;
    const items = searchItems(ranks, ids), row = {};
    let outside = 0;
    for (const item of items) {
      if (selected.has(item.id)) row[item.id] = outside;
      else outside++;
    }
    rows[ids[n]] = row;
    coverage[ids[n]] = { limit: 50, returned: items.length, outside };
  });
  return { rows, coverage };
}
