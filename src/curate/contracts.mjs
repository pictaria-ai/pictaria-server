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
export function validateSeparationAction(partitions, action = null) {
  if (action === null) return null; // Earlier clients did not record intent.
  if (!action || typeof action !== 'object' || Array.isArray(action))
    throw new CurateError('Invalid correction action.', 'invalid_curate_partition', 400);
  if (action.kind === 'split' && Object.keys(action).length === 1 && partitions.every(p => p.length === 1))
    return { kind: 'split' };
  if (action.kind === 'remove' && Object.keys(action).length === 2 &&
      typeof action.assetId === 'string' && partitions.length === 2 &&
      partitions[0].length === 1 && partitions[0][0] === action.assetId)
    return { kind: 'remove', assetId: action.assetId };
  throw new CurateError('Correction action does not match its photos.', 'invalid_curate_partition', 400);
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
