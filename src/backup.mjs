import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import {
  lstat as lstatAsync,
  open as openAsync,
  readdir as readdirAsync,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';

import {
  MAX_PERSISTENT_STATE_BYTES,
  PERSISTENT_STATE_ROLE,
  inspectPersistentTarget,
  validatePersistentStateInventory,
  validateSqlitePersistentState,
} from './persistentState.mjs';
import { MAX_SETTINGS_STATE_BYTES, validateSettingsPersistentState } from './settings.mjs';
import { MAX_SMART_ALBUM_STATE_BYTES, validateSmartAlbumPersistentState } from './albums/store.mjs';
import {
  MAX_RESTORED_WAKE_WORD_SNAPSHOT_ENTRIES,
  MAX_RESTORED_WAKE_WORD_SNAPSHOT_BYTES,
  MAX_WAKE_WORD_REGISTRY_BYTES,
  validateWakeWordPersistentState,
  wakeWordBackupManifest,
} from './wakeword/store.mjs';
import { parseBoundedJsonFileSync, readBoundedRegularFileSync } from './boundedFile.mjs';
import { loadOrCreateSessionSecret } from './sessionTokens.mjs';
import { writePrivateFileAtomicSync } from './atomicFile.mjs';

// Snapshots everything Pictaria can't recompute into a dated folder under
// config.backup.dir, using SQLite's online-backup API so live databases
// copy safely while the server runs. insights.sqlite is included for
// convenience but is recomputable from Immich; the irreplaceable files are
// the enrichment database (decisions, tags, captions, run history),
// settings.json (incl. location groups), smart-albums.json, and frame.db.

// Each target carries a stable semantic `role` used as the filename inside
// the snapshot. Destinations must never derive from the source basename:
// env overrides (DATABASE_PATH, FRAME_DB_PATH, ...) can give two sources the
// same basename, and basename-derived destinations would silently overwrite
// one with the other while reporting both as backed up. Roles match the
// default basenames so existing snapshots stay recognizable and restorable.
export function backupTargets(config) {
  return [
    {
      role: 'enrichment.sqlite',
      path: config.databasePath,
      kind: 'sqlite',
      validate: (path) => validateSqlitePersistentState(path, ['assets', 'processing_runs', 'asset_tags']),
    },
    {
      role: 'frame.db',
      path: config.frame.dbPath,
      kind: 'sqlite',
      validate: (path) => validateSqlitePersistentState(path, ['asset_displays', 'voice_command_stats']),
    },
    {
      role: 'insights.sqlite',
      path: config.insights.dbPath,
      kind: 'sqlite',
      validate: validateSqlitePersistentState,
    },
    {
      role: 'settings.json',
      path: config.settingsPath,
      kind: 'file',
      maxBytes: MAX_SETTINGS_STATE_BYTES,
      validate: validateSettingsPersistentState,
    },
    {
      role: 'smart-albums.json',
      path: config.albums.dataFile,
      kind: 'file',
      maxBytes: MAX_SMART_ALBUM_STATE_BYTES,
      validate: validateSmartAlbumPersistentState,
    },
    {
      role: 'wake-word-models',
      path: config.wakeWordModelsDir,
      kind: 'directory',
      maxBytes: MAX_RESTORED_WAKE_WORD_SNAPSHOT_BYTES,
      maxEntries: MAX_RESTORED_WAKE_WORD_SNAPSHOT_ENTRIES,
      inspectRetention: inspectWakeWordRetentionShape,
      failureMode: 'degrade',
      validate: validateWakeWordPersistentState,
      copyDirectory: copyWakeWordDirectory,
    },
    {
      role: PERSISTENT_STATE_ROLE,
      path: config.persistentState.inventoryPath,
      kind: 'file',
      maxBytes: MAX_PERSISTENT_STATE_BYTES,
      validate: validatePersistentStateInventory,
    },
  ];
}

export const DESTINATION_MARKER = '.pictaria-backup-destination';
export const SNAPSHOT_MANIFEST = '.pictaria-snapshot.json';
export const SNAPSHOT_OWNER = '.pictaria-snapshot-owner.json';
export const BACKUP_LOCK_DIR = '.pictaria-backup.lock';
const BACKUP_LOCK_OWNER = 'owner.json';
const BACKUP_NAME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})(?:(?:-run-\d{4})|(?:-pre-migration-v\d+-to-v\d+))?$/;

const MARKER_NOTE = 'Pictaria backup destination marker. Its presence is what lets backups '
  + 'write here; without it, a directory at this path is treated as a stand-in '
  + 'for an absent mount — keep this file.\n';
export const MAX_SNAPSHOT_MANIFEST_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_OWNER_BYTES = 1024;
const MAX_BACKUP_LOCK_OWNER_BYTES = 2048;
const BACKUP_INSTALLATION_ID_DOMAIN = 'pictaria-backup-installation-v1\0';
const activeBackupLockTokens = new Set();
const activeBackupLocks = new Map();
// Folder stamps have minute precision while manifests retain milliseconds.
// Five minutes tolerates ordinary clock correction during a run without ever
// letting an implausibly future snapshot suppress or displace a healthy one.
export const MAX_SNAPSHOT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SNAPSHOT_VERIFICATION_TTL_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_VERIFICATION_CACHE_ENTRIES = 16;
const snapshotVerificationCache = new Map();

// The destination must be the real one, not a stand-in the OS left where a
// mount should be — off-machine backups promise to fail visibly, never to
// write elsewhere. Trust is carried by one thing only, the marker file
// stamped into the destination when it is adopted:
// - The DEFAULT data/backups sits on the local data disk the server already
//   owns, so it is created and adopted implicitly (existing installs gain
//   the marker on their next run).
// - A CUSTOM `BACKUP_DIR` is where mounts live, and a mount's stand-in is
//   indistinguishable from a fresh directory by content alone — so nothing
//   is ever created or adopted implicitly. Adoption is an explicit, one-time
//   act (`node bin/backup.mjs --adopt`, or creating the marker by hand)
//   performed while the real destination is reachable; from then on the
//   marker travels with the destination. An absent mount then fails every
//   shape loudly: path missing (macOS unmount removes /Volumes mount
//   points), or path present but unmarked (Linux mount points persist
//   empty; pre-fix phantom directories carry snapshots but no marker).
export function ensureBackupDestination(config) {
  const dir = config.backup.dir;
  if (!config.backup.dirIsCustom) {
    const existing = lstatIfExists(dir);
    if (existing?.isSymbolicLink()) {
      throw new Error(
        `Backup destination unavailable: the implicit default ${dir} is a symbolic link. `
        + 'Set BACKUP_DIR explicitly and adopt that destination if the link is intentional. Nothing was written.',
      );
    }
    if (!existing) {
      // Non-recursive on purpose: data/ exists from boot, and a missing
      // parent here means a broken install, not a fresh one.
      mkdirSync(dir, { mode: 0o700 });
    }
    const identity = destinationIdentity(dir);
    ensureDestinationMarker(dir, identity, { create: true });
    return identity;
  }
  if (!existsSync(dir)) {
    throw new Error(
      `Backup destination unavailable: ${dir} does not exist. `
      + 'If it lives on a network share or external disk, the mount is absent. '
      + `If it is a brand-new destination, adopt it once while it is reachable: node bin/backup.mjs --adopt (or create it with an empty ${DESTINATION_MARKER} file inside). `
      + 'Nothing was written.',
    );
  }
  const identity = destinationIdentity(dir);
  if (!destinationMarkerIsRegular(dir)) {
    const withSnapshots = listBackups(dir).length > 0;
    throw new Error(
      `Backup destination unavailable: ${dir} exists but carries no ${DESTINATION_MARKER} marker`
      + (withSnapshots
        ? ` — it holds dated snapshots, so it may be a destination from before the marker existed, or a phantom the old bug wrote on the local disk while the mount was absent. If the snapshots are really on your intended destination, adopt it once: node bin/backup.mjs --adopt. `
        : ' — an unmarked directory here usually means an empty stand-in for an absent mount. Mount the share, or for a genuinely new/replaced destination adopt it once: node bin/backup.mjs --adopt. ')
      + 'Nothing was written.',
    );
  }
  assertDestinationIdentity(dir, identity);
  return identity;
}

