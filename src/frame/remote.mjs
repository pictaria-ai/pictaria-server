const COMMANDS = new Set([
  'favorite',
  'interesting',
  'more',
  'never-show',
  'next',
  'pause',
  'previous',
  'reload-albums',
  'resume',
  'show-album',
  'toggle-metadata',
]);

// Shared by request validation and privacy-safe activity capture. Keeping the
// allowlist private behind this predicate prevents a mutable exported Set and
// makes a newly supported remote command one deliberate change, not two.
export function isSupportedFrameCommand(value) {
  return COMMANDS.has(value);
}
const TARGETS = new Set(['left', 'right']);
// Cross-product contract: this must match Pictaria Frame's album-selection
// limit; change both together.
const MAX_FRAME_ALBUMS = 5;
const SESSION_TYPES = new Set(['normal', 'show-search', 'more-from-day', 'album']);
const SOURCE_MODES = new Set(['album', 'timeline']);
const DEVICE_ID_PATTERN = /^[a-z0-9-]+$/;

export function validateFrameCommandRequest(body) {
  const command = typeof body?.command === 'string' ? body.command.trim() : '';
  if (!isSupportedFrameCommand(command)) {
    return { error: 'Unsupported frame command.' };
  }

  const target = body?.target;
  if (target !== undefined && !TARGETS.has(target)) {
    return { error: 'target must be left or right.' };
  }

  // Optional: routes the command to one device instead of every frame.
  const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim().toLowerCase() : '';
  if (deviceId && (deviceId.length > 32 || !DEVICE_ID_PATTERN.test(deviceId))) {
    return { error: 'deviceId must be a lowercase slug up to 32 characters.' };
  }

  const albumId = typeof body?.albumId === 'string' ? body.albumId.trim() : '';
  const albumName = typeof body?.albumName === 'string' ? body.albumName.trim() : '';

  if (command === 'show-album' && (!albumId || albumId.length > 128)) {
    return { error: 'show-album requires an albumId no longer than 128 characters.' };
  }

  const albumIds = validateAlbumIds(body?.albumIds);
  if (command === 'reload-albums' && albumIds.error) {
    return albumIds;
  }

  if (albumName.length > 200) {
    return { error: 'albumName must be 200 characters or fewer.' };
  }

  return {
    value: {
      command,
      ...(target ? { target } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(albumId ? { albumId } : {}),
      ...(command === 'reload-albums' ? { albumIds: albumIds.value } : {}),
      ...(albumName ? { albumName } : {}),
    },
  };
}

// For the SSE subscribe URL's optional ?device= param: absent means a
// pre-multi-device app that never declares itself.
export function validateFrameEventDevice(value) {
  const deviceId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
  if (!deviceId) {
    return { value: null };
  }

  if (deviceId.length > 32 || !DEVICE_ID_PATTERN.test(deviceId)) {
    return { error: 'device must be a lowercase slug up to 32 characters.' };
  }

  return { value: deviceId };
}

export function validateFrameStateRequest(body) {
  const assets = validateStateAssets(body?.assets);
  if (assets.error) {
    return assets;
  }

  const queue = validateQueue(body?.queue);
  if (queue.error) {
    return queue;
  }

  const session = validateSession(body?.session);
  if (session.error) {
    return session;
  }

  if (typeof body?.paused !== 'boolean') {
    return { error: 'paused must be a boolean.' };
  }

  const updatedAt = validateUpdatedAt(body?.updatedAt);
  if (updatedAt.error) {
    return updatedAt;
  }

  const deviceId = validateDeviceId(body?.deviceId);
  if (deviceId.error) {
    return deviceId;
  }

  const selectedAlbumIds = validateAlbumIds(body?.selectedAlbumIds, { allowEmpty: true });
  if (selectedAlbumIds.error) {
    return selectedAlbumIds;
  }

  const sourceMode = typeof body?.sourceMode === 'string' && SOURCE_MODES.has(body.sourceMode) ? body.sourceMode : 'timeline';
  const watchdog = validateWatchdog(body?.watchdog);

  return {
    value: {
      assets: assets.value,
      deviceId: deviceId.value,
      paused: body.paused,
      queue: queue.value,
      selectedAlbumIds: selectedAlbumIds.value,
      sourceMode,
      session: session.value,
      updatedAt: updatedAt.value,
      ...(watchdog ? { watchdog } : {}),
    },
  };
}

// White-screen watchdog episode, reported by the frame only while active.
// Optional and additive: older apps never send it, and a malformed object is
// dropped rather than failing the whole state report — a broken diagnostics
// field must never take down the frame's normal hub presence.
function validateWatchdog(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const whiteScreenSince = typeof value.whiteScreenSince === 'string' ? value.whiteScreenSince.slice(0, 40) : '';
  if (!whiteScreenSince || Number.isNaN(Date.parse(whiteScreenSince))) {
    return null;
  }

  const recoveryAttempts = Number.isInteger(value.recoveryAttempts) && value.recoveryAttempts >= 0
    ? Math.min(value.recoveryAttempts, 100000)
    : 0;
  const lastRecoveryAction = typeof value.lastRecoveryAction === 'string' && value.lastRecoveryAction
    ? value.lastRecoveryAction.slice(0, 40)
    : null;

  // v3 layer-forensics fields (Task #111): where in the image stack the wedge
  // sits. Absent from older apps, so each is passed through only when valid.
  const loadStartsSinceEpisode = Number.isInteger(value.loadStartsSinceEpisode) && value.loadStartsSinceEpisode >= 0
    ? Math.min(value.loadStartsSinceEpisode, 1000000)
    : null;
  const imageErrorsSinceEpisode = Number.isInteger(value.imageErrorsSinceEpisode) && value.imageErrorsSinceEpisode >= 0
    ? Math.min(value.imageErrorsSinceEpisode, 1000000)
    : null;
  const imagesSummary = typeof value.imagesSummary === 'string' && value.imagesSummary
    ? value.imagesSummary.slice(0, 120)
    : null;

  return {
    lastRecoveryAction,
    recoveryAttempts,
    whiteScreenSince,
    ...(loadStartsSinceEpisode === null ? {} : { loadStartsSinceEpisode }),
    ...(imageErrorsSinceEpisode === null ? {} : { imageErrorsSinceEpisode }),
    ...(imagesSummary === null ? {} : { imagesSummary }),
  };
}

function validateStateAssets(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) {
    return { error: 'assets must contain one or two displayed assets.' };
  }

  const assets = [];
  for (const asset of value) {
    const id = typeof asset?.id === 'string' ? asset.id.trim() : '';
    if (!id || id.length > 128) {
      return { error: 'Each state asset requires an id no longer than 128 characters.' };
    }

    assets.push({
      id,
      dateLabel: cleanOptionalString(asset.dateLabel, 120),
      locationLabel: cleanOptionalString(asset.locationLabel, 200),
    });
  }

  return { value: assets };
}

