import { DatabaseSync } from 'node:sqlite';

import { preparePrivateDatabasePath, restrictPrivateDatabaseModes } from '../privateDatabase.mjs';

const DEFAULT_FRAME_DB_PATH = './data/frame.db';
const DISPLAY_STATS_CHUNK_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const PRUNE_BATCH_SIZE = 1_000;
const DISPLAY_ROW_OVERHEAD_BYTES = 64;
const REPORT_ROW_OVERHEAD_BYTES = 32;
const MAX_SHOWN_AT_FUTURE_MS = DAY_MS;

const DEFAULT_RETENTION = Object.freeze({
  displayRetentionMs: 1_825 * DAY_MS,
  maxDisplayRowsPerDevice: 500_000,
  maxDisplayBytesPerDevice: 128 * 1024 * 1024,
  maxDisplayRows: 500_000,
  maxDisplayBytes: 128 * 1024 * 1024,
  reportRetentionMs: 90 * DAY_MS,
  maxReportRows: 100_000,
  maxReportBytes: 16 * 1024 * 1024,
});

// Hard row/byte ceilings are checked on every write; indexed age pruning
// piggybacks periodically so expired rows cannot accumulate indefinitely.
const PRUNE_EVERY_RECORD_CALLS = 200;
const PRUNE_MIN_INTERVAL_MS = DAY_MS;

export const DEFAULT_FRAME_DEVICE_ID = 'frame';

