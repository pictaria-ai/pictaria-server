import { awaitDrain } from '../lifecycle.mjs';
import { jobIsDue, runSmartAlbumJob } from './smartAlbums.mjs';

export class SmartAlbumScheduler {
  constructor({ immich, store, config, enrichRepo = null, intervalMs = 60_000, bootDelayMs = 2_000 }) {
    this.immich = immich;
    this.store = store;
    this.config = config;
    this.enrichRepo = enrichRepo;
    this.intervalMs = intervalMs;
    this.bootDelayMs = bootDelayMs;
    this.timer = null;
    this.bootTimer = null;
    this.tickPromise = null;
    this.stopped = false;
  }

  start() {
    if (this.timer) {
      return;
    }
    this.stopped = false;

    const kick = () => {
      if (this.stopped || this.ticking) {
        // A tick outliving the interval must keep the drain handle: an
        // overwrite would leave stop() awaiting only the newest (no-op-ish)
        // tick while the older one still holds Immich work. Per-job
        // single-flight in runSmartAlbumJob makes the skipped kick a no-op.
        return;
      }
      this.ticking = true;
      this.tickPromise = this.tick()
        .catch((error) => console.error(error))
        .finally(() => {
          this.ticking = false;
        });
    };
    // The boot kick is owned like the interval: stop() must clear it, or a
    // shutdown inside the first seconds leaves a timer that fires listJobs
    // into a closed world.
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      kick();
    }, this.bootDelayMs);
    this.bootTimer.unref?.();
    this.timer = setInterval(kick, this.intervalMs);
    this.timer.unref?.();
  }

  // Shutdown drain: retire both timers, tell an in-flight tick to stop
  // between jobs, and wait for it — bounded, because a job mid-Immich-call
  // can't be aborted, only abandoned. Returns false when the wait gave up.
  async stop(timeoutMs = 3000) {
    this.stopped = true;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return awaitDrain(this.tickPromise, timeoutMs);
  }

  async tick(now = new Date()) {
    const jobs = await this.store.listJobs();
    const dueJobs = jobs.filter((job) => jobIsDue(job, now));

    for (const job of dueJobs) {
      if (this.stopped) {
        return; // shutting down — remaining due jobs run on the next boot
      }
      try {
        // Single-flight lives in runSmartAlbumJob itself, shared with manual
        // API runs — a job already running (either path) throws job_running.
        await runSmartAlbumJob({
          immich: this.immich,
          store: this.store,
          config: this.config,
          enrichRepo: this.enrichRepo,
          jobId: job.id,
        });
      } catch (error) {
        if (error?.code === 'job_running') {
          continue;
        }
        console.error(`Smart album job failed: ${job.albumName} (${job.id})`, error);
      }
    }
  }
}
