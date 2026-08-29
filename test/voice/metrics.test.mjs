import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createVoiceMetrics } from '../../src/voice/metrics.mjs';

function withMetrics(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'pictaria-voice-metrics-'));
  const metrics = createVoiceMetrics({
    dbPath: join(directory, 'frame.db'),
    logger: { warn() {} },
  });
  try {
    callback(metrics);
  } finally {
    metrics.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test('counts command labels with last-used timestamps, never transcripts', () => {
  withMetrics((metrics) => {
    metrics.record('next', { usedAt: new Date('2026-01-01T10:00:00Z') });
    metrics.record('next', { usedAt: new Date('2026-01-02T10:00:00Z') });
    metrics.record('favorite', { usedAt: new Date('2026-01-01T12:00:00Z') });
    metrics.record('unknown', { usedAt: new Date('2026-01-01T13:00:00Z') });
    metrics.record('', { usedAt: new Date() }); // blank labels are dropped
    metrics.record(null);

    const summary = metrics.summary();
    assert.equal(summary.available, true);
    assert.equal(summary.totalUses, 4);
    assert.deepEqual(summary.commands[0], {
      label: 'next',
      uses: 2,
      lastUsedAt: '2026-01-02T10:00:00.000Z',
    });
    assert.deepEqual(summary.commands.map((row) => row.label), ['next', 'favorite', 'unknown']);
  });
});

test('breaks counts down by device: all-devices aggregate, per-device filter, unattributed bucket', () => {
  withMetrics((metrics) => {
    metrics.record('next', { deviceId: 'kitchen', usedAt: new Date('2026-07-01T10:00:00Z') });
    metrics.record('next', { deviceId: 'kitchen', usedAt: new Date('2026-07-02T10:00:00Z') });
    metrics.record('next', { deviceId: 'hallway', usedAt: new Date('2026-07-03T10:00:00Z') });
    metrics.record('favorite', { deviceId: 'hallway', usedAt: new Date('2026-07-01T11:00:00Z') });
    metrics.record('tell', { usedAt: new Date('2026-07-01T12:00:00Z') }); // no device → unattributed

    const all = metrics.summary();
    assert.equal(all.totalUses, 5);
    assert.deepEqual(all.commands[0], { label: 'next', uses: 3, lastUsedAt: '2026-07-03T10:00:00.000Z' });
    assert.deepEqual(
      all.devices.map((d) => [d.deviceId, d.uses]),
      [['hallway', 2], ['kitchen', 2], ['', 1]],
    );

    const kitchen = metrics.summary('kitchen');
    assert.equal(kitchen.totalUses, 2);
    assert.deepEqual(kitchen.commands.map((c) => c.label), ['next']);
    assert.equal(kitchen.devices.length, 3); // device list stays complete under a filter

    const unattributed = metrics.summary('');
    assert.equal(unattributed.totalUses, 1);
    assert.deepEqual(unattributed.commands.map((c) => c.label), ['tell']);
  });
});

test('migrates the legacy label-only table into the unattributed bucket, preserving counts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pictaria-voice-metrics-'));
  const dbPath = join(directory, 'frame.db');
  try {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE voice_command_stats (
        label        TEXT PRIMARY KEY,
        uses         INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL
      );
      INSERT INTO voice_command_stats VALUES ('next', 7, '2026-06-01T10:00:00.000Z');
      INSERT INTO voice_command_stats VALUES ('tell', 2, '2026-06-02T10:00:00.000Z');
    `);
    legacy.close();

    const metrics = createVoiceMetrics({ dbPath, logger: { warn() {} } });
    try {
      const summary = metrics.summary();
      assert.equal(summary.totalUses, 9);
      assert.deepEqual(summary.devices, [{ deviceId: '', uses: 9, lastUsedAt: '2026-06-02T10:00:00.000Z' }]);
      // New per-device counts land beside the migrated history.
      metrics.record('next', { deviceId: 'kitchen', usedAt: new Date('2026-07-01T10:00:00Z') });
      assert.equal(metrics.summary('kitchen').totalUses, 1);
      assert.equal(metrics.summary().totalUses, 10);
    } finally {
      metrics.close();
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('deleting a device purges its counts but never the unattributed bucket', () => {
  withMetrics((metrics) => {
    metrics.record('next', { deviceId: 'kitchen', usedAt: new Date('2026-07-01T10:00:00Z') });
    metrics.record('next', { deviceId: 'kitchen', usedAt: new Date('2026-07-02T10:00:00Z') });
    metrics.record('tell', { usedAt: new Date('2026-07-01T12:00:00Z') });

    assert.equal(metrics.deleteDevice('kitchen'), 2);
    assert.equal(metrics.deleteDevice('kitchen'), 0); // already gone
    assert.equal(metrics.deleteDevice(''), 0); // blank id refused
    const summary = metrics.summary();
    assert.equal(summary.totalUses, 1);
    assert.deepEqual(summary.devices.map((d) => d.deviceId), ['']);
  });
});

test('degrades to a noop store when the database cannot open', () => {
  const metrics = createVoiceMetrics({ dbPath: '/dev/null/nope/frame.db', logger: { warn() {} } });
  assert.equal(metrics.available, false);
  metrics.record('next');
  assert.equal(metrics.deleteDevice('kitchen'), 0);
  assert.deepEqual(metrics.summary(), { available: false, totalUses: 0, commands: [], devices: [] });
  metrics.close();
});
