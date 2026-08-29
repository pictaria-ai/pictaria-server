import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const SECRET_BYTES = 32;
const TOKEN_VERSION = 'v2';
const SECRET_PUBLISH_RETRIES = 50;
const SECRET_PUBLISH_RETRY_MS = 10;
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const UNSUPPORTED_CHMOD_ERRORS = new Set(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

// One random secret per Pictaria installation prevents a captured session
// token from becoming an offline APP_PASSWORD verifier. It lives beside
// settings.json so the normal Docker /data volume preserves it across
// restarts. Losing it invalidates outstanding browser sessions and also causes
// enabled Smart Album schedules bound to the old installation secret to be
// quarantined for explicit review; durable rules and manual runs remain.
export function loadOrCreateSessionSecret(filePath, options = {}) {
  const helpers = {
    chmod: options.chmod ?? chmodSync,
    stat: options.stat ?? statSync,
    wait: options.wait ?? waitSync,
    warn: options.warn ?? console.warn,
  };
  try {
    return readSessionSecret(filePath, helpers);
  } catch (error) {
    if (error?.code === 'ESESSIONSECRET') {
      // Another process may have created the file just before finishing its
      // tiny synchronous write. Give that publication a bounded chance to
      // complete; persistent corruption still fails closed after the wait.
      return waitForPublishedSecret(filePath, error, helpers);
    }
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }

  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const generated = randomBytes(SECRET_BYTES);
  try {
    // Exclusive creation avoids two simultaneous first starts silently
    // choosing different keys. The one-process deployment is normal, but
    // this makes the persistent boundary correct even under a race.
    writeFileSync(filePath, `${generated.toString('hex')}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    tightenSecretPermissions(filePath, helpers);
    return generated;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return waitForPublishedSecret(filePath, error, helpers);
    }
    throw error;
  }
}

function waitForPublishedSecret(filePath, initialError, helpers) {
  let lastError = initialError;
  for (let attempt = 0; attempt < SECRET_PUBLISH_RETRIES; attempt += 1) {
    helpers.wait(SECRET_PUBLISH_RETRY_MS);
    try {
      return readSessionSecret(filePath, helpers);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ESESSIONSECRET') {
        throw error;
      }
      lastError = error;
    }
  }
  throw lastError;
}

function waitSync(milliseconds) {
  Atomics.wait(WAIT_BUFFER, 0, 0, milliseconds);
}

function readSessionSecret(filePath, helpers) {
  const encoded = readFileSync(filePath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) {
    const error = new Error(`Session secret at ${filePath} is invalid; expected 32 bytes encoded as hex.`);
    error.code = 'ESESSIONSECRET';
    throw error;
  }
  tightenSecretPermissions(filePath, helpers);
  return Buffer.from(encoded, 'hex');
}

function tightenSecretPermissions(filePath, { chmod, stat, warn }) {
  const currentMode = stat(filePath).mode & 0o777;
  if ((currentMode & 0o077) === 0) {
    return;
  }
  try {
    chmod(filePath, 0o600);
  } catch (error) {
    if (!UNSUPPORTED_CHMOD_ERRORS.has(error?.code)) {
      throw error;
    }
    warn(
      `[Pictaria] Could not restrict ${filePath} to mode 0600 (${error.code}); `
      + 'continuing because this filesystem may not support POSIX permissions.',
    );
    return;
  }
  const tightenedMode = stat(filePath).mode & 0o777;
  if ((tightenedMode & 0o077) !== 0) {
    throw new Error(
      `Session secret at ${filePath} remains more permissive than mode 0600 after chmod; `
      + 'refusing to start with a locally readable signing secret.',
    );
  }
}

// Session signatures depend on both the installation secret and the current
// APP_PASSWORD. The secret removes the password oracle; binding the password
// preserves the established behavior that changing it invalidates sessions.
export function createSessionTokenCodec({ appPassword, installationSecret, ttlMs = SESSION_TTL_MS }) {
  if (typeof appPassword !== 'string' || appPassword.length === 0) {
    throw new Error('Session tokens require a non-empty app password.');
  }
  if (!Buffer.isBuffer(installationSecret) || installationSecret.length !== SECRET_BYTES) {
    throw new Error(`Session tokens require a ${SECRET_BYTES}-byte installation secret.`);
  }
  const signingKey = createHmac('sha256', installationSecret)
    .update('pictaria-session-v2\0')
    .update(appPassword)
    .digest();

  function signature(payload) {
    return createHmac('sha256', signingKey).update(payload).digest('hex');
  }

  return {
    issue(now = Date.now()) {
      const payload = `${TOKEN_VERSION}.${now + ttlMs}`;
      return `${payload}.${signature(payload)}`;
    },

    valid(token, now = Date.now()) {
      const parts = String(token).split('.');
      if (parts.length !== 3 || parts[0] !== TOKEN_VERSION || !parts[2]) {
        return false;
      }
      const expires = Number(parts[1]);
      if (!Number.isSafeInteger(expires) || expires < now) {
        return false;
      }
      const expected = Buffer.from(signature(`${parts[0]}.${parts[1]}`));
      const provided = Buffer.from(parts[2]);
      return provided.length === expected.length && timingSafeEqual(provided, expected);
    },
  };
}
