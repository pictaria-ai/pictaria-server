import fs from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { writePrivateFileAtomic } from '../atomicFile.mjs';
import {
  parseBoundedJsonFile,
  parseBoundedJsonFileSync,
  readBoundedRegularFile,
} from '../boundedFile.mjs';
import { DEFAULT_MAX_RESULTS, normalizeFilters } from './smartAlbums.mjs';

const EMPTY_STATE = {
  version: 1,
  jobs: [],
};
export const MAX_SMART_ALBUM_STATE_BYTES = 16 * 1024 * 1024;

export class SmartAlbumStore {
  constructor(filePath, { installationSecret } = {}) {
    if (!Buffer.isBuffer(installationSecret) || installationSecret.length !== 32) {
      throw new Error('Smart Album storage requires a 32-byte installation secret.');
    }
    this.filePath = filePath;
    this.signingKey = createHmac('sha256', installationSecret)
      .update('pictaria-smart-album-schedule-v1\0')
      .digest();
    this.state = structuredClone(EMPTY_STATE);
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
  }

  // Concurrent first callers share one in-flight load: a second load
  // finishing after a committed mutation would clobber the mutated state.
  // A failed load is not cached, so a hand-fixed file can be retried.
  load() {
    this.loadPromise ??= this.#load().catch((error) => {
      this.loadPromise = null;
      throw error;
    });
    return this.loadPromise;
  }

  async #load() {
    try {
      const parsed = await parseBoundedJsonFile(this.filePath, {
        maxBytes: MAX_SMART_ALBUM_STATE_BYTES,
        label: 'Smart Album state',
      });
      this.state = normalizeState(parsed);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.state = structuredClone(EMPTY_STATE);
        await this.#persist(this.state);
      } else {
        this.state = await this.#recoverFromBackup(error);
      }
    }

    if (this.#quarantineUnconfirmedSchedules()) {
      await this.#persist(this.state);
    }
    return this.state;
  }

  // A corrupt state file no longer takes the whole server down: every save
  // keeps the previous version as .bak, so recovery restores the last good
  // state and parks the bad file as .corrupt for diagnosis. With no valid
  // backup we refuse to start — silently starting empty could later persist
  // empty state over a hand-recoverable file.
  async #recoverFromBackup(originalError) {
    const backupPath = `${this.filePath}.bak`;
    let recovered;
    try {
      recovered = normalizeState(await parseBoundedJsonFile(backupPath, {
        maxBytes: MAX_SMART_ALBUM_STATE_BYTES,
        label: 'Smart Album backup state',
      }));
    } catch {
      throw new Error(
        `Smart album state at ${this.filePath} is unreadable (${originalError.message}) `
        + `and no valid backup exists at ${backupPath}. Fix or remove the file to start.`,
      );
    }
    await fs.rename(this.filePath, `${this.filePath}.corrupt`).catch(() => {});
    await this.#persist(recovered);
    console.warn(
      `[Pictaria] Smart album state was corrupt; recovered from ${backupPath} `
      + `(bad file kept as ${this.filePath}.corrupt)`,
    );
    return recovered;
  }

  async listJobs() {
    await this.load();
    return this.state.jobs.map(publicJob);
  }

  async getJob(jobId) {
    await this.load();
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    return job ? publicJob(job) : null;
  }

  async addJob(job) {
    await this.load();
    const normalized = normalizeJob(job);
    if (!normalized) {
      throw new Error('Cannot store a malformed Smart Album job.');
    }
    const stored = {
      ...normalized,
      scheduleQuarantined: false,
    };
    stored.scheduleConfirmation = this.#signSchedule(stored);
    await this.#commit((state) => ({ ...state, jobs: [...state.jobs, stored] }));
    return publicJob(stored);
  }

  async updateJob(jobId, updater, { confirmSchedule = false } = {}) {
    await this.load();
    let updated = null;
    await this.#commit((state) => {
      const index = state.jobs.findIndex((job) => job.id === jobId);

      if (index === -1) {
        return null;
      }

      updated = {
        ...state.jobs[index],
        ...updater(publicJob(state.jobs[index])),
        updatedAt: new Date().toISOString(),
      };
      if (updated.enabled) {
        if (confirmSchedule || this.#scheduleIsConfirmed(state.jobs[index])) {
          updated.scheduleQuarantined = false;
          updated.scheduleConfirmation = this.#signSchedule(updated);
        } else {
          updated.enabled = false;
          updated.scheduleQuarantined = true;
          updated.scheduleConfirmation = null;
        }
      } else if (updated.scheduleQuarantined) {
        updated.scheduleConfirmation = null;
      } else {
        updated.scheduleConfirmation = this.#signSchedule(updated);
      }
      const jobs = [...state.jobs];
      jobs[index] = updated;
      return { ...state, jobs };
    });
    return updated ? publicJob(updated) : null;
  }

  async deleteJob(jobId) {
    await this.load();
    let deleted = false;
    await this.#commit((state) => {
      const jobs = state.jobs.filter((job) => job.id !== jobId);

      if (jobs.length === state.jobs.length) {
        return null;
      }

      deleted = true;
      return { ...state, jobs };
    });
    return deleted;
  }

  // The mutator runs inside the queued task, so each read-modify-write is
  // atomic: it sees the state left by the previous commit, never a snapshot
  // taken while another mutation was in flight. Returning null skips the
  // save (no-op). Memory advances only after the new state is durably on
  // disk: a failed save leaves memory and file both at the previous state,
  // so a reported error tells the truth and no phantom change rides along
  // on a later save. A throw (from the mutator or the write) rejects only
  // this caller — the queue itself recovers for the next commit.
  async #commit(mutator) {
    const task = this.writeQueue.then(async () => {
      const nextState = mutator(this.state);

      if (nextState === null) {
        return;
      }

      await this.#persist(nextState);
      this.state = nextState;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async #persist(state) {
    const payload = serializeState(state);
    // Keep the outgoing version as last-known-good before replacing it.
    const previous = await readBoundedRegularFile(this.filePath, {
      maxBytes: MAX_SMART_ALBUM_STATE_BYTES,
      label: 'Smart Album state',
    }).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (previous) {
      await writePrivateFileAtomic(`${this.filePath}.bak`, previous).catch(() => {});
    }
    await writePrivateFileAtomic(this.filePath, payload, { encoding: 'utf8' });
  }

  #quarantineUnconfirmedSchedules() {
    let changed = false;
    for (const job of this.state.jobs) {
      if (job.scheduleQuarantined) {
        if (job.enabled || job.scheduleConfirmation) {
          job.enabled = false;
          job.scheduleConfirmation = null;
          changed = true;
        }
        continue;
      }
      if (job.enabled && !this.#scheduleIsConfirmed(job)) {
        job.enabled = false;
        job.scheduleQuarantined = true;
        job.scheduleConfirmation = null;
        changed = true;
      }
    }
    return changed;
  }

  #signSchedule(job) {
    return createHmac('sha256', this.signingKey)
      .update(schedulePayload(job))
      .digest('hex');
  }

  #scheduleIsConfirmed(job) {
    if (!/^[0-9a-f]{64}$/.test(job.scheduleConfirmation || '')) {
      return false;
    }
    const expected = Buffer.from(this.#signSchedule(job), 'hex');
    const provided = Buffer.from(job.scheduleConfirmation, 'hex');
    return timingSafeEqual(provided, expected);
  }
}

