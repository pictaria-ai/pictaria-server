import { existsSync, lstatSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { writePrivateFileAtomicSync } from './atomicFile.mjs';
import { parseBoundedJsonFileSync } from './boundedFile.mjs';
import { assertPrivateDatabasePath } from './privateDatabase.mjs';

export const PERSISTENT_STATE_ROLE = 'persistent-state.json';
export const MAX_PERSISTENT_STATE_BYTES = 64 * 1024;

// These roles contain state that cannot be reconstructed faithfully from
// Immich. Once the inventory records them, startup must never convert a
// missing target into healthy empty state.
export const PROTECTED_PERSISTENT_ROLES = Object.freeze([
  'enrichment.sqlite',
  'settings.json',
  'smart-albums.json',
  'frame.db',
  'wake-word-models',
]);

// Insights is a cache of Immich metadata. Recreating it is intentional: the
// collector repopulates it from Immich, so its absence must not take the
// server down with the irreplaceable targets above.
export const RECOMPUTABLE_PERSISTENT_ROLES = Object.freeze([
  'insights.sqlite',
]);

const INVENTORY_VERSION = 1;
const TARGET_MISSING_REASON = 'target is missing';
const MARKER_NOTE = 'Pictaria persistent-state inventory marker. '
  + 'If persistent-state.json is missing while this file remains, do not initialize replacement state.\n';

export class PersistentStateError extends Error {
  constructor(message, { code = 'persistent_state_error', missingRoles = [] } = {}) {
    super(message);
    this.name = 'PersistentStateError';
    this.code = code;
    this.missingRoles = missingRoles;
  }
}

export class PersistentStateGuard {
  constructor({ inventoryPath, markerPath, legacySettingsMarkerPath = null, targets, now = () => new Date() }) {
    this.inventoryPath = inventoryPath;
    this.markerPath = markerPath;
    this.legacySettingsMarkerPath = legacySettingsMarkerPath;
    this.targets = new Map(
      targets
        .filter((target) => target.role !== PERSISTENT_STATE_ROLE)
        .map((target) => [target.role, target]),
    );
    this.now = now;
    this.inventory = null;
    this.mode = null;
  }

  // Runs before any store or SQLite repository opens. A markerless volume is
  // the one migration boundary: it may be a genuinely fresh installation or
  // a pre-v1 installation whose old code allowed some state never to exist.
  // After seal(), the durable inventory makes every later loss unambiguous.
  preflight() {
    let parsed;
    try {
      parsed = parseBoundedJsonFileSync(this.inventoryPath, {
        maxBytes: MAX_PERSISTENT_STATE_BYTES,
        label: 'Persistent-state inventory',
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new PersistentStateError(
          `Persistent-state inventory at ${this.inventoryPath} is unreadable: ${error.message}`,
          { code: 'persistent_state_inventory_unreadable' },
        );
      }
      if (existsSync(this.markerPath)) {
        throw new PersistentStateError(
          `Persistent-state inventory is missing at ${this.inventoryPath}, but this installation was already initialized. `
          + 'Restore persistent-state.json from a complete backup. Pictaria refused to initialize replacement state.',
          { code: 'persistent_state_inventory_missing', missingRoles: [PERSISTENT_STATE_ROLE] },
        );
      }
      const settingsTarget = this.targets.get('settings.json');
      if (this.legacySettingsMarkerPath && existsSync(this.legacySettingsMarkerPath)
        && settingsTarget && !existsSync(settingsTarget.path)) {
        throw new PersistentStateError(
          `Previously initialized settings state is missing at ${settingsTarget.path}. `
          + `Restore settings.json before upgrading. To deliberately accept the loss on this one-time migration, `
          + `stop Pictaria and remove the legacy marker at ${this.legacySettingsMarkerPath}. `
          + 'Pictaria refused to initialize replacement settings.',
          { code: 'persistent_state_legacy_settings_missing', missingRoles: ['settings.json'] },
        );
      }
      const unsafeExistingDatabases = [...this.targets.entries()].flatMap(([role, target]) => {
        if (target.kind !== 'sqlite' || !pathEntryExists(target.path)) {
          return [];
        }
        const status = inspectPersistentTarget(target);
        return status.valid ? [] : [{ role, target, reason: status.reason }];
      });
      if (unsafeExistingDatabases.length > 0) {
        throw missingStateError(unsafeExistingDatabases);
      }
      this.mode = 'initialize';
      return { mode: this.mode, missingRoles: [] };
    }

    this.inventory = normalizeInventory(parsed, this.inventoryPath);
    const degradedRoles = [];
    const missingTargets = this.inventory.protectedRoles.flatMap((role) => {
      const target = this.targets.get(role);
      if (!target) {
        throw new PersistentStateError(
          `Persistent-state inventory expects ${role}, but this server version has no matching backup target.`,
          { code: 'persistent_state_target_unknown', missingRoles: [role] },
        );
      }
      const status = inspectPersistentTarget(target);
      if (!status.valid && target.failureMode === 'degrade' && status.degradable === true) {
        degradedRoles.push(role);
        return [];
      }
      return status.valid ? [] : [{ role, target, reason: status.reason }];
    });
    if (missingTargets.length > 0) {
      throw missingStateError(missingTargets);
    }

    // Missing recomputable state is healthy, but an existing unsafe cache is
    // not: SQLite would otherwise follow it before the collector can rebuild.
    const unsafeRecomputableTargets = this.inventory.recomputableRoles.flatMap((role) => {
      const target = this.targets.get(role);
      if (!target || !pathEntryExists(target.path)) {
        return [];
      }
      const status = inspectPersistentTarget(target);
      return status.valid ? [] : [{ role, target, reason: status.reason }];
    });
    if (unsafeRecomputableTargets.length > 0) {
      throw missingStateError(unsafeRecomputableTargets);
    }

    this.mode = 'verify';
    return {
      mode: this.mode,
      missingRoles: [],
      ...(degradedRoles.length > 0 ? { degradedRoles } : {}),
    };
  }

  // Called only after every store completed its own initialization. Writing
  // the inventory before the marker keeps both crash windows safe: a lone
  // inventory is sufficient after restore, while a lone marker always blocks
  // replacement state rather than blessing an empty install.
  seal({ successfulStateVersion = null, successfulServerVersion = null } = {}) {
    if (!this.mode) {
      throw new PersistentStateError('Persistent-state preflight must run before seal().');
    }

    const allRoles = [...PROTECTED_PERSISTENT_ROLES, ...RECOMPUTABLE_PERSISTENT_ROLES];
    const missingTargets = allRoles.flatMap((role) => {
      const target = this.targets.get(role);
      if (!target) {
        return [{ role, target: null, reason: 'no matching persistent target is configured' }];
      }
      const status = inspectPersistentTarget(target);
      if (!status.valid && target.failureMode === 'degrade' && status.degradable === true) {
        return [];
      }
      return status.valid ? [] : [{ role, target, reason: status.reason }];
    });
    if (missingTargets.length > 0) {
      const missingRoles = missingTargets.map(({ role }) => role);
      throw new PersistentStateError(
        `Persistent state did not finish initializing: ${missingRoles.join(', ')}. `
        + 'Pictaria refused to mark this installation healthy.',
        { code: 'persistent_state_initialization_incomplete', missingRoles },
      );
    }

    const completedAt = this.now().toISOString();
    const upgrade = successfulStateVersion === null && successfulServerVersion === null
      ? this.inventory?.upgrade ?? null
      : completeUpgradeState(
          this.inventory?.upgrade ?? null,
          successfulStateVersion,
          successfulServerVersion,
          completedAt,
        );
    const payload = {
      version: INVENTORY_VERSION,
      initializedAt: this.inventory?.initializedAt ?? completedAt,
      protectedRoles: [...PROTECTED_PERSISTENT_ROLES],
      recomputableRoles: [...RECOMPUTABLE_PERSISTENT_ROLES],
      ...(upgrade ? { upgrade } : {}),
    };
    persistPrivateJson(this.inventoryPath, payload);
    if (!existsSync(this.markerPath)) {
      persistPrivateText(this.markerPath, MARKER_NOTE);
    }
    // A settings-specific marker can predate the shared inventory. Honor it
    // during the one migration boot, then retire it only after the global
    // inventory and marker are durable, ensuring the documented two-file
    // destructive reset never has a hidden third gate.
    if (this.legacySettingsMarkerPath && existsSync(this.legacySettingsMarkerPath)) {
      try {
        rmSync(this.legacySettingsMarkerPath);
      } catch (error) {
        throw new PersistentStateError(
          `Persistent state was sealed, but the superseded settings marker at `
          + `${this.legacySettingsMarkerPath} could not be removed: ${error.message}`,
          { code: 'persistent_state_legacy_marker_cleanup_failed' },
        );
      }
    }
    this.inventory = payload;
    this.mode = 'verify';
    return structuredClone(payload);
  }

  upgradeState() {
    if (!this.mode) {
      throw new PersistentStateError('Persistent-state preflight must run before reading upgrade state.');
    }
    return this.inventory?.upgrade ? structuredClone(this.inventory.upgrade) : null;
  }

  recordPendingUpgrade(pending) {
    if (this.mode !== 'verify' || !this.inventory) {
      throw new PersistentStateError(
        'A pre-migration recovery point can only be recorded for an initialized installation.',
        { code: 'persistent_state_upgrade_not_initialized' },
      );
    }
    const normalizedPending = normalizeUpgradePoint(pending, 'pending upgrade');
    const current = this.inventory.upgrade;
    if (!current || current.stateVersion !== normalizedPending.fromStateVersion) {
      throw new PersistentStateError(
        'The pending upgrade does not start from the installation\'s last successful persistent-state version.',
        { code: 'persistent_state_upgrade_version_mismatch' },
      );
    }
    const payload = {
      ...this.inventory,
      upgrade: {
        ...current,
        pending: normalizedPending,
      },
    };
    persistPrivateJson(this.inventoryPath, payload);
    this.inventory = normalizeInventory(payload, this.inventoryPath);
    return structuredClone(this.inventory.upgrade.pending);
  }
}

export function inspectPersistentTarget(target) {
  if (!pathEntryExists(target.path)) {
    return { valid: false, reason: TARGET_MISSING_REASON };
  }
  if (typeof target.validate !== 'function') {
    return { valid: true, reason: null };
  }
  try {
    const result = target.validate(target.path);
    if (result === true || result?.valid === true) {
      return { valid: true, reason: null };
    }
    return {
      valid: false,
      ...(result?.degradable === true ? { degradable: true } : {}),
      reason: typeof result?.reason === 'string' && result.reason
        ? result.reason
        : 'target failed its persistent-state validation',
    };
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function validateSqlitePersistentState(path, requiredTables = []) {
  let database;
  try {
    assertPrivateDatabasePath(path, { readOnly: true });
    const stat = statSync(path);
    if (!stat.isFile() || stat.size === 0) {
      return { valid: false, reason: 'SQLite file is empty or is not a regular file' };
    }
    database = new DatabaseSync(path, { readOnly: true });
    const tables = new Set(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const missingTables = requiredTables.filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
      return { valid: false, reason: `SQLite schema is missing: ${missingTables.join(', ')}` };
    }
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: `SQLite file is unreadable: ${error.message}` };
  } finally {
    try {
      database?.close();
    } catch {
      // Opening or schema inspection already supplied the useful reason.
    }
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export function validatePersistentStateInventory(path) {
  try {
    normalizeInventory(parseBoundedJsonFileSync(path, {
      maxBytes: MAX_PERSISTENT_STATE_BYTES,
      label: 'Persistent-state inventory',
    }), path);
    return { valid: true, reason: null };
  } catch (error) {
    return { valid: false, reason: `persistent-state inventory is unreadable: ${error.message}` };
  }
}

function normalizeInventory(value, inventoryPath) {
  if (!value || value.version !== INVENTORY_VERSION
    || typeof value.initializedAt !== 'string'
    || !Array.isArray(value.protectedRoles)
    || !value.protectedRoles.every((role) => typeof role === 'string')
    || !Array.isArray(value.recomputableRoles)
    || !value.recomputableRoles.every((role) => typeof role === 'string')
    || !sameRoleSet(value.protectedRoles, PROTECTED_PERSISTENT_ROLES)
    || !sameRoleSet(value.recomputableRoles, RECOMPUTABLE_PERSISTENT_ROLES)) {
    throw new PersistentStateError(
      `Persistent-state inventory at ${inventoryPath} has an unsupported or invalid shape.`,
      { code: 'persistent_state_inventory_invalid' },
    );
  }
  const upgrade = value.upgrade === undefined
    ? null
    : normalizeUpgradeState(value.upgrade, inventoryPath);
  return {
    version: INVENTORY_VERSION,
    initializedAt: value.initializedAt,
    protectedRoles: [...PROTECTED_PERSISTENT_ROLES],
    recomputableRoles: [...RECOMPUTABLE_PERSISTENT_ROLES],
    ...(upgrade ? { upgrade } : {}),
  };
}

function normalizeUpgradeState(value, inventoryPath) {
  if (!value || !Number.isInteger(value.stateVersion) || value.stateVersion < 1
    || typeof value.serverVersion !== 'string' || !value.serverVersion
    || typeof value.succeededAt !== 'string'
    || !Object.hasOwn(value, 'pending')
    || !Object.hasOwn(value, 'recoveryPoint')) {
    throw new PersistentStateError(
      `Persistent-state inventory at ${inventoryPath} has invalid upgrade metadata.`,
      { code: 'persistent_state_inventory_invalid' },
    );
  }
  const pending = value.pending === null
    ? null
    : normalizeUpgradePoint(value.pending, 'pending upgrade');
  const recoveryPoint = value.recoveryPoint === null
    ? null
    : normalizeUpgradePoint(value.recoveryPoint, 'recovery point');
  if (pending && pending.fromStateVersion !== value.stateVersion) {
    throw new PersistentStateError(
      `Persistent-state inventory at ${inventoryPath} has a pending upgrade from the wrong version.`,
      { code: 'persistent_state_inventory_invalid' },
    );
  }
  return {
    stateVersion: value.stateVersion,
    serverVersion: value.serverVersion,
    succeededAt: value.succeededAt,
    recoveryPoint,
    pending,
  };
}

function normalizeUpgradePoint(value, label) {
  if (!value || !Number.isInteger(value.fromStateVersion) || value.fromStateVersion < 1
    || !Number.isInteger(value.toStateVersion) || value.toStateVersion <= value.fromStateVersion
    || typeof value.fromServerVersion !== 'string' || !value.fromServerVersion
    || typeof value.toServerVersion !== 'string' || !value.toServerVersion
    || typeof value.snapshotName !== 'string'
    || !new RegExp(
      `^\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-pre-migration-v${value.fromStateVersion}-to-v${value.toStateVersion}$`,
    ).test(value.snapshotName)
    || typeof value.createdAt !== 'string') {
    throw new PersistentStateError(
      `Persistent-state ${label} metadata is invalid.`,
      { code: 'persistent_state_inventory_invalid' },
    );
  }
  return {
    fromStateVersion: value.fromStateVersion,
    toStateVersion: value.toStateVersion,
    fromServerVersion: value.fromServerVersion,
    toServerVersion: value.toServerVersion,
    snapshotName: value.snapshotName,
    createdAt: value.createdAt,
  };
}

function completeUpgradeState(current, stateVersion, serverVersion, succeededAt) {
  if (!Number.isInteger(stateVersion) || stateVersion < 1
    || typeof serverVersion !== 'string' || !serverVersion) {
    throw new PersistentStateError(
      'A successful startup needs a positive persistent-state version and non-empty server version.',
      { code: 'persistent_state_upgrade_version_invalid' },
    );
  }
  if (current && stateVersion < current.stateVersion) {
    throw new PersistentStateError(
      `Cannot mark persistent-state version ${stateVersion} successful after version ${current.stateVersion}.`,
      { code: 'persistent_state_upgrade_version_mismatch' },
    );
  }
  if (current && stateVersion > current.stateVersion && !current.pending) {
    throw new PersistentStateError(
      `Cannot advance persistent state from version ${current.stateVersion} to ${stateVersion} without a recorded pre-migration recovery point.`,
      { code: 'persistent_state_upgrade_recovery_required' },
    );
  }
  if (current?.pending && current.pending.toStateVersion !== stateVersion) {
    throw new PersistentStateError(
      `The pending upgrade targets persistent-state version ${current.pending.toStateVersion}, not ${stateVersion}.`,
      { code: 'persistent_state_upgrade_version_mismatch' },
    );
  }
  return {
    stateVersion,
    serverVersion,
    succeededAt,
    recoveryPoint: current?.pending ?? current?.recoveryPoint ?? null,
    pending: null,
  };
}

function sameRoleSet(actual, expected) {
  const roles = new Set(actual);
  return actual.length === expected.length
    && roles.size === expected.length
    && expected.every((role) => roles.has(role));
}

function missingStateError(missingTargets) {
  const missingRoles = missingTargets.map(({ role }) => role);
  const details = missingTargets
    .map(({ role, target, reason }) => `${role} (${target.path}; ${reason})`)
    .join(', ');
  const everyTargetIsMissing = missingTargets.every(({ reason }) => reason === TARGET_MISSING_REASON);
  const message = everyTargetIsMissing
    ? `Previously initialized persistent state is missing: ${details}. `
      + 'Restore the missing target(s) from a complete backup before restarting. '
      + 'Pictaria refused to recreate empty state over the loss.'
    : `Previously initialized persistent state is unusable: ${details}. `
      + 'Restore or repair the affected target(s) as described in docs/BACKUP.md before restarting. '
      + 'When restoring, use ordinary file copies rather than symbolic or hard links. '
      + 'Pictaria left the existing state unchanged.';
  return new PersistentStateError(
    message,
    { code: 'persistent_state_missing', missingRoles },
  );
}

function persistPrivateJson(path, value) {
  persistPrivateText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function persistPrivateText(path, value) {
  writePrivateFileAtomicSync(path, value, { encoding: 'utf8' });
}