function validateQueue(value) {
  const index = Number(value?.index);
  const length = Number(value?.length);

  if (!Number.isInteger(index) || !Number.isInteger(length) || index < 0 || length < 0) {
    return { error: 'queue index and length must be non-negative integers.' };
  }

  return {
    value: {
      index,
      length,
    },
  };
}

function validateSession(value) {
  const type = typeof value?.type === 'string' ? value.type : '';
  if (!SESSION_TYPES.has(type)) {
    return { error: 'session type is invalid.' };
  }

  return {
    value: {
      type,
      title: cleanOptionalString(value.title, 200),
    },
  };
}

function validateUpdatedAt(value) {
  if (value === undefined || value === null || value === '') {
    return { value: new Date().toISOString() };
  }

  if (typeof value !== 'string') {
    return { error: 'updatedAt must be an ISO timestamp string.' };
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { error: 'updatedAt must be a valid ISO timestamp.' };
  }

  return { value: date.toISOString() };
}

function validateDeviceId(value) {
  const deviceId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'frame';

  if (deviceId.length > 32 || !DEVICE_ID_PATTERN.test(deviceId)) {
    return { error: 'deviceId must be a lowercase slug up to 32 characters.' };
  }

  return { value: deviceId };
}

function validateAlbumIds(value, { allowEmpty = false } = {}) {
  const error = `albumIds must contain 1 to ${MAX_FRAME_ALBUMS} album ids.`;

  if ((value === undefined || value === null) && allowEmpty) {
    return { value: [] };
  }

  if (!Array.isArray(value)) {
    return { error };
  }

  const albumIds = [];
  for (const item of value) {
    const albumId = typeof item === 'string' ? item.trim() : '';
    if (!albumId || albumId.length > 128) {
      return { error };
    }

    if (!albumIds.includes(albumId)) {
      albumIds.push(albumId);
    }
  }

  if ((!allowEmpty && albumIds.length === 0) || albumIds.length > MAX_FRAME_ALBUMS) {
    return { error };
  }

  return { value: albumIds };
}

function cleanOptionalString(value, maxLength) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().slice(0, maxLength);
}
