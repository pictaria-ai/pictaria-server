import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import test from 'node:test';

import { createFrameLedger } from '../../src/frame/ledger.mjs';
import {
  validateDisplayStatsRequest,
  validateRecordDisplaysRequest,
} from '../../src/frame/ledgerRequests.mjs';

test('creates private database state even under a permissive umask', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-frame-modes-'));
  const dbPath = join(dir, 'nested', 'frame.db');
  const previousUmask = process.umask(0);
  let ledger;
  try {
    ledger = createFrameLedger({ dbPath });
    assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700);
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    assert.equal(statSync(`${dbPath}-wal`).mode & 0o777, 0o600);
    assert.equal(statSync(`${dbPath}-shm`).mode & 0o777, 0o600);
  } finally {
    ledger?.close();
    process.umask(previousUmask);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('records display events and preserves first shown timestamps', () => {
  withLedger((ledger, db) => {
    ledger.recordDisplays(['asset-1', 'asset-1'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'));
    ledger.recordDisplays(['asset-1'], 'kitchen', new Date('2026-07-02T10:00:00.000Z'));

    const row = db.prepare('SELECT * FROM asset_displays WHERE asset_id = ? AND device_id = ?').get('asset-1', 'kitchen');
    assert.equal(row.display_count, 3);
    assert.equal(row.first_shown_at, '2026-07-01T10:00:00.000Z');
    assert.equal(row.last_shown_at, '2026-07-02T10:00:00.000Z');
  });
});

test('returns global display stats for mixed known and unknown assets', () => {
  withLedger((ledger) => {
    ledger.recordDisplays(['asset-1'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'));
    ledger.recordDisplays(['asset-1'], 'den', new Date('2026-07-03T10:00:00.000Z'));

    assert.deepEqual(ledger.getDisplayStats(['asset-1', 'asset-missing']), {
      'asset-1': {
        displayCount: 2,
        lastShownAt: '2026-07-03T10:00:00.000Z',
      },
    });
  });
});

test('chunks display stats lookups over 500 asset IDs', () => {
  withLedger((ledger) => {
    const ids = Array.from({ length: 650 }, (_, index) => `asset-${index}`);
    ledger.recordDisplays(['asset-0', 'asset-500', 'asset-649'], 'frame', new Date('2026-07-01T10:00:00.000Z'));

    const stats = ledger.getDisplayStats(ids);
    assert.equal(Object.keys(stats).length, 3);
    assert.equal(stats['asset-0'].displayCount, 1);
    assert.equal(stats['asset-500'].displayCount, 1);
    assert.equal(stats['asset-649'].displayCount, 1);
  });
});

test('summarizes global and per-device display counts', () => {
  withLedger((ledger) => {
    ledger.recordDisplays(['asset-1', 'asset-2'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'));
    ledger.recordDisplays(['asset-1'], 'den', new Date('2026-07-02T10:00:00.000Z'));

    const { retention, ...summary } = ledger.getLedgerSummary();
    assert.deepEqual(summary, {
      ledgerAvailable: true,
      distinctAssetsShown: 2,
      totalDisplays: 3,
      lastDisplayAt: '2026-07-02T10:00:00.000Z',
      devices: [
        {
          deviceId: 'den',
          distinctAssetsShown: 1,
          totalDisplays: 1,
          lastDisplayAt: '2026-07-02T10:00:00.000Z',
        },
        {
          deviceId: 'kitchen',
          distinctAssetsShown: 2,
          totalDisplays: 2,
          lastDisplayAt: '2026-07-01T10:00:00.000Z',
        },
      ],
    });
    assert.equal(retention.displayRows, 3);
    assert.ok(retention.displayBytes > 0);
    assert.equal(retention.prunedDisplays, 0);
  });
});

test('topShown ranks assets by summed display count across devices', () => {
  withLedger((ledger) => {
    ledger.recordDisplays(['a', 'b'], 'frame', new Date('2026-01-01T10:00:00Z'));
    ledger.recordDisplays(['b'], 'tablet', new Date('2026-01-02T10:00:00Z'));
    ledger.recordDisplays(['b', 'c'], 'frame', new Date('2026-01-03T10:00:00Z'));

    const top = ledger.topShown(2);
    assert.equal(top.length, 2);
    assert.deepEqual(top[0], { assetId: 'b', displayCount: 3, lastShownAt: '2026-01-03T10:00:00.000Z' });
    assert.equal(top[1].displayCount, 1);
    // A bogus limit falls back to the default (12) rather than exploding.
    assert.equal(ledger.topShown(0).length, 3);
  });
});

test('validates frame display record requests', () => {
  assert.deepEqual(validateRecordDisplaysRequest({ assetIds: [' a ', 'a'], deviceId: 'Kitchen-1' }), {
    value: {
      assetIds: ['a', 'a'],
      deviceId: 'kitchen-1',
      shownAt: undefined,
      reportId: null,
    },
  });
  assert.deepEqual(validateRecordDisplaysRequest({ assetIds: [] }), {
    error: 'assetIds must be a non-empty array.',
  });
  assert.deepEqual(validateRecordDisplaysRequest({ assetIds: ['a'], deviceId: 'Kitchen One' }), {
    error: 'Device ID must be a slug with letters, numbers, or hyphens.',
  });
  assert.deepEqual(
    validateRecordDisplaysRequest({ assetIds: ['a'], reportId: '3e6c1b9a-2f4d-4e8a-9c7b-1d2e3f4a5b6c' }).value.reportId,
    '3e6c1b9a-2f4d-4e8a-9c7b-1d2e3f4a5b6c',
  );
  assert.deepEqual(validateRecordDisplaysRequest({ assetIds: ['a'], reportId: 'nope!' }), {
    error: 'reportId must be 8-64 characters of letters, numbers, or hyphens.',
  });
});

test('replaying a display report with the same reportId is a no-op', () => {
  withLedger((ledger) => {
    const first = ledger.recordDisplays(['asset-1', 'asset-2'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'), 'report-aaaa-1111');
    assert.deepEqual(first, { recorded: 2, duplicate: false });

    // Same batch again — as after a lost response and outbox retry.
    const replay = ledger.recordDisplays(['asset-1', 'asset-2'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'), 'report-aaaa-1111');
    assert.deepEqual(replay, { recorded: 0, duplicate: true });

    const stats = ledger.getDisplayStats(['asset-1', 'asset-2']);
    assert.equal(stats['asset-1'].displayCount, 1);
    assert.equal(stats['asset-2'].displayCount, 1);

    // A different batch id still counts, and legacy reports without an id
    // keep the old always-count behavior.
    ledger.recordDisplays(['asset-1'], 'kitchen', new Date('2026-07-01T11:00:00.000Z'), 'report-bbbb-2222');
    ledger.recordDisplays(['asset-1'], 'kitchen', new Date('2026-07-01T12:00:00.000Z'));
    assert.equal(ledger.getDisplayStats(['asset-1'])['asset-1'].displayCount, 3);
  });
});

test('validates frame display stats requests', () => {
  assert.deepEqual(validateDisplayStatsRequest({ assetIds: ['asset-1'] }), {
    value: {
      assetIds: ['asset-1'],
    },
  });
  assert.deepEqual(validateDisplayStatsRequest({ assetIds: Array.from({ length: 1001 }, (_, index) => `asset-${index}`) }), {
    error: 'assetIds must contain 1000 or fewer entries.',
  });
});

test('deleteDeviceDisplays erases one device without touching the others', () => {
  withLedger((ledger) => {
    ledger.recordDisplays(['asset-1', 'asset-2'], 'kitchen', new Date('2026-07-01T10:00:00.000Z'));
    ledger.recordDisplays(['asset-1'], 'retired', new Date('2026-07-02T10:00:00.000Z'));

    assert.equal(ledger.deleteDeviceDisplays('retired'), 1);
    assert.equal(ledger.deleteDeviceDisplays('retired'), 0);

    const summary = ledger.getLedgerSummary();
    assert.deepEqual(summary.devices.map((device) => device.deviceId), ['kitchen']);
    assert.equal(summary.totalDisplays, 2);
  });
});

test('recordDisplays occasionally prunes expired idempotency keys', () => {
  withLedger((ledger, db) => {
    // Planted AFTER the startup prune, as if the process had been running
    // for months: only the piggybacked prune can remove it.
    db.prepare('INSERT INTO accepted_display_reports (report_id, received_at) VALUES (?, ?)').run(
      'stale-report',
      new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const staleQuery = db.prepare('SELECT 1 AS present FROM accepted_display_reports WHERE report_id = ?');

    ledger.recordDisplays(['asset-1'], 'kitchen', new Date(), 'fresh-report');
    assert.ok(staleQuery.get('stale-report'), 'one call must not prune yet');

    for (let call = 0; call < 200; call += 1) {
      ledger.recordDisplays(['asset-1'], 'kitchen', new Date());
    }

    assert.equal(staleQuery.get('stale-report'), undefined);
    assert.ok(staleQuery.get('fresh-report'), 'keys inside the retention window survive');
  });
});

test('enforces per-device and global display row ceilings oldest-first', () => {
  withLedger((ledger, db) => {
    ledger.recordDisplays(['a1'], 'kitchen', new Date('2026-01-01T00:00:00Z'));
    ledger.recordDisplays(['a2'], 'kitchen', new Date('2026-01-02T00:00:00Z'));
    ledger.recordDisplays(['a3'], 'kitchen', new Date('2026-01-03T00:00:00Z'));
    assert.deepEqual(
      db.prepare("SELECT asset_id FROM asset_displays WHERE device_id = 'kitchen' ORDER BY asset_id").all().map((row) => row.asset_id),
      ['a2', 'a3'],
    );

    ledger.recordDisplays(['b1'], 'den', new Date('2026-01-04T00:00:00Z'));
    ledger.recordDisplays(['b2'], 'den', new Date('2026-01-05T00:00:00Z'));
    assert.deepEqual(
      db.prepare('SELECT asset_id FROM asset_displays ORDER BY last_shown_at').all().map((row) => row.asset_id),
      ['a3', 'b1', 'b2'],
    );
    const retention = ledger.getLedgerSummary().retention;
    assert.equal(retention.displayRows, 3);
    assert.equal(retention.prunedDisplays, 2);
  }, {
    retention: {
      maxDisplayRowsPerDevice: 2,
      maxDisplayBytesPerDevice: 10_000,
      maxDisplayRows: 3,
      maxDisplayBytes: 10_000,
    },
    now: () => new Date('2026-01-06T00:00:00Z'),
  });
});

test('enforces logical display and retry-report byte and item ceilings', () => {
  withLedger((ledger, db) => {
    ledger.recordDisplays(['a1'], 'frame', new Date('2026-01-01T00:00:00Z'), 'report-0001');
    ledger.recordDisplays(['a2'], 'frame', new Date('2026-01-02T00:00:00Z'), 'report-0002');
    ledger.recordDisplays(['a3'], 'frame', new Date('2026-01-03T00:00:00Z'), 'report-0003');

    const summary = ledger.getLedgerSummary().retention;
    assert.ok(summary.displayBytes <= 250);
    assert.ok(summary.displayRows <= 2);
    assert.equal(summary.reportRows, 2);
    assert.equal(summary.prunedReports, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accepted_display_reports').get().count, 2);
  }, {
    retention: {
      maxDisplayRowsPerDevice: 10,
      maxDisplayBytesPerDevice: 250,
      maxDisplayRows: 10,
      maxDisplayBytes: 250,
      maxReportRows: 2,
      maxReportBytes: 10_000,
    },
    now: () => new Date('2026-01-04T00:00:00Z'),
  });
});

test('age pruning removes delayed stale rows and display timestamps stay monotonic', () => {
  let current = new Date('2026-02-01T00:00:00Z');
  withLedger((ledger, db) => {
    ledger.recordDisplays(['stale'], 'frame', new Date('2025-01-01T00:00:00Z'));
    ledger.recordDisplays(['same'], 'frame', new Date('2026-01-31T12:00:00Z'));
    ledger.recordDisplays(['same'], 'frame', new Date('2026-01-20T12:00:00Z'));
    const same = db.prepare("SELECT * FROM asset_displays WHERE asset_id = 'same'").get();
    assert.equal(same.first_shown_at, '2026-01-20T12:00:00.000Z');
    assert.equal(same.last_shown_at, '2026-01-31T12:00:00.000Z');

    current = new Date('2026-02-02T00:00:00Z');
    ledger.recordDisplays(['fresh'], 'frame', current);
    assert.equal(db.prepare("SELECT 1 FROM asset_displays WHERE asset_id = 'stale'").get(), undefined);
  }, {
    retention: { displayRetentionMs: 30 * 24 * 60 * 60 * 1000 },
    now: () => current,
  });
});

test('startup reconciliation bounds restored ledger rows without touching shared voice state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pictaria-frame-restore-'));
  const dbPath = join(directory, 'frame.db');
  const backupPath = join(directory, 'frame-backup.db');
  const warnings = [];
  let ledger;
  try {
    ledger = createFrameLedger({ dbPath, now: () => new Date('2026-03-01T00:00:00Z') });
    for (let index = 0; index < 5; index += 1) {
      ledger.recordDisplays([`asset-${index}`], 'frame', new Date(`2026-02-0${index + 1}T00:00:00Z`));
    }
    ledger.close();

    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE voice_command_stats (device_id TEXT, label TEXT, uses INTEGER, last_used_at TEXT)');
    seed.prepare('INSERT INTO voice_command_stats VALUES (?, ?, ?, ?)').run('frame', 'next', 3, '2026-02-28T00:00:00Z');
    seed.close();

    ledger = createFrameLedger({
      dbPath,
      logger: { warn: (message) => warnings.push(message) },
      retention: {
        maxDisplayRowsPerDevice: 2,
        maxDisplayBytesPerDevice: 10_000,
        maxDisplayRows: 2,
        maxDisplayBytes: 10_000,
      },
      now: () => new Date('2026-03-01T00:00:00Z'),
    });
    assert.equal(ledger.getLedgerSummary().retention.displayRows, 2);
    assert.deepEqual(warnings, [
      '[Pictaria] Display ledger startup reconciliation pruned 3 display row(s) and 0 retry report row(s).',
    ]);

    ledger.close();
    ledger = null;
    warnings.length = 0;
    ledger = createFrameLedger({
      dbPath,
      logger: { warn: (message) => warnings.push(message) },
      retention: {
        maxDisplayRowsPerDevice: 2,
        maxDisplayBytesPerDevice: 10_000,
        maxDisplayRows: 2,
        maxDisplayBytes: 10_000,
      },
      now: () => new Date('2026-03-01T00:00:00Z'),
    });
    assert.deepEqual(warnings, [], 'historical prune counters do not repeat startup warnings');

    const source = new DatabaseSync(dbPath, { readOnly: true });
    await sqliteBackup(source, backupPath);
    source.close();
    const restored = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(restored.prepare('SELECT COUNT(*) AS count FROM asset_displays').get().count, 2);
    assert.equal(restored.prepare('SELECT uses FROM voice_command_stats').get().uses, 3);
    restored.close();
  } finally {
    ledger?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects display timestamps more than 24 hours in the future', () => {
  assert.deepEqual(
    validateRecordDisplaysRequest({ assetIds: ['a'], shownAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString() }),
    { error: 'shownAt cannot be more than 24 hours in the future.' },
  );
});

function withLedger(callback, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'photo-frame-ledger-'));
  const ledger = createFrameLedger({
    dbPath: join(directory, 'frame.db'),
    logger: { warn() {} },
    ...options,
  });
  const db = new DatabaseSync(join(directory, 'frame.db'));

  try {
    callback(ledger, db);
  } finally {
    db.close();
    ledger.close();
    rmSync(directory, { force: true, recursive: true });
  }
}
