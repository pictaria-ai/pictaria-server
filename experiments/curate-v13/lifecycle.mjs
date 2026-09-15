// Offline lifecycle contracts. Production SQLite transactions/adapters belong
// to PIC-367/368/346; these functions do not operate application data.
import { randomUUID } from 'node:crypto';
import { fingerprint } from './grouping.mjs';

export const MINUTE = 60000, DAY = 86400000;
export const LIFETIME = Object.freeze({ lease: 30 * MINUTE, receipt: 30 * DAY, tombstone: 30 * DAY });

export function selectKeptContext(pending, candidates, { queryLimited = false } = {}) {
  // The adapter supplies at most 64 locally compatible, indexed candidates.
  // Do not fetch full enrichment rows or scan decided history to call this.
  if (!pending.length || pending.length > 30 || candidates.length > 64) throw Error('context query outside budget');
  const pendingIds = new Set(pending.map(p => p.id));
  if (pendingIds.size !== pending.length) throw Error('duplicate pending photo');
  const times = pending.map(p => Date.parse(p.capturedAt)).filter(Number.isFinite);
  const seen = new Set(), eligible = [];
  for (const p of candidates) {
    if (seen.has(p.id)) throw Error('duplicate context');
    seen.add(p.id);
    const time = Date.parse(p.capturedAt);
    if (pendingIds.has(p.id) || p.state !== 'kept' || p.available === false || !Number.isFinite(time) || !times.length) continue;
    const distance = Math.min(...times.map(t => Math.abs(t - time)));
    if (distance <= 180000) eligible.push({ id: p.id, distance });
  }
  eligible.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return { actionableIds: [...pendingIds], contextIds: eligible.slice(0, 8).map(p => p.id),
    omitted: queryLimited || eligible.length > 8, omittedKnown: Math.max(0, eligible.length - 8) };
}

export function freshCohorts() { return { members: {}, reservations: [] }; }

export function reconcileCohort(state, ids, createId = randomUUID) {
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw Error('invalid cohort members');
  const origins = new Set(ids.filter(id => Object.hasOwn(state.members, id)).map(id => state.members[id]));
  const target = [...origins].sort()[0] ?? createId();
  if (typeof target !== 'string' || !target || (!origins.size && Object.values(state.members).includes(target))) throw Error('invalid cohort identity');
  // Rebind ALL members of merged origins, including absent/split siblings, so
  // later recomputation cannot recover an old origin with a fresh allowance.
  if (origins.size > 1) {
    for (const id of Object.keys(state.members)) if (origins.has(state.members[id])) state.members[id] = target;
    for (const event of state.reservations) if (origins.has(event.cohort)) event.cohort = target;
  }
  for (const id of ids) Object.defineProperty(state.members, id, { value: target, writable: true, enumerable: true, configurable: true });
  return target;
}

export function reserveCohortBudget(state, ids, { id, role, revision, slots = 1, now }) {
  if (!id || !revision || !['check', 'keeper'].includes(role) || !Number.isSafeInteger(slots) || slots < 1 || slots > 3
    || !Number.isSafeInteger(now) || now < 0) throw Error('invalid reservation');
  const payload = fingerprint({ ids: [...ids].sort(), role, revision, slots });
  const prior = state.reservations.find(e => e.id === id);
  if (prior) { if (prior.payload !== payload) throw Error('reservation ID reused'); return { state: 'reserved', replay: true, cohort: prior.cohort }; }
  const cohort = reconcileCohort(state, ids);
  const spent = state.reservations.filter(e => e.cohort === cohort && e.role === role && now - e.at < 30 * MINUTE)
    .reduce((n, e) => n + e.slots, 0);
  if (spent + slots > 3) return { state: 'manual-recheck', cohort };
  state.reservations.push({ id, payload, cohort, role, revision, slots, at: now });
  return { state: 'reserved', replay: false, cohort };
}

export function pruneCohortReservations(state, now, activeIds = []) {
  const active = new Set(activeIds);
  state.reservations = state.reservations.filter(e => active.has(e.id) || now - e.at < 30 * MINUTE);
  // Per-revision attempts/completed advice are separate current-job records;
  // their applicability, not this rolling ledger, prevents resubmission.
}

