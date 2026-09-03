import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_ENRICH_RUN_TITLE,
  EnrichScheduler,
  dailyTimeMinute,
  localScheduleParts,
} from '../../src/enrich/scheduler.mjs';

function fixture(overrides = {}) {
  const starts = [];
  let running = false;
  let latest = null;
  const warnings = [];
  const config = {
    enrichEnabled: true,
    defaultProvider: 'local_ollama',
    enrichSchedule: {
      enabled: true,
      time: '03:00',
      timeZone: 'America/Los_Angeles',
      photoBudget: 100,
    },
    ...overrides.config,
  };
  const runner = {
    isRunning: () => running,
    start: (options) => starts.push(options),
    ...overrides.runner,
  };
  const repo = {
    latestJobRunStartedAtByTitle: (title) => {
      assert.equal(title, DAILY_ENRICH_RUN_TITLE);
      return latest;
    },
    ...overrides.repo,
  };
  const scheduler = new EnrichScheduler({
    runner,
    repo,
    config,
    warn: (message) => warnings.push(message),
  });
  return {
    scheduler,
    starts,
    warnings,
    setRunning: (value) => { running = value; },
    setLatest: (value) => { latest = value; },
  };
}

test('daily schedule time parsing and IANA conversion are deterministic', () => {
  assert.equal(dailyTimeMinute('03:15'), 195);
  assert.equal(dailyTimeMinute('24:00'), null);
  assert.deepEqual(localScheduleParts(new Date('2026-09-03T09:59:00Z'), 'America/Los_Angeles'), {
    date: '2026-09-03',
    minuteOfDay: 179,
  });
  assert.deepEqual(localScheduleParts(new Date('2026-09-03T10:00:00Z'), 'America/Los_Angeles'), {
    date: '2026-09-03',
    minuteOfDay: 180,
  });
});

test('Daily Enrich starts once after the chosen local time with only-unenriched semantics', () => {
  const { scheduler, starts } = fixture();
  assert.equal(scheduler.tick(new Date('2026-09-03T09:59:00Z')), false);
  assert.equal(scheduler.tick(new Date('2026-09-03T10:00:00Z')), true);
  assert.equal(scheduler.tick(new Date('2026-09-03T18:00:00Z')), false);
  assert.deepEqual(starts, [{
    title: DAILY_ENRICH_RUN_TITLE,
    provider: 'local_ollama',
    maxAnalyzed: 100,
    skipAnySuccessful: true,
    sendToCurate: true,
  }]);
});

test('a same-day history row prevents a duplicate after restart', () => {
  const { scheduler, setLatest, starts } = fixture();
  setLatest('2026-09-03T10:02:00.000Z');
  assert.equal(scheduler.tick(new Date('2026-09-03T18:00:00Z')), false);
  assert.equal(starts.length, 0);
});

test('an active manual run delays the daily run without consuming the day', () => {
  const { scheduler, setRunning, starts } = fixture();
  setRunning(true);
  assert.equal(scheduler.tick(new Date('2026-09-03T10:00:00Z')), false);
  setRunning(false);
  assert.equal(scheduler.tick(new Date('2026-09-03T10:01:00Z')), true);
  assert.equal(starts.length, 1);
});

test('Enrich and its daily switch must both be enabled', () => {
  const offMaster = fixture({ config: { enrichEnabled: false } });
  assert.equal(offMaster.scheduler.tick(new Date('2026-09-03T18:00:00Z')), false);
  const offSchedule = fixture({
    config: {
      enrichEnabled: true,
      enrichSchedule: { enabled: false, time: '03:00', timeZone: 'UTC', photoBudget: 100 },
    },
  });
  assert.equal(offSchedule.scheduler.tick(new Date('2026-09-03T18:00:00Z')), false);
});

test('a provider configuration error logs once until Settings changes', () => {
  const { scheduler, warnings } = fixture({
    runner: {
      isRunning: () => false,
      start: () => { throw new Error('model missing'); },
    },
  });
  assert.equal(scheduler.tick(new Date('2026-09-03T18:00:00Z')), false);
  assert.equal(scheduler.tick(new Date('2026-09-03T18:01:00Z')), false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /model missing/);
});

test('stop before the boot kick prevents a late scheduled start', async () => {
  const { scheduler, starts } = fixture();
  scheduler.bootDelayMs = 20;
  scheduler.start();
  assert.equal(scheduler.stop(), true);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(starts.length, 0);
});
