import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { CurateError } from './contracts.mjs';
import { LAB_PHOTO_LIMIT } from '../../public/curate/stacking-model.js';
import { labRecognizedIds } from './lab-evidence.mjs';

// Separate, ephemeral scopes: lab IDs cannot issue decisions or corrections.
export class StackingLab {
  constructor(curate) {
    this.curate = curate;
    this.views = new Map();
  }
  async open({ gapSeconds = 15, sort = 'oldest' } = {}) {
    if (!Number.isInteger(gapSeconds) || gapSeconds < 1 || gapSeconds > 180 || !['oldest', 'newest'].includes(sort))
      throw new CurateError('Choose a gap of 1–180 seconds and a date order.', 'invalid_lab_query', 400);
    if (this.closed || this.busy) throw new CurateError('The stacking lab is busy. Try again shortly.', 'lab_busy', 503);
    this.busy = true;
    try {
      // Refresh derived local evidence only. Does not start metadata/AI workers.
      await this.curate.refresh();
      if (this.closed) throw Error('The stacking lab is stopping.');
      const result = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./lab-worker.mjs', import.meta.url), {
          workerData: { path: this.curate.repo.databasePath, gapMs: gapSeconds * 1000, sort }, execArgv: [],
        });
        this.worker = worker;
        let message;
        worker.once('message', (value) => { message = value; });
        worker.once('error', reject);
        worker.once('exit', (code) => {
          this.worker = null;
          if (code || !message) reject(Error('The stacking lab could not read this library.'));
          else if (message.error) reject(Error(message.error));
          else resolve(message.result);
        });
      });
      if (this.closed) throw Error('The stacking lab is stopping.');
      for (const [id, view] of this.views) if (view.expiresAt <= Date.now()) this.views.delete(id);
      // Four complete bounded snapshots, independent of production view leases.
      if (this.views.size >= 4) this.views.delete(this.views.keys().next().value);
      const viewId = randomUUID();
      this.views.set(viewId, { ...result, viewId, gapSeconds, sort, expiresAt: Date.now() + 30 * 60000 });
      return this.page(viewId);
    } catch (error) {
      if (error instanceof CurateError) throw error;
      throw new CurateError(error.message, 'lab_unavailable', 503);
    } finally { this.busy = false; }
  }
  view(id) {
    const view = this.views.get(id);
    if (!view || view.expiresAt <= Date.now()) {
      this.views.delete(id);
      throw new CurateError('This lab snapshot expired. Build time groups again.', 'lab_expired', 410);
    }
    return view;
  }
  page(id, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new CurateError('Invalid lab page.', 'invalid_lab_query', 400);
    const view = this.view(id);
    const { groups, ...rest } = view;
    return { ...rest, total: groups.length, offset, nextOffset: offset + 50 < groups.length ? offset + 50 : null,
      groups: groups.slice(offset, offset + 50).map((photos, i) => ({
        id: offset + i, memberCount: photos.length, photo: { id: photos[0].id, filename: photos[0].filename },
        first: photos[0].time, last: photos.at(-1).time,
      })),
    };
  }
  comparison(id, groupId) {
    const view = this.view(id);
    if (!Number.isSafeInteger(groupId) || groupId < 0 || !view.groups[groupId])
      throw new CurateError('Time group not found.', 'invalid_lab_query', 404);
    const photos = view.groups[groupId];
    if (photos.length > LAB_PHOTO_LIMIT)
      throw new CurateError(`This time group has ${photos.length} photos. Experiments support up to ${LAB_PHOTO_LIMIT}; try a shorter starting gap. No photos were sampled.`, 'lab_group_too_large', 422);
    return { photos, gapSeconds: view.gapSeconds, capturedAt: view.expiresAt - 30 * 60000,
      immichUrl: this.curate.config.immichPublicUrl || null };
  }
  async refreshRecognition(id, groupId, { signal } = {}) {
    const comparison = this.comparison(id, groupId);
    const refreshed = await this.curate.metadata.refreshPhotos(comparison.photos.map(p => p.id), { signal });
    // Return an independent experiment snapshot. Neither other tabs nor an
    // already-open experiment gain changing evidence as background work runs.
    this.view(id);
    const byId = new Map(refreshed.photos.map(p => [p.id, p]));
    return { ...comparison, photos: comparison.photos.map(photo => {
      const metadata = byId.get(photo.id);
      const recognizedIds = metadata.outcome === 'refreshed'
        ? labRecognizedIds(JSON.stringify(metadata.recognition)) : null;
      return { ...photo, recognizedIds, recognizedCount: recognizedIds?.length ?? null,
        recognitionStatus: recognizedIds !== null ? 'loaded' : metadata.outcome === 'refreshed' ? 'not-returned' : 'failed',
        recognitionCheckedAt: metadata.checkedAt, recognitionOutcome: metadata.outcome };
    }) };
  }
  async similarityRanking(id, groupId, { signal } = {}) {
    const { photos } = this.comparison(id, groupId);
    if (photos.length < 2)
      throw new CurateError('Choose a time group with at least two photos.', 'invalid_lab_query', 400);
    // The snapshot is already in capture order (ID ties); rule toggles or a
    // highlighted photo cannot change the reference or narrow the search pool.
    const { ids, ...result } = await this.curate.similarity.search(photos[0].id, { signal });
    this.view(id);
    const positions = new Map(ids.map((id, index) => [id, index + 1]));
    return { ...result, returned: ids.length, photos: photos.map(p => ({ id: p.id,
      rank: positions.get(p.id) ?? null })) };
  }
  async close() {
    this.closed = true;
    this.views.clear();
    if (this.worker) await this.worker.terminate();
  }
}
