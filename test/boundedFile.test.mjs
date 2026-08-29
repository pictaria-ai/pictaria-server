import assert from 'node:assert/strict';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseBoundedJsonFile,
  parseBoundedJsonFileSync,
  readBoundedRegularFile,
  readBoundedRegularFileSync,
} from '../src/boundedFile.mjs';
import { writePrivateFileAtomic, writePrivateFileAtomicSync } from '../src/atomicFile.mjs';

async function withDir(work) {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-bounded-file-'));
  try {
    return await work(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('bounded readers accept the exact ceiling and reject one byte more before parsing', async () => {
  await withDir(async (dir) => {
    const exact = join(dir, 'exact.json');
    const oversized = join(dir, 'oversized.json');
    writeFileSync(exact, '{"ok":true}');
    writeFileSync(oversized, '{"ok":true} ');

    assert.deepEqual(parseBoundedJsonFileSync(exact, { maxBytes: 11, label: 'Test state' }), { ok: true });
    assert.deepEqual(await parseBoundedJsonFile(exact, { maxBytes: 11, label: 'Test state' }), { ok: true });
    assert.throws(
      () => readBoundedRegularFileSync(oversized, { maxBytes: 11, label: 'Test state' }),
      /exceeds the 11-byte limit/,
    );
    await assert.rejects(
      readBoundedRegularFile(oversized, { maxBytes: 11, label: 'Test state' }),
      /exceeds the 11-byte limit/,
    );
  });
});

test('bounded readers reject substituted final links while allowing a linked configured parent', async () => {
  await withDir(async (dir) => {
    const actual = join(dir, 'actual');
    const linkedParent = join(dir, 'linked-parent');
    const target = join(actual, 'state.json');
    const linkedEntry = join(actual, 'linked.json');
    const hardTarget = join(actual, 'hard-target.json');
    const hardLinkedEntry = join(actual, 'hard-linked.json');
    // Parent links are an operator-selected storage boundary; final-entry
    // links and aliases are restored state and are never followed.
    mkdirSync(actual);
    writeFileSync(target, '{"ok":true}');
    writeFileSync(hardTarget, '{"ok":true}');
    symlinkSync(actual, linkedParent);
    symlinkSync(target, linkedEntry);
    linkSync(hardTarget, hardLinkedEntry);

    assert.deepEqual(
      parseBoundedJsonFileSync(join(linkedParent, 'state.json'), { maxBytes: 64, label: 'Test state' }),
      { ok: true },
    );
    assert.throws(
      () => readBoundedRegularFileSync(linkedEntry, { maxBytes: 64, label: 'Test state' }),
      /without extra links/,
    );
    await assert.rejects(
      readBoundedRegularFile(hardLinkedEntry, { maxBytes: 64, label: 'Test state' }),
      /without extra links/,
    );
  });
});

test('bounded readers retry one ordinary atomic replacement without weakening entry checks', async () => {
  await withDir(async (dir) => {
    const syncPath = join(dir, 'sync.json');
    writeFileSync(syncPath, '{"version":1}');
    let syncAttempts = 0;
    const syncBytes = readBoundedRegularFileSync(syncPath, {
      maxBytes: 64,
      label: 'Test state',
      testHooks: {
        afterOpen({ attempt }) {
          syncAttempts += 1;
          if (attempt === 0) writePrivateFileAtomicSync(syncPath, '{"version":2}');
        },
      },
    });
    assert.equal(syncBytes.toString('utf8'), '{"version":2}');
    assert.equal(syncAttempts, 2);

    const asyncPath = join(dir, 'async.json');
    writeFileSync(asyncPath, '{"version":1}');
    let asyncAttempts = 0;
    const asyncBytes = await readBoundedRegularFile(asyncPath, {
      maxBytes: 64,
      label: 'Test state',
      testHooks: {
        async afterOpen({ attempt }) {
          asyncAttempts += 1;
          if (attempt === 0) await writePrivateFileAtomic(asyncPath, '{"version":2}');
        },
      },
    });
    assert.equal(asyncBytes.toString('utf8'), '{"version":2}');
    assert.equal(asyncAttempts, 2);
  });
});

test('bounded readers accept a transient zero-link pathname observation', async () => {
  await withDir(async (dir) => {
    const syncPath = join(dir, 'sync.json');
    writeFileSync(syncPath, '{"ok":true}');
    const syncPhases = [];
    assert.equal(
      readBoundedRegularFileSync(syncPath, {
        maxBytes: 64,
        testHooks: {
          afterPathStat({ phase, stats }) {
            syncPhases.push(phase);
            stats.nlink = 0;
          },
        },
      }).toString('utf8'),
      '{"ok":true}',
    );
    assert.deepEqual(syncPhases, ['before-open', 'after-read']);

    const asyncPath = join(dir, 'async.json');
    writeFileSync(asyncPath, '{"ok":true}');
    const asyncPhases = [];
    assert.equal(
      (await readBoundedRegularFile(asyncPath, {
        maxBytes: 64,
        testHooks: {
          async afterPathStat({ phase, stats }) {
            asyncPhases.push(phase);
            stats.nlink = 0;
          },
        },
      })).toString('utf8'),
      '{"ok":true}',
    );
    assert.deepEqual(asyncPhases, ['before-open', 'after-read']);
  });
});
