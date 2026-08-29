import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createFrameHub, formatSseEvent } from '../../src/frame/hub.mjs';

test('formats SSE events with event and data fields', () => {
  assert.equal(
    formatSseEvent('command', { command: 'next' }),
    'event: command\ndata: {"command":"next"}\n\n',
  );
});

test('greets every subscriber with the complete live protocol contract', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });

  // Named frame: deviceId echoes back what the connection registered as.
  const fold = createResponse();
  hub.subscribe('frame', new EventEmitter(), fold, { deviceId: 'fold' });
  const foldHello = readEventData(fold.body, 'hello');
  assert.equal(foldHello.protocolVersion, 1);
  assert.equal(foldHello.minAppProtocol, 1);
  assert.equal(foldHello.role, 'frame');
  assert.equal(foldHello.deviceId, 'fold');
  assert.ok(foldHello.capabilities.includes('remote-commands'));
  assert.ok(foldHello.capabilities.includes('named-frames'));
  assert.equal(fold.headers['Access-Control-Allow-Origin'], undefined);

  // Unnamed legacy frame and remotes get a null deviceId — the hello is
  // additive and never invents an identity.
  const legacy = createResponse();
  hub.subscribe('frame', new EventEmitter(), legacy);
  assert.deepEqual(
    {
      deviceId: readEventData(legacy.body, 'hello').deviceId,
      role: readEventData(legacy.body, 'hello').role,
    },
    { deviceId: null, role: 'frame' },
  );

  const remote = createResponse();
  hub.subscribe('remote', new EventEmitter(), remote);
  assert.deepEqual(
    {
      deviceId: readEventData(remote.body, 'hello').deviceId,
      role: readEventData(remote.body, 'hello').role,
    },
    { deviceId: null, role: 'remote' },
  );
});

test('a subscriber whose hello write fails is dropped immediately', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const dead = createResponse({ throwAfterWrites: 1 }); // `: connected` succeeds, hello throws
  hub.subscribe('frame', new EventEmitter(), dead);

  assert.equal(hub.getHubStatus().frameConnected, false);
  assert.equal(hub.publishCommand({ command: 'next' }), 0);
});

test('broadcasts commands to connected frame subscribers', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const request = new EventEmitter();
  const response = createResponse();

  hub.subscribe('frame', request, response);

  assert.equal(hub.publishCommand({ command: 'next' }), 1);
  assert.match(response.body, /event: command\ndata: \{"command":"next"\}\n\n/);

  request.emit('close');
  assert.equal(hub.publishCommand({ command: 'next' }), 0);
});

test('replays latest state immediately to remote subscribers', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  hub.publishState({
    assets: [{ id: 'asset-1' }],
    paused: false,
    queue: { index: 0, length: 1 },
    session: { type: 'normal' },
    updatedAt: '2026-07-03T18:20:00.000Z',
  });

  const response = createResponse();
  hub.subscribe('remote', new EventEmitter(), response);

  assert.match(response.body, /event: state\ndata: \{"assets":\[\{"id":"asset-1"\}\]/);
});

test('routes device-targeted commands to the matching frame only', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const tablet = createResponse();
  const fold = createResponse();
  const unnamed = createResponse();
  hub.subscribe('frame', new EventEmitter(), tablet, { deviceId: 'pictarav1' });
  hub.subscribe('frame', new EventEmitter(), fold, { deviceId: 'fold' });
  hub.subscribe('frame', new EventEmitter(), unnamed);

  assert.equal(hub.publishCommand({ command: 'next', deviceId: 'fold' }), 1);
  assert.doesNotMatch(tablet.body, /"command":"next"/);
  assert.doesNotMatch(unnamed.body, /"command":"next"/);
  assert.match(fold.body, /"deviceId":"fold"/);

  // No deviceId keeps the pre-multi-device broadcast behavior: every frame,
  // named or not, receives it.
  assert.equal(hub.publishCommand({ command: 'pause' }), 3);
  assert.match(unnamed.body, /"command":"pause"/);
});