// Device + inode pin the validated directory itself, not just its path: a
// mount dropping mid-run can reveal an underlying directory at the same
// path where writes keep succeeding — the stand-in has a different
// identity, and (unless deliberately adopted) no marker.
function destinationIdentity(dir) {
  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`Backup destination unavailable: ${dir} is not a directory. Nothing was written.`);
  }
  return { dev: stat.dev, ino: stat.ino };
}

function assertDestinationIdentity(dir, expected) {
  const current = statSync(dir);
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error(
      `Backup destination unavailable: ${dir} changed while it was being validated. Nothing was written.`,
    );
  }
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function destinationMarkerIsRegular(dir) {
  const markerStat = lstatIfExists(join(dir, DESTINATION_MARKER));
  return Boolean(markerStat?.isFile() && !markerStat.isSymbolicLink() && markerStat.nlink === 1);
}

function ensureDestinationMarker(dir, identity, { create }) {
  const marker = join(dir, DESTINATION_MARKER);
  const existing = lstatIfExists(marker);
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
      throw new Error(
        `Backup destination unavailable: ${marker} is not a regular marker file. Nothing was written.`,
      );
    }
    assertDestinationIdentity(dir, identity);
    return;
  }
  if (!create) {
    throw new Error(`Backup destination unavailable: ${dir} carries no ${DESTINATION_MARKER} marker. Nothing was written.`);
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd;
  try {
    fd = openSync(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    writeSync(fd, MARKER_NOTE);
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ELOOP') {
      throw new Error(
        `Backup destination unavailable: ${marker} appeared while the destination was being adopted. Nothing was written.`,
      );
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  assertDestinationIdentity(dir, identity);
}

// The explicit adoption step for a custom destination: run while the real
// destination is reachable. Creates the directory (its parent — the mount —
// must already exist) and stamps the marker that all future runs require.
export function adoptBackupDestination(config) {
  const dir = config.backup.dir;
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(
          `Cannot adopt ${dir}: its parent directory does not exist. Mount the share (or create the parent) first.`,
        );
      }
      throw error;
    }
  }
  const identity = destinationIdentity(dir);
  ensureDestinationMarker(dir, identity, { create: true });
  return dir;
}

export class BackupRunningError extends Error {
  constructor(message = 'A backup is already in progress for this destination.') {
    super(message);
    this.name = 'BackupRunningError';
    this.code = 'backup_running';
    this.status = 409;
  }
}

