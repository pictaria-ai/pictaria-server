import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { writePrivateFileAtomic } from '../atomicFile.mjs';
import { readBoundedRegularFileSync } from '../boundedFile.mjs';
import { MAX_WAKE_WORD_SHAPE_DIMENSIONS } from './modelInspector.mjs';

const EMPTY_STATE = Object.freeze({ version: 1, models: [] });
export const MAX_WAKE_WORD_MODELS = 20;
export const MAX_WAKE_WORD_MODEL_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_WAKE_WORD_REGISTRY_BYTES = 1024 * 1024;
// Upload quotas are operator policy. These immutable restore limits are a
// wider compatibility envelope for state accepted by an earlier release.
export const MAX_RESTORED_WAKE_WORD_MODELS = 100;
export const MAX_RESTORED_WAKE_WORD_MODEL_BYTES = 5 * 1024 * 1024;
export const MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_RESTORED_WAKE_WORD_SNAPSHOT_BYTES =
  MAX_WAKE_WORD_REGISTRY_BYTES + MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES;
// A legacy snapshot may contain registry.json.bak in addition to the current
// registry, models directory, and every restored model allowed above.
export const MAX_RESTORED_WAKE_WORD_SNAPSHOT_ENTRIES =
  MAX_RESTORED_WAKE_WORD_MODELS + 3;
const MAX_RESTORED_WAKE_WORD_METADATA_BYTES = 1024;

// Backups use the registry as an allowlist rather than walking the complete
// restored directory. Keep this projection beside registry normalization so
// the backup path cannot accept a looser model-id or byte-count contract.
export function wakeWordBackupManifest(directoryPath) {
  const registryBytes = readBoundedRegularFileSync(path.join(directoryPath, 'registry.json'), {
    maxBytes: MAX_WAKE_WORD_REGISTRY_BYTES,
    label: 'Wake-word registry',
  });
  const registry = normalizeState(JSON.parse(registryBytes.toString('utf8')));
  // Admission quotas constrain new uploads; they do not make previously
  // accepted state disposable when a later release lowers a quota. The
  // backup reader independently bounds registry bytes and copies only exact
  // registered files. Absolute restored-state bounds belong to that reader,
  // not to the current upload policy.
  return {
    registryBytes,
    models: registry.models.map((model) => ({
      name: `${model.id}.tflite`,
      byteSize: model.byteSize,
    })),
  };
}

export class WakeWordModelStoreError extends Error {
  constructor(message, { code = 'wake_word_model_error', status = 400 } = {}) {
    super(message);
    this.name = 'WakeWordModelStoreError';
    this.code = code;
    this.status = status;
  }
}

// The persistent-state guard and backup runner call this before the store has
// a chance to initialize. The directory alone is not sufficient evidence:
// losing registry.json while leaving its parent behind used to make load()
// publish an empty registry over the loss. Recorded model files are part of
// the same state and must still match both the size and SHA-256 recorded by
// the registry. Size alone cannot distinguish a same-length replacement.
export function validateWakeWordPersistentState(directoryPath) {
  try {
    const boundary = inspectStorageDirectoriesSync(
      directoryPath,
      path.join(directoryPath, 'models'),
    );
    const registry = normalizeState(
      JSON.parse(readContainedFileSync(path.join(directoryPath, 'registry.json'), boundary.root, {
        maxBytes: MAX_WAKE_WORD_REGISTRY_BYTES,
      }).toString('utf8')),
    );
    requireWakeWordInventorySync(directoryPath, registry);
    for (const model of registry.models) {
      const modelPath = path.join(directoryPath, 'models', `${model.id}.tflite`);
      const inspected = hashContainedFileSync(modelPath, boundary.models, {
        exactBytes: model.byteSize,
        maxBytes: MAX_RESTORED_WAKE_WORD_MODEL_BYTES,
      });
      if (inspected.bytes !== model.byteSize) {
        return { valid: false, reason: `model file is missing or incomplete: ${model.id}.tflite` };
      }
      if (inspected.sha256 !== model.sha256) {
        return { valid: false, reason: `model file failed its SHA-256 integrity check: ${model.id}.tflite` };
      }
    }
    return { valid: true, reason: null };
  } catch (error) {
    return {
      valid: false,
      ...(error instanceof WakeWordModelStoreError && error.code === 'wake_word_storage_unsafe'
        ? { degradable: true }
        : {}),
      reason: error?.code === 'ENOENT'
        ? 'registry.json or a recorded model file is missing'
        : `wake-word registry is unreadable: ${error.message}`,
    };
  }
}