test('never delivers a targeted command to unnamed legacy connections', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const legacy = createResponse();
  hub.subscribe('frame', new EventEmitter(), legacy);

  // A named target's command must never execute anywhere else. With the
  // target offline it is undelivered — even when an unnamed legacy
  // connection is present.
  assert.equal(hub.publishCommand({ command: 'next', deviceId: 'pictarav1' }), 0);
  assert.doesNotMatch(legacy.body, /"command":"next"/);
});

test('reports zero delivery when the target is offline and no legacy connection exists', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const fold = createResponse();
  hub.subscribe('frame', new EventEmitter(), fold, { deviceId: 'fold' });

  // A command aimed at an offline device must not leak to other named frames.
  assert.equal(hub.publishCommand({ command: 'next', deviceId: 'pictarav1' }), 0);
  assert.doesNotMatch(fold.body, /"command":"next"/);
});

test('offline-target commands reach nobody, named or unnamed', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const fold = createResponse();
  const legacy = createResponse();
  hub.subscribe('frame', new EventEmitter(), fold, { deviceId: 'fold' });
  hub.subscribe('frame', new EventEmitter(), legacy);

  assert.equal(hub.publishCommand({ command: 'next', deviceId: 'pictarav1' }), 0);
  assert.doesNotMatch(legacy.body, /"command":"next"/);
  assert.doesNotMatch(fold.body, /"command":"next"/);
});

test('keeps one state per device and replays all of them to new remotes', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  hub.publishState({ assets: [{ id: 'a' }], deviceId: 'pictarav1', paused: false, queue: { index: 0, length: 5 }, session: { type: 'normal' }, updatedAt: '2026-07-14T01:00:00.000Z' });
  hub.publishState({ assets: [{ id: 'b' }], deviceId: 'fold', paused: true, queue: { index: 2, length: 9 }, session: { type: 'normal' }, updatedAt: '2026-07-14T02:00:00.000Z' });

  const remote = createResponse();
  hub.subscribe('remote', new EventEmitter(), remote);
  assert.match(remote.body, /"deviceId":"pictarav1"/);
  assert.match(remote.body, /"deviceId":"fold"/);

  const status = hub.getHubStatus();
  assert.equal(status.lastStateAt, '2026-07-14T02:00:00.000Z');
  assert.deepEqual(status.devices.map((device) => device.deviceId), ['fold', 'pictarav1']);
  assert.deepEqual(status.devices.map((device) => device.connected), [false, false]);
  assert.deepEqual(status.devices.map((device) => device.paused), [true, false]);
  assert.deepEqual(status.devices.map((device) => device.watchdog), [null, null]);
});

test('status carries an active white-screen watchdog episode and clears with the next healthy state', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const watchdog = { lastRecoveryAction: 'remount', recoveryAttempts: 1, whiteScreenSince: '2026-07-17T03:29:09.000Z' };
  hub.publishState({
    assets: [{ id: 'a' }],
    deviceId: 'tablet',
    paused: false,
    queue: { index: 1, length: 5 },
    session: { type: 'normal' },
    updatedAt: '2026-07-17T03:30:00.000Z',
    watchdog,
  });
  assert.deepEqual(hub.getHubStatus().devices[0].watchdog, watchdog);

  // The first healthy report has no watchdog field — the episode clears.
  hub.publishState({
    assets: [{ id: 'b' }],
    deviceId: 'tablet',
    paused: false,
    queue: { index: 2, length: 5 },
    session: { type: 'normal' },
    updatedAt: '2026-07-17T03:31:00.000Z',
  });
  assert.equal(hub.getHubStatus().devices[0].watchdog, null);
});

test('status marks devices with a named connection and counts unnamed ones', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const foldRequest = new EventEmitter();
  hub.subscribe('frame', foldRequest, createResponse(), { deviceId: 'fold' });
  hub.subscribe('frame', new EventEmitter(), createResponse());

  let status = hub.getHubStatus();
  assert.equal(status.unnamedFrameConnections, 1);
  assert.deepEqual(status.devices, [
    { connected: true, deviceId: 'fold', lastStateAt: null, paused: false, watchdog: null },
  ]);

  foldRequest.emit('close');
  status = hub.getHubStatus();
  assert.equal(status.devices.length, 0);
  assert.equal(status.frameConnected, true);
});