function acquireBackupLock(backupDir, backupIdentity, installationId) {
  const lockDir = join(backupDir, BACKUP_LOCK_DIR);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertDestinationIdentity(backupDir, backupIdentity);
    if (!destinationMarkerIsRegular(backupDir)) {
      throw new Error(`Backup destination unavailable: ${backupDir} lost its regular ${DESTINATION_MARKER} marker.`);
    }
    try {
      mkdirSync(lockDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = readBackupLock(lockDir, backupIdentity);
      if (!existing || !backupLockIsDefinitelyStale(existing.owner, installationId)) {
        throw new BackupRunningError(
          existing
            ? `Backup destination is locked by ${JSON.stringify(existing.owner.hostname)} since ${existing.owner.createdAt}. `
              + `If no backup is running, see docs/BACKUP.md before removing ${BACKUP_LOCK_DIR}.`
            : `Backup coordination is blocked by an unrecognized ${BACKUP_LOCK_DIR}. It was preserved; confirm no backup is running before removing it manually.`,
        );
      }
      try {
        removeBackupLockDirectory(backupDir, backupIdentity, existing);
      } catch {
        // Another contender may have reclaimed or replaced the stale lock.
        // Re-read the atomic path rather than deleting what appeared there.
      }
      continue;
    }

    const identity = destinationIdentity(lockDir);
    const owner = {
      version: 2,
      token: randomUUID(),
      hostname: hostname(),
      pid: process.pid,
      createdAt: new Date().toISOString(),
      abandonedAt: null,
      installationId,
      backupRoot: {
        dev: String(backupIdentity.dev),
        ino: String(backupIdentity.ino),
      },
    };
    try {
      writeFileSync(join(lockDir, BACKUP_LOCK_OWNER), `${JSON.stringify(owner)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      assertDestinationIdentity(backupDir, backupIdentity);
      activeBackupLockTokens.add(owner.token);
      const lock = { dir: lockDir, identity, owner, backupDir, backupIdentity };
      activeBackupLocks.set(backupDir, lock);
      return lock;
    } catch (error) {
      try {
        const current = lstatIfExists(lockDir);
        if (current?.isDirectory() && !current.isSymbolicLink()
          && current.dev === identity.dev && current.ino === identity.ino) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        // Preserve the original acquisition failure.
      }
      throw error;
    }
  }
  throw new BackupRunningError('Backup coordination changed repeatedly; no backup was started.');
}

function readBackupLock(lockDir, backupIdentity) {
  try {
    const stat = lstatSync(lockDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    const owner = parseBoundedJsonFileSync(join(lockDir, BACKUP_LOCK_OWNER), {
      maxBytes: MAX_BACKUP_LOCK_OWNER_BYTES,
      label: 'Backup lock owner',
    });
    const createdAt = parseSnapshotCreatedAt(owner?.createdAt);
    const valid = owner?.version === 2
      && typeof owner.token === 'string'
      && /^[a-f0-9-]{36}$/.test(owner.token)
      && typeof owner.hostname === 'string'
      && owner.hostname.length > 0
      && owner.hostname.length <= 255
      && Number.isSafeInteger(owner.pid)
      && owner.pid > 0
      && createdAt
      && (owner.abandonedAt === null || parseSnapshotCreatedAt(owner.abandonedAt))
      && (owner.installationId === null
        || (typeof owner.installationId === 'string' && /^[a-f0-9]{64}$/.test(owner.installationId)))
      && owner.backupRoot?.dev === String(backupIdentity.dev)
      && owner.backupRoot?.ino === String(backupIdentity.ino);
    const current = lstatSync(lockDir);
    return valid
      && current.isDirectory()
      && !current.isSymbolicLink()
      && current.dev === stat.dev
      && current.ino === stat.ino
      ? { dir: lockDir, identity: { dev: stat.dev, ino: stat.ino }, owner }
      : null;
  } catch {
    return null;
  }
}

function backupLockIsDefinitelyStale(owner, installationId) {
  const sameInstallation = installationId !== null && owner.installationId === installationId;
  const sameUnidentifiedHost = installationId === null
    && owner.installationId === null
    && owner.hostname === hostname();
  if (!sameInstallation && !sameUnidentifiedHost) return false;
  if (owner.hostname !== hostname()) {
    // PIDs cannot establish liveness across containers or hosts. A changed
    // runtime may reclaim only the explicit handoff written immediately
    // before the owning Pictaria process exits.
    return sameInstallation && owner.abandonedAt !== null;
  }
  if (owner.pid === process.pid) {
    // Container restarts commonly reuse PID 1. The token set distinguishes
    // this process's live lock from a dead predecessor with the same PID.
    return !activeBackupLockTokens.has(owner.token);
  }
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === 'ESRCH';
  }
}

function backupInstallationIdentity(config) {
  if (!config.sessionSecretPath) return null;
  const installationSecret = loadOrCreateSessionSecret(config.sessionSecretPath);
  return createHash('sha256')
    .update(BACKUP_INSTALLATION_ID_DOMAIN)
    .update(installationSecret)
    .digest('hex');
}

function removeBackupLockDirectory(backupDir, backupIdentity, lock) {
  assertDestinationIdentity(backupDir, backupIdentity);
  if (!destinationMarkerIsRegular(backupDir)) {
    throw new Error(`Backup destination unavailable: ${backupDir} lost its regular ${DESTINATION_MARKER} marker.`);
  }
  const current = readBackupLock(lock.dir, backupIdentity);
  if (!current
    || current.identity.dev !== lock.identity.dev
    || current.identity.ino !== lock.identity.ino
    || current.owner.token !== lock.owner.token) {
    throw new Error(`Backup coordination changed before cleanup: ${lock.dir}. It was preserved.`);
  }
  rmSync(lock.dir, { recursive: true, force: true });
}

function releaseBackupLock(backupDir, backupIdentity, lock) {
  try {
    removeBackupLockDirectory(backupDir, backupIdentity, lock);
  } finally {
    activeBackupLockTokens.delete(lock.owner.token);
    if (activeBackupLocks.get(backupDir)?.owner.token === lock.owner.token) {
      activeBackupLocks.delete(backupDir);
    }
  }
}

export function markActiveBackupLockAbandoned(config, { now = new Date() } = {}) {
  const lock = activeBackupLocks.get(config.backup.dir);
  if (!lock) return false;
  const current = readBackupLock(lock.dir, lock.backupIdentity);
  if (!current
    || current.identity.dev !== lock.identity.dev
    || current.identity.ino !== lock.identity.ino
    || current.owner.token !== lock.owner.token) {
    return false;
  }
  const abandonedAt = validDate(now, 'Backup lock abandonment time').toISOString();
  const owner = { ...current.owner, abandonedAt };
  assertDestinationIdentity(lock.backupDir, lock.backupIdentity);
  writePrivateFileAtomicSync(
    join(lock.dir, BACKUP_LOCK_OWNER),
    `${JSON.stringify(owner)}\n`,
    { encoding: 'utf8' },
  );
  const written = readBackupLock(lock.dir, lock.backupIdentity);
  if (!written || written.owner.token !== owner.token || written.owner.abandonedAt !== abandonedAt) {
    throw new Error('Backup lock could not record its shutdown handoff; it remains fail-closed.');
  }
  lock.owner = owner;
  return true;
}

function allocateSnapshotStamp(backupDir, requestedStamp, purpose) {
  if (purpose) {
    if (existsSync(join(backupDir, requestedStamp)) || existsSync(join(backupDir, `${requestedStamp}.partial`))) {
      throw new Error(
        `Pre-migration backup destination collision: ${requestedStamp} already exists. It was preserved; Pictaria refused to overwrite a recovery point.`,
      );
    }
    return requestedStamp;
  }

  const escaped = requestedStamp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sameMinute = new RegExp(`^${escaped}(?:-run-(\\d{4}))?(?:\\.partial)?$`);
  let highestRun = 0;
  for (const entry of readdirSync(backupDir)) {
    const match = sameMinute.exec(entry);
    if (!match) continue;
    highestRun = Math.max(highestRun, match[1] ? Number(match[1]) : 1);
  }
  if (highestRun === 0) return requestedStamp;
  if (highestRun >= 9999) {
    throw new Error(`Backup naming exhausted for ${requestedStamp}; wait until the next minute before retrying.`);
  }
  // Never reuse a gap left by retention: monotonically increasing suffixes
  // keep lexical newest-first behavior correct for the rest of this minute.
  return `${requestedStamp}-run-${String(Math.max(2, highestRun + 1)).padStart(4, '0')}`;
}

export async function runBackup(config, options = {}) {
  const {
    now = new Date(),
    targets = backupTargets(config),
    purpose = null,
    testHooks = {},
  } = options;
  const identity = ensureBackupDestination(config);
  const installationId = backupInstallationIdentity(config);
  const lock = acquireBackupLock(config.backup.dir, identity, installationId);
  let operationError = null;
  try {
    await testHooks.afterLockAcquired?.({ lockDir: lock.dir });
    return await runBackupLocked(config, {
      now,
      targets,
      purpose,
      testHooks,
      identity,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseBackupLock(config.backup.dir, identity, lock);
    } catch (releaseError) {
      if (!operationError) {
        throw releaseError;
      }
    }
  }
}

async function runBackupLocked(config, {
  now = new Date(),
  targets = backupTargets(config),
  purpose = null,
  testHooks = {},
  identity,
}) {
  // Safety net: roles are the destination filenames, so a duplicate would
  // silently overwrite one copy with another. Fail loudly instead — a wrong
  // backup that looks right is worse than no backup.
  const roles = targets.map((target) => target.role);
  const unsafeRole = roles.find((role) => !isSafeSnapshotRole(role));
  if (unsafeRole) {
    throw new Error(`Backup target role "${unsafeRole}" is not a safe snapshot entry name.`);
  }
  const duplicate = roles.find((role, index) => roles.indexOf(role) !== index);
  if (duplicate) {
    throw new Error(`Backup targets collide on destination name "${duplicate}"; refusing to overwrite one copy with another.`);
  }
  const normalizedPurpose = normalizeSnapshotPurpose(purpose);
  const baseStamp = now.toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const requestedStamp = normalizedPurpose
    ? `${baseStamp}-pre-migration-v${normalizedPurpose.fromStateVersion}-to-v${normalizedPurpose.toStateVersion}`
    : baseStamp;
  removeStalePartials(config.backup.dir, identity, testHooks);
  const stamp = allocateSnapshotStamp(config.backup.dir, requestedStamp, normalizedPurpose);
  const dir = join(config.backup.dir, stamp);
  // Backups hold captions, decisions, and settings — private to the server
  // user even on a bind mount with a permissive umask. Existing directories
  // keep their modes (the guard's mkdirSync only applies mode on creation),
  // so files get an explicit chmod below.
  // Copies land in a .partial directory renamed into place only once every
  // file succeeded: an interrupted run must never carry the final name, or
  // listBackups/newestBackupAt would count it as real and suppress the
  // retry for a whole interval. Created NON-recursively: if the destination
  // vanishes between the guard above and here (a mount dropping mid-run),
  // a recursive create would quietly rebuild the whole path on the local
  // disk and hand this run right back to the silent-fallback bug. Note
  // that this alone does NOT make later writes safe — an unmount can
  // reveal an underlying directory at the same path (the root-mount
  // shape) where copies and even the rename keep succeeding, which is why
  // the pre-publish identity + marker recheck below is load-bearing, not
  // belt-and-suspenders.
  const partialDir = `${dir}.partial`;
  let partialIdentity = null;
  try {
    mkdirSync(partialDir, { mode: 0o700 });
    partialIdentity = destinationIdentity(partialDir);
    writeSnapshotOwner(partialDir, stamp, identity);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(
        `Backup destination unavailable: ${config.backup.dir} disappeared before the snapshot could start — the mount likely dropped. Nothing was written.`,
      );
    }
    throw error;
  }

  const files = [];
  const missing = [];
  try {
    for (const target of targets) {
      const targetStatus = inspectPersistentTarget(target);
      if (!targetStatus.valid) {
        // A source that has never existed, vanished, or failed its structural
        // validation must be visible in the result; otherwise lost state can
        // leave zero trace in backup status.
        missing.push({ name: target.role, path: target.path, reason: targetStatus.reason });
        continue;
      }
      const destination = join(partialDir, target.role);
      if (target.kind === 'sqlite') {
        const source = new DatabaseSync(target.path, { readOnly: true });
        try {
          await sqliteBackup(source, destination);
        } finally {
          source.close();
        }
      } else if (target.kind === 'directory') {
        if (target.copyDirectory) {
          try {
            target.copyDirectory(target.path, destination);
          } catch (error) {
            // A strict, security-sensitive copier must fail closed for its
            // own target. It must not, however, discard the other recovery
            // data already collected in this snapshot.
            rmSync(destination, { recursive: true, force: true });
            missing.push({ name: target.role, path: target.path, reason: error.message });
            continue;
          }
        } else {
          // Generic directory snapshots carry bytes rather than links back to
          // the live volume. Security-sensitive stores provide a stricter,
          // manifest-driven copier above rather than using this traversal.
          copyDirectoryMaterialized(target.path, destination);
        }
      } else if (target.maxBytes) {
        let bytes;
        try {
          bytes = readBoundedRegularFileSync(target.path, {
            maxBytes: target.maxBytes,
            label: `${target.role} backup source`,
          });
        } catch (error) {
          // Source state may disappear or change after its structural check.
          // Preserve the other recovery data as an honest incomplete snapshot;
          // destination write failures below remain fatal.
          missing.push({ name: target.role, path: target.path, reason: error.message });
          continue;
        }
        writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 });
      } else {
        copyFileSync(target.path, destination);
      }
      const copiedStatus = inspectPersistentTarget({ ...target, path: destination });
      if (!copiedStatus.valid) {
        rmSync(destination, { recursive: true, force: true });
        missing.push({ name: target.role, path: target.path, reason: copiedStatus.reason });
        continue;
      }
      chmodSync(destination, target.kind === 'directory' ? 0o700 : 0o600);
      const integrity = snapshotTargetIntegrity(destination, target.kind, { maxBytes: target.maxBytes ?? null });
      files.push({
        name: target.role,
        kind: integrity.kind,
        bytes: integrity.bytes,
        sha256: integrity.sha256,
      });
    }
    const snapshotManifest = {
      version: 2,
      createdAt: now.toISOString(),
      complete: missing.length === 0,
      missing: missing.map((entry) => entry.name),
      targets: files.map(({ name, kind, bytes, sha256 }) => ({ name, kind, bytes, sha256 })),
      ...(normalizedPurpose ? { purpose: normalizedPurpose } : {}),
    };
    const snapshotManifestPath = join(partialDir, SNAPSHOT_MANIFEST);
    writeFileSync(snapshotManifestPath, `${JSON.stringify(snapshotManifest, null, 2)}\n`, { mode: 0o600 });
    await testHooks.beforePublish?.({ partialDir, dir, stamp });

    // Publish only onto the destination the guard validated. A mount
    // dropping mid-run can reveal an underlying directory at the same
    // path (the root-mount Linux shape) where every write above kept
    // succeeding — the stand-in has a different device/inode identity and,
    // unless deliberately adopted, no marker. Checked at the last moment
    // before the snapshot gets its real name; on mismatch the partial is
    // discarded from the stand-in and the run fails into lastError.
    const current = statSync(config.backup.dir);
    if (current.dev !== identity.dev || current.ino !== identity.ino
      || !destinationMarkerIsRegular(config.backup.dir)) {
      throw new Error(
        `Backup destination unavailable: ${config.backup.dir} is no longer the destination this run validated — the mount likely changed mid-run. The unpublished snapshot was discarded; nothing was published.`,
      );
    }
    if (existsSync(dir)) {
      throw new Error(`Backup destination collision: ${dir} appeared before publication. It was preserved.`);
    }
    renameSync(partialDir, dir);
  } catch (error) {
    removeOwnedPartial(partialDir, stamp, identity, partialIdentity, {
      beforeRemoval: testHooks.beforeOwnedRemoval,
      kind: 'failed-partial',
    });
    throw error;
  }

  const complete = missing.length === 0;
  await testHooks.beforeRetention?.({ dir, stamp });
  const removed = rotateBackups(config.backup.dir, config.backup.keep, targets, {
    now,
    // The copy loop just derived every digest recorded in this complete
    // snapshot's manifest. Reuse that evidence instead of immediately reading
    // the same payload again during retention. Incomplete runs provide no
    // trusted anchor, so retention still verifies the existing history.
    publishedCompleteEntry: complete ? stamp : null,
    testHooks,
  });
  return {
    dir,
    files,
    missing,
    complete,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    removed,
    at: now.toISOString(),
    ...(normalizedPurpose ? { purpose: normalizedPurpose } : {}),
  };
}

function normalizeSnapshotPurpose(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value?.type !== 'pre-migration'
    || !Number.isInteger(value.fromStateVersion) || value.fromStateVersion < 1
    || !Number.isInteger(value.toStateVersion) || value.toStateVersion <= value.fromStateVersion
    || typeof value.fromServerVersion !== 'string' || !value.fromServerVersion
    || typeof value.toServerVersion !== 'string' || !value.toServerVersion) {
    throw new Error('Invalid pre-migration backup purpose.');
  }
  return {
    type: 'pre-migration',
    fromStateVersion: value.fromStateVersion,
    toStateVersion: value.toStateVersion,
    fromServerVersion: value.fromServerVersion,
    toServerVersion: value.toServerVersion,
  };
}

function snapshotTargetIntegrity(path, targetKind, { maxBytes = null } = {}) {
  if (targetKind !== 'directory') {
    const file = hashRegularFileNoFollow(path, { maxBytes });
    return { kind: 'file', bytes: file.bytes, sha256: file.sha256 };
  }

  const digest = createHash('sha256');
  let bytes = 0;
  const visit = (directory, relativePath = '') => {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Snapshot directory target contains a non-directory entry at ${directory}`);
    }
    digest.update(`directory\0${relativePath}\0`);
    for (const name of readdirSync(directory).sort()) {
      const entryPath = join(directory, name);
      const entryRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const entryStat = lstatSync(entryPath);
      if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
        visit(entryPath, entryRelativePath);
      } else if (entryStat.isFile() && !entryStat.isSymbolicLink()) {
        const remainingBytes = maxBytes === null ? null : Math.max(0, maxBytes - bytes);
        const file = hashRegularFileNoFollow(entryPath, { maxBytes: remainingBytes });
        bytes += file.bytes;
        digest.update(`file\0${entryRelativePath}\0${file.bytes}\0${file.sha256}\0`);
      } else {
        throw new Error(`Snapshot directory target contains an unsupported entry at ${entryPath}`);
      }
    }
    const currentDirectoryStat = lstatSync(directory);
    if (!sameFileSnapshot(directoryStat, currentDirectoryStat)) {
      throw new Error(`Snapshot directory target changed while it was being inspected: ${directory}`);
    }
  };
  visit(path);
  return { kind: 'directory', bytes, sha256: digest.digest('hex') };
}

