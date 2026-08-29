import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateFrameCommandRequest,
  validateFrameEventDevice,
  validateFrameStateRequest,
} from '../../src/frame/remote.mjs';

test('validates remote frame commands', () => {
  assert.deepEqual(validateFrameCommandRequest({ command: 'next' }), {
    value: { command: 'next' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'favorite', target: 'left' }), {
    value: { command: 'favorite', target: 'left' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'more', target: 'right' }), {
    value: { command: 'more', target: 'right' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'show-album', albumId: 'album-1', albumName: 'Family' }), {
    value: { command: 'show-album', albumId: 'album-1', albumName: 'Family' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'reload-albums', albumIds: [' album-1 ', 'album-2'] }), {
    value: { command: 'reload-albums', albumIds: ['album-1', 'album-2'] },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'delete-everything' }), {
    error: 'Unsupported frame command.',
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'show-album' }), {
    error: 'show-album requires an albumId no longer than 128 characters.',
  });
});

test('reload-albums enforces the album limit shared with the app', () => {
  const limitError = { error: 'albumIds must contain 1 to 5 album ids.' };

  // reload-albums has no allowEmpty semantics: zero albums is rejected.
  assert.deepEqual(validateFrameCommandRequest({ command: 'reload-albums', albumIds: [] }), limitError);
  assert.deepEqual(validateFrameCommandRequest({ command: 'reload-albums' }), limitError);

  assert.deepEqual(validateFrameCommandRequest({ command: 'reload-albums', albumIds: ['one'] }), {
    value: { command: 'reload-albums', albumIds: ['one'] },
  });
  assert.deepEqual(
    validateFrameCommandRequest({ command: 'reload-albums', albumIds: ['one', 'two', 'three', 'four', 'five'] }),
    { value: { command: 'reload-albums', albumIds: ['one', 'two', 'three', 'four', 'five'] } },
  );
  assert.deepEqual(
    validateFrameCommandRequest({ command: 'reload-albums', albumIds: ['one', 'two', 'three', 'four', 'five', 'six'] }),
    limitError,
  );

  // Duplicates collapse before the limit applies: six entries naming five
  // distinct albums are accepted as those five.
  assert.deepEqual(
    validateFrameCommandRequest({ command: 'reload-albums', albumIds: ['one', 'one', 'two', 'three', 'four', 'five'] }),
    { value: { command: 'reload-albums', albumIds: ['one', 'two', 'three', 'four', 'five'] } },
  );
});

test('validates device-targeted commands', () => {
  assert.deepEqual(validateFrameCommandRequest({ command: 'next', deviceId: ' Fold ' }), {
    value: { command: 'next', deviceId: 'fold' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'next', deviceId: '' }), {
    value: { command: 'next' },
  });
  assert.deepEqual(validateFrameCommandRequest({ command: 'next', deviceId: 'no spaces!' }), {
    error: 'deviceId must be a lowercase slug up to 32 characters.',
  });
});

test('validates the SSE device declaration', () => {
  assert.deepEqual(validateFrameEventDevice('Fold'), { value: 'fold' });
  assert.deepEqual(validateFrameEventDevice(null), { value: null });
  assert.deepEqual(validateFrameEventDevice(''), { value: null });
  assert.deepEqual(validateFrameEventDevice('bad slug!'), {
    error: 'device must be a lowercase slug up to 32 characters.',
  });
});