function requireWakeWordInventorySync(directoryPath, registry) {
  const rootEntries = readdirSync(directoryPath);
  const allowedRootEntries = new Set(['models', 'registry.json', 'registry.json.bak']);
  const unexpectedRootEntry = rootEntries.find((entry) => !allowedRootEntries.has(entry));
  if (unexpectedRootEntry) {
    throw storageError(
      path.join(directoryPath, unexpectedRootEntry),
      new Error(`unexpected entry in wake-word storage: ${unexpectedRootEntry}`),
    );
  }
  if (rootEntries.includes('registry.json.bak')) {
    const backupPath = path.join(directoryPath, 'registry.json.bak');
    const stat = lstatSync(backupPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1
      || stat.size > MAX_WAKE_WORD_REGISTRY_BYTES) {
      throw storageError(
        backupPath,
        new Error('registry.json.bak is not a bounded regular file without extra links'),
      );
    }
  }

  const modelsPath = path.join(directoryPath, 'models');
  const modelEntries = readdirSync(modelsPath);
  const expectedModels = new Set(registry.models.map((model) => `${model.id}.tflite`));
  const unexpectedModel = modelEntries.find((entry) => !expectedModels.has(entry));
  if (unexpectedModel) {
    throw storageError(
      path.join(modelsPath, unexpectedModel),
      new Error(`unexpected entry in wake-word model storage: ${unexpectedModel}`),
    );
  }
}

export class WakeWordModelStore {
  constructor(directoryPath, {
    maxModels = MAX_WAKE_WORD_MODELS,
    maxTotalBytes = MAX_WAKE_WORD_MODEL_TOTAL_BYTES,
    logger = console,
  } = {}) {
    if (!Number.isSafeInteger(maxModels) || maxModels < 1
      || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
      throw new TypeError('Wake-word model quotas must be positive safe integers.');
    }
    this.directoryPath = directoryPath;
    this.modelsPath = path.join(directoryPath, 'models');
    this.registryPath = path.join(directoryPath, 'registry.json');
    this.state = structuredClone(EMPTY_STATE);
    this.unavailable = new Map();
    this.storageFailure = null;
    this.loadPromise = null;
    this.writeQueue = Promise.resolve();
    this.maxModels = maxModels;
    this.maxTotalBytes = maxTotalBytes;
    this.logger = logger;
  }

