// A Map with an upper bound: past maxEntries, the least-recently-used key is
// evicted (get() refreshes recency). TTL and staleness semantics stay with
// the caller — weather deliberately keeps expired entries around as a stale
// fallback when the upstream fetch fails, so this container never expires
// anything on its own. It only guarantees the process can't grow one of
// these caches without limit.
export function createBoundedMap(maxEntries) {
  const entries = new Map();
  return {
    get(key) {
      if (!entries.has(key)) {
        return undefined;
      }
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value);
      }
    },
    delete(key) {
      return entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}
