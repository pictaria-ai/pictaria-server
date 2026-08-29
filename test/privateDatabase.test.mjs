import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPrivateDatabasePath,
  preparePrivateDatabasePath,
} from '../src/privateDatabase.mjs';

function withDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-private-db-'));
  try {
    return work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a fresh database path is created privately and accepts regular sidecars', () => {
  withDir((dir) => {
    const path = join(dir, 'state.sqlite');
    preparePrivateDatabasePath(path);
    writeFileSync(`${path}-wal`, 'wal', { mode: 0o600 });
    writeFileSync(`${path}-shm`, 'shm', { mode: 0o600 });

    assert.deepEqual(assertPrivateDatabasePath(path), { exists: true, path });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

test('database final entries, sidecars, and hard links fail before their targets change', () => {
  for (const position of ['', '-wal', '-shm']) {
    withDir((dir) => {
      const path = join(dir, 'state.sqlite');
      const outside = join(dir, `outside${position || '-main'}`);
      writeFileSync(path, 'main', { mode: 0o600 });
      writeFileSync(outside, 'untouched', { mode: 0o640 });
      chmodSync(outside, 0o640);
      const outsideMode = statSync(outside).mode & 0o777;
      if (position) {
        symlinkSync(outside, `${path}${position}`);
      } else {
        rmSync(path);
        symlinkSync(outside, path);
      }

      assert.throws(() => preparePrivateDatabasePath(path), /Unsafe SQLite path.*not a regular file/s);
      assert.equal(readFileSync(outside, 'utf8'), 'untouched');
      assert.equal(statSync(outside).mode & 0o777, outsideMode);
    });
  }

  withDir((dir) => {
    const outside = join(dir, 'outside');
    const path = join(dir, 'state.sqlite');
    writeFileSync(outside, 'untouched', { mode: 0o600 });
    linkSync(outside, path);
    assert.throws(() => preparePrivateDatabasePath(path), /multiple hard links/);
    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  });
});

test('an operator-configured symlinked database parent is accepted and pinned', () => {
  withDir((dir) => {
    const real = join(dir, 'real');
    const alias = join(dir, 'alias');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    const path = join(alias, 'state.sqlite');

    preparePrivateDatabasePath(path);

    assert.deepEqual(assertPrivateDatabasePath(path), { exists: true, path });
    assert.equal(statSync(join(real, 'state.sqlite')).mode & 0o777, 0o600);
  });
});
