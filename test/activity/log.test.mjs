import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  ACTIVITY_RETENTION_DAYS,
  createActivityLog,
} from '../../src/activity/log.mjs';
import { Repository } from '../../src/enrich/repository.mjs';

function withRepository(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-activity-'));
  const repo = new Repository(join(dir, 'enrichment.sqlite'));
  repo.initSchema();
  try {
    return work({ dir, repo });
  } finally {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insert(repo, overrides = {}) {
  return repo.recordActivityEvent({
    at: '2026-08-07T12:00:00.000Z',
    category: 'system',
    type: 'system.test',
    source: 'test',
    provider: null,
    model: null,
    outcome: 'succeeded',
    summary: 'Test event',
    detailJson: null,
    ...overrides,
  });
}

test('records a bounded server-start event and includes it in database backups', () => {
  withRepository(({ dir, repo }) => {
    const activity = createActivityLog({
      repo,
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    });
    assert.equal(activity.retentionDays, ACTIVITY_RETENTION_DAYS);
    assert.equal(activity.systemStarted({ serverVersion: `1.2.3-${'x'.repeat(200)}` }), true);

    const { events, nextCursor } = activity.list();
    assert.equal(nextCursor, null);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      id: events[0].id,
      at: '2026-08-07T12:00:00.000Z',
      category: 'system',
      type: 'system.start',
      source: 'server',
      deviceId: null,
      assetId: null,
      provider: null,
      model: null,
      outcome: 'succeeded',
      summary: 'Pictaria Server started',
      detail: { serverVersion: `1.2.3-${'x'.repeat(122)}` },
    });

    const snapshotPath = join(dir, 'snapshot', 'enrichment.sqlite');
    repo.backupTo(snapshotPath);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE type = 'system.start'").get().n, 1);
    snapshot.close();
  });
});

test('typed activity methods keep a stable vocabulary and discard sensitive caller data', () => {
  withRepository(({ repo }) => {
    const activity = createActivityLog({
      repo,
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    });
    const secret = 'SENTINEL-secret-transcript-prompt-url';

    activity.systemStopping({ reason: secret, exitCode: 1, error: secret });
    activity.settingsChanged({
      fields: ['voice.ttsProvider', 'server.immichApiKey', secret],
      values: { immichApiKey: secret },
    });
    activity.frameCommand({ command: 'next', deviceId: 'kitchen', deliveredCount: 1, albumName: secret });
    activity.voiceCommand({ label: secret, deviceId: 'kitchen', transcript: secret });
    activity.voiceAnswer({ kind: 'tell-me', provider: 'openai', model: 'gpt-safe', outcome: 'succeeded', question: secret });
    activity.voiceTts({ provider: 'elevenlabs', model: 'eleven-safe', outcome: 'failed', text: secret });
    activity.assetFavorited({ assetId: 'asset-1', outcome: 'succeeded', metadata: secret });
    activity.assetHidden({ assetId: 'asset-2', outcome: 'failed', metadata: secret });
    activity.assetsDiscarded({ count: 2, mode: 'all', skippedSuccessful: 1, truncated: true, assetIds: [secret] });
    activity.assetsRestored({ count: 1, assetId: 'asset-3', assetIds: [secret] });

    const events = activity.list({ limit: 50 }).events;
    assert.deepEqual(new Set(events.map((event) => event.type)), new Set([
      'system.stop',
      'settings.changed',
      'frame.command',
      'voice.command',
      'voice.tell-me',
      'voice.tts',
      'curation.favorite',
      'curation.never-show',
      'curation.discard',
      'curation.restore',
    ]));

    const unknownVoice = events.find((event) => event.type === 'voice.command');
    assert.equal(unknownVoice.summary, 'Voice command used: unrecognized');
    assert.equal(unknownVoice.outcome, 'reported');
    assert.deepEqual(unknownVoice.detail, { command: 'unrecognized' });
    const settings = events.find((event) => event.type === 'settings.changed');
    assert.deepEqual(settings.detail, {
      fields: ['server.immichApiKey', 'voice.ttsProvider'],
      truncated: false,
    });
    const stop = events.find((event) => event.type === 'system.stop');
    assert.deepEqual(stop.detail, { reason: 'other', exitCode: 1 });

    const stored = repo.db.prepare('SELECT * FROM activity_log').all();
    assert.doesNotMatch(JSON.stringify(stored), new RegExp(secret));
  });
});

