import { DatabaseSync } from 'node:sqlite';

import { preparePrivateDatabasePath, restrictPrivateDatabaseModes } from '../privateDatabase.mjs';

const DEFAULT_FRAME_DB_PATH = './data/frame.db';

// Voice command usage counters. Privacy stance: one row per (device, command
// LABEL) pair (e.g. "sm-x820", "next") with a count and last-used timestamp —
// transcripts are never stored, here or anywhere else. The device is the same
// self-chosen name the app sends with display reports; counts recorded before
// devices were tracked (or by app builds that don't send one yet) live under
// device_id '' and surface as "unattributed".
// Lives in the frame DB (same file as the display ledger, own connection).
export function createVoiceMetrics({
  dbPath = process.env.FRAME_DB_PATH || DEFAULT_FRAME_DB_PATH,
  logger = console,
} = {}) {
  let db;

  try {
    preparePrivateDatabasePath(dbPath, logger);
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    restrictPrivateDatabaseModes(dbPath, logger);
    migrateLegacyTable(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_command_stats (
        device_id    TEXT NOT NULL DEFAULT '',
        label        TEXT NOT NULL,
        uses         INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT NOT NULL,
        PRIMARY KEY (device_id, label)
      );
    `);
  } catch (error) {
    logger.warn?.(
      `[Pictaria] Voice metrics unavailable; continuing without usage counters. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    // Close the handle (rolling back any transaction a failed migration left
    // open) — a wedged connection would otherwise hold the shared frame DB's
    // write lock for the process lifetime and starve the display ledger,
    // which writes through its own connection to the same file.
    try {
      db?.close();
    } catch {
      // already closed or never opened
    }
    return createNoopVoiceMetrics();
  }

  const recordStatement = db.prepare(`
    INSERT INTO voice_command_stats (device_id, label, uses, last_used_at)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(device_id, label) DO UPDATE SET
      uses = uses + 1,
      last_used_at = excluded.last_used_at
  `);

  return {
    available: true,
    close() {
      db.close();
    },
    // Device deletion (Settings → Devices) purges voice counts along with
    // the display ledger. Returns the number of uses removed. A blank id is
    // refused so the unattributed bucket can't be dropped by accident.
    deleteDevice(deviceId) {
      const device = String(deviceId || '').trim().slice(0, 64);
      if (!device) {
        return 0;
      }
      const row = db
        .prepare('SELECT COALESCE(SUM(uses), 0) AS uses FROM voice_command_stats WHERE device_id = ?')
        .get(device);
      db.prepare('DELETE FROM voice_command_stats WHERE device_id = ?').run(device);
      return Number(row.uses) || 0;
    },
    record(label, { deviceId = '', usedAt = new Date() } = {}) {
      const clean = String(label || '').trim();
      if (!clean) {
        return;
      }
      const device = String(deviceId || '').trim().slice(0, 64);
      recordStatement.run(device, clean, usedAt instanceof Date ? usedAt.toISOString() : String(usedAt));
    },
    // deviceFilter: null/undefined → all devices combined; '' → only counts
    // never attributed to a device; anything else → that device. The devices
    // list always covers every device regardless of filter (it feeds the
    // page's device picker). ISO timestamps compare correctly as strings,
    // so MAX() picks the latest.
    summary(deviceFilter = null) {
      const filtered = deviceFilter !== null && deviceFilter !== undefined;
      const commands = (filtered
        ? db
            .prepare('SELECT label, uses, last_used_at FROM voice_command_stats WHERE device_id = ? ORDER BY uses DESC, label')
            .all(String(deviceFilter))
        : db
            .prepare(`
              SELECT label, SUM(uses) AS uses, MAX(last_used_at) AS last_used_at
              FROM voice_command_stats GROUP BY label ORDER BY uses DESC, label
            `)
            .all()
      ).map((row) => ({
        label: row.label,
        uses: Number(row.uses) || 0,
        lastUsedAt: row.last_used_at,
      }));
      const devices = db
        .prepare(`
          SELECT device_id, SUM(uses) AS uses, MAX(last_used_at) AS last_used_at
          FROM voice_command_stats GROUP BY device_id ORDER BY uses DESC, device_id
        `)
        .all()
        .map((row) => ({
          deviceId: row.device_id,
          uses: Number(row.uses) || 0,
          lastUsedAt: row.last_used_at,
        }));
      return {
        available: true,
        totalUses: commands.reduce((sum, row) => sum + row.uses, 0),
        commands,
        devices,
      };
    },
  };
}

// Counters recorded before mid-July 2026 used one row per label with no
// device column. Rebuild them under the composite key with device_id '' so
// history keeps counting toward the all-devices totals (it can't be
// attributed after the fact). Shape-detected rather than versioned: the
// frame DB file is shared with the display ledger's own connection, so this
// module keeps its hands off PRAGMA user_version.
function migrateLegacyTable(db) {
  const columns = db.prepare('PRAGMA table_info(voice_command_stats)').all().map((column) => column.name);
  if (columns.length === 0 || columns.includes('device_id')) {
    return;
  }
  db.exec(`
    BEGIN;
    CREATE TABLE voice_command_stats_v2 (
      device_id    TEXT NOT NULL DEFAULT '',
      label        TEXT NOT NULL,
      uses         INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (device_id, label)
    );
    INSERT INTO voice_command_stats_v2 (device_id, label, uses, last_used_at)
      SELECT '', label, uses, last_used_at FROM voice_command_stats;
    DROP TABLE voice_command_stats;
    ALTER TABLE voice_command_stats_v2 RENAME TO voice_command_stats;
    COMMIT;
  `);
}

function createNoopVoiceMetrics() {
  return {
    available: false,
    close() {},
    deleteDevice() {
      return 0;
    },
    record() {},
    summary() {
      return { available: false, totalUses: 0, commands: [], devices: [] };
    },
  };
}