function normalizeState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.jobs)) {
    throw new Error('expected Smart Album state version 1 with a jobs array');
  }
  const jobs = value.jobs.map(normalizeJob);
  if (jobs.some((job) => job === null)) {
    throw new Error('Smart Album state contains a malformed job');
  }
  return {
    version: 1,
    jobs,
  };
}

export function validateSmartAlbumPersistentState(filePath) {
  try {
    const normalized = normalizeState(parseBoundedJsonFileSync(filePath, {
      maxBytes: MAX_SMART_ALBUM_STATE_BYTES,
      label: 'Smart Album state',
    }));
    serializeState(normalized);
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: `smart-albums.json is unreadable: ${error.message}` };
  }
}

function serializeState(state) {
  const pretty = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(pretty, 'utf8') <= MAX_SMART_ALBUM_STATE_BYTES) {
    return pretty;
  }
  // Sparse legacy jobs expand during normalization. Keep accepted state
  // recoverable with compact canonical JSON when indentation alone would
  // cross the encoded-size boundary.
  const compact = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(compact, 'utf8') <= MAX_SMART_ALBUM_STATE_BYTES) {
    return compact;
  }
  throw new Error(`Smart Album state exceeds the ${MAX_SMART_ALBUM_STATE_BYTES}-byte limit.`);
}

function normalizeJob(job) {
  if (!job || typeof job.id !== 'string') {
    return null;
  }

  return {
    id: job.id,
    albumId: job.albumId || '',
    albumName: job.albumName || '',
    query: job.query || '',
    // Load legacy jobs without refusing startup; execution revalidates them
    // against current collection and work-cost limits before any Immich call.
    filters: normalizeFilters(job.filters || {}, { enforceLimits: false }),
    smart: Boolean(job.smart),
    bestOf: Boolean(job.bestOf),
    enabled: Boolean(job.enabled),
    intervalDays: Number.isFinite(job.intervalDays) ? job.intervalDays : 7,
    includeAllResults: Boolean(job.includeAllResults),
    maxResults: Number.isFinite(job.maxResults) ? job.maxResults : DEFAULT_MAX_RESULTS,
    createdAt: job.createdAt || new Date().toISOString(),
    updatedAt: job.updatedAt || job.createdAt || new Date().toISOString(),
    lastRunAt: job.lastRunAt || null,
    lastSuccessAt: job.lastSuccessAt || null,
    nextRunAt: job.nextRunAt || null,
    lastError: job.lastError || null,
    lastResult: job.lastResult || null,
    scheduleQuarantined: Boolean(job.scheduleQuarantined),
    scheduleConfirmation: typeof job.scheduleConfirmation === 'string'
      ? job.scheduleConfirmation.toLowerCase()
      : null,
  };
}

function copyJob(job) {
  return structuredClone(job);
}

function publicJob(job) {
  const copy = copyJob(job);
  delete copy.scheduleConfirmation;
  return copy;
}

function schedulePayload(job) {
  return JSON.stringify([
    1,
    job.id,
    job.albumId,
    job.albumName,
    job.query,
    job.filters,
    Boolean(job.smart),
    Boolean(job.bestOf),
    Boolean(job.enabled),
    job.intervalDays,
    Boolean(job.includeAllResults),
    job.maxResults,
    job.nextRunAt,
  ]);
}