  load() {
    this.loadPromise ??= this.#load().catch((error) => {
      if (error instanceof WakeWordModelStoreError && error.code === 'wake_word_storage_unsafe') {
        this.storageFailure = storageUnavailableError();
        this.logger.warn?.(
          `[Pictaria] Custom wake-word model storage is disabled: ${error.message} `
          + 'Built-in wake-word support remains available; the suspect storage was not changed.',
        );
        return this;
      }
      this.loadPromise = null;
      throw error;
    });
    return this.loadPromise;
  }

  async #load() {
    let boundary;
    try {
      boundary = await prepareStorageDirectories(this.directoryPath, this.modelsPath);
    } catch (error) {
      throw storageError(this.directoryPath, error);
    }
    try {
      this.state = normalizeState(JSON.parse(
        (await readContainedFile(this.registryPath, boundary.root, {
          maxBytes: MAX_WAKE_WORD_REGISTRY_BYTES,
        })).toString('utf8'),
      ));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new WakeWordModelStoreError(
          `Wake-word model registry at ${this.registryPath} is unreadable: ${error.message}`,
          { code: 'wake_word_registry_unreadable', status: 500 },
        );
      }
      this.state = structuredClone(EMPTY_STATE);
      await this.#persist(this.state);
    }
    requireWakeWordInventorySync(this.directoryPath, this.state);
    await this.#auditFiles();
    this.storageFailure = null;
    return this;
  }

  async listModels() {
    await this.load();
    this.#requireStorage();
    return this.state.models.map((model) => ({
      ...copyModel(model),
      available: !this.unavailable.has(model.id),
      unavailableReason: this.unavailable.get(model.id) ?? null,
    }));
  }

  async addModel({ displayName, phrase, defaultThreshold, originalFilename, bytes, inspection }) {
    await this.load();
    this.#requireStorage();
    if (!validAdmissionShape(inspection?.inputShape)
      || !validAdmissionShape(inspection?.outputShape)) {
      throw new WakeWordModelStoreError('Wake-word model metadata contains invalid model dimensions.', {
        code: 'invalid_wake_word_model',
        status: 400,
      });
    }
    const hash = sha256(bytes);
    const task = this.writeQueue.then(async () => {
      const duplicate = this.state.models.find((model) => model.sha256 === hash);
      if (duplicate) {
        throw new WakeWordModelStoreError(
          `That model is already uploaded as "${duplicate.displayName}".`,
          { code: 'duplicate_wake_word_model', status: 409 },
        );
      }

      // Check both quotas inside the same queue that commits the registry.
      // This makes the decision atomic across concurrent uploads and happens
      // before even a temporary model file is allocated.
      const nextCount = this.state.models.length + 1;
      const storedBytes = this.state.models.reduce((total, model) => total + model.byteSize, 0);
      const nextBytes = storedBytes + bytes.byteLength;
      if (!Number.isSafeInteger(nextBytes)
        || nextCount > this.maxModels
        || nextBytes > this.maxTotalBytes) {
        throw new WakeWordModelStoreError(
          `Custom wake-word storage is limited to ${this.maxModels} models and ${formatMiB(this.maxTotalBytes)} MiB. Delete an unused model before uploading another.`,
          { code: 'wake_word_model_quota_exceeded', status: 409 },
        );
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const model = {
        id,
        displayName,
        phrase,
        defaultThreshold,
        originalFilename,
        byteSize: bytes.byteLength,
        sha256: hash,
        createdAt,
        updatedAt: createdAt,
        rightsConfirmedAt: createdAt,
        ...inspection,
      };
      const nextState = normalizeState({ ...this.state, models: [...this.state.models, model] });
      const finalPath = this.#modelPath(model);
      const boundary = await inspectStorageDirectories(this.directoryPath, this.modelsPath);
      const createdIdentity = await createContainedFile(finalPath, bytes, boundary.models);
      try {
        await this.#persist(nextState);
        this.state = nextState;
        this.unavailable.delete(id);
      } catch (error) {
        await removeContainedFile(finalPath, boundary.models, createdIdentity).catch(() => {});
        throw error;
      }
      return copyModel(model);
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async deleteModel(modelId) {
    await this.load();
    this.#requireStorage();
    const task = this.writeQueue.then(async () => {
      const model = this.state.models.find((candidate) => candidate.id === modelId);
      if (!model) {
        return false;
      }
      const nextState = {
        ...this.state,
        models: this.state.models.filter((candidate) => candidate.id !== modelId),
      };
      await this.#persist(nextState);
      this.state = nextState;
      this.unavailable.delete(modelId);
      const boundary = await inspectStorageDirectories(this.directoryPath, this.modelsPath);
      await removeContainedFile(this.#modelPath(model), boundary.models).catch((error) => {
        if (error?.code !== 'ENOENT') {
          console.warn(`[Pictaria] Could not remove retired wake-word model ${modelId}: ${error.message}`);
        }
      });
      return true;
    });
    this.writeQueue = task.catch(() => {});
    return task;
  }

  async readModel(modelId) {
    await this.load();
    this.#requireStorage();
    const model = this.state.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new WakeWordModelStoreError('Wake-word model not found.', {
        code: 'wake_word_model_not_found',
        status: 404,
      });
    }
    let bytes;
    let boundary;
    try {
      boundary = await inspectStorageDirectories(this.directoryPath, this.modelsPath);
      bytes = await readContainedFile(this.#modelPath(model), boundary.models, {
        maxBytes: Math.min(model.byteSize, MAX_RESTORED_WAKE_WORD_MODEL_BYTES),
      });
    } catch (error) {
      if (!boundary) {
        throw storageUnavailableError();
      }
      try {
        await assertDirectoryBoundary(boundary.root);
        await assertDirectoryBoundary(boundary.models);
      } catch {
        throw storageUnavailableError();
      }
      if (error?.code === 'ENOENT') {
        this.unavailable.set(model.id, 'Model file is missing from persistent storage.');
        throw new WakeWordModelStoreError('The model file is missing from server storage.', {
          code: 'wake_word_model_unavailable',
          status: 409,
        });
      }
      if (error instanceof WakeWordModelStoreError && error.code === 'wake_word_storage_unsafe') {
        // A replaced storage directory is an installation-level safety
        // failure. A bad entry inside an otherwise pinned models directory is
        // only an unavailable model and must not expose filesystem detail.
        this.unavailable.set(model.id, 'Model file is unavailable in persistent storage.');
        throw new WakeWordModelStoreError('The model file is unavailable in server storage.', {
          code: 'wake_word_model_unavailable',
          status: 409,
        });
      }
      if (typeof error?.code === 'string') {
        this.unavailable.set(model.id, 'Model file could not be read from persistent storage.');
        throw new WakeWordModelStoreError('The model file could not be read from server storage.', {
          code: 'wake_word_model_unavailable',
          status: 409,
        });
      }
      this.unavailable.set(model.id, 'Model file failed its size or SHA-256 integrity check.');
      throw new WakeWordModelStoreError('The model file failed its integrity check.', {
        code: 'wake_word_model_unavailable',
        status: 409,
      });
    }
    if (bytes.byteLength !== model.byteSize || sha256(bytes) !== model.sha256) {
      this.unavailable.set(model.id, 'Model file failed its size or SHA-256 integrity check.');
      throw new WakeWordModelStoreError('The model file failed its integrity check.', {
        code: 'wake_word_model_unavailable',
        status: 409,
      });
    }
    this.unavailable.delete(model.id);
    return { bytes, model: copyModel(model) };
  }

  async #auditFiles() {
    this.unavailable.clear();
    for (const model of this.state.models) {
      try {
        const boundary = await inspectStorageDirectories(this.directoryPath, this.modelsPath);
        const stat = await inspectContainedFile(this.#modelPath(model), boundary.models);
        if (!stat.isFile() || stat.size !== model.byteSize) {
          this.unavailable.set(model.id, 'Model file size does not match the registry.');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          this.logger.warn?.(
            `[Pictaria] Wake-word model ${model.id} was unavailable during storage audit: ${error.message}`,
          );
        }
        this.unavailable.set(
          model.id,
          error?.code === 'ENOENT'
            ? 'Model file is missing from persistent storage.'
            : 'Model file is unavailable in persistent storage.',
        );
      }
    }
  }

  #modelPath(model) {
    return path.join(this.modelsPath, `${model.id}.tflite`);
  }

  #requireStorage() {
    if (this.storageFailure) {
      throw this.storageFailure;
    }
  }

  async #persist(state) {
    const boundary = await inspectStorageDirectories(this.directoryPath, this.modelsPath);
    const payload = encodeRegistry(state);
    const previous = await readContainedFile(this.registryPath, boundary.root, {
      maxBytes: MAX_WAKE_WORD_REGISTRY_BYTES,
    }).catch((error) => {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    });
    if (previous) {
      await writePrivateFileAtomic(`${this.registryPath}.bak`, previous).catch(() => {});
    }
    await writePrivateFileAtomic(this.registryPath, payload, { encoding: 'utf8' });
  }
}

