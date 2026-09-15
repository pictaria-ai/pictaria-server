// Offline snapshot-publication experiment, not a server cache or database reader.
import { groupPhotosInBackground } from './grouping.mjs';

export class BackgroundGroups {
  constructor({ build = groupPhotosInBackground, runtime = {} } = {}) {
    this.build = build;
    this.runtime = runtime;
    this.current = null;
    this.active = null;
    this.queued = null;
    this.closed = false;
  }

  // Load lazily: repeated notifications keep one latest request rather than
  // constructing and retaining another full projection for every update.
  request(loadSnapshot) {
    if (this.closed) return Promise.reject(Error('builder closed'));
    if (typeof loadSnapshot !== 'function') return Promise.reject(Error('invalid snapshot loader'));
    return new Promise((resolve, reject) => {
      this.queued?.resolve({ published: false, reason: 'superseded' });
      this.queued = { loadSnapshot, resolve, reject };
      this.active?.abort.abort();
      void this.pump();
    });
  }

  async pump() {
    if (this.active) return;
    while (this.queued && !this.closed) {
      const job = this.queued;
      this.queued = null;
      job.abort = new AbortController();
      this.active = job;
      try {
        const snapshot = await job.loadSnapshot(job.abort.signal);
        job.abort.signal.throwIfAborted();
        if (!snapshot || typeof snapshot.revision !== 'string' || !Array.isArray(snapshot.rows)) throw Error('invalid snapshot');
        const result = await this.build(snapshot.rows, snapshot.options, { ...this.runtime, signal: job.abort.signal });
        job.abort.signal.throwIfAborted();
        // The complete replacement is published at once. Existing readers keep
        // their old object; none observes a half-built or superseded index.
        const pending = result.groups.filter(g => g.pendingIds.length);
        this.current = { revision: snapshot.revision, ...result, pending };
        job.resolve({ published: true, revision: snapshot.revision });
      } catch (error) {
        if (job.abort.signal.aborted) job.resolve({ published: false, reason: this.closed ? 'closed' : 'superseded' });
        else job.reject(error); // keep the previous usable projection on failure
      } finally { this.active = null; }
    }
  }

  page(offset = 0, limit = 50) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw Error('invalid page');
    return { revision: this.current?.revision ?? null,
      groups: (this.current?.pending ?? []).slice(offset, offset + limit).map(g => ({
        id: g.id, memberCount: g.ids.length, pendingCount: g.pendingIds.length,
        keptCount: g.keptContextIds.length, route: g.route, reasons: g.reasons,
      })) };
  }

  close() {
    this.closed = true;
    this.active?.abort.abort();
    this.queued?.resolve({ published: false, reason: 'closed' });
    this.queued = null;
  }
}
