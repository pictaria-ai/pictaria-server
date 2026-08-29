import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSessionTokenCodec, loadOrCreateSessionSecret } from '../src/sessionTokens.mjs';

test('installation secret persists with private permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-session-'));
  try {
    const path = join(dir, 'session-secret');
    const first = loadOrCreateSessionSecret(path);
    chmodSync(path, 0o644);
    const second = loadOrCreateSessionSecret(path);

    assert.equal(first.length, 32);
    assert.deepEqual(second, first);
    assert.match(readFileSync(path, 'utf8'), /^[0-9a-f]{64}\n$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a partially published first-start secret is retried before failing closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-session-'));
  try {
    const path = join(dir, 'session-secret');
    const expected = Buffer.alloc(32, 0x33);
    writeFileSync(path, '');
    let waits = 0;

    const loaded = loadOrCreateSessionSecret(path, {
      wait() {
        waits += 1;
        writeFileSync(path, `${expected.toString('hex')}\n`);
      },
    });

    assert.deepEqual(loaded, expected);
    assert.equal(waits, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a filesystem without POSIX chmod support warns but remains bootable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-session-'));
  try {
    const path = join(dir, 'session-secret');
    const expected = Buffer.alloc(32, 0x44);
    writeFileSync(path, `${expected.toString('hex')}\n`);
    const warnings = [];

    const loaded = loadOrCreateSessionSecret(path, {
      stat: () => ({ mode: 0o100644 }),
      chmod: () => {
        const error = new Error('operation not supported');
        error.code = 'ENOTSUP';
        throw error;
      },
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(loaded, expected);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /continuing because this filesystem may not support POSIX permissions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('permission-denied or ineffective chmod fails closed on a permissive secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-session-'));
  try {
    const path = join(dir, 'session-secret');
    const expected = Buffer.alloc(32, 0x55);
    writeFileSync(path, `${expected.toString('hex')}\n`);

    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      assert.throws(
        () => loadOrCreateSessionSecret(path, {
          stat: () => ({ mode: 0o100644 }),
          chmod: () => {
            const error = new Error('permission denied');
            error.code = code;
            throw error;
          },
          warn: () => assert.fail(`${code} must not warn and continue`),
        }),
        (error) => error.code === code,
      );
    }

    assert.throws(
      () => loadOrCreateSessionSecret(path, {
        stat: () => ({ mode: 0o100644 }),
        chmod: () => {},
        warn: () => assert.fail('an ineffective chmod must not warn and continue'),
      }),
      /remains more permissive than mode 0600/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed persisted installation secrets fail closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-session-'));
  try {
    const path = join(dir, 'session-secret');
    writeFileSync(path, 'too-short\n');
    assert.throws(() => loadOrCreateSessionSecret(path), /is invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session tokens expire and are bound to both installation and password', () => {
  const secret = Buffer.alloc(32, 0x11);
  const codec = createSessionTokenCodec({ appPassword: 'correct horse', installationSecret: secret, ttlMs: 1_000 });
  const token = codec.issue(10_000);

  assert.match(token, /^v2\.11000\.[0-9a-f]{64}$/);
  assert.equal(codec.valid(token, 10_999), true);
  assert.equal(codec.valid(token, 11_001), false);
  assert.equal(codec.valid(`${token}ff`, 10_999), false);
  assert.equal(codec.valid('not-a-token', 10_999), false);

  const otherInstallation = createSessionTokenCodec({
    appPassword: 'correct horse',
    installationSecret: Buffer.alloc(32, 0x22),
  });
  assert.equal(otherInstallation.valid(token, 10_999), false);

  const changedPassword = createSessionTokenCodec({
    appPassword: 'different password',
    installationSecret: secret,
  });
  assert.equal(changedPassword.valid(token, 10_999), false);
});