async function prepareStorageDirectories(rootPath, modelsPath) {
  await fs.mkdir(rootPath, { recursive: true, mode: 0o700 });
  const root = await inspectConfiguredDirectory(rootPath);
  try {
    await fs.mkdir(modelsPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
  const boundary = await inspectStorageDirectories(rootPath, modelsPath);
  assertDirectoryIdentity(root, boundary.root);
  return boundary;
}

async function inspectStorageDirectories(rootPath, modelsPath) {
  const root = await inspectConfiguredDirectory(rootPath);
  const models = await inspectRealDirectory(modelsPath);
  if (path.dirname(models.canonical) !== root.canonical) {
    throw storageError(modelsPath, new Error('models directory escapes the configured wake-word root'));
  }
  await assertDirectoryBoundary(root);
  await assertDirectoryBoundary(models);
  return { root, models };
}

function inspectStorageDirectoriesSync(rootPath, modelsPath) {
  const root = inspectConfiguredDirectorySync(rootPath);
  const models = inspectRealDirectorySync(modelsPath);
  if (path.dirname(models.canonical) !== root.canonical) {
    throw storageError(modelsPath, new Error('models directory escapes the configured wake-word root'));
  }
  assertDirectoryBoundarySync(root);
  assertDirectoryBoundarySync(models);
  return { root, models };
}

// The root itself comes from trusted operator configuration and may normally
// be a bind mount or symbolic link. Resolve and pin its directory identity;
// entries selected from inside it still use no-follow checks below.
async function inspectConfiguredDirectory(directoryPath) {
  const stats = await fs.stat(directoryPath);
  if (!stats.isDirectory()) {
    throw storageError(directoryPath, new Error('configured storage root is not a directory'));
  }
  return {
    path: directoryPath,
    canonical: await fs.realpath(directoryPath),
    followsConfiguredPath: true,
    ...fileIdentity(stats),
  };
}

function inspectConfiguredDirectorySync(directoryPath) {
  const stats = statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw storageError(directoryPath, new Error('configured storage root is not a directory'));
  }
  return {
    path: directoryPath,
    canonical: realpathSync.native(directoryPath),
    followsConfiguredPath: true,
    ...fileIdentity(stats),
  };
}

async function inspectRealDirectory(directoryPath) {
  const stats = await fs.lstat(directoryPath);
  if (!stats.isDirectory()) {
    throw storageError(directoryPath, new Error('expected a real directory, not a link or special entry'));
  }
  return {
    path: directoryPath,
    canonical: await fs.realpath(directoryPath),
    ...fileIdentity(stats),
  };
}

function inspectRealDirectorySync(directoryPath) {
  const stats = lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw storageError(directoryPath, new Error('expected a real directory, not a link or special entry'));
  }
  return {
    path: directoryPath,
    canonical: realpathSync.native(directoryPath),
    ...fileIdentity(stats),
  };
}

