import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { lstat, open } from 'node:fs/promises';

const READ_CHUNK_BYTES = 64 * 1024;
const MAX_READ_ATTEMPTS = 2;

export function readBoundedRegularFileSync(filePath, {
  maxBytes,
  label = 'File',
  testHooks = {},
}) {
  requireByteLimit(maxBytes);
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    try {
      return readBoundedRegularFileSyncOnce(filePath, { maxBytes, label, testHooks, attempt });
    } catch (error) {
      if (error?.code !== 'EBOUNDEDFILECHANGED' || attempt + 1 === MAX_READ_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw changedFileError(filePath, label);
}

function readBoundedRegularFileSyncOnce(filePath, { maxBytes, label, testHooks, attempt }) {
  const beforeStats = lstatSync(filePath);
  testHooks.afterPathStat?.({ attempt, phase: 'before-open', stats: beforeStats });
  const before = requireBoundedEntry(beforeStats, filePath, maxBytes, label);
  const descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    testHooks.afterOpen?.({ attempt, filePath });
    const opened = requireOpenedBoundedEntry(fstatSync(descriptor), filePath, maxBytes, label);
    requireSameSnapshot(before, opened, filePath, label);
    const bytes = readDescriptorBoundedSync(descriptor, maxBytes, filePath, label);
    testHooks.afterRead?.({ attempt, filePath });
    const after = requireOpenedBoundedEntry(fstatSync(descriptor), filePath, maxBytes, label);
    const currentStats = lstatSync(filePath);
    testHooks.afterPathStat?.({ attempt, phase: 'after-read', stats: currentStats });
    const current = requireBoundedEntry(currentStats, filePath, maxBytes, label);
    requireSameSnapshot(opened, after, filePath, label);
    requireSameSnapshot(opened, current, filePath, label);
    if (after.size !== bytes.length) {
      throw changedFileError(filePath, label);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export async function readBoundedRegularFile(filePath, {
  maxBytes,
  label = 'File',
  testHooks = {},
}) {
  requireByteLimit(maxBytes);
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readBoundedRegularFileOnce(filePath, { maxBytes, label, testHooks, attempt });
    } catch (error) {
      if (error?.code !== 'EBOUNDEDFILECHANGED' || attempt + 1 === MAX_READ_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw changedFileError(filePath, label);
}

async function readBoundedRegularFileOnce(filePath, { maxBytes, label, testHooks, attempt }) {
  const beforeStats = await lstat(filePath);
  await testHooks.afterPathStat?.({ attempt, phase: 'before-open', stats: beforeStats });
  const before = requireBoundedEntry(beforeStats, filePath, maxBytes, label);
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    await testHooks.afterOpen?.({ attempt, filePath });
    const opened = requireOpenedBoundedEntry(await handle.stat(), filePath, maxBytes, label);
    requireSameSnapshot(before, opened, filePath, label);
    const bytes = await readHandleBounded(handle, maxBytes, filePath, label);
    await testHooks.afterRead?.({ attempt, filePath });
    const after = requireOpenedBoundedEntry(await handle.stat(), filePath, maxBytes, label);
    const currentStats = await lstat(filePath);
    await testHooks.afterPathStat?.({ attempt, phase: 'after-read', stats: currentStats });
    const current = requireBoundedEntry(currentStats, filePath, maxBytes, label);
    requireSameSnapshot(opened, after, filePath, label);
    requireSameSnapshot(opened, current, filePath, label);
    if (after.size !== bytes.length) {
      throw changedFileError(filePath, label);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export function parseBoundedJsonFileSync(filePath, options) {
  return JSON.parse(readBoundedRegularFileSync(filePath, options).toString('utf8'));
}

export async function parseBoundedJsonFile(filePath, options) {
  return JSON.parse((await readBoundedRegularFile(filePath, options)).toString('utf8'));
}

function readDescriptorBoundedSync(descriptor, maxBytes, filePath, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw oversizedFileError(filePath, maxBytes, label);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function readHandleBounded(handle, maxBytes, filePath, label) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      throw oversizedFileError(filePath, maxBytes, label);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function requireByteLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes === Number.MAX_SAFE_INTEGER) {
    throw new TypeError('Bounded file reads require a positive safe byte limit.');
  }
}

function requireBoundedEntry(stats, filePath, maxBytes, label) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
    throw new Error(`${label} at ${filePath} is not a regular file without extra links.`);
  }
  if (stats.size > maxBytes) {
    throw oversizedFileError(filePath, maxBytes, label);
  }
  return snapshot(stats);
}

function requireOpenedBoundedEntry(stats, filePath, maxBytes, label) {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink > 1) {
    throw new Error(`${label} at ${filePath} is not a regular opened file.`);
  }
  if (stats.size > maxBytes) {
    throw oversizedFileError(filePath, maxBytes, label);
  }
  return snapshot(stats);
}

function snapshot(stats) {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function requireSameSnapshot(expected, actual, filePath, label) {
  if (expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs
    || expected.ctimeMs !== actual.ctimeMs) {
    throw changedFileError(filePath, label);
  }
}

function oversizedFileError(filePath, maxBytes, label) {
  return new Error(`${label} at ${filePath} exceeds the ${maxBytes}-byte limit.`);
}

function changedFileError(filePath, label) {
  const error = new Error(`${label} at ${filePath} changed while it was being read.`);
  error.code = 'EBOUNDEDFILECHANGED';
  return error;
}
