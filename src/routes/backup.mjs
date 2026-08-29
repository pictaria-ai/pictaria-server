import { sendError, sendJson } from '../http.mjs';
import { backupTargets, listBackups, newestBackupAt, newestBackupStatusAsync, runBackup } from '../backup.mjs';

// Backup status + on-demand runs. The scheduler lives in server.mjs; this
// exposes what Settings shows (destination, last backup, history) and the
// "Back up now" button. One backup at a time.

export function createBackupRoutes({ config, backupState }) {
  return async function handleBackupRoute(request, response, url) {
    if (request.method === 'GET' && url.pathname === '/api/backup/status') {
      const newest = newestBackupAt(config.backup.dir);
      const persistedResult = await newestBackupStatusAsync(config.backup.dir, backupTargets(config));
      const lastResult = persistedResult
        ? (backupState.lastResult?.dir === persistedResult.dir
            ? { ...backupState.lastResult, ...persistedResult }
            : persistedResult)
        : backupState.lastResult;
      sendJson(response, 200, {
        dir: config.backup.dir,
        enabled: config.backup.enabled,
        intervalHours: config.backup.intervalHours,
        keep: config.backup.keep,
        running: backupState.running,
        lastAt: newest ? newest.toISOString() : null,
        // The disk is authoritative: standalone/cron backups can publish a
        // newer snapshot while this process still remembers an older result.
        // Preserve richer in-memory statistics only when both identify the
        // same published directory, with manifest state winning the merge.
        lastResult,
        lastError: backupState.lastError,
        count: listBackups(config.backup.dir).length,
      });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/backup/run') {
      if (backupState.running) {
        sendError(response, 409, 'backup_running', 'A backup is already in progress.');
        return true;
      }
      backupState.running = true;
      try {
        const result = await runBackup(config);
        backupState.lastResult = result;
        backupState.lastError = null;
        sendJson(response, 200, result);
      } catch (error) {
        backupState.lastError = error instanceof Error ? error.message : String(error);
        const coordinated = error?.code === 'backup_running';
        sendError(
          response,
          coordinated ? 409 : 500,
          coordinated ? 'backup_running' : 'backup_failed',
          backupState.lastError,
        );
      } finally {
        backupState.running = false;
      }
      return true;
    }

    return false;
  };
}