test('validates frame state snapshots', () => {
  assert.deepEqual(validateFrameStateRequest({
    assets: [{ id: ' asset-1 ', locationLabel: ' Kyoto ', dateLabel: ' April 12, 2023 ' }],
    deviceId: 'Kitchen-1',
    paused: false,
    queue: { index: 17, length: 245 },
    selectedAlbumIds: ['album-1', 'album-2'],
    sourceMode: 'album',
    session: { type: 'show-search', title: 'David in Paris' },
    updatedAt: '2026-07-03T18:20:00.000Z',
  }), {
    value: {
      assets: [{ id: 'asset-1', locationLabel: 'Kyoto', dateLabel: 'April 12, 2023' }],
      deviceId: 'kitchen-1',
      paused: false,
      queue: { index: 17, length: 245 },
      selectedAlbumIds: ['album-1', 'album-2'],
      sourceMode: 'album',
      session: { type: 'show-search', title: 'David in Paris' },
      updatedAt: '2026-07-03T18:20:00.000Z',
    },
  });

  assert.deepEqual(validateFrameStateRequest({
    assets: [],
    paused: false,
    queue: { index: 0, length: 0 },
    session: { type: 'normal' },
  }), {
    error: 'assets must contain one or two displayed assets.',
  });

  // White-screen watchdog rides along only while an episode is active — and
  // a malformed watchdog object is DROPPED, never an error: broken
  // diagnostics must not cost the frame its hub presence.
  const watchdogState = {
    assets: [{ id: 'asset-1' }],
    deviceId: 'tablet',
    paused: false,
    queue: { index: 3, length: 10 },
    session: { type: 'normal' },
    updatedAt: '2026-07-17T03:29:00.000Z',
  };
  const validatedWithWatchdog = validateFrameStateRequest({
    ...watchdogState,
    watchdog: {
      lastRecoveryAction: 'native-recover',
      recoveryAttempts: 4,
      whiteScreenSince: '2026-07-17T03:29:09.000Z',
    },
  });
  assert.deepEqual(validatedWithWatchdog.value.watchdog, {
    lastRecoveryAction: 'native-recover',
    recoveryAttempts: 4,
    whiteScreenSince: '2026-07-17T03:29:09.000Z',
  });
  assert.equal('watchdog' in validateFrameStateRequest(watchdogState).value, false);
  for (const malformed of [
    'active',
    { whiteScreenSince: 'not-a-date' },
    { whiteScreenSince: '' },
    { recoveryAttempts: 2 },
  ]) {
    const validated = validateFrameStateRequest({ ...watchdogState, watchdog: malformed });
    assert.equal(validated.error, undefined);
    assert.equal('watchdog' in validated.value, false);
  }
  // Junk fields inside an otherwise-valid watchdog fall back to safe values.
  assert.deepEqual(
    validateFrameStateRequest({
      ...watchdogState,
      watchdog: { whiteScreenSince: '2026-07-17T03:29:09.000Z', recoveryAttempts: -3, lastRecoveryAction: 42 },
    }).value.watchdog,
    { lastRecoveryAction: null, recoveryAttempts: 0, whiteScreenSince: '2026-07-17T03:29:09.000Z' },
  );
  // v3 layer-forensics fields pass through when valid…
  assert.deepEqual(
    validateFrameStateRequest({
      ...watchdogState,
      watchdog: {
        whiteScreenSince: '2026-07-17T03:29:09.000Z',
        recoveryAttempts: 4,
        lastRecoveryAction: 'restart',
        loadStartsSinceEpisode: 0,
        imageErrorsSinceEpisode: 2,
        imagesSummary: '2 images, uris ok',
      },
    }).value.watchdog,
    {
      lastRecoveryAction: 'restart',
      recoveryAttempts: 4,
      whiteScreenSince: '2026-07-17T03:29:09.000Z',
      loadStartsSinceEpisode: 0,
      imageErrorsSinceEpisode: 2,
      imagesSummary: '2 images, uris ok',
    },
  );
  // …and junk versions of them are dropped, not errors (older apps simply
  // never send them).
  assert.deepEqual(
    validateFrameStateRequest({
      ...watchdogState,
      watchdog: {
        whiteScreenSince: '2026-07-17T03:29:09.000Z',
        recoveryAttempts: 4,
        lastRecoveryAction: 'restart',
        loadStartsSinceEpisode: -1,
        imageErrorsSinceEpisode: 'many',
        imagesSummary: 7,
      },
    }).value.watchdog,
    { lastRecoveryAction: 'restart', recoveryAttempts: 4, whiteScreenSince: '2026-07-17T03:29:09.000Z' },
  );

  assert.deepEqual(validateFrameStateRequest({
    assets: [{ id: 'asset-1' }],
    paused: false,
    queue: { index: 0, length: 1 },
    session: { type: 'party' },
  }), {
    error: 'session type is invalid.',
  });

  // selectedAlbumIds keeps allowEmpty semantics: absent or empty means
  // "no album selection" (timeline mode), not an error — but the shared
  // five-album ceiling still applies.
  const baseState = {
    assets: [{ id: 'asset-1' }],
    paused: false,
    queue: { index: 0, length: 1 },
    session: { type: 'normal' },
    updatedAt: '2026-07-03T18:20:00.000Z',
  };
  assert.deepEqual(validateFrameStateRequest(baseState).value.selectedAlbumIds, []);
  assert.deepEqual(validateFrameStateRequest({ ...baseState, selectedAlbumIds: [] }).value.selectedAlbumIds, []);
  assert.deepEqual(
    validateFrameStateRequest({ ...baseState, selectedAlbumIds: ['a', 'b', 'c', 'd', 'e'] }).value.selectedAlbumIds,
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.deepEqual(
    validateFrameStateRequest({ ...baseState, selectedAlbumIds: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    { error: 'albumIds must contain 1 to 5 album ids.' },
  );
});