test('prunes events older than retention while preserving the cutoff and newer events', () => {
  withRepository(({ repo }) => {
    insert(repo, { at: '2026-05-08T11:59:59.999Z', summary: 'Too old' });
    insert(repo, { at: '2026-05-09T12:00:00.000Z', summary: 'At cutoff' });
    insert(repo, { at: '2026-08-07T11:00:00.000Z', summary: 'Recent' });

    createActivityLog({
      repo,
      retentionDays: 90,
      now: () => new Date('2026-08-07T12:00:00.000Z'),
    });

    const summaries = repo.listActivityEvents({ limit: 10 }).events.map((event) => event.summary);
    assert.deepEqual(summaries, ['Recent', 'At cutoff']);
  });
});

test('a tracked daily prune enforces retention without new writes and reads hide expired rows', () => {
  withRepository(({ repo }) => {
    let current = new Date('2026-08-07T12:00:00.000Z');
    let scheduled = null;
    const activity = createActivityLog({
      repo,
      now: () => current,
      setIntervalFn(callback, intervalMs) {
        scheduled = { callback, intervalMs };
      },
    });
    assert.equal(scheduled.intervalMs, 24 * 60 * 60 * 1000);

    // Model an expired row appearing after today's successful prune. Reads
    // enforce the cutoff even before the next physical-delete interval.
    insert(repo, { at: '2026-05-08T11:59:59.999Z', summary: 'Expired' });
    assert.deepEqual(activity.list().events, []);
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n, 1);

    // A quiet server receives no record() calls, but the lifecycle-owned
    // daily callback still physically removes the row as time advances.
    current = new Date('2026-08-08T12:00:00.000Z');
    scheduled.callback();
    assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM activity_log').get().n, 0);
  });
});

test('activity writes and retention pruning fail open', () => {
  const warnings = [];
  const activity = createActivityLog({
    repo: {
      pruneActivityEvents() {
        throw new Error('database unavailable');
      },
      recordActivityEvent() {
        throw new Error('database unavailable');
      },
    },
    logger: { warn: (message) => warnings.push(message) },
    now: () => new Date('2026-08-07T12:00:00.000Z'),
  });

  assert.equal(activity.systemStarted({ serverVersion: '1.0.0' }), false);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /retention prune failed/);
  assert.match(warnings[2], /write failed/);
});

test('lists filtered activity with stable keyset pagination and an honest cursor', () => {
  withRepository(({ repo }) => {
    insert(repo, { at: '2026-08-07T12:03:00.000Z', category: 'voice', type: 'voice.command', provider: 'openai', model: 'gpt-a', summary: 'Newest' });
    insert(repo, { at: '2026-08-07T12:02:00.000Z', category: 'voice', type: 'voice.command', provider: 'openai', model: 'gpt-b', summary: 'Same time A' });
    insert(repo, { at: '2026-08-07T12:02:00.000Z', category: 'voice', type: 'voice.command', provider: 'openai', model: 'gpt-b', summary: 'Same time B' });
    insert(repo, { at: '2026-08-07T12:01:00.000Z', category: 'system', type: 'system.test', summary: 'Oldest' });

    const first = repo.listActivityEvents({ limit: 2 });
    assert.deepEqual(first.events.map((event) => event.summary), ['Newest', 'Same time B']);
    assert.deepEqual(first.nextCursor, {
      at: '2026-08-07T12:02:00.000Z',
      id: first.events[1].id,
    });

    const second = repo.listActivityEvents({ limit: 2, before: first.nextCursor });
    assert.deepEqual(second.events.map((event) => event.summary), ['Same time A', 'Oldest']);
    assert.equal(second.nextCursor, null);

    const filtered = repo.listActivityEvents({
      category: 'voice',
      provider: 'openai',
      model: 'gpt-b',
      since: '2026-08-07T12:02:00.000Z',
      until: '2026-08-07T12:02:00.000Z',
    });
    assert.deepEqual(filtered.events.map((event) => event.summary), ['Same time B', 'Same time A']);
  });
});
