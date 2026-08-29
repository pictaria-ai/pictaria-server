import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const SQLITE_SIDECARS = Object.freeze(['-wal', '-shm']);

export class PrivateDatabasePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PrivateDatabasePathError';
    this.code = 'unsafe_private_database_path';
  }
}

// SQLite accepts only a pathname, not an already verified descriptor. Pin the
// configured parent, reject link/hard-link entries, and prove the file opened
// with O_NOFOLLOW is the same contained entry seen by lstat before SQLite gets
// the path. Restored state is static at startup; the identity recheck also
// closes the practical substitution window before chmod or SQLite migration.
export function assertPrivateDatabasePath(dbPath, {
  allowMissing = false,
  readOnly = true,
} = {}) {
  const filePath = resolve(String(dbPath));
  const parentPath = dirname(filePath);
  const parent = directoryBoundary(parentPath);
  const main = inspectEntry(filePath, {
    allowMissing,
    readOnly,
    parent,
  });
  if (!main) {
    return { exists: false, path: filePath };
  }
  for (const suffix of SQLITE_SIDECARS) {
    inspectEntry(`${filePath}${suffix}`, {
      allowMissing: true,
      readOnly,
      parent,
    });
  }
  assertSameDirectory(parent, directoryBoundary(parentPath));
  return { exists: true, path: filePath };
}

// SQLite does not expose a creation-mode or no-follow option. Create the main
// file ourselves with private permissions and exclusive/no-follow flags, then
// validate all restored entries before SQLite opens anything for migration.
export function preparePrivateDatabasePath(dbPath, logger = console) {
  const filePath = resolve(String(dbPath));
  const parentPath = dirname(filePath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });

  const existing = assertPrivateDatabasePath(filePath, {
    allowMissing: true,
    readOnly: false,
  });
  if (!existing.exists) {
    createPrivateDatabaseFile(filePath);
  }
  assertPrivateDatabasePath(filePath, { readOnly: false });
  restrictPrivateDatabaseModes(filePath, logger);
}

// Re-assert every mode after WAL activation as defense in depth. Unsafe
// restored entries are rejected before chmod; permission errors on otherwise
// safe exotic filesystems retain the established warn-and-continue behavior.
export function restrictPrivateDatabaseModes(dbPath, logger = console) {
  const filePath = resolve(String(dbPath));
  assertPrivateDatabasePath(filePath, { readOnly: true });
  try {
    chmodSync(filePath, 0o600);
    for (const suffix of SQLITE_SIDECARS) {
      try {
        lstatSync(`${filePath}${suffix}`);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          continue;
        }
        throw error;
      }
      chmodSync(`${filePath}${suffix}`, 0o600);
    }
  } catch (error) {
    logger.warn?.(
      `[Pictaria] Could not restrict permissions on ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function createPrivateDatabaseFile(filePath) {
  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function inspectEntry(filePath, { allowMissing, readOnly, parent }) {
  let pathStats;
  try {
    pathStats = lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      return null;
    }
    throw unsafe(filePath, error?.code === 'ENOENT' ? 'entry is missing' : error.message);
  }

  requireSingleLinkRegularFile(filePath, pathStats);
  const canonicalPath = realpathSync.native(filePath);
  if (dirname(canonicalPath) !== parent.canonical
    || basename(canonicalPath) !== basename(filePath)) {
    throw unsafe(filePath, `entry escapes configured database directory ${parent.path}`);
  }

  let descriptor;
  try {
    descriptor = openSync(
      filePath,
      (readOnly ? constants.O_RDONLY : constants.O_RDWR) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedStats = fstatSync(descriptor);
    requireSingleLinkRegularFile(filePath, openedStats);
    if (!sameIdentity(pathStats, openedStats)) {
      throw unsafe(filePath, 'entry changed while it was being verified');
    }
  } catch (error) {
    if (error instanceof PrivateDatabasePathError) {
      throw error;
    }
    throw unsafe(filePath, `entry could not be opened without following links: ${error.message}`);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
  assertSameDirectory(parent, directoryBoundary(parent.path));
  return fileIdentity(pathStats);
}

function directoryBoundary(parentPath) {
  let stats;
  try {
    // The configured path is an operator-controlled boundary. Follow links in
    // that path (including a configured bind/symlink), then pin the resolved
    // directory identity while validating the untrusted entries inside it.
    stats = statSync(parentPath);
  } catch (error) {
    if (error instanceof PrivateDatabasePathError) {
      throw error;
    }
    throw unsafe(parentPath, `database directory is unavailable: ${error.message}`);
  }
  if (!stats.isDirectory()) {
    throw unsafe(parentPath, 'database parent is not a directory');
  }
  return {
    path: parentPath,
    canonical: realpathSync.native(parentPath),
    ...fileIdentity(stats),
  };
}

function requireSingleLinkRegularFile(filePath, stats) {
  if (!stats.isFile()) {
    throw unsafe(filePath, 'entry is not a regular file');
  }
  if (stats.nlink !== 1) {
    throw unsafe(filePath, 'entry has multiple hard links');
  }
}

function assertSameDirectory(expected, current) {
  if (!sameIdentity(expected, current) || expected.canonical !== current.canonical) {
    throw unsafe(expected.path, 'database directory changed while entries were being verified');
  }
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unsafe(path, reason) {
  return new PrivateDatabasePathError(`Unsafe SQLite path at ${path}: ${reason}.`);
}
