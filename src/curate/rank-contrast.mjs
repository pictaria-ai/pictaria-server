// Contrast is a group-level observation, not a missing-result pair veto.
// Called only after the complete bounded pass; all inputs are candidate-local.
export function rankContrasts(members, { pair, near, outside, coverage, farOutside }) {
  const order = (a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || a.id.localeCompare(b.id);
  const linked = (a, b) => !pair(a, b).conflict && near(a, b) && near(b, a);
  const degree = p => members.filter(q => q !== p && linked(p, q)).length;
  const pending = [...members].sort((a, b) => degree(b) - degree(a) || order(a, b));
  const cores = [], singles = [];
  while (pending.length) {
    const core = [pending.shift()];
    for (let i = 0; i < pending.length;) {
      if (core.every(p => linked(p, pending[i]))) core.push(...pending.splice(i, 1));
      else i++;
    }
    if (core.length >= 2) cores.push({ core, members: [...core] });
    else singles.push(core[0]);
  }
  if (cores.length < 2) return new Set();

  // A missing target can count only in a full result window with enough
  // outside photos ahead, and after positive evidence of its own subgroup.
  const far = (a, b) => {
    const n = outside(a, b);
    if (n !== null) return n >= farOutside;
    const row = coverage[a.id];
    return row?.limit === 50 && row.returned === row.limit &&
      Number.isInteger(row.outside) && row.outside >= farOutside && row.outside <= row.returned;
  };
  const required = core => Math.max(2, Math.ceil(core.length * 0.75));
  // Incoming agreement can locate a member whose own row is uninformative.
  // Only frozen reciprocal cores vote; attachments never become witnesses.
  for (const p of singles) {
    const targets = cores.filter(({ core, members: group }) =>
      group.every(q => !pair(p, q).conflict) &&
      core.filter(q => near(q, p)).length >= required(core) &&
      !core.some(q => far(p, q)));
    if (targets.length === 1) targets[0].members.push(p);
  }

  const contrasts = new Set();
  for (let i = 0; i < cores.length; i++) for (let j = i + 1; j < cores.length; j++) {
    const a = cores[i], b = cores[j];
    // Any close cross-direction or compatible exact rendition makes this
    // conservative separation rule inconclusive, even if other rows are far.
    if (a.members.some(p => b.members.some(q => near(p, q) || near(q, p) || pair(p, q).exact))) continue;
    const favorsOwn = (from, other) => from.core.filter(p => other.members.every(q => far(p, q))).length >= required(from.core);
    if (!favorsOwn(a, b) || !favorsOwn(b, a)) continue;
    for (const p of a.members) for (const q of b.members) contrasts.add(pair(p, q));
  }
  return contrasts;
}