function hashRegularFileNoFollow(path, { maxBytes = null } = {}) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Snapshot target is not a regular file: ${path}`);
  }
  if (maxBytes !== null && before.size > maxBytes) {
    throw new Error(`Snapshot target exceeds its ${maxBytes}-byte limit: ${path}`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error(`Snapshot target changed while it was being inspected: ${path}`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const readLength = maxBytes === null
        ? buffer.length
        : Math.min(buffer.length, maxBytes + 1 - bytes);
      const bytesRead = readSync(fd, buffer, 0, readLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (maxBytes !== null && bytes > maxBytes) {
        throw new Error(`Snapshot target grew beyond its ${maxBytes}-byte limit: ${path}`);
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(fd);
    const current = lstatSync(path);
    if (after.size !== bytes
      || !after.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameFileSnapshot(opened, after)
      || !sameFileSnapshot(opened, current)) {
      throw new Error(`Snapshot target changed size while it was being inspected: ${path}`);
    }
    return { bytes, sha256: digest.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

async function snapshotTargetIntegrityAsync(path, targetKind, { maxBytes = null } = {}) {
  if (targetKind !== 'directory') {
    const file = await hashRegularFileNoFollowAsync(path, { maxBytes });
    return { kind: 'file', bytes: file.bytes, sha256: file.sha256 };
  }

  const digest = createHash('sha256');
  let bytes = 0;
  const visit = async (directory, relativePath = '') => {
    const directoryStat = await lstatAsync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error(`Snapshot directory target contains a non-directory entry at ${directory}`);
    }
    digest.update(`directory\0${relativePath}\0`);
    for (const name of (await readdirAsync(directory)).sort()) {
      const entryPath = join(directory, name);
      const entryRelativePath = relativePath ? `${relativePath}/${name}` : name;
      const entryStat = await lstatAsync(entryPath);
      if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
        await visit(entryPath, entryRelativePath);
      } else if (entryStat.isFile() && !entryStat.isSymbolicLink()) {
        const remainingBytes = maxBytes === null ? null : Math.max(0, maxBytes - bytes);
        const file = await hashRegularFileNoFollowAsync(entryPath, { maxBytes: remainingBytes });
        bytes += file.bytes;
        digest.update(`file\0${entryRelativePath}\0${file.bytes}\0${file.sha256}\0`);
      } else {
        throw new Error(`Snapshot directory target contains an unsupported entry at ${entryPath}`);
      }
    }
    const currentDirectoryStat = await lstatAsync(directory);
    if (!sameFileSnapshot(directoryStat, currentDirectoryStat)) {
      throw new Error(`Snapshot directory target changed while it was being inspected: ${directory}`);
    }
  };
  await visit(path);
  return { kind: 'directory', bytes, sha256: digest.digest('hex') };
}

async function hashRegularFileNoFollowAsync(path, { maxBytes = null } = {}) {
  const before = await lstatAsync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`Snapshot target is not a regular file: ${path}`);
  }
  if (maxBytes !== null && before.size > maxBytes) {
    throw new Error(`Snapshot target exceeds its ${maxBytes}-byte limit: ${path}`);
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await openAsync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileSnapshot(before, opened)) {
      throw new Error(`Snapshot target changed while it was being inspected: ${path}`);
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const readLength = maxBytes === null
        ? buffer.length
        : Math.min(buffer.length, maxBytes + 1 - bytes);
      const { bytesRead } = await handle.read(buffer, 0, readLength, null);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (maxBytes !== null && bytes > maxBytes) {
        throw new Error(`Snapshot target grew beyond its ${maxBytes}-byte limit: ${path}`);
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await lstatAsync(path);
    if (after.size !== bytes
      || !after.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || current.nlink !== 1
      || !sameFileSnapshot(opened, after)
      || !sameFileSnapshot(opened, current)) {
      throw new Error(`Snapshot target changed size while it was being inspected: ${path}`);
    }
    return { bytes, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function snapshotVerificationFingerprint(snapshotDir, metadata) {
  try {
    const digest = createHash('sha256');
    digest.update(JSON.stringify(metadata.manifest));
    const visit = async (path, relativePath) => {
      const stat = await lstatAsync(path);
      const kind = stat.isDirectory() && !stat.isSymbolicLink()
        ? 'directory'
        : stat.isFile() && !stat.isSymbolicLink()
          ? 'file'
          : 'unsupported';
      digest.update(`${kind}\0${relativePath}\0${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\0${stat.ctimeMs}\0`);
      if (kind === 'directory') {
        for (const name of (await readdirAsync(path)).sort()) {
          await visit(join(path, name), `${relativePath}/${name}`);
        }
      }
    };
    for (const record of metadata.integrityTargets) {
      await visit(join(snapshotDir, record.name), record.name);
    }
    return digest.digest('hex');
  } catch {
    return null;
  }
}

function copyDirectoryMaterialized(source, destination, activeDirectories = new Set()) {
  const sourceStat = statSync(source);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Directory backup source is not a directory: ${source}`);
  }
  const identity = `${sourceStat.dev}:${sourceStat.ino}`;
  if (activeDirectories.has(identity)) {
    throw new Error(`Directory backup contains a symlink cycle at ${source}`);
  }
  activeDirectories.add(identity);
  try {
    mkdirSync(destination, { mode: 0o700 });
    for (const entry of readdirSync(source)) {
      const sourcePath = join(source, entry);
      const destinationPath = join(destination, entry);
      const stat = statSync(sourcePath);
      if (stat.isDirectory()) {
        copyDirectoryMaterialized(sourcePath, destinationPath, activeDirectories);
      } else if (stat.isFile()) {
        copyFileSync(sourcePath, destinationPath);
      } else {
        throw new Error(`Directory backup contains an unsupported filesystem entry: ${sourcePath}`);
      }
    }
  } finally {
    activeDirectories.delete(identity);
  }
}

