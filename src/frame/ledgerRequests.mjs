const MAX_RECORD_DISPLAY_IDS = 100;
const MAX_DISPLAY_STATS_IDS = 1000;
const MAX_ASSET_ID_LENGTH = 128;
const DEFAULT_FRAME_DEVICE_ID = 'frame';
const DEVICE_ID_PATTERN = /^[a-z0-9-]+$/;
const MAX_DEVICE_ID_LENGTH = 32;
const REPORT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MAX_SHOWN_AT_FUTURE_MS = 24 * 60 * 60 * 1000;

export function validateRecordDisplaysRequest(body) {
  const assetIds = validateAssetIds(body?.assetIds, MAX_RECORD_DISPLAY_IDS);
  if (assetIds.error) {
    return assetIds;
  }

  const deviceId = normalizeDeviceId(body?.deviceId);
  if (!deviceId) {
    return { error: 'Device ID must be a slug with letters, numbers, or hyphens.' };
  }

  const shownAt = validateShownAt(body?.shownAt);
  if (shownAt.error) {
    return shownAt;
  }

  // Optional batch identity for idempotent retries: the app stamps each
  // outbox batch with a UUID, so a batch whose response was lost can be
  // resent without double-counting. Absent for older apps.
  let reportId = null;
  if (body?.reportId !== undefined && body?.reportId !== null) {
    if (typeof body.reportId !== 'string' || !REPORT_ID_PATTERN.test(body.reportId)) {
      return { error: 'reportId must be 8-64 characters of letters, numbers, or hyphens.' };
    }
    reportId = body.reportId;
  }

  return {
    value: {
      assetIds: assetIds.value,
      deviceId,
      shownAt: shownAt.value,
      reportId,
    },
  };
}

export function validateDisplayStatsRequest(body) {
  const assetIds = validateAssetIds(body?.assetIds, MAX_DISPLAY_STATS_IDS);
  if (assetIds.error) {
    return assetIds;
  }

  return {
    value: {
      assetIds: assetIds.value,
    },
  };
}

function validateAssetIds(value, maxCount) {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'assetIds must be a non-empty array.' };
  }

  if (value.length > maxCount) {
    return { error: `assetIds must contain ${maxCount} or fewer entries.` };
  }

  const assetIds = [];
  for (const assetId of value) {
    if (typeof assetId !== 'string' || !assetId.trim() || assetId.length > MAX_ASSET_ID_LENGTH) {
      return { error: 'Each asset ID must be a non-empty string no longer than 128 characters.' };
    }

    assetIds.push(assetId.trim());
  }

  return { value: assetIds };
}

function normalizeDeviceId(value) {
  const deviceId = typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : DEFAULT_FRAME_DEVICE_ID;

  if (deviceId.length > MAX_DEVICE_ID_LENGTH || !DEVICE_ID_PATTERN.test(deviceId)) {
    return '';
  }

  return deviceId;
}

function validateShownAt(value) {
  if (value === undefined || value === null || value === '') {
    return { value: undefined };
  }

  if (typeof value !== 'string') {
    return { error: 'shownAt must be an ISO timestamp string.' };
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return { error: 'shownAt must be a valid ISO timestamp.' };
  }
  if (date.getTime() > Date.now() + MAX_SHOWN_AT_FUTURE_MS) {
    return { error: 'shownAt cannot be more than 24 hours in the future.' };
  }

  return { value: date };
}