async function readContainedFile(filePath, directory, { maxBytes = null } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readContainedFileOnce(filePath, directory, { maxBytes });
    } catch (error) {
      if (!isContainedFileChange(error) || attempt === 1) {
        throw isContainedFileChange(error) ? storageError(filePath, error) : error;
      }
    }
  }
  throw new Error('unreachable');
}

async function readContainedFileOnce(filePath, directory, { maxBytes = null } = {}) {
  const opened = await openContainedFile(filePath, directory);
  try {
    if (maxBytes !== null && opened.stats.size > maxBytes) {
      throw new Error(`file exceeds the ${maxBytes}-byte limit`);
    }
    const bytes = maxBytes === null
      ? await opened.handle.readFile()
      : await readHandleWithLimit(opened.handle, maxBytes);
    const after = await opened.handle.stat();
    if (after.size !== opened.stats.size || after.size !== bytes.length) {
      throw containedFileChange('file changed while it was being read');
    }
    await assertContainedEntry(filePath, directory, opened.identity, {
      requireLinked: false,
      reportGenerationChange: true,
    });
    return bytes;
  } finally {
    await opened.handle.close();
  }
}

function readContainedFileSync(filePath, directory, { maxBytes = null } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return readContainedFileSyncOnce(filePath, directory, { maxBytes });
    } catch (error) {
      if (!isContainedFileChange(error) || attempt === 1) {
        throw isContainedFileChange(error) ? storageError(filePath, error) : error;
      }
    }
  }
  throw new Error('unreachable');
}

