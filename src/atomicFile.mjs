import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';

function temporarySibling(filePath) {
  return `${filePath}.${process.pid}.${randomUUID()}.tmp`;
}

export function writePrivateFileAtomicSync(filePath, value, options = {}) {
  const parentPath = dirname(filePath);
  mkdirSync(parentPath, { recursive: true, mode: 0o700 });
  const parentIdentity = requireDirectory(statSync(parentPath), parentPath);
  const temporaryPath = temporarySibling(filePath);
  let descriptor;
  let temporaryIdentity;
  try {
    descriptor = openSync(temporaryPath, privateExclusiveWriteFlags(), 0o600);
    temporaryIdentity = requirePrivateRegularFile(fstatSync(descriptor), temporaryPath);
    writeFileSync(descriptor, value, options);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifyReplacementBoundary({ parentPath, parentIdentity, temporaryPath, temporaryIdentity });
    renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original write failure.
      }
    }
    removeOwnedTemporarySync(temporaryPath, temporaryIdentity);
    throw error;
  }
}

export async function writePrivateFileAtomic(filePath, value, options = {}, testHooks = {}) {
  const parentPath = dirname(filePath);
  await fs.mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parentIdentity = requireDirectory(await fs.stat(parentPath), parentPath);
  const temporaryPath = temporarySibling(filePath);
  let handle;
  let temporaryIdentity;
  try {
    handle = await fs.open(temporaryPath, privateExclusiveWriteFlags(), 0o600);
    temporaryIdentity = requirePrivateRegularFile(await handle.stat(), temporaryPath);
    await handle.writeFile(value, options);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await testHooks.beforeReplace?.({ temporaryPath });
    await verifyReplacementBoundaryAsync({ parentPath, parentIdentity, temporaryPath, temporaryIdentity });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await removeOwnedTemporary(temporaryPath, temporaryIdentity);
    throw error;
  }
}

function privateExclusiveWriteFlags() {
  return constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_EXCL
    | (constants.O_NOFOLLOW ?? 0);
}

function requireDirectory(stats, path) {
  if (!stats.isDirectory()) {
    throw new Error(`Atomic write destination parent is not a directory: ${path}`);
  }
  return fileIdentity(stats);
}

function requirePrivateRegularFile(stats, path) {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw new Error(`Atomic write temporary entry is unsafe: ${path}`);
  }
  return fileIdentity(stats);
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameEntry(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyReplacementBoundary({ parentPath, parentIdentity, temporaryPath, temporaryIdentity }) {
  const currentParent = requireDirectory(statSync(parentPath), parentPath);
  const currentTemporary = requirePrivateRegularFile(lstatSync(temporaryPath), temporaryPath);
  if (!sameEntry(parentIdentity, currentParent) || !sameEntry(temporaryIdentity, currentTemporary)) {
    throw new Error('Atomic write boundary changed before replacement.');
  }
}

async function verifyReplacementBoundaryAsync({ parentPath, parentIdentity, temporaryPath, temporaryIdentity }) {
  const currentParent = requireDirectory(await fs.stat(parentPath), parentPath);
  const currentTemporary = requirePrivateRegularFile(await fs.lstat(temporaryPath), temporaryPath);
  if (!sameEntry(parentIdentity, currentParent) || !sameEntry(temporaryIdentity, currentTemporary)) {
    throw new Error('Atomic write boundary changed before replacement.');
  }
}

function removeOwnedTemporarySync(temporaryPath, temporaryIdentity) {
  if (!temporaryIdentity) {
    return;
  }
  try {
    const stats = lstatSync(temporaryPath);
    if (!stats.isFile() || stats.nlink !== 1) {
      return;
    }
    const current = fileIdentity(stats);
    if (sameEntry(temporaryIdentity, current)) {
      // unlink removes the directory entry itself and never follows its target.
      unlinkSync(temporaryPath);
    }
  } catch {
    // It may have been replaced, removed, or already renamed.
  }
}

async function removeOwnedTemporary(temporaryPath, temporaryIdentity) {
  if (!temporaryIdentity) {
    return;
  }
  try {
    const stats = await fs.lstat(temporaryPath);
    if (!stats.isFile() || stats.nlink !== 1) {
      return;
    }
    const current = fileIdentity(stats);
    if (sameEntry(temporaryIdentity, current)) {
      await fs.unlink(temporaryPath);
    }
  } catch {
    // It may have been replaced, removed, or already renamed.
  }
}
