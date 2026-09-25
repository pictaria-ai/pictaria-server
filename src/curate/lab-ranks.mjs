import { setTimeout as sleep } from 'node:timers/promises';
import { CurateError, fingerprint } from './contracts.mjs';

export const LAB_RANK_LIMITS = Object.freeze({ photos: 40, searches: 8, passMs: 180_000 });

// Ephemeral, caller-driven work. No jobs, retries, pagination or curation writes.
export class LabRanks {
  constructor(lab, { wait = (ms, signal) => sleep(ms, undefined, { signal }) } = {}) {
    this.lab = lab;
    this.wait = wait;
  }
  prepare({ viewId, groupId, completed = [], scope } = {}) {
    const { photos } = this.lab.comparison(viewId, groupId);
    if (photos.length < 2 || photos.length > LAB_RANK_LIMITS.photos)
      throw new CurateError(`Rank comparisons support 2–${LAB_RANK_LIMITS.photos} photos. Try a shorter starting gap; no photos were sampled.`, 'lab_rank_size', 422);
    const ids = photos.map(p => p.id);
    if (!Array.isArray(completed) || completed.length > ids.length || new Set(completed).size !== completed.length || completed.some(id => !ids.includes(id)))
      throw new CurateError('Invalid completed references.', 'invalid_lab_query', 400);
    const search = this.lab.curate.similarity;
    search.settingsChanged();
    const revision = fingerprint([viewId, groupId, search.connectionKey(), ids.map(id => [id, search.sourceKey(id)])]);
    if ((scope && scope !== revision) || (completed.length && scope !== revision))
      throw new CurateError('The photos or Immich connection changed. Reset rank evidence before checking again.', 'lab_rank_changed');
    const remaining = ids.filter(id => !completed.includes(id));
    const cached = remaining.map(id => search.cached(id)).filter(Boolean);
    const cachedIds = new Set(cached.map(row => row.referenceId));
    const pending = remaining.filter(id => !cachedIds.has(id));
    const references = pending.slice(0, LAB_RANK_LIMITS.searches);
    const value = { scope: revision, newSearches: references.length, cached: cached.length,
      remaining: pending.length - references.length, references,
      // Bind admission to the displayed cache state, too. Cache expiry must
      // never quietly increase the user's approved work estimate.
      admission: fingerprint([revision, completed, cached.map(r => [r.referenceId, r.checkedAt]), references]) };
    return { value, photos, cached };
  }
  plan(body) { return this.prepare(body).value; }
  row(value, photos) {
    const { ids, ...result } = value;
    const positions = new Map(ids.map((id, i) => [id, i + 1]));
    return { ...result, state: 'complete', returned: ids.length,
      photos: photos.map(p => ({ id: p.id, rank: p.id === value.referenceId ? null : positions.get(p.id) ?? null })) };
  }
  async run(body, { signal, emit }) {
    const search = this.lab.curate.similarity;
    const { value, photos, cached } = this.prepare(body);
    if (body.admission !== value.admission)
      throw new CurateError('The search estimate changed. Review the updated estimate and start again.', 'lab_rank_estimate_changed');
    const owner = search.reserve();
    const deadline = AbortSignal.any([signal, search.shutdown.signal, AbortSignal.timeout(LAB_RANK_LIMITS.passMs)]);
    const check = () => {
      deadline.throwIfAborted();
      // Also check membership, the lab lease and all source revisions between
      // requests; do not combine observations from different libraries/renditions.
      this.prepare({ viewId: body.viewId, groupId: body.groupId, scope: value.scope });
    };
    try {
      check();
      await emit({ type: 'start', plan: value });
      for (const row of cached) { check(); await emit({ type: 'row', row: this.row(row, photos) }); }
      let completed = 0;
      for (const referenceId of value.references) {
        check();
        await emit({ type: 'progress', referenceId, completed, total: value.newSearches });
        const pause = Math.max(0, search.nextAt - search.now());
        if (pause) await this.wait(pause, deadline);
        check();
        let result;
        try { result = await search.search(referenceId, { signal: deadline, owner }); }
        catch (error) {
          check();
          await emit({ type: 'row', row: { referenceId, state: 'failed', message: error instanceof CurateError ? error.message : 'Could not check this reference.' } });
          await emit({ type: 'done', stopped: true, message: 'Stopped after a failed search. No automatic retries; remaining references are unqueried.' });
          return;
        }
        check();
        await emit({ type: 'row', row: this.row(result, photos) });
        completed++;
      }
      check();
      await emit({ type: 'done', stopped: false, message: value.remaining ? 'Pass complete. More references remain unqueried.' : 'Pass complete.' });
    } finally { search.release(owner); }
  }
}