function readContainedFileSyncOnce(filePath, directory, { maxBytes = null } = {}) {
  assertDirectoryBoundarySync(directory);
  const pathStats = lstatSync(filePath);
  requireObservedRegularFile(filePath, pathStats);
  assertCanonicalContainment(filePath, directory);
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(descriptor);
    requireOpenedRegularFile(filePath, openedStats);
    if (!sameIdentity(pathStats, openedStats)) {
      throw containedFileChange('file changed while it was being opened');
    }
    if (maxBytes !== null && openedStats.size > maxBytes) {
      throw storageError(filePath, new Error(`file exceeds the ${maxBytes}-byte limit`));
    }
    const bytes = maxBytes === null
      ? readFileSync(descriptor)
      : readDescriptorWithLimit(descriptor, maxBytes);
    const after = fstatSync(descriptor);
    if (after.size !== openedStats.size || after.size !== bytes.length) {
      throw containedFileChange('file changed while it was being read');
    }
    const current = lstatSync(filePath);
    requireObservedRegularFile(filePath, current);
    if (!sameIdentity(openedStats, current)) {
      throw containedFileChange('file changed while it was being read');
    }
    assertDirectoryBoundarySync(directory);
    assertCanonicalContainment(filePath, directory);
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function hashContainedFileSync(filePath, directory, { exactBytes, maxBytes }) {
  assertDirectoryBoundarySync(directory);
  const pathStats = lstatSync(filePath);
  requireSingleRegularFile(filePath, pathStats);
  assertCanonicalContainment(filePath, directory);
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(descriptor);
    requireSingleRegularFile(filePath, openedStats);
    if (!sameIdentity(pathStats, openedStats)) {
      throw storageError(filePath, new Error('file changed while it was being opened'));
    }
    if (openedStats.size !== exactBytes || openedStats.size > maxBytes) {
      return { bytes: openedStats.size, sha256: null };
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    while (true) {
      const bytesRead = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, maxBytes + 1 - bytes),
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > exactBytes || bytes > maxBytes) {
        throw storageError(filePath, new Error('model file grew while it was being inspected'));
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    const current = lstatSync(filePath);
    requireSingleRegularFile(filePath, current);
    if (bytes !== exactBytes
      || !sameIdentity(openedStats, after)
      || !sameIdentity(openedStats, current)
      || after.size !== bytes
      || current.size !== bytes) {
      throw storageError(filePath, new Error('model file changed while it was being inspected'));
    }
    assertDirectoryBoundarySync(directory);
    assertCanonicalContainment(filePath, directory);
    return { bytes, sha256: digest.digest('hex') };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

async function readHandleWithLimit(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte limit`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

function readDescriptorWithLimit(descriptor, maxBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte limit`);
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

async function inspectContainedFile(filePath, directory) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await inspectContainedFileOnce(filePath, directory);
    } catch (error) {
      if (!isContainedFileChange(error) || attempt === 1) {
        throw isContainedFileChange(error) ? storageError(filePath, error) : error;
      }
    }
  }
  throw new Error('unreachable');
}

async function inspectContainedFileOnce(filePath, directory) {
  const opened = await openContainedFile(filePath, directory);
  try {
    await assertContainedEntry(filePath, directory, opened.identity, {
      requireLinked: false,
      reportGenerationChange: true,
    });
    return opened.stats;
  } finally {
    await opened.handle.close();
  }
}

