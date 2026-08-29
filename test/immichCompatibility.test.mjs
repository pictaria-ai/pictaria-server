import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isImmichVersionSupported,
  MINIMUM_IMMICH_MAJOR,
  parseImmichVersion,
} from '../src/immichCompatibility.mjs';

test('parses the stable Immich server-version response', () => {
  assert.deepEqual(
    parseImmichVersion({ major: 3, minor: 1, patch: 0, prerelease: null }),
    { major: 3, minor: 1, patch: 0, prerelease: null, display: '3.1.0' },
  );
});

test('retains a numeric prerelease component in the display version', () => {
  assert.equal(
    parseImmichVersion({ major: 3, minor: 2, patch: 0, prerelease: 4 })?.display,
    '3.2.0-4',
  );
});

test('rejects malformed or ambiguous version responses', () => {
  for (const value of [
    null,
    [],
    {},
    { major: '3', minor: 1, patch: 0 },
    { major: 3, minor: -1, patch: 0 },
    { major: 3, minor: 1, patch: 0.5 },
    { major: 3, minor: 1, patch: 0, prerelease: 'beta' },
  ]) {
    assert.equal(parseImmichVersion(value), null);
  }
});

test('enforces only the Immich 2.0 major-version floor', () => {
  assert.equal(MINIMUM_IMMICH_MAJOR, 2);
  assert.equal(isImmichVersionSupported(parseImmichVersion({ major: 1, minor: 132, patch: 3 })), false);
  assert.equal(isImmichVersionSupported(parseImmichVersion({ major: 2, minor: 0, patch: 0 })), true);
  assert.equal(isImmichVersionSupported(parseImmichVersion({ major: 99, minor: 0, patch: 0 })), true);
});