test('forgetDevice drops remembered state; live named connections are detectable', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  hub.subscribe('frame', new EventEmitter(), createResponse(), { deviceId: 'fold' });
  hub.publishState({ assets: [{ id: 'a' }], deviceId: 'fold', paused: false, queue: { index: 0, length: 1 }, session: { type: 'normal' } });
  hub.publishState({ assets: [{ id: 'b' }], deviceId: 'retired', paused: false, queue: { index: 0, length: 1 }, session: { type: 'normal' } });

  assert.equal(hub.deviceHasNamedConnection('fold'), true);
  assert.equal(hub.deviceHasNamedConnection('retired'), false);

  assert.equal(hub.forgetDevice('retired'), true);
  assert.equal(hub.forgetDevice('retired'), false);
  assert.deepEqual(hub.getHubStatus().devices.map((device) => device.deviceId), ['fold']);

  // Forgetting is not banning: the device re-registers on its next report.
  hub.publishState({ assets: [{ id: 'b' }], deviceId: 'retired', paused: false, queue: { index: 0, length: 1 }, session: { type: 'normal' } });
  assert.deepEqual(hub.getHubStatus().devices.map((device) => device.deviceId), ['fold', 'retired']);
});

test('drops dead subscribers when writes fail', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const liveRequest = new EventEmitter();
  const live = createResponse();
  const dead = createResponse({ throwAfterWrites: 1 });

  hub.subscribe('frame', liveRequest, live);
  hub.subscribe('frame', new EventEmitter(), dead);

  assert.equal(hub.publishCommand({ command: 'next' }), 1);
  assert.equal(hub.getHubStatus().frameConnected, true);

  liveRequest.emit('close');
  assert.equal(hub.getHubStatus().frameConnected, false);
});

test('enforces independent per-role subscriber capacity before starting a stream', () => {
  const hub = createFrameHub({
    maxSubscribersPerRole: 2,
    setIntervalFn: fakeSetInterval,
    clearIntervalFn() {},
  });
  const remotes = [createResponse(), createResponse(), createResponse()];
  const frames = [createResponse(), createResponse()];

  assert.equal(hub.subscribe('remote', new EventEmitter(), remotes[0]), true);
  assert.equal(hub.subscribe('remote', new EventEmitter(), remotes[1]), true);
  assert.equal(hub.subscribe('remote', new EventEmitter(), remotes[2]), false);
  assert.equal(remotes[2].headers, null, 'a rejected stream must remain a normal JSON-capable response');
  assert.equal(hub.subscribe('frame', new EventEmitter(), frames[0]), true);
  assert.equal(hub.subscribe('frame', new EventEmitter(), frames[1]), true);
  assert.equal(hub.getHubStatus().remoteCount, 2);
  assert.equal(hub.getHubStatus().frameConnected, true);
});

test('evicts and does not count a subscriber that reports backpressure', () => {
  const hub = createFrameHub({ setIntervalFn: fakeSetInterval, clearIntervalFn() {} });
  const response = createResponse({ backpressureAfterWrites: 2 });
  hub.subscribe('frame', new EventEmitter(), response);

  assert.equal(hub.publishCommand({ command: 'next' }), 0);
  assert.equal(hub.getHubStatus().frameConnected, false);
  assert.equal(response.destroyed, true);
});

function createResponse({ backpressureAfterWrites = Infinity, throwAfterWrites = Infinity } = {}) {
  const response = {
    body: '',
    destroyed: false,
    headers: null,
    writeCount: 0,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.writeCount += 1;
      if (this.writeCount > throwAfterWrites) {
        throw new Error('socket closed');
      }

      this.body += chunk;
      return this.writeCount <= backpressureAfterWrites;
    },
    destroy() { this.destroyed = true; },
    end() {},
  };

  return response;
}

function readEventData(body, eventName) {
  const match = new RegExp(`event: ${eventName}\\ndata: (.*)\\n`).exec(body);
  assert.ok(match, `missing ${eventName} event in:\n${body}`);
  return JSON.parse(match[1]);
}

function fakeSetInterval() {
  return {
    unref() {},
  };
}