export function compactIdleCohort(state, cohort, partitions, { now, settledSince, activeCohorts = [], createId = randomUUID }) {
  const known = Object.keys(state.members).filter(id => state.members[id] === cohort).sort();
  const ids = partitions.flat();
  if (!known.length || partitions.some(p => !Array.isArray(p) || !p.length) || new Set(ids).size !== ids.length
    || fingerprint([...ids].sort()) !== fingerprint(known)) throw Error('incomplete cohort partition');
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(settledSince) || now - settledSince < 30 * MINUTE
    || activeCohorts.includes(cohort) || state.reservations.some(e => e.cohort === cohort && now - e.at < 30 * MINUTE)) return false;
  // After a full quiet budget window, unrelated stable descendants need not
  // remain tied forever. Exact-input attempts/advice are NOT reset by this.
  const used = new Set(Object.values(state.members)), replacement = partitions.map(() => {
    const id = createId(); if (typeof id !== 'string' || !id || used.has(id)) throw Error('invalid cohort identity'); used.add(id); return id;
  });
  partitions.forEach((part, i) => part.forEach(id => { state.members[id] = replacement[i]; }));
  state.reservations = state.reservations.filter(e => e.cohort !== cohort);
  return replacement;
}

export function receiptDisposition(record, now) {
  if (record.pendingSync || record.undoDependency || record.completedAt == null) return 'receipt';
  if (!Number.isSafeInteger(record.completedAt) || !Number.isSafeInteger(now)) throw Error('invalid receipt time');
  const age = now - record.completedAt;
  if (age < LIFETIME.receipt) return 'receipt';
  if (age < LIFETIME.receipt + LIFETIME.tombstone) return 'tombstone';
  return 'forget';
}

export function operationScopeHash(payload) {
  // At issuance the adapter uses its authoritative snapshot/Undo target.
  // At inspection derive the binding from the submitted payload, not a second
  // client-supplied scope hash that could disagree with that payload.
  if (payload?.kind === 'decision' && ['manual', 'advice'].includes(payload.mode)
    && payload.snapshot && typeof payload.snapshot === 'object' && !Array.isArray(payload.snapshot)) {
    const ids = payload.snapshot.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length || !payload.outcomes || typeof payload.outcomes !== 'object' || Array.isArray(payload.outcomes)
      || fingerprint(Object.keys(payload.outcomes).sort()) !== fingerprint([...ids].sort())) throw Error('outcomes outside operation scope');
    return fingerprint({ kind: payload.kind, mode: payload.mode, snapshot: payload.snapshot });
  }
  if (payload?.kind === 'undo' && typeof payload.targetOperationId === 'string' && payload.targetOperationId) {
    return fingerprint({ kind: payload.kind, targetOperationId: payload.targetOperationId });
  }
  throw Error('invalid operation scope');
}

export function inspectOperation({ operationId, payload, now }, lookup) {
  if (typeof operationId !== 'string' || !operationId) return 'conflict';
  let scopeHash;
  try { scopeHash = operationScopeHash(payload); } catch { return 'conflict'; }
  const { lease, saved } = lookup(operationId) ?? {};
  const payloadHash = fingerprint(payload);
  // Look up an existing receipt before checking lease expiry: a lost response
  // remains recoverable without reapplying the operation.
  if (saved) {
    if (saved.operationId !== operationId || saved.payloadHash !== payloadHash) return 'conflict';
    return saved.receipt == null ? 'expired' : 'replay';
  }
  // IDs are server-issued in a bounded lease, never accepted as a fresh action
  // merely because an arbitrary client ID is absent after history pruning.
  if (!lease || !Number.isSafeInteger(lease.expiresAt) || !Number.isSafeInteger(now) || now >= lease.expiresAt) return 'expired';
  if (lease.operationId !== operationId || lease.scopeHash !== scopeHash) return 'conflict';
  return 'new';
}
