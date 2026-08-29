import { MIN_APP_PROTOCOL, PROTOCOL_VERSION, SERVER_CAPABILITIES } from '../protocol.mjs';

const HEARTBEAT_MS = 25000;
export const MAX_FRAME_EVENT_SUBSCRIBERS_PER_ROLE = 32;

export function createFrameHub({
  heartbeatMs = HEARTBEAT_MS,
  maxSubscribersPerRole = MAX_FRAME_EVENT_SUBSCRIBERS_PER_ROLE,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!Number.isInteger(maxSubscribersPerRole) || maxSubscribersPerRole < 1) {
    throw new TypeError('maxSubscribersPerRole must be a positive integer.');
  }
  const subscribers = {
    frame: new Set(),
    remote: new Set(),
  };
  // Frame connections that declared a device name on subscribe. Apps built
  // before multi-device support never declare one and are absent here.
  const frameDevices = new Map();
  // Latest reported state per device, keyed by the deviceId frames stamp on
  // every state post (validation defaults it to 'frame').
  const states = new Map();
  let heartbeat = null;

  function subscribe(role, request, response, { deviceId = null } = {}) {
    if (subscribers[role].size >= maxSubscribersPerRole) {
      return false;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });
    subscribers[role].add(response);
    if (role === 'frame' && deviceId) {
      frameDevices.set(response, deviceId);
    }
    request.once('close', () => dropSubscriber(role, response));

    if (!writeChunk(response, ': connected\n\n', () => evictSubscriber(role, response))) {
      return true;
    }

    // The handshake: first structured event on every stream. Additive — the
    // remote page and pre-versioning apps only listen for the events they
    // know, so an unknown `hello` is silently ignored. The app checks
    // the complete protocol contract before releasing commands; deviceId
    // echoes back what this connection registered as (null for remotes and
    // unnamed legacy frames).
    if (!writeEvent(
      response,
      'hello',
      {
        protocolVersion: PROTOCOL_VERSION,
        minAppProtocol: MIN_APP_PROTOCOL,
        capabilities: SERVER_CAPABILITIES,
        role,
        deviceId: frameDevices.get(response) ?? null,
      },
      () => evictSubscriber(role, response),
    )) {
      return true;
    }

    if (role === 'remote') {
      for (const state of states.values()) {
        if (!writeEvent(response, 'state', state, () => evictSubscriber(role, response))) {
          return true;
        }
      }
    }

    ensureHeartbeat();
    return true;
  }

  function publishState(state) {
    const deviceId = state.deviceId || 'frame';
    const stamped = {
      ...state,
      deviceId,
      updatedAt: state.updatedAt ?? new Date().toISOString(),
    };
    states.set(deviceId, stamped);
    broadcast('remote', 'state', stamped);
  }

  function publishCommand(command) {
    // Commands without a device target keep pre-multi-device semantics:
    // every connected frame receives them.
    if (!command.deviceId) {
      return broadcastToFrames(command, () => true);
    }

    // Deliver only to frames registered under the target name — never anywhere
    // else. A command aimed at a named device must not execute on another
    // frame, so there is no fallback of any kind: legacy unnamed connections
    // are reachable only by commands without a deviceId (the broadcast path
    // above). When the target is offline the command is honestly undelivered
    // (the route surfaces delivered: false).
    return broadcastToFrames(command, (connectionDeviceId) => connectionDeviceId === command.deviceId);
  }

  function getHubStatus() {
    const devices = new Map();
    let lastStateAt = null;
    for (const state of states.values()) {
      devices.set(state.deviceId, {
        connected: false,
        deviceId: state.deviceId,
        lastStateAt: state.updatedAt,
        paused: state.paused === true,
        // Active white-screen episode (null when healthy): Settings and any
        // status consumer can flag a frame that is up but not rendering.
        watchdog: state.watchdog ?? null,
      });
      if (!lastStateAt || state.updatedAt > lastStateAt) {
        lastStateAt = state.updatedAt;
      }
    }

    let unnamedFrameConnections = 0;
    for (const response of subscribers.frame) {
      const deviceId = frameDevices.get(response);
      if (!deviceId) {
        unnamedFrameConnections += 1;
        continue;
      }
      const entry = devices.get(deviceId) ?? { connected: false, deviceId, lastStateAt: null, paused: false, watchdog: null };
      entry.connected = true;
      devices.set(deviceId, entry);
    }

    return {
      devices: [...devices.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId)),
      frameConnected: subscribers.frame.size > 0,
      lastStateAt,
      remoteCount: subscribers.remote.size,
      unnamedFrameConnections,
    };
  }

  function deviceHasNamedConnection(deviceId) {
    for (const connectionDeviceId of frameDevices.values()) {
      if (connectionDeviceId === deviceId) {
        return true;
      }
    }
    return false;
  }

  // Drop a device's remembered state so it disappears from remotes. If the
  // device is still alive it simply re-registers on its next state post —
  // forgetting is not banning.
  function forgetDevice(deviceId) {
    return states.delete(deviceId);
  }

  function close() {
    if (heartbeat) {
      clearIntervalFn(heartbeat);
      heartbeat = null;
    }

    for (const role of Object.keys(subscribers)) {
      for (const response of subscribers[role]) {
        try {
          response.end();
        } catch {
          // Ignore dead test/client responses during shutdown.
        }
      }
      subscribers[role].clear();
    }
    frameDevices.clear();
  }

  function dropSubscriber(role, response) {
    subscribers[role].delete(response);
    frameDevices.delete(response);
    stopHeartbeatIfIdle();
  }

  function evictSubscriber(role, response) {
    dropSubscriber(role, response);
    try {
      response.destroy?.();
    } catch {
      // A failed stream is already unusable; cleanup above is authoritative.
    }
  }

  function broadcast(role, event, data) {
    let delivered = 0;

    for (const response of subscribers[role]) {
      if (writeEvent(response, event, data, () => evictSubscriber(role, response))) {
        delivered += 1;
      }
    }

    stopHeartbeatIfIdle();
    return delivered;
  }

  function broadcastToFrames(command, matches) {
    let delivered = 0;

    for (const response of subscribers.frame) {
      if (!matches(frameDevices.get(response) ?? null)) {
        continue;
      }
      if (writeEvent(response, 'command', command, () => evictSubscriber('frame', response))) {
        delivered += 1;
      }
    }

    stopHeartbeatIfIdle();
    return delivered;
  }

  function ensureHeartbeat() {
    if (heartbeat) {
      return;
    }

    heartbeat = setIntervalFn(() => {
      for (const role of Object.keys(subscribers)) {
        for (const response of subscribers[role]) {
          writeChunk(response, ': ping\n\n', () => evictSubscriber(role, response));
        }
      }
      stopHeartbeatIfIdle();
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function stopHeartbeatIfIdle() {
    if (!heartbeat || subscribers.frame.size + subscribers.remote.size > 0) {
      return;
    }

    clearIntervalFn(heartbeat);
    heartbeat = null;
  }

  return {
    close,
    deviceHasNamedConnection,
    forgetDevice,
    getHubStatus,
    publishCommand,
    publishState,
    subscribe,
  };
}

export function formatSseEvent(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function writeEvent(response, event, data, onDead) {
  return writeChunk(response, formatSseEvent(event, data), onDead);
}

function writeChunk(response, chunk, onDead) {
  try {
    if (response.write(chunk) === false) {
      onDead();
      return false;
    }
    return true;
  } catch {
    onDead();
    return false;
  }
}
