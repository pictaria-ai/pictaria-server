import { basename, join } from 'node:path';

import { backupTargets, readSnapshotStatus, runBackup } from './backup.mjs';

// Bump only when a release changes a persisted contract and therefore needs
// a pre-migration recovery point. Ordinary server releases keep this value.
export const PERSISTENT_STATE_VERSION = 7;

export class UpgradeSafetyError extends Error {
  constructor(message, { code = 'upgrade_safety_error' } = {}) {
    super(message);
    this.name = 'UpgradeSafetyError';
    this.code = code;
  }
}

export async function preparePersistentStateUpgrade({
  guard,
  config,
  currentServerVersion,
  currentStateVersion = PERSISTENT_STATE_VERSION,
  now = new Date(),
  createBackup = runBackup,
}) {
  validateCurrentVersion(currentStateVersion, currentServerVersion);
  const previous = guard.upgradeState();

  // Fresh installations and installations adopting this safety metadata for
  // the first time have no known older contract. Their first fully healthy
  // boot records the current baseline in seal(); no migration is licensed by
  // this branch.
  if (!previous) {
    return { action: 'baseline', fromStateVersion: null, toStateVersion: currentStateVersion };
  }

  if (previous.stateVersion > currentStateVersion) {
    throw new UpgradeSafetyError(
      `This installation last started successfully with persistent-state version ${previous.stateVersion}, `
      + `but this server supports version ${currentStateVersion}. Arbitrary downgrade is not supported. `
      + `${rollbackInstruction(previous)}`,
      { code: 'persistent_state_downgrade_refused' },
    );
  }

  if (previous.stateVersion === currentStateVersion) {
    if (previous.pending) {
      throw new UpgradeSafetyError(
        `Persistent-state metadata still records an unfinished upgrade to version ${previous.pending.toStateVersion}. `
        + `${rollbackInstruction(previous)}`,
        { code: 'persistent_state_pending_upgrade_invalid' },
      );
    }
    return {
      action: 'none',
      fromStateVersion: previous.stateVersion,
      toStateVersion: currentStateVersion,
    };
  }

  if (previous.pending) {
    if (previous.pending.fromStateVersion !== previous.stateVersion
      || previous.pending.toStateVersion !== currentStateVersion) {
      throw new UpgradeSafetyError(
        `An unfinished upgrade from persistent-state version ${previous.pending.fromStateVersion} `
        + `to ${previous.pending.toStateVersion} cannot be continued by a build targeting version ${currentStateVersion}. `
        + `${rollbackInstruction(previous)}`,
        { code: 'persistent_state_pending_upgrade_mismatch' },
      );
    }
    verifyRecoveryPoint(config, previous.pending);
    return {
      action: 'reuse',
      fromStateVersion: previous.stateVersion,
      toStateVersion: currentStateVersion,
      snapshotName: previous.pending.snapshotName,
    };
  }

  const purpose = {
    type: 'pre-migration',
    fromStateVersion: previous.stateVersion,
    toStateVersion: currentStateVersion,
    fromServerVersion: previous.serverVersion,
    toServerVersion: currentServerVersion,
  };
  const backup = await createBackup(config, { now, purpose });
  if (!backup.complete) {
    throw new UpgradeSafetyError(
      `Pre-migration backup is incomplete (${backup.missing.map(({ name }) => name).join(', ')}). `
      + 'Pictaria refused to migrate persistent state. Restore or repair the missing state and restart.',
      { code: 'pre_migration_backup_incomplete' },
    );
  }

  const pending = guard.recordPendingUpgrade({
    ...purpose,
    snapshotName: basename(backup.dir),
    createdAt: backup.at,
  });
  verifyRecoveryPoint(config, pending);
  return {
    action: 'create',
    fromStateVersion: previous.stateVersion,
    toStateVersion: currentStateVersion,
    snapshotName: pending.snapshotName,
  };
}

function verifyRecoveryPoint(config, point) {
  const snapshotDir = join(config.backup.dir, point.snapshotName);
  const status = readSnapshotStatus(snapshotDir, backupTargets(config));
  if (status.state !== 'complete'
    || status.purpose?.type !== 'pre-migration'
    || status.purpose.fromStateVersion !== point.fromStateVersion
    || status.purpose.toStateVersion !== point.toStateVersion
    || status.purpose.fromServerVersion !== point.fromServerVersion
    || status.purpose.toServerVersion !== point.toServerVersion) {
    throw new UpgradeSafetyError(
      `The recorded pre-migration recovery point ${snapshotDir} is missing, damaged, or does not match the pending upgrade. `
      + 'Pictaria refused to run or retry migrations. Restore that recovery point before retrying the upgrade.',
      { code: 'pre_migration_recovery_point_invalid' },
    );
  }
  return status;
}

function validateCurrentVersion(stateVersion, serverVersion) {
  if (!Number.isInteger(stateVersion) || stateVersion < 1) {
    throw new UpgradeSafetyError('The running build has an invalid persistent-state version.');
  }
  if (typeof serverVersion !== 'string' || !serverVersion) {
    throw new UpgradeSafetyError('The running build has no readable server version.');
  }
}

function rollbackInstruction(upgrade) {
  const point = upgrade.pending ?? upgrade.recoveryPoint;
  return point
    ? `Stop Pictaria and restore snapshot ${point.snapshotName} before running the matching older server version.`
    : 'Stop Pictaria and restore a complete snapshot created by the older server version.';
}
