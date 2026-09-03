export const DAILY_ENRICH_RUN_TITLE = 'Daily Enrich';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BOOT_DELAY_MS = 2_000;

// A daily time belongs to the administrator, not to the container. Settings
// saves the browser's IANA time zone beside the chosen HH:MM value so a Docker
// host that runs in UTC still starts the job when the user expects it.
export function localScheduleParts(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

export function dailyTimeMinute(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export class EnrichScheduler {
  constructor({
    runner,
    repo,
    config,
    intervalMs = DEFAULT_INTERVAL_MS,
    bootDelayMs = DEFAULT_BOOT_DELAY_MS,
    now = () => new Date(),
    log = (message) => console.log(message),
    warn = (message) => console.warn(message),
  }) {
    this.runner = runner;
    this.repo = repo;
    this.config = config;
    this.intervalMs = intervalMs;
    this.bootDelayMs = bootDelayMs;
    this.now = now;
    this.log = log;
    this.warn = warn;
    this.timer = null;
    this.bootTimer = null;
    this.soonTimer = null;
    this.stopped = false;
    this.historyCheckedDate = null;
    this.startedDate = null;
    this.failedDate = null;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.bootTimer = setTimeout(() => {
      this.bootTimer = null;
      this.#safeTick();
    }, this.bootDelayMs);
    this.bootTimer.unref?.();
    this.timer = setInterval(() => this.#safeTick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    for (const key of ['bootTimer', 'soonTimer', 'timer']) {
      if (this[key]) {
        clearTimeout(this[key]); // also clears intervals
        this[key] = null;
      }
    }
    return true;
  }

  // Settings apply live. Re-check promptly so enabling after today's chosen
  // time catches up without a restart; run history still prevents a second
  // scheduled run on the same local date.
  settingsChanged() {
    this.historyCheckedDate = null;
    this.startedDate = null;
    this.failedDate = null;
    if (this.stopped || this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null;
      this.#safeTick();
    }, 0);
    this.soonTimer.unref?.();
  }

  tick(now = this.now()) {
    if (this.stopped || !this.config.enrichEnabled || !this.config.enrichSchedule?.enabled) {
      return false;
    }

    const schedule = this.config.enrichSchedule;
    const current = localScheduleParts(now, schedule.timeZone);
    const dueMinute = dailyTimeMinute(schedule.time);
    if (dueMinute === null || current.minuteOfDay < dueMinute) return false;
    if (this.startedDate === current.date || this.failedDate === current.date) return false;

    // A manual/queued run or a queued slice resolution keeps priority. Check
    // before caching today's history lookup: a Settings save during an active
    // run clears the in-memory latch, and the run has no history row until it
    // finishes. Consuming the lookup while busy could otherwise start a
    // second Daily Enrich later that day.
    if (this.runner.isBusy()) return false;

    // Run history is the durable once-per-day latch. A graceful restart writes
    // an interrupted row too, so it will not start the same daily job twice.
    // Abrupt power loss can repeat the catch-up scan, but only-unenriched makes
    // that idempotent: completed photos do not reach the provider again.
    if (this.historyCheckedDate !== current.date) {
      const previous = this.repo.latestJobRunStartedAtByTitle(DAILY_ENRICH_RUN_TITLE);
      this.historyCheckedDate = current.date;
      if (previous) {
        const priorDate = localScheduleParts(new Date(previous), schedule.timeZone).date;
        if (priorDate === current.date) {
          this.startedDate = current.date;
          return false;
        }
      }
    }

    try {
      this.runner.start({
        title: DAILY_ENRICH_RUN_TITLE,
        provider: this.config.defaultProvider,
        maxAnalyzed: schedule.photoBudget,
        skipAnySuccessful: true,
        sendToCurate: true,
      });
      this.startedDate = current.date;
      this.log(
        `[Pictaria] Daily Enrich started: up to ${schedule.photoBudget} new photo(s) `
        + `with ${this.config.defaultProvider}`,
      );
      return true;
    } catch (error) {
      // A missing key/model should make one useful log entry, not one every
      // minute. Any Settings save clears this latch so a correction retries.
      this.failedDate = current.date;
      this.warn(`[Pictaria] Daily Enrich could not start: ${error?.message ?? error}`);
      return false;
    }
  }

  #safeTick() {
    try {
      this.tick();
    } catch (error) {
      this.warn(`[Pictaria] Daily Enrich scheduler failed: ${error?.message ?? error}`);
    }
  }
}