async function openContainedFile(filePath, directory) {
  const pathStats = await fs.lstat(filePath);
  requireObservedRegularFile(filePath, pathStats);
  await assertCanonicalContainmentAsync(filePath, directory);
  const handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = await handle.stat();
    requireOpenedRegularFile(filePath, openedStats);
    if (!sameIdentity(pathStats, openedStats)) {
      throw containedFileChange('file changed while it was being opened');
    }
    await assertDirectoryBoundary(directory);
    return { handle, stats: openedStats, identity: fileIdentity(openedStats) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function createContainedFile(filePath, bytes, directory) {
  await assertDirectoryBoundary(directory);
  let handle;
  let identity;
  try {
    handle = await fs.open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const stats = await handle.stat();
    requireSingleRegularFile(filePath, stats);
    identity = fileIdentity(stats);
    await assertContainedEntry(filePath, directory, identity);
    await handle.close();
    handle = null;
    return identity;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (identity) {
      await removeContainedFile(filePath, directory, identity).catch(() => {});
    }
    throw error;
  }
}

async function removeContainedFile(filePath, directory, expectedIdentity = null) {
  let stats;
  try {
    stats = await inspectContainedFile(filePath, directory);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  const identity = fileIdentity(stats);
  if (expectedIdentity && !sameIdentity(expectedIdentity, identity)) {
    throw storageError(filePath, new Error('refusing to delete a replaced model file'));
  }
  await assertContainedEntry(filePath, directory, identity);
  await fs.unlink(filePath);
  return true;
}

async function assertContainedEntry(
  filePath,
  directory,
  expectedIdentity,
  { requireLinked = true, reportGenerationChange = false } = {},
) {
  await assertDirectoryBoundary(directory);
  const current = await fs.lstat(filePath);
  if (requireLinked) {
    requireSingleRegularFile(filePath, current);
  } else {
    requireObservedRegularFile(filePath, current);
  }
  if (!sameIdentity(expectedIdentity, current)) {
    if (reportGenerationChange) {
      throw containedFileChange('file changed before the operation completed');
    }
    throw storageError(filePath, new Error('file changed before the operation completed'));
  }
  await assertCanonicalContainmentAsync(filePath, directory);
}

async function assertDirectoryBoundary(expected) {
  const current = expected.followsConfiguredPath
    ? await inspectConfiguredDirectory(expected.path)
    : await inspectRealDirectory(expected.path);
  assertDirectoryIdentity(expected, current);
}

function assertDirectoryBoundarySync(expected) {
  const current = expected.followsConfiguredPath
    ? inspectConfiguredDirectorySync(expected.path)
    : inspectRealDirectorySync(expected.path);
  assertDirectoryIdentity(expected, current);
}

function assertDirectoryIdentity(expected, current) {
  if (!sameIdentity(expected, current) || expected.canonical !== current.canonical) {
    throw storageError(expected.path, new Error('directory changed while storage was in use'));
  }
}

async function assertCanonicalContainmentAsync(filePath, directory) {
  const canonical = await fs.realpath(filePath);
  if (path.dirname(canonical) !== directory.canonical
    || path.basename(canonical) !== path.basename(filePath)) {
    throw storageError(filePath, new Error('file escapes its configured storage directory'));
  }
}

function assertCanonicalContainment(filePath, directory) {
  const canonical = realpathSync.native(filePath);
  if (path.dirname(canonical) !== directory.canonical
    || path.basename(canonical) !== path.basename(filePath)) {
    throw storageError(filePath, new Error('file escapes its configured storage directory'));
  }
}

function requireSingleRegularFile(filePath, stats) {
  if (!stats.isFile() || stats.nlink !== 1) {
    throw storageError(filePath, new Error('expected a single-link regular file'));
  }
}

function requireOpenedRegularFile(filePath, stats) {
  if (!stats.isFile() || stats.nlink > 1) {
    throw storageError(filePath, new Error('expected a regular opened file without extra links'));
  }
}

function requireObservedRegularFile(filePath, stats) {
  if (!stats.isFile() || stats.nlink > 1) {
    throw storageError(filePath, new Error('expected a regular file without extra links'));
  }
}

function fileIdentity(stats) {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function containedFileChange(message) {
  const error = new Error(message);
  error.code = 'EWAKEWORDFILECHANGED';
  return error;
}

function isContainedFileChange(error) {
  return error?.code === 'EWAKEWORDFILECHANGED';
}

function storageError(storagePath, error) {
  if (error instanceof WakeWordModelStoreError) {
    return error;
  }
  return new WakeWordModelStoreError(
    `Unsafe wake-word storage at ${storagePath}: ${error instanceof Error ? error.message : String(error)}`,
    { code: 'wake_word_storage_unsafe', status: 500 },
  );
}

function storageUnavailableError() {
  return new WakeWordModelStoreError(
    'Custom wake-word model storage is unavailable. Built-in wake-word support remains available; check the server log before repairing or restoring this storage.',
    { code: 'wake_word_storage_unavailable', status: 503 },
  );
}

function normalizeState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.models)) {
    throw new Error('expected registry version 1 with a models array');
  }
  if (value.models.length > MAX_RESTORED_WAKE_WORD_MODELS) {
    throw new Error(`registry exceeds the ${MAX_RESTORED_WAKE_WORD_MODELS}-model restore limit`);
  }
  const models = value.models.map(normalizeModel);
  const ids = new Set();
  const hashes = new Set();
  let totalBytes = 0;
  for (const model of models) {
    const canonicalId = model.id.toLowerCase();
    const canonicalHash = model.sha256.toLowerCase();
    if (ids.has(canonicalId) || hashes.has(canonicalHash)) {
      throw new Error('registry contains duplicate model ids or SHA-256 values');
    }
    ids.add(canonicalId);
    hashes.add(canonicalHash);
    totalBytes += model.byteSize;
    if (!Number.isSafeInteger(totalBytes)
      || totalBytes > MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES) {
      throw new Error(`registry exceeds the ${formatMiB(MAX_RESTORED_WAKE_WORD_MODEL_TOTAL_BYTES)} MiB restore limit`);
    }
  }
  const state = {
    version: 1,
    models,
  };
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_WAKE_WORD_REGISTRY_BYTES) {
    throw new Error(`normalized registry exceeds the ${MAX_WAKE_WORD_REGISTRY_BYTES}-byte limit`);
  }
  return state;
}