export function createFrameLedger({
  dbPath = process.env.FRAME_DB_PATH || DEFAULT_FRAME_DB_PATH,
  logger = console,
  retention = {},
  now = () => new Date(),
} = {}) {
  let db;
  const limits = normalizeRetention(retention);

  try {
    preparePrivateDatabasePath(dbPath, logger);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    restrictPrivateDatabaseModes(dbPath, logger);
    db.exec(`
      CREATE TABLE IF NOT EXISTS asset_displays (
        asset_id       TEXT NOT NULL,
        device_id      TEXT NOT NULL DEFAULT 'frame',
        display_count  INTEGER NOT NULL DEFAULT 0,
        first_shown_at TEXT NOT NULL,
        last_shown_at  TEXT NOT NULL,
        PRIMARY KEY (asset_id, device_id)
      );
      CREATE INDEX IF NOT EXISTS asset_displays_retention_idx
        ON asset_displays (last_shown_at, asset_id, device_id);
      CREATE INDEX IF NOT EXISTS asset_displays_device_retention_idx
        ON asset_displays (device_id, last_shown_at, asset_id);

      CREATE TABLE IF NOT EXISTS accepted_display_reports (
        report_id   TEXT PRIMARY KEY,
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS accepted_display_reports_retention_idx
        ON accepted_display_reports (received_at, report_id);

      -- Logical usage counters keep every-write ceiling checks cheap. They
      -- describe only ledger rows, not frame.db, which also owns voice data.
      CREATE TABLE IF NOT EXISTS frame_ledger_retention (
        singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
        display_rows    INTEGER NOT NULL,
        display_bytes   INTEGER NOT NULL,
        report_rows     INTEGER NOT NULL,
        report_bytes    INTEGER NOT NULL,
        pruned_displays INTEGER NOT NULL DEFAULT 0,
        pruned_reports  INTEGER NOT NULL DEFAULT 0,
        last_pruned_at  TEXT
      );
      CREATE TABLE IF NOT EXISTS frame_ledger_device_usage (
        device_id     TEXT PRIMARY KEY,
        display_rows  INTEGER NOT NULL,
        display_bytes INTEGER NOT NULL
      );
    `);
    const reconciliation = reconcileRestoredLedger(db, limits, normalizeNow(now()));
    if (reconciliation.prunedDisplays > 0 || reconciliation.prunedReports > 0) {
      logger.warn?.(
        '[Pictaria] Display ledger startup reconciliation pruned '
        + `${reconciliation.prunedDisplays} display row(s) and `
        + `${reconciliation.prunedReports} retry report row(s).`,
      );
    }
  } catch (error) {
    logger.warn?.(
      `[Pictaria] Display ledger unavailable; continuing without persistent display memory. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    try {
      db?.close();
    } catch {
      // already closed or never opened
    }
    return createNoopFrameLedger(limits);
  }

  let recordCallsSincePrune = 0;
  let lastPrunedAt = Date.parse(readRetentionState(db).last_pruned_at) || normalizeNow(now()).getTime();
  const insertDisplay = db.prepare(`
    INSERT OR IGNORE INTO asset_displays
      (asset_id, device_id, display_count, first_shown_at, last_shown_at)
    VALUES (?, ?, 1, ?, ?)
  `);
  const updateDisplay = db.prepare(`
    UPDATE asset_displays SET
      display_count = display_count + 1,
      first_shown_at = MIN(first_shown_at, ?),
      last_shown_at = MAX(last_shown_at, ?)
    WHERE asset_id = ? AND device_id = ?
  `);

  return {
    available: true,
    close() {
      db.close();
    },
    getDisplayStats(assetIds) {
      const stats = {};
      const uniqueIds = dedupeStrings(assetIds);
      for (let index = 0; index < uniqueIds.length; index += DISPLAY_STATS_CHUNK_SIZE) {
        const chunk = uniqueIds.slice(index, index + DISPLAY_STATS_CHUNK_SIZE);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = db.prepare(`
          SELECT asset_id, SUM(display_count) AS display_count, MAX(last_shown_at) AS last_shown_at
          FROM asset_displays WHERE asset_id IN (${placeholders}) GROUP BY asset_id
        `).all(...chunk);
        for (const row of rows) {
          stats[row.asset_id] = {
            displayCount: Number(row.display_count) || 0,
            lastShownAt: row.last_shown_at,
          };
        }
      }
      return stats;
    },
    topShown(limit = 12) {
      return db.prepare(`
        SELECT asset_id, SUM(display_count) AS display_count, MAX(last_shown_at) AS last_shown_at
        FROM asset_displays GROUP BY asset_id
        ORDER BY display_count DESC, last_shown_at DESC LIMIT ?
      `).all(Math.max(1, Math.min(100, Number(limit) || 12))).map((row) => ({
        assetId: row.asset_id,
        displayCount: Number(row.display_count) || 0,
        lastShownAt: row.last_shown_at,
      }));
    },
    getLedgerSummary() {
      const global = db.prepare(`
        SELECT COUNT(DISTINCT asset_id) AS distinct_assets_shown,
          COALESCE(SUM(display_count), 0) AS total_displays,
          MAX(last_shown_at) AS last_display_at
        FROM asset_displays
      `).get();
      const devices = db.prepare(`
        SELECT device_id, COUNT(*) AS distinct_assets_shown,
          COALESCE(SUM(display_count), 0) AS total_displays,
          MAX(last_shown_at) AS last_display_at
        FROM asset_displays GROUP BY device_id ORDER BY device_id
      `).all();
      return {
        ledgerAvailable: true,
        distinctAssetsShown: Number(global.distinct_assets_shown) || 0,
        totalDisplays: Number(global.total_displays) || 0,
        lastDisplayAt: global.last_display_at ?? null,
        devices: devices.map((device) => ({
          deviceId: device.device_id,
          distinctAssetsShown: Number(device.distinct_assets_shown) || 0,
          totalDisplays: Number(device.total_displays) || 0,
          lastDisplayAt: device.last_display_at ?? null,
        })),
        retention: retentionSummary(readRetentionState(db), limits),
      };
    },
    deleteDeviceDisplays(deviceId) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const usage = db.prepare(`
          SELECT COUNT(*) AS rows, COALESCE(SUM(${displayBytesSql()}), 0) AS bytes
          FROM asset_displays WHERE device_id = ?
        `).get(deviceId);
        const result = db.prepare('DELETE FROM asset_displays WHERE device_id = ?').run(deviceId);
        db.prepare('DELETE FROM frame_ledger_device_usage WHERE device_id = ?').run(deviceId);
        db.prepare(`
          UPDATE frame_ledger_retention SET
            display_rows = MAX(0, display_rows - ?),
            display_bytes = MAX(0, display_bytes - ?)
          WHERE singleton = 1
        `).run(Number(usage.rows) || 0, Number(usage.bytes) || 0);
        db.exec('COMMIT');
        return Number(result.changes) || 0;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    recordDisplays(assetIds, deviceId = DEFAULT_FRAME_DEVICE_ID, shownAt = new Date(), reportId = null) {
      const current = normalizeNow(now());
      const shownAtIso = normalizeShownAt(shownAt, current);
      recordCallsSincePrune += 1;
      const agePruneDue = recordCallsSincePrune >= PRUNE_EVERY_RECORD_CALLS
        || current.getTime() - lastPrunedAt >= PRUNE_MIN_INTERVAL_MS;

      db.exec('BEGIN IMMEDIATE');
      try {
        if (reportId) {
          const receivedAt = current.toISOString();
          const claimed = db.prepare(`
            INSERT OR IGNORE INTO accepted_display_reports (report_id, received_at) VALUES (?, ?)
          `).run(reportId, receivedAt);
          if (Number(claimed.changes) === 0) {
            if (agePruneDue) {
              pruneExpiredRows(db, limits, current);
              recordCallsSincePrune = 0;
              lastPrunedAt = current.getTime();
            }
            db.exec('COMMIT');
            return { recorded: 0, duplicate: true };
          }
          incrementReportUsage(db, reportEntryBytes(reportId, receivedAt));
        }

        ensureDeviceUsage(db, deviceId);
        for (const assetId of assetIds) {
          const inserted = insertDisplay.run(assetId, deviceId, shownAtIso, shownAtIso);
          if (Number(inserted.changes) > 0) {
            incrementDisplayUsage(db, deviceId, displayEntryBytes({
              asset_id: assetId,
              device_id: deviceId,
              first_shown_at: shownAtIso,
              last_shown_at: shownAtIso,
            }));
          } else {
            updateDisplay.run(shownAtIso, shownAtIso, assetId, deviceId);
          }
        }

        pruneDisplayScope(db, limits, deviceId);
        pruneDisplayScope(db, limits, null);
        pruneReportScope(db, limits);
        if (agePruneDue) {
          pruneExpiredRows(db, limits, current);
          recordCallsSincePrune = 0;
          lastPrunedAt = current.getTime();
        }
        db.exec('COMMIT');
        return { recorded: assetIds.length, duplicate: false };
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function reconcileRestoredLedger(db, limits, current) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const prior = db.prepare(`
      SELECT pruned_displays, pruned_reports FROM frame_ledger_retention WHERE singleton = 1
    `).get() ?? {};
    const nowIso = current.toISOString();
    const futureCutoff = new Date(current.getTime() + MAX_SHOWN_AT_FUTURE_MS).toISOString();
    db.prepare('UPDATE asset_displays SET last_shown_at = ? WHERE last_shown_at > ?').run(nowIso, futureCutoff);
    db.prepare('UPDATE asset_displays SET first_shown_at = last_shown_at WHERE first_shown_at > last_shown_at').run();

    const display = db.prepare(`
      SELECT COUNT(*) AS rows, COALESCE(SUM(${displayBytesSql()}), 0) AS bytes FROM asset_displays
    `).get();
    const reports = db.prepare(`
      SELECT COUNT(*) AS rows, COALESCE(SUM(${reportBytesSql()}), 0) AS bytes FROM accepted_display_reports
    `).get();
    db.prepare(`
      INSERT OR REPLACE INTO frame_ledger_retention (
        singleton, display_rows, display_bytes, report_rows, report_bytes,
        pruned_displays, pruned_reports, last_pruned_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Number(display.rows) || 0,
      Number(display.bytes) || 0,
      Number(reports.rows) || 0,
      Number(reports.bytes) || 0,
      Number(prior.pruned_displays) || 0,
      Number(prior.pruned_reports) || 0,
      nowIso,
    );

    // Global limits run first, bounding all later per-device grouping work.
    pruneExpiredRows(db, limits, current, { updateDeviceUsage: false });
    pruneDisplayScope(db, limits, null, { updateDeviceUsage: false });
    rebuildDeviceUsage(db);
    for (const device of db.prepare(`
      SELECT device_id FROM frame_ledger_device_usage
      WHERE display_rows > ? OR display_bytes > ?
    `).all(limits.maxDisplayRowsPerDevice, limits.maxDisplayBytesPerDevice)) {
      pruneDisplayScope(db, limits, device.device_id);
    }
    pruneReportScope(db, limits);
    db.prepare('UPDATE frame_ledger_retention SET last_pruned_at = ? WHERE singleton = 1').run(nowIso);
    const after = db.prepare(`
      SELECT pruned_displays, pruned_reports FROM frame_ledger_retention WHERE singleton = 1
    `).get();
    db.exec('COMMIT');
    return {
      prunedDisplays: Math.max(
        0,
        (Number(after.pruned_displays) || 0) - (Number(prior.pruned_displays) || 0),
      ),
      prunedReports: Math.max(
        0,
        (Number(after.pruned_reports) || 0) - (Number(prior.pruned_reports) || 0),
      ),
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function pruneExpiredRows(db, limits, current, { updateDeviceUsage = true } = {}) {
  const displayCutoff = new Date(current.getTime() - limits.displayRetentionMs).toISOString();
  while (true) {
    const rows = db.prepare(`
      SELECT rowid, device_id, ${displayBytesSql()} AS logical_bytes
      FROM asset_displays WHERE last_shown_at < ?
      ORDER BY last_shown_at, rowid LIMIT ?
    `).all(displayCutoff, PRUNE_BATCH_SIZE);
    if (rows.length === 0) break;
    deleteDisplayRows(db, rows, { updateDeviceUsage });
  }

  const reportCutoff = new Date(current.getTime() - limits.reportRetentionMs).toISOString();
  while (true) {
    const rows = db.prepare(`
      SELECT rowid, ${reportBytesSql()} AS logical_bytes
      FROM accepted_display_reports WHERE received_at < ?
      ORDER BY received_at, rowid LIMIT ?
    `).all(reportCutoff, PRUNE_BATCH_SIZE);
    if (rows.length === 0) break;
    deleteReportRows(db, rows);
  }
  db.prepare('UPDATE frame_ledger_retention SET last_pruned_at = ? WHERE singleton = 1').run(current.toISOString());
}

function pruneDisplayScope(db, limits, deviceId, { updateDeviceUsage = true } = {}) {
  const usage = deviceId === null
    ? readRetentionState(db)
    : db.prepare('SELECT display_rows, display_bytes FROM frame_ledger_device_usage WHERE device_id = ?').get(deviceId);
  if (!usage) return;
  const maxRows = deviceId === null ? limits.maxDisplayRows : limits.maxDisplayRowsPerDevice;
  const maxBytes = deviceId === null ? limits.maxDisplayBytes : limits.maxDisplayBytesPerDevice;
  let rowExcess = Math.max(0, Number(usage.display_rows) - maxRows);
  let byteExcess = Math.max(0, Number(usage.display_bytes) - maxBytes);

  while (rowExcess > 0 || byteExcess > 0) {
    const rows = db.prepare(`
      SELECT rowid, device_id, ${displayBytesSql()} AS logical_bytes
      FROM asset_displays ${deviceId === null ? '' : 'WHERE device_id = ?'}
      ORDER BY last_shown_at, rowid LIMIT ?
    `).all(...(deviceId === null ? [PRUNE_BATCH_SIZE] : [deviceId, PRUNE_BATCH_SIZE]));
    const selected = selectEnoughRows(rows, rowExcess, byteExcess);
    if (selected.length === 0) break;
    const removedBytes = selected.reduce((sum, row) => sum + Number(row.logical_bytes), 0);
    deleteDisplayRows(db, selected, { updateDeviceUsage });
    rowExcess = Math.max(0, rowExcess - selected.length);
    byteExcess = Math.max(0, byteExcess - removedBytes);
  }
}

function pruneReportScope(db, limits) {
  const usage = readRetentionState(db);
  let rowExcess = Math.max(0, Number(usage.report_rows) - limits.maxReportRows);
  let byteExcess = Math.max(0, Number(usage.report_bytes) - limits.maxReportBytes);
  while (rowExcess > 0 || byteExcess > 0) {
    const rows = db.prepare(`
      SELECT rowid, ${reportBytesSql()} AS logical_bytes
      FROM accepted_display_reports ORDER BY received_at, rowid LIMIT ?
    `).all(PRUNE_BATCH_SIZE);
    const selected = selectEnoughRows(rows, rowExcess, byteExcess);
    if (selected.length === 0) break;
    const removedBytes = selected.reduce((sum, row) => sum + Number(row.logical_bytes), 0);
    deleteReportRows(db, selected);
    rowExcess = Math.max(0, rowExcess - selected.length);
    byteExcess = Math.max(0, byteExcess - removedBytes);
  }
}

function selectEnoughRows(rows, rowExcess, byteExcess) {
  const selected = [];
  let bytes = 0;
  for (const row of rows) {
    selected.push(row);
    bytes += Number(row.logical_bytes) || 0;
    if (selected.length >= rowExcess && bytes >= byteExcess) break;
  }
  return selected;
}

function deleteDisplayRows(db, rows, { updateDeviceUsage = true } = {}) {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => '?').join(', ');
  db.prepare(`DELETE FROM asset_displays WHERE rowid IN (${placeholders})`).run(...rows.map((row) => row.rowid));
  const removedBytes = rows.reduce((sum, row) => sum + Number(row.logical_bytes), 0);
  db.prepare(`
    UPDATE frame_ledger_retention SET
      display_rows = MAX(0, display_rows - ?),
      display_bytes = MAX(0, display_bytes - ?),
      pruned_displays = pruned_displays + ? WHERE singleton = 1
  `).run(rows.length, removedBytes, rows.length);
  if (!updateDeviceUsage) return;

  const perDevice = new Map();
  for (const row of rows) {
    const usage = perDevice.get(row.device_id) ?? { rows: 0, bytes: 0 };
    usage.rows += 1;
    usage.bytes += Number(row.logical_bytes) || 0;
    perDevice.set(row.device_id, usage);
  }
  for (const [deviceId, usage] of perDevice) {
    db.prepare(`
      UPDATE frame_ledger_device_usage SET
        display_rows = MAX(0, display_rows - ?),
        display_bytes = MAX(0, display_bytes - ?) WHERE device_id = ?
    `).run(usage.rows, usage.bytes, deviceId);
    db.prepare('DELETE FROM frame_ledger_device_usage WHERE device_id = ? AND display_rows = 0').run(deviceId);
  }
}

function deleteReportRows(db, rows) {
  if (rows.length === 0) return;
  const placeholders = rows.map(() => '?').join(', ');
  db.prepare(`DELETE FROM accepted_display_reports WHERE rowid IN (${placeholders})`).run(...rows.map((row) => row.rowid));
  const removedBytes = rows.reduce((sum, row) => sum + Number(row.logical_bytes), 0);
  db.prepare(`
    UPDATE frame_ledger_retention SET
      report_rows = MAX(0, report_rows - ?),
      report_bytes = MAX(0, report_bytes - ?),
      pruned_reports = pruned_reports + ? WHERE singleton = 1
  `).run(rows.length, removedBytes, rows.length);
}

function rebuildDeviceUsage(db) {
  db.prepare('DELETE FROM frame_ledger_device_usage').run();
  const insert = db.prepare(`
    INSERT INTO frame_ledger_device_usage (device_id, display_rows, display_bytes) VALUES (?, ?, ?)
  `);
  for (const row of db.prepare(`
    SELECT device_id, COUNT(*) AS rows, COALESCE(SUM(${displayBytesSql()}), 0) AS bytes
    FROM asset_displays GROUP BY device_id
  `).iterate()) {
    insert.run(row.device_id, Number(row.rows) || 0, Number(row.bytes) || 0);
  }
}

function ensureDeviceUsage(db, deviceId) {
  db.prepare(`
    INSERT OR IGNORE INTO frame_ledger_device_usage (device_id, display_rows, display_bytes)
    VALUES (?, 0, 0)
  `).run(deviceId);
}

function incrementDisplayUsage(db, deviceId, bytes) {
  db.prepare(`
    UPDATE frame_ledger_device_usage SET display_rows = display_rows + 1, display_bytes = display_bytes + ?
    WHERE device_id = ?
  `).run(bytes, deviceId);
  db.prepare(`
    UPDATE frame_ledger_retention SET display_rows = display_rows + 1, display_bytes = display_bytes + ?
    WHERE singleton = 1
  `).run(bytes);
}

function incrementReportUsage(db, bytes) {
  db.prepare(`
    UPDATE frame_ledger_retention SET report_rows = report_rows + 1, report_bytes = report_bytes + ?
    WHERE singleton = 1
  `).run(bytes);
}

function readRetentionState(db) {
  return db.prepare('SELECT * FROM frame_ledger_retention WHERE singleton = 1').get();
}

function retentionSummary(state, limits) {
  return {
    displayRetentionDays: Math.floor(limits.displayRetentionMs / DAY_MS),
    displayRows: Number(state?.display_rows) || 0,
    displayBytes: Number(state?.display_bytes) || 0,
    maxDisplayRowsPerDevice: limits.maxDisplayRowsPerDevice,
    maxDisplayBytesPerDevice: limits.maxDisplayBytesPerDevice,
    maxDisplayRows: limits.maxDisplayRows,
    maxDisplayBytes: limits.maxDisplayBytes,
    reportRetentionDays: Math.floor(limits.reportRetentionMs / DAY_MS),
    reportRows: Number(state?.report_rows) || 0,
    reportBytes: Number(state?.report_bytes) || 0,
    maxReportRows: limits.maxReportRows,
    maxReportBytes: limits.maxReportBytes,
    prunedDisplays: Number(state?.pruned_displays) || 0,
    prunedReports: Number(state?.pruned_reports) || 0,
    lastPrunedAt: state?.last_pruned_at ?? null,
  };
}

function normalizeRetention(overrides) {
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_RETENTION)) {
    const value = Number(overrides?.[key]);
    limits[key] = Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }
  return limits;
}

function displayBytesSql() {
  return `length(CAST(asset_id AS BLOB)) + length(CAST(device_id AS BLOB))
    + length(CAST(first_shown_at AS BLOB)) + length(CAST(last_shown_at AS BLOB))
    + ${DISPLAY_ROW_OVERHEAD_BYTES}`;
}

function reportBytesSql() {
  return `length(CAST(report_id AS BLOB)) + length(CAST(received_at AS BLOB)) + ${REPORT_ROW_OVERHEAD_BYTES}`;
}

function displayEntryBytes(row) {
  return utf8Bytes(row.asset_id) + utf8Bytes(row.device_id)
    + utf8Bytes(row.first_shown_at) + utf8Bytes(row.last_shown_at)
    + DISPLAY_ROW_OVERHEAD_BYTES;
}

function reportEntryBytes(reportId, receivedAt) {
  return utf8Bytes(reportId) + utf8Bytes(receivedAt) + REPORT_ROW_OVERHEAD_BYTES;
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

function createNoopFrameLedger(limits) {
  return {
    available: false,
    close() {},
    getDisplayStats() { return {}; },
    topShown() { return []; },
    deleteDeviceDisplays() { return 0; },
    getLedgerSummary() {
      return {
        ledgerAvailable: false,
        distinctAssetsShown: 0,
        totalDisplays: 0,
        lastDisplayAt: null,
        devices: [],
        retention: retentionSummary(null, limits),
      };
    },
    recordDisplays() { return { recorded: 0, duplicate: false }; },
  };
}

function dedupeStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function normalizeNow(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function normalizeShownAt(value, current) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > current.getTime() + MAX_SHOWN_AT_FUTURE_MS) {
    return current.toISOString();
  }
  return date.toISOString();
}
