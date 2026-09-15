import { createHash } from 'node:crypto';

export function canonicalJson(value) {
  const order = (v) =>
    Array.isArray(v)
      ? v.map(order)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, order(v[k])]),
          )
        : v;
  return JSON.stringify(order(value));
}
export const fingerprint = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export class CurateError extends Error {
  constructor(message, code = 'curate_conflict', status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export function validatePartition(ids, partitions) {
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.some((id) => typeof id !== 'string' || !id || id.length > 128) ||
    new Set(ids).size !== ids.length ||
    !Array.isArray(partitions) ||
    !partitions.length
  ) {
    throw new CurateError('Invalid comparison membership.', 'invalid_curate_partition', 400);
  }
  const expected = new Set(ids),
    seen = new Set();
  for (const part of partitions) {
    if (!Array.isArray(part) || !part.length)
      throw new CurateError('Empty partition.', 'invalid_curate_partition', 400);
    for (const id of part) {
      if (!expected.has(id) || seen.has(id))
        throw new CurateError('Partition must cover each photo exactly once.', 'invalid_curate_partition', 400);
      seen.add(id);
    }
  }
  if (seen.size !== expected.size) throw new CurateError('Incomplete partition.', 'invalid_curate_partition', 400);
  return partitions.map((p) => [...p]);
}
export function validateAdvice(ids, output, role) {
  if (
    !['check', 'keeper'].includes(role) ||
    !output ||
    Object.keys(output).some((k) => k !== 'groups') ||
    !Array.isArray(output.groups)
  )
    throw new CurateError('Invalid AI result.', 'invalid_curate_advice', 400);
  validatePartition(
    ids,
    output.groups.map((g) => g?.ids),
  );
  for (const group of output.groups) {
    const allowed = role === 'keeper' ? ['ids', 'keepers', 'reason'] : ['ids', 'reason'];
    if (
      Object.keys(group).some((k) => !allowed.includes(k)) ||
      typeof group.reason !== 'string' ||
      !group.reason.trim() ||
      group.reason.length > 300
    )
      throw new CurateError('Invalid AI explanation.', 'invalid_curate_advice', 400);
    if (
      role === 'keeper' &&
      (!Array.isArray(group.keepers) ||
        new Set(group.keepers).size !== group.keepers.length ||
        group.keepers.some((id) => !group.ids.includes(id)))
    )
      throw new CurateError('Invalid keeper set.', 'invalid_curate_advice', 400);
  }
  return structuredClone(output);
}