function copyWakeWordDirectory(source, destination) {
  const rootStat = statSync(source);
  if (!rootStat.isDirectory()) {
    throw new Error(`Wake-word backup source is not a directory: ${source}`);
  }
  const rootEntries = readdirSync(source);
  const allowedRootEntries = new Set(['models', 'registry.json', 'registry.json.bak']);
  const unexpectedRootEntry = rootEntries.find((entry) => !allowedRootEntries.has(entry));
  if (unexpectedRootEntry) {
    throw new Error(`Wake-word backup contains an unexpected entry: ${join(source, unexpectedRootEntry)}`);
  }

  const registryBackupPath = join(source, 'registry.json.bak');
  if (rootEntries.includes('registry.json.bak')) {
    // The previous registry is useful only to the live store. It is not part
    // of the internally consistent snapshot, but it must not be a disguised
    // link or special entry in restored state.
    observeRegularEntry(registryBackupPath, { maxBytes: MAX_WAKE_WORD_REGISTRY_BYTES });
  }

  const manifest = wakeWordBackupManifest(source);
  const expectedModels = new Map(manifest.models.map((model) => [model.name, model.byteSize]));
  const modelsPath = join(source, 'models');
  if (rootEntries.includes('models')) {
    const modelsStat = lstatSync(modelsPath);
    if (!modelsStat.isDirectory() || modelsStat.isSymbolicLink()) {
      throw new Error(`Wake-word backup models path is not a real directory: ${modelsPath}`);
    }
    const unexpectedModel = readdirSync(modelsPath).find((entry) => !expectedModels.has(entry));
    if (unexpectedModel) {
      throw new Error(`Wake-word backup contains an unregistered model entry: ${join(modelsPath, unexpectedModel)}`);
    }
  } else if (expectedModels.size > 0) {
    throw new Error(`Wake-word backup models directory is missing: ${modelsPath}`);
  }

  mkdirSync(destination, { mode: 0o700 });
  // The allowlist and copied registry must be the same stable generation.
  // Reopening registry.json here could otherwise pair a new registry with
  // model files selected from the old one during an ordinary atomic save.
  writeFileSync(join(destination, 'registry.json'), manifest.registryBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  // Preserve the empty directory too: the live store and persistent-state
  // validator treat it as part of the storage shape even with zero models.
  const destinationModels = join(destination, 'models');
  mkdirSync(destinationModels, { mode: 0o700 });
  for (const [name, byteSize] of expectedModels) {
    copyRegularFileNoFollow(join(modelsPath, name), join(destinationModels, name), {
      exactBytes: byteSize,
    });
  }
}

function observeRegularEntry(path, { exactBytes = null, maxBytes = null } = {}) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) {
    throw new Error(`Wake-word backup entry is not a regular file without extra links: ${path}`);
  }
  if ((exactBytes !== null && stat.size !== exactBytes)
    || (maxBytes !== null && stat.size > maxBytes)) {
    throw new Error(`Wake-word backup entry has an invalid size: ${path}`);
  }
  return stat;
}

function copyRegularFileNoFollow(source, destination, limits) {
  const before = observeRegularEntry(source, limits);
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const sourceFd = openSync(source, constants.O_RDONLY | noFollow);
  let destinationFd;
  try {
    const opened = fstatSync(sourceFd);
    if (!opened.isFile() || opened.nlink > 1
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`Wake-word backup entry changed during validation: ${source}`);
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let copied = 0;
    while (true) {
      const bytesRead = readSync(sourceFd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copied += bytesRead;
      if ((limits.exactBytes !== null && limits.exactBytes !== undefined && copied > limits.exactBytes)
        || (limits.maxBytes !== null && limits.maxBytes !== undefined && copied > limits.maxBytes)) {
        throw new Error(`Wake-word backup entry grew beyond its validated size: ${source}`);
      }
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(destinationFd, buffer, written, bytesRead - written);
        if (bytesWritten === 0) {
          throw new Error(`Wake-word backup could not make progress writing: ${destination}`);
        }
        written += bytesWritten;
      }
    }
    if (limits.exactBytes !== null && limits.exactBytes !== undefined && copied !== limits.exactBytes) {
      throw new Error(`Wake-word backup entry changed size during copy: ${source}`);
    }
    const after = fstatSync(sourceFd);
    const current = observeRegularEntry(source, limits);
    const samePathEntry = after.dev === current.dev && after.ino === current.ino;
    if (!after.isFile()
      || after.nlink > 1
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || (samePathEntry
        ? !sameFileSnapshot(after, current)
        : after.nlink !== 0)) {
      throw new Error(`Wake-word backup entry changed during copy: ${source}`);
    }
  } finally {
    if (destinationFd !== undefined) closeSync(destinationFd);
    closeSync(sourceFd);
  }
}

function writeSnapshotOwner(partialDir, stamp, backupIdentity) {
  writeFileSync(join(partialDir, SNAPSHOT_OWNER), `${JSON.stringify({
    version: 1,
    stamp,
    backupRoot: {
      dev: String(backupIdentity.dev),
      ino: String(backupIdentity.ino),
    },
  })}\n`, { flag: 'wx', mode: 0o600 });
}

