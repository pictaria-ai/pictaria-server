// Pure scheduling policy experiment. Callers would persist this state before
// a real submission; this module neither runs requests nor integrates queues.
import { fingerprint } from './grouping.mjs';

export function backendKey(endpoint, resourceAlias = '') {
  if (resourceAlias) return fingerprint({ resourceAlias });
  const url = new URL(endpoint);
  // Models and API paths on the same endpoint share a conservative resource
  // key. Explicit aliases can identify different endpoints on one GPU.
  return fingerprint({ origin: url.origin });
}

export function nextTurn(state, waiting) {
  const curate = waiting.interactive || waiting.background;
  if (!curate && !waiting.enrich) return null;
  if (waiting.enrich && (!curate || state.last !== 'enrich')) { state.last = 'enrich'; return 'enrich'; }
  state.last = 'curate';
  if (waiting.background && (!waiting.interactive || (state.interactiveTurns ?? 0) >= 2)) {
    state.interactiveTurns = 0; return 'background';
  }
  state.interactiveTurns = (state.interactiveTurns ?? 0) + 1;
  return 'interactive';
}

export function freshLineage() { return { active: null, queued: null, changedAt: 0, attempts: {}, completed: {}, submissions: [] }; }
export function supersede(state, revision, now) {
  if (state.active === revision || Object.hasOwn(state.completed, revision)) { state.queued = null; return; }
  if (state.queued === revision) return;
  state.queued = revision; state.changedAt = now; // one latest replacement
}
export function reserve(state, backend, now, { enabled = true, paused = false, explicit = false } = {}) {
  if (!enabled || paused) return 'paused';
  if (state.active || !state.queued) return 'idle';
  if (backend.blocked || now < (backend.cooldownUntil ?? 0)) return 'provider-paused';
  if (now - state.changedAt < 30000) return 'settling';
  state.submissions = state.submissions.filter(t => now - t < 30 * 60000);
  const attempts = state.attempts[state.queued] ?? 0;
  if (!explicit && (attempts >= 2 || state.submissions.length >= 3)) return 'manual-recheck';
  state.active = state.queued; state.queued = null;
  state.attempts[state.active] = attempts + 1; state.submissions.push(now);
  return 'reserved';
}
export function finish(state, backend, now, { success, permanent = false, retryAfterMs = 0 }) {
  if (!state.active) throw Error('no active work');
  const revision = state.active; state.active = null;
  if (success) { backend.failures = 0; state.completed[revision] = true; return; }
  backend.failures = (backend.failures ?? 0) + 1;
  backend.blocked ||= permanent;
  backend.cooldownUntil = now + Math.max(60000, Math.min(30 * 60000, retryAfterMs), backend.failures >= 3 ? 5 * 60000 : 0);
  if (!state.queued) { state.queued = revision; state.changedAt = now; }
}
