import assert from 'node:assert/strict';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { writePrivateFileAtomic, writePrivateFileAtomicSync } from '../src/atomicFile.mjs';

test('synchronous atomic writes do not follow predictable or final-path symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-atomic-sync-'));
  try {
    const outside = join(dir, 'outside');
    const target = join(dir, 'settings.json');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, `${target}.tmp`);
    symlinkSync(outside, target);

    writePrivateFileAtomicSync(target, 'safe\n', { encoding: 'utf8' });

    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    assert.equal(readFileSync(target, 'utf8'), 'safe\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('asynchronous atomic writes replace rather than follow a destination symlink', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-atomic-async-'));
  try {
    const outside = join(dir, 'outside');
    const target = join(dir, 'registry.json.bak');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, target);

    await writePrivateFileAtomic(target, 'safe\n', { encoding: 'utf8' });

    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    assert.equal(readFileSync(target, 'utf8'), 'safe\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an async temporary-entry replacement is rejected without following or deleting the link', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-atomic-race-'));
  try {
    const outside = join(dir, 'outside');
    const target = join(dir, 'state.json');
    let racedTemporaryPath;
    writeFileSync(outside, 'untouched');
    writeFileSync(target, 'previous');

    await assert.rejects(
      writePrivateFileAtomic(target, 'replacement', {}, {
        beforeReplace({ temporaryPath }) {
          racedTemporaryPath = temporaryPath;
          unlinkSync(temporaryPath);
          symlinkSync(outside, temporaryPath);
        },
      }),
      /temporary entry is unsafe|boundary changed/,
    );

    assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    assert.equal(readFileSync(target, 'utf8'), 'previous');
    assert.equal(lstatSync(racedTemporaryPath).isSymbolicLink(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