function partialOwnershipIdentity(partialDir, stamp, backupIdentity, expectedPartialIdentity = null) {
  try {
    const partialStat = lstatSync(partialDir);
    if (!partialStat.isDirectory() || partialStat.isSymbolicLink()
      || (expectedPartialIdentity && (
        partialStat.dev !== expectedPartialIdentity.dev
        || partialStat.ino !== expectedPartialIdentity.ino
      ))) {
      return null;
    }
    const owner = parseBoundedJsonFileSync(join(partialDir, SNAPSHOT_OWNER), {
      maxBytes: MAX_SNAPSHOT_OWNER_BYTES,
      label: 'Snapshot ownership marker',
    });
    const owned = owner?.version === 1
      && owner.stamp === stamp
      && owner.backupRoot?.dev === String(backupIdentity.dev)
      && owner.backupRoot?.ino === String(backupIdentity.ino);
    const current = lstatSync(partialDir);
    return owned
      && current.isDirectory()
      && !current.isSymbolicLink()
      && current.dev === partialStat.dev
      && current.ino === partialStat.ino
      ? { dev: current.dev, ino: current.ino }
      : null;
  } catch {
    return null;
  }
}

function removeOwnedPartial(partialDir, stamp, backupIdentity, expectedPartialIdentity = null, removal = {}) {
  try {
    const backupDir = dirname(partialDir);
    assertDestinationIdentity(backupDir, backupIdentity);
    const ownedPartialIdentity = partialOwnershipIdentity(
      partialDir,
      stamp,
      backupIdentity,
      expectedPartialIdentity,
    );
    if (!ownedPartialIdentity) {
      return false;
    }
    removeOwnedDirectory(partialDir, ownedPartialIdentity, backupDir, backupIdentity, removal);
    return true;
  } catch {
    return false;
  }
}

// A marked, timestamp-shaped .partial directory is a Pictaria run that died
// mid-copy; preserve every ambiguous entry in case it belongs to the operator.
function removeStalePartials(backupDir, backupIdentity, testHooks = {}) {
  assertDestinationIdentity(backupDir, backupIdentity);
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith('.partial')) {
      continue;
    }
    const stamp = name.slice(0, -'.partial'.length);
    if (backupTimestamp(stamp) !== null) {
      removeOwnedPartial(join(backupDir, name), stamp, backupIdentity, null, {
        beforeRemoval: testHooks.beforeOwnedRemoval,
        kind: 'stale-partial',
      });
    }
  }
}

// Keep the newest `keep` manifest-confirmed complete recovery points. An
// incomplete snapshot never evicts a complete one. Legacy manifestless and
// malformed entries have no ownership evidence, so they remain unknown and
// are never automatically deleted.
export function rotateBackups(backupDir, keep, targets = [], {
  now = new Date(),
  publishedCompleteEntry = null,
  testHooks = {},
} = {}) {
  const backupIdentity = destinationIdentity(backupDir);
  if (!destinationMarkerIsRegular(backupDir)) {
    throw new Error(`Backup destination unavailable: ${backupDir} carries no regular ${DESTINATION_MARKER} marker.`);
  }
  const entries = listBackups(backupDir);
  const complete = [];
  const preMigration = [];
  const incomplete = [];
  const unknown = [];
  const owned = new Map();
  for (const entry of entries) {
    // Retention is a manifest/shape decision. Content verification belongs
    // to the newest-status and named migration-recovery paths; hashing every
    // byte of every retained snapshot after each backup makes retention cost
    // grow with the complete backup history.
    const status = readSnapshotStatus(join(backupDir, entry), targets, {
      verifyIntegrity: false,
      now,
    });
    const ownedSnapshotIdentity = snapshotOwnershipIdentity(join(backupDir, entry), targets, { now });
    if (ownedSnapshotIdentity) {
      owned.set(entry, ownedSnapshotIdentity);
    }
    if (status.state === 'incomplete') {
      incomplete.push(entry);
    } else if (status.state === 'complete') {
      if (status.purpose?.type === 'pre-migration') {
        preMigration.push(entry);
      } else {
        complete.push(entry);
      }
    } else {
      unknown.push(entry);
    }
  }
  const verifyNewestComplete = (candidates) => {
    for (const entry of [...candidates].reverse()) {
      if (entry === publishedCompleteEntry) {
        return entry;
      }
      const status = readSnapshotStatus(join(backupDir, entry), targets, {
        verifyIntegrity: true,
        now,
      });
      if (status.state === 'complete') {
        return entry;
      }
      candidates.splice(candidates.indexOf(entry), 1);
      (status.state === 'incomplete' ? incomplete : unknown).push(entry);
    }
    return null;
  };
  // Retention may use cheap metadata for its bounded history, but it may not
  // delete an older recovery point until a newer candidate has passed full
  // content verification. A complete snapshot published by this same run
  // reuses the integrity evidence produced while copying; restored or older
  // candidates are hashed, walking backward only when post-publication damage
  // is found. Pre-migration recovery points have their own dedicated slot.
  const verifiedComplete = verifyNewestComplete(complete);
  const verifiedPreMigration = verifyNewestComplete(preMigration);
  incomplete.sort();
  unknown.sort();
  // Keep one dedicated rollback point outside normal retention. A later
  // state migration supersedes the older one only after its own snapshot has
  // passed full content verification.
  const keepPreMigration = verifiedPreMigration ?? null;
  const newestComplete = complete.at(-1) ?? null;
  const unresolvedIncomplete = incomplete.filter((entry) => !newestComplete || entry > newestComplete);
  // If the newest run is incomplete, keep the already-bounded set of nominal
  // recovery points until a new complete snapshot is published. This avoids
  // deleting the last healthy older point based only on cheap metadata if a
  // newer retained snapshot suffered same-size damage.
  const keepComplete = new Set(
    unresolvedIncomplete.length > 0 || !verifiedComplete
      ? complete
      : complete.slice(-Math.max(1, keep)),
  );
  const keepIncomplete = unresolvedIncomplete.at(-1) ?? null;
  const keepUnknown = new Set(
    unknown.filter((entry) => !newestComplete || entry > newestComplete),
  );
  const excess = entries.filter((entry) => (
    owned.has(entry)
      && !keepComplete.has(entry)
      && entry !== keepPreMigration
      && (!preMigration.includes(entry) || Boolean(verifiedPreMigration))
      && entry !== keepIncomplete
      && !keepUnknown.has(entry)
  ));
  for (const entry of excess) {
    removeOwnedDirectory(join(backupDir, entry), owned.get(entry), backupDir, backupIdentity, {
      beforeRemoval: testHooks.beforeOwnedRemoval,
      kind: 'retention',
    });
  }
  return excess.length;
}

function snapshotOwnershipIdentity(snapshotDir, targets, { now = new Date() } = {}) {
  try {
    return readSnapshotMetadata(snapshotDir, targets, { now }).identity;
  } catch {
    return null;
  }
}

function removeOwnedDirectory(entryPath, expectedIdentity, backupDir, backupIdentity, {
  beforeRemoval = null,
  kind = 'cleanup',
} = {}) {
  assertDestinationIdentity(backupDir, backupIdentity);
  if (!destinationMarkerIsRegular(backupDir)) {
    throw new Error(`Backup destination unavailable: ${backupDir} lost its regular ${DESTINATION_MARKER} marker.`);
  }
  beforeRemoval?.({ entryPath, kind });
  const current = lstatSync(entryPath);
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== expectedIdentity.dev || current.ino !== expectedIdentity.ino) {
    throw new Error(`Backup entry changed before owned cleanup: ${entryPath}. It was preserved.`);
  }
  // Keep this identity check beside the destructive sink. The cross-process
  // lock prevents another legitimate backup process from racing the check.
  assertDestinationIdentity(backupDir, backupIdentity);
  if (!destinationMarkerIsRegular(backupDir)) {
    throw new Error(`Backup destination unavailable: ${backupDir} lost its regular ${DESTINATION_MARKER} marker.`);
  }
  rmSync(entryPath, { recursive: true, force: true });
}

