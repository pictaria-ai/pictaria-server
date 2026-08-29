const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_CLIENT_LIMIT = 10;
const DEFAULT_CLIENT_LOCKOUT_MS = 15 * 60 * 1000;
const DEFAULT_GLOBAL_LIMIT = 100;
const DEFAULT_GLOBAL_LOCKOUT_MS = 60 * 1000;
const DEFAULT_MAX_CLIENTS = 1024;

/**
 * Admit only a small fixed number of password attempts at once. Rejected
 * callers retry instead of joining an unbounded queue, so the gate itself
 * cannot become another memory or connection sink.
 */
export function createAuthAdmissionGate({ limit = 16 } = {}) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('Authentication admission limit must be a positive integer.');
  }
  let active = 0;

  function tryAcquire() {
    if (active >= limit) {
      return null;
    }
    active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
    };
  }

  return { tryAcquire };
}

/**
 * Bound password guessing per resolved client while retaining a deliberately
 * higher global failure signal for distributed attempts.
 */
export function createAuthFailureLimiter({
  windowMs = DEFAULT_WINDOW_MS,
  clientLimit = DEFAULT_CLIENT_LIMIT,
  clientLockoutMs = DEFAULT_CLIENT_LOCKOUT_MS,
  globalLimit = DEFAULT_GLOBAL_LIMIT,
  globalLockoutMs = DEFAULT_GLOBAL_LOCKOUT_MS,
  maxClients = DEFAULT_MAX_CLIENTS,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(maxClients) || maxClients <= 0) {
    throw new TypeError('Authentication client limit must be a positive integer.');
  }
  const clients = new Map();
  let global = null;

  function remainingMs(clientKey) {
    const current = now();
    const client = activeEntry(clients.get(clientKey), current, windowMs);
    if (!client) {
      clients.delete(clientKey);
    }
    global = activeEntry(global, current, windowMs);
    return Math.max(
      client?.lockedUntil > current ? client.lockedUntil - current : 0,
      global?.lockedUntil > current ? global.lockedUntil - current : 0,
    );
  }

  function clientRemainingMs(clientKey) {
    const current = now();
    const client = activeEntry(clients.get(clientKey), current, windowMs);
    if (!client) {
      clients.delete(clientKey);
      return 0;
    }
    return client.lockedUntil > current ? client.lockedUntil - current : 0;
  }

  function globalRemainingMs() {
    const current = now();
    global = activeEntry(global, current, windowMs);
    return global?.lockedUntil > current ? global.lockedUntil - current : 0;
  }

  function recordFailure(clientKey) {
    const current = now();
    const client = increment(activeEntry(clients.get(clientKey), current, windowMs), current, clientLimit, clientLockoutMs);
    // Map insertion order is the eviction order. Refresh an active client's
    // position, then evict exactly one oldest identity before accepting a new
    // one. This keeps state fixed-size with O(1) work per failure.
    clients.delete(clientKey);
    if (clients.size >= maxClients) {
      clients.delete(clients.keys().next().value);
    }
    clients.set(clientKey, client);
    recordGlobalFailure(current);
  }

  function recordGlobalFailure(current = now()) {
    global = increment(activeEntry(global, current, windowMs), current, globalLimit, globalLockoutMs);
  }

  function clearClient(clientKey) {
    clients.delete(clientKey);
  }

  return {
    remainingMs,
    clientRemainingMs,
    globalRemainingMs,
    recordFailure,
    recordGlobalFailure,
    clearClient,
  };
}

function activeEntry(entry, current, windowMs) {
  if (!entry) {
    return null;
  }
  if (entry.lockedUntil) {
    // The counting window decides when failures stop accumulating; once its
    // threshold creates a lockout, that independent duration must run in full.
    return entry.lockedUntil > current ? entry : null;
  }
  if (current - entry.firstAt > windowMs) {
    return null;
  }
  return entry;
}

function increment(entry, current, limit, lockoutMs) {
  const next = entry ?? { count: 0, firstAt: current, lockedUntil: 0 };
  next.count += 1;
  if (next.count >= limit) {
    next.lockedUntil = current + lockoutMs;
  }
  return next;
}