function normalizeModel(value) {
  const requiredStrings = [
    'id',
    'displayName',
    'phrase',
    'originalFilename',
    'sha256',
    'createdAt',
    'updatedAt',
    'rightsConfirmedAt',
    'featureStack',
    'runtime',
  ];
  if (!value || requiredStrings.some((field) => typeof value[field] !== 'string' || !value[field])) {
    throw new Error('registry contains a malformed model record');
  }
  if (requiredStrings.some(
    (field) => Buffer.byteLength(value[field], 'utf8') > MAX_RESTORED_WAKE_WORD_METADATA_BYTES,
  )) {
    throw new Error('registry contains oversized model metadata');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    || !/^[0-9a-f]{64}$/i.test(value.sha256)) {
    throw new Error('registry contains an invalid model id or SHA-256');
  }
  const threshold = Number(value.defaultThreshold);
  if (!Number.isSafeInteger(value.byteSize) || value.byteSize < 1) {
    throw new Error('registry contains an invalid model byte size');
  }
  if (value.byteSize > MAX_RESTORED_WAKE_WORD_MODEL_BYTES) {
    throw new Error(`registry model exceeds the ${formatMiB(MAX_RESTORED_WAKE_WORD_MODEL_BYTES)} MiB restore limit`);
  }
  if (!Number.isInteger(value.inputFrames) || value.inputFrames < 1 || value.inputFrames > 120
    || value.embeddingDimension !== 96
    || !Number.isFinite(threshold) || threshold < 0.05 || threshold >= 0.95
    || !validShape(value.inputShape) || !validShape(value.outputShape)
    || (value.schemaVersion !== undefined
      && (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1))) {
    throw new Error('registry contains invalid model dimensions');
  }
  return {
    id: value.id,
    displayName: value.displayName,
    phrase: value.phrase,
    defaultThreshold: threshold,
    originalFilename: value.originalFilename,
    byteSize: value.byteSize,
    sha256: value.sha256.toLowerCase(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    rightsConfirmedAt: value.rightsConfirmedAt,
    embeddingDimension: value.embeddingDimension,
    featureStack: value.featureStack,
    inputFrames: value.inputFrames,
    inputShape: value.inputShape,
    outputShape: value.outputShape,
    runtime: value.runtime,
    schemaVersion: value.schemaVersion,
  };
}

function validShape(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((dimension) => Number.isSafeInteger(dimension) && dimension > 0);
}

function validAdmissionShape(value) {
  return validShape(value) && value.length <= MAX_WAKE_WORD_SHAPE_DIMENSIONS;
}

function encodeRegistry(state) {
  const pretty = `${JSON.stringify(state, null, 2)}\n`;
  if (Buffer.byteLength(pretty) <= MAX_WAKE_WORD_REGISTRY_BYTES) {
    return pretty;
  }
  const compact = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(compact) <= MAX_WAKE_WORD_REGISTRY_BYTES) {
    return compact;
  }
  throw new WakeWordModelStoreError(
    `Wake-word registry exceeds the ${MAX_WAKE_WORD_REGISTRY_BYTES}-byte limit.`,
    { code: 'wake_word_registry_too_large', status: 409 },
  );
}

function copyModel(model) {
  return structuredClone(model);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function formatMiB(bytes) {
  return Number((bytes / (1024 * 1024)).toFixed(2));
}