export function readSnapshotStatus(snapshotDir, targets = [], {
  verifyIntegrity = true,
  now = new Date(),
} = {}) {
  try {
    const metadata = readSnapshotMetadata(snapshotDir, targets, { now });
    const damagedRoles = metadata.integrityTargets.flatMap((record) => (
      snapshotRecordIsValid(snapshotDir, record, metadata.expectedTargets.get(record.name), { verifyIntegrity })
        ? []
        : [record.name]
    ));
    return snapshotStatusFromMetadata(metadata, damagedRoles);
  } catch {
    return unknownSnapshotStatus();
  }
}

async function readSnapshotStatusAsync(snapshotDir, targets = [], { now = new Date() } = {}) {
  try {
    const metadata = readSnapshotMetadata(snapshotDir, targets, { now });
    const cacheKey = `${snapshotDir}\0${targets.map(({ role, kind }) => `${role}:${kind}`).join(',')}`;
    const beforeFingerprint = await snapshotVerificationFingerprint(snapshotDir, metadata);
    const cached = snapshotVerificationCache.get(cacheKey);
    if (beforeFingerprint && cached?.fingerprint === beforeFingerprint
      && Date.now() - cached.verifiedAt < SNAPSHOT_VERIFICATION_TTL_MS) {
      return cached.status;
    }

    const damagedRoles = [];
    // Verify sequentially to avoid making a NAS seek across several large
    // snapshot files at once. File reads are asynchronous, so the server can
    // continue serving Frame and Settings requests while this runs.
    for (const record of metadata.integrityTargets) {
      const expected = metadata.expectedTargets.get(record.name);
      if (!await snapshotRecordIsValidAsync(snapshotDir, record, expected)) {
        damagedRoles.push(record.name);
      }
    }
    const status = snapshotStatusFromMetadata(metadata, damagedRoles);
    const afterFingerprint = await snapshotVerificationFingerprint(snapshotDir, metadata);
    if (!beforeFingerprint || beforeFingerprint !== afterFingerprint) {
      return unknownSnapshotStatus();
    }
    cacheSnapshotVerification(cacheKey, {
      fingerprint: afterFingerprint,
      status,
      verifiedAt: Date.now(),
    });
    return status;
  } catch {
    return unknownSnapshotStatus();
  }
}

function cacheSnapshotVerification(key, value) {
  snapshotVerificationCache.delete(key);
  snapshotVerificationCache.set(key, value);
  while (snapshotVerificationCache.size > MAX_SNAPSHOT_VERIFICATION_CACHE_ENTRIES) {
    snapshotVerificationCache.delete(snapshotVerificationCache.keys().next().value);
  }
}

function readSnapshotMetadata(snapshotDir, targets, { now = new Date() } = {}) {
  const snapshotStat = lstatSync(snapshotDir);
  if (!snapshotStat.isDirectory() || snapshotStat.isSymbolicLink()) {
    throw new Error('Snapshot path is not a real directory.');
  }
  const manifest = parseBoundedJsonFileSync(join(snapshotDir, SNAPSHOT_MANIFEST), {
    maxBytes: MAX_SNAPSHOT_MANIFEST_BYTES,
    label: 'Snapshot manifest',
  });
  if (![1, 2].includes(manifest?.version) || typeof manifest.complete !== 'boolean'
    || !Array.isArray(manifest.missing)
    || !manifest.missing.every(isSafeSnapshotRole)
    || new Set(manifest.missing).size !== manifest.missing.length
    || manifest.complete !== (manifest.missing.length === 0)) {
    throw new Error('Snapshot manifest is invalid.');
  }
  const purpose = manifest.purpose === undefined
    ? null
    : normalizeSnapshotPurpose(manifest.purpose);
  const directoryAt = backupTimestamp(basename(snapshotDir));
  const manifestAt = parseSnapshotCreatedAt(manifest.createdAt);
  const currentAt = validDate(now, 'Current backup time');
  if (!directoryAt || !manifestAt
    || Math.abs(manifestAt.getTime() - directoryAt.getTime()) > MAX_SNAPSHOT_CLOCK_SKEW_MS
    || directoryAt.getTime() > currentAt.getTime() + MAX_SNAPSHOT_CLOCK_SKEW_MS
    || manifestAt.getTime() > currentAt.getTime() + MAX_SNAPSHOT_CLOCK_SKEW_MS) {
    throw new Error('Snapshot timestamps are invalid, inconsistent, or implausibly future-dated.');
  }
  const createdAt = manifestAt.toISOString();
  const expectedTargets = new Map(targets.map((target) => [target.role, target]));
  let integrityTargets;
  if (manifest.version === 2) {
    if (!Array.isArray(manifest.targets)
      || !manifest.targets.every(validSnapshotIntegrityRecord)
      || new Set(manifest.targets.map((target) => target.name)).size !== manifest.targets.length
      || manifest.targets.some((target) => manifest.missing.includes(target.name))) {
      throw new Error('Snapshot integrity manifest is invalid.');
    }
    integrityTargets = manifest.targets;
    if (expectedTargets.size > 0) {
      const accountedRoles = new Set([
        ...manifest.missing,
        ...integrityTargets.map((target) => target.name),
      ]);
      if (accountedRoles.size !== expectedTargets.size
        || [...accountedRoles].some((role) => !expectedTargets.has(role))) {
        throw new Error('Snapshot targets do not match the current recovery inventory.');
      }
    }
  } else {
    integrityTargets = targets
      .filter((target) => !manifest.missing.includes(target.role))
      .map((target) => ({
        name: target.role,
        kind: target.kind === 'directory' ? 'directory' : 'file',
        bytes: null,
        sha256: null,
      }));
  }
  const currentSnapshotStat = lstatSync(snapshotDir);
  if (!currentSnapshotStat.isDirectory() || currentSnapshotStat.isSymbolicLink()
    || currentSnapshotStat.dev !== snapshotStat.dev
    || currentSnapshotStat.ino !== snapshotStat.ino) {
    throw new Error('Snapshot directory changed while its ownership was being validated.');
  }
  return {
    manifest,
    purpose,
    createdAt,
    expectedTargets,
    integrityTargets,
    identity: { dev: snapshotStat.dev, ino: snapshotStat.ino },
  };
}

function snapshotRecordIsValid(snapshotDir, record, expected, { verifyIntegrity }) {
  const targetKind = expected?.kind ?? record.kind;
  const path = join(snapshotDir, record.name);
  try {
    if (expected?.maxBytes && record.bytes !== null && record.bytes > expected.maxBytes) {
      return false;
    }
    if (verifyIntegrity) {
      // Inspect the filesystem shape without following links before any
      // target-specific validator is allowed to read the restored entry.
      const actual = snapshotTargetIntegrity(path, targetKind, { maxBytes: expected?.maxBytes ?? null });
      if (record.bytes !== null
        && (actual.kind !== record.kind
          || actual.bytes !== record.bytes
          || actual.sha256 !== record.sha256)) {
        return false;
      }
      if (expected && !inspectPersistentTarget({ ...expected, path }).valid) {
        return false;
      }
      return true;
    }

    const stat = lstatSync(path);
    if (targetKind === 'directory') {
      if (record.kind !== 'directory' || !stat.isDirectory() || stat.isSymbolicLink()) {
        return false;
      }
      if (expected?.maxBytes) {
        // Retention needs a cheap compatibility check for legacy manifests,
        // not a second content hash. Bound the filesystem shape and declared
        // bytes without opening model contents; explicit status/restore still
        // performs the full target-specific integrity validation.
        const inspectShape = expected.inspectRetention ?? inspectDirectoryShape;
        const shape = inspectShape(path, {
          maxBytes: expected.maxBytes,
          maxEntries: expected.maxEntries ?? Number.MAX_SAFE_INTEGER,
        });
        return record.bytes === null || shape.bytes === record.bytes;
      }
      return true;
    }
    return record.kind === 'file' && stat.isFile() && !stat.isSymbolicLink()
      && stat.nlink === 1
      && (!expected?.maxBytes || stat.size <= expected.maxBytes)
      && (record.bytes === null || stat.size === record.bytes);
  } catch {
    return false;
  }
}

