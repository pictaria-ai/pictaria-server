#!/usr/bin/env node
// Standalone backup: snapshots Pictaria's data files using the same logic
// as the server's automatic backups. Safe to invoke while the server is up:
// SQLite is copied online, and a destination lock makes an overlapping run
// exit without touching the active backup. Intended for cron/launchd jobs
// that write to a NAS mount or synced folder. The command also creates or
// reads the private `session-secret` beside SETTINGS_PATH; that durable local
// identity coordinates safe lock recovery and is never copied into a backup.
// An unreadable or malformed secret makes the backup fail closed:
//
//   node --env-file-if-exists=.env bin/backup.mjs
//   BACKUP_DIR=/mnt/nas/pictaria-backups node --env-file-if-exists=.env bin/backup.mjs

import { loadConfig } from '../src/config.mjs';
import { adoptBackupDestination, runBackup } from '../src/backup.mjs';

const config = loadConfig();
try {
  // --adopt: the one-time explicit trust step for a custom BACKUP_DIR —
  // run it while the real destination is mounted; the first snapshot
  // follows immediately.
  if (process.argv.includes('--adopt')) {
    console.log(`Adopted backup destination: ${adoptBackupDestination(config)}`);
  }
  const result = await runBackup(config);
  const mb = (result.bytes / 1024 / 1024).toFixed(1);
  console.log(`Backup written: ${result.dir}`);
  for (const file of result.files) {
    console.log(`  ${file.name} (${(file.bytes / 1024 / 1024).toFixed(1)} MB)`);
  }
  console.log(`Total ${mb} MB · rotated out ${result.removed} old backup(s)`);
  if (!result.complete) {
    console.error(`Backup incomplete — missing: ${result.missing.map((entry) => entry.name).join(', ')}`);
    console.error('Older complete snapshots were preserved.');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`Backup failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
