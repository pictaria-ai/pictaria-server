import { setImmediate } from 'node:timers/promises';

const empty = () => ({ total: 0, completed: 0, incomplete: 0, remaining: 0,
  waitingForGrouping: 0, waitingForStack: 0, paused: 0 });
const configurationReasons = new Set(['configuration', 'stack-configuration', 'unknown-capability', 'unsupported-provider', 'invalid-scope']);

// One item per pending stack, even when Photo Referee needs several requests.
// A terminal outcome is finished work, not a promise that the AI succeeded.
export function countRefereeStack(counts, status) {
  // Checked Stack Referee reasons are model prose, not machine state codes.
  const reason = status?.unavailableReason ?? (['checked', 'complete'].includes(status?.state) ? undefined : status?.reason);
  if (status?.state === 'off' || (status?.state === 'skipped' && reason !== 'deterministic-pending' && !configurationReasons.has(reason))) return;
  counts.total++;
  if (status?.state === 'paused' || status?.scope === 'configuration' || configurationReasons.has(reason)) {
    counts.remaining++; counts.paused++;
  } else if (reason === 'deterministic-pending') {
    counts.remaining++; counts.waitingForGrouping++;
  } else if (reason === 'stack-pending') {
    counts.remaining++; counts.waitingForStack++;
  } else if (['checked', 'complete'].includes(status?.state)) counts.completed++;
  else if (status?.state === 'incomplete') counts.incomplete++;
  else counts.remaining++;
}

// Shared, read-only library summary. Never scan the library in an HTTP status
// request or infer its size from the bounded AI queue. Yield between slices so
// large libraries cannot hold up photo decisions while counts are collected.
export class CurateRefereeProgress {
  constructor(curate, { now = Date.now, interval = 4000, yieldSlice = setImmediate } = {}) {
    this.curate = curate; this.now = now; this.interval = interval; this.yieldSlice = yieldSlice;
    this.revision = 0; this.snapshot = null;
  }
  invalidate() { this.revision++; this.snapshot = null; }
  enabled() { return [this.curate.stackReferee?.enabled() === true, this.curate.photoReferee?.enabled() === true]; }
  current(snapshot) {
    return snapshot && snapshot.current === this.curate.current && snapshot.revision === this.revision &&
      snapshot.generation === this.curate.store.generation() &&
      this.enabled().every((enabled, i) => enabled === snapshot.enabled[i]);
  }
  status() {
    const fresh = this.current(this.snapshot);
    return Object.fromEntries(['stack', 'photo'].map((role, i) => [role, !this.enabled()[i] ? { state: 'off' }
      : fresh ? { state: 'ready', ...this.snapshot[role] } : { state: 'counting' }]));
  }
  async refresh() {
    if (this.current(this.snapshot) && this.now() - this.snapshot.at < this.interval) return;
    const current = this.curate.current;
    if (!current || this.curate.closed) return;
    const snapshot = { current, generation: current.generation, revision: this.revision,
      enabled: this.enabled(), stack: empty(), photo: empty() };
    if (!snapshot.enabled.some(Boolean)) return;
    let slice = performance.now();
    for (const group of current.groups) {
      if (performance.now() - slice >= 4) {
        await this.yieldSlice(); slice = performance.now();
        if (this.curate.closed || !this.current(snapshot)) return;
      }
      if (group.ids.length < 2) continue;
      if (snapshot.enabled[0]) countRefereeStack(snapshot.stack, this.curate.stackReferee.status(group));
      if (snapshot.enabled[1]) countRefereeStack(snapshot.photo, this.curate.photoReferee.status(group));
    }
    if (!this.curate.closed && this.current(snapshot)) this.snapshot = { ...snapshot, at: this.now() };
  }
}