function inspectWakeWordRetentionShape(rootPath, limits) {
  const shape = inspectDirectoryShape(rootPath, limits);
  const rootEntries = readdirSync(rootPath);
  const allowedRootEntries = new Set(['models', 'registry.json', 'registry.json.bak']);
  if (!rootEntries.includes('registry.json') || !rootEntries.includes('models')
    || rootEntries.some((entry) => !allowedRootEntries.has(entry))) {
    throw new Error('Legacy wake-word snapshot has an invalid root inventory.');
  }

  const manifest = wakeWordBackupManifest(rootPath);
  const expectedModels = new Map(manifest.models.map((model) => [model.name, model.byteSize]));
  const modelsPath = join(rootPath, 'models');
  const modelEntries = readdirSync(modelsPath);
  if (modelEntries.length !== expectedModels.size
    || modelEntries.some((entry) => !expectedModels.has(entry))) {
    throw new Error('Legacy wake-word snapshot has an invalid model inventory.');
  }
  for (const [name, byteSize] of expectedModels) {
    const stat = lstatSync(join(modelsPath, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== byteSize) {
      throw new Error(`Legacy wake-word snapshot has an invalid model entry: ${name}`);
    }
  }
  return shape;
}

function inspectDirectoryShape(rootPath, { maxBytes, maxEntries }) {
  let bytes = 0;
  let entries = 0;
  const visit = (directory) => {
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error(`Snapshot directory target contains a non-directory entry at ${directory}`);
    }
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entries += 1;
        if (entries > maxEntries) {
          throw new Error(`Snapshot directory target exceeds its ${maxEntries}-entry limit.`);
        }
        const entryPath = join(directory, entry.name);
        const stat = lstatSync(entryPath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          visit(entryPath);
        } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
          if (!Number.isSafeInteger(stat.size) || !Number.isSafeInteger(bytes + stat.size)) {
            throw new Error('Snapshot directory target has an unsafe aggregate size.');
          }
          bytes += stat.size;
          if (bytes > maxBytes) {
            throw new Error(`Snapshot directory target exceeds its ${maxBytes}-byte limit.`);
          }
        } else {
          throw new Error(`Snapshot directory target contains an unsupported entry at ${entryPath}`);
        }
      }
    } finally {
      handle.closeSync();
    }
    const after = lstatSync(directory);
    if (!sameFileSnapshot(before, after)) {
      throw new Error(`Snapshot directory target changed while it was being inspected: ${directory}`);
    }
  };
  visit(rootPath);
  return { bytes, entries };
}

async function snapshotRecordIsValidAsync(snapshotDir, record, expected) {
  const targetKind = expected?.kind ?? record.kind;
  const path = join(snapshotDir, record.name);
  try {
    if (expected?.maxBytes && record.bytes !== null && record.bytes > expected.maxBytes) {
      return false;
    }
    const actual = await snapshotTargetIntegrityAsync(path, targetKind, { maxBytes: expected?.maxBytes ?? null });
    if (record.bytes !== null
      && (actual.kind !== record.kind
        || actual.bytes !== record.bytes
        || actual.sha256 !== record.sha256)) {
      return false;
    }
    // Version-two content was structurally validated immediately before its
    // digest was recorded. Matching that digest proves the bytes are still
    // the validated copy, so do not synchronously reopen SQLite databases or
    // re-read and re-hash wake-word models on the request path. Version-one
    // manifests have no digest and retain their structural compatibility
    // check; named migration recovery uses the synchronous deep path above.
    return record.bytes !== null
      || !expected
      || inspectPersistentTarget({ ...expected, path }).valid;
  } catch {
    return false;
  }
}

function snapshotStatusFromMetadata({ manifest, purpose, createdAt }, damagedRoles) {
  const missing = [...new Set([...manifest.missing, ...damagedRoles])];
  if (damagedRoles.length > 0) {
    return {
      state: 'incomplete',
      complete: false,
      missing,
      createdAt,
      damaged: true,
      ...(purpose ? { purpose } : {}),
    };
  }
  return {
    state: manifest.complete ? 'complete' : 'incomplete',
    complete: manifest.complete,
    missing,
    createdAt,
    damaged: false,
    ...(purpose ? { purpose } : {}),
  };
}

function unknownSnapshotStatus() {
  return { state: 'unknown', complete: null, missing: [], createdAt: null };
}

function isSafeSnapshotRole(role) {
  return typeof role === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(role)
    && role !== SNAPSHOT_MANIFEST
    && role !== DESTINATION_MARKER;
}

function validSnapshotIntegrityRecord(record) {
  return record && isSafeSnapshotRole(record.name)
    && ['file', 'directory'].includes(record.kind)
    && Number.isSafeInteger(record.bytes) && record.bytes >= 0
    && typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256);
}

export function listBackups(backupDir) {
  try {
    return readdirSync(backupDir)
      .filter((name) => backupTimestamp(name) !== null)
      .filter((name) => {
        const stat = lstatIfExists(join(backupDir, name));
        return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
      })
      .sort();
  } catch {
    return [];
  }
}

export function newestBackupAt(backupDir, { now = new Date() } = {}) {
  const currentAt = validDate(now, 'Current backup time');
  const newest = listBackups(backupDir).findLast((entry) => (
    backupTimestamp(entry).getTime() <= currentAt.getTime() + MAX_SNAPSHOT_CLOCK_SKEW_MS
  ));
  if (!newest) {
    return null;
  }
  // Folder name is an ISO minute stamp: 2026-07-09-23-40 → 2026-07-09T23:40Z
  return backupTimestamp(newest);
}

export function newestCompleteBackupAt(backupDir, targets = [], {
  verifyIntegrity = true,
  now = new Date(),
} = {}) {
  for (const entry of [...listBackups(backupDir)].reverse()) {
    const status = readSnapshotStatus(join(backupDir, entry), targets, { verifyIntegrity, now });
    if (status.state === 'complete' && status.purpose?.type !== 'pre-migration') {
      return new Date(status.createdAt);
    }
  }
  return null;
}

function backupTimestamp(entry) {
  const match = BACKUP_NAME_PATTERN.exec(entry);
  if (!match) {
    return null;
  }
  const [, y, m, d, hh, mm] = match;
  const timestamp = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm)));
  return timestamp.getUTCFullYear() === Number(y)
    && timestamp.getUTCMonth() === Number(m) - 1
    && timestamp.getUTCDate() === Number(d)
    && timestamp.getUTCHours() === Number(hh)
    && timestamp.getUTCMinutes() === Number(mm)
    ? timestamp
    : null;
}

function parseSnapshotCreatedAt(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
    ? timestamp
    : null;
}

function validDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

export async function newestCompleteBackupAtAsync(backupDir, targets = [], { now = new Date() } = {}) {
  for (const entry of [...listBackups(backupDir)].reverse()) {
    const status = await readSnapshotStatusAsync(join(backupDir, entry), targets, { now });
    if (status.state === 'complete' && status.purpose?.type !== 'pre-migration') {
      return new Date(status.createdAt);
    }
  }
  return null;
}

export function newestBackupStatus(backupDir, targets = []) {
  const newest = listBackups(backupDir).at(-1);
  if (!newest) {
    return null;
  }
  const dir = join(backupDir, newest);
  const status = readSnapshotStatus(dir, targets);
  return {
    dir,
    at: status.createdAt ?? newestBackupAt(backupDir)?.toISOString() ?? null,
    complete: status.complete,
    missing: status.missing.map((name) => ({ name })),
    legacy: status.state === 'unknown',
    ...(status.damaged === true ? { damaged: true } : {}),
  };
}

export async function newestBackupStatusAsync(backupDir, targets = []) {
  const newest = listBackups(backupDir).at(-1);
  if (!newest) {
    return null;
  }
  const dir = join(backupDir, newest);
  const status = await readSnapshotStatusAsync(dir, targets);
  return {
    dir,
    at: status.createdAt ?? newestBackupAt(backupDir)?.toISOString() ?? null,
    complete: status.complete,
    missing: status.missing.map((name) => ({ name })),
    legacy: status.state === 'unknown',
    ...(status.damaged === true ? { damaged: true } : {}),
  };
}
