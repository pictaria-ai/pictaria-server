import { readJsonBody, sendError, sendImage, sendJson, sendNoContent } from '../http.mjs';
import { validateDisplayStatsRequest, validateRecordDisplaysRequest } from '../frame/ledgerRequests.mjs';
import { validateFrameCommandRequest, validateFrameEventDevice, validateFrameStateRequest } from '../frame/remote.mjs';
import { getFrameEligibleTagId } from '../frame/tags.mjs';

export function createFrameRoutes({ immich, frameHub, frameLedger, requireImmich, voiceMetrics = null, activityLog = null }) {
  return async function handleFrameRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/frame')) {
      return false;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame/events') {
      const role = url.searchParams.get('role');
      if (role !== 'frame' && role !== 'remote') {
        sendError(response, 400, 'invalid_frame_event_role', 'role must be frame or remote.');
        return true;
      }
      const device = validateFrameEventDevice(url.searchParams.get('device'));
      if (device.error) {
        sendError(response, 400, 'invalid_frame_event_device', device.error);
        return true;
      }
      const accepted = frameHub.subscribe(role, request, response, { deviceId: role === 'frame' ? device.value : null });
      if (!accepted) {
        sendError(response, 503, 'frame_event_capacity', 'Too many active frame event streams. Try again shortly.', {
          Connection: 'close',
          'Retry-After': '5',
        });
      }
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame/status') {
      sendJson(response, 200, {
        ...frameHub.getHubStatus(),
        stats: await getFrameStatsPayload(),
      });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame/stats') {
      sendJson(response, 200, await getFrameStatsPayload());
      return true;
    }

    // Every device the server knows about — live hub entries merged with the
    // durable display ledger, so retired frames show up too.
    if (request.method === 'GET' && url.pathname === '/api/frame/devices') {
      sendJson(response, 200, { devices: listKnownDevices() });
      return true;
    }

    const deviceMatch = url.pathname.match(/^\/api\/frame\/devices\/([^/]+)$/);
    if (request.method === 'DELETE' && deviceMatch) {
      const deviceId = decodeURIComponent(deviceMatch[1]);
      if (frameHub.deviceHasNamedConnection(deviceId)) {
        sendError(response, 409, 'device_connected', 'This device is online right now. Turn it off first, then delete it.');
        return true;
      }
      const forgotten = frameHub.forgetDevice(deviceId);
      const deletedDisplays = frameLedger.deleteDeviceDisplays(deviceId);
      const deletedVoiceUses = voiceMetrics?.deleteDevice(deviceId) ?? 0;
      if (!forgotten && deletedDisplays === 0 && deletedVoiceUses === 0) {
        sendError(response, 404, 'device_not_found', 'No device with that name is known to the server.');
        return true;
      }
      sendJson(response, 200, { deviceId, deletedDisplays, deletedVoiceUses });
      return true;
    }

    // Most-displayed assets for the App Metrics page.
    if (request.method === 'GET' && url.pathname === '/api/frame/ledger/top') {
      const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      sendJson(response, 200, { items: frameLedger.topShown(Number.isFinite(limit) ? limit : 12) });
      return true;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame/albums') {
      if (!requireImmich(response)) {
        return true;
      }
      const albums = await immich.getAlbums();
      sendJson(
        response,
        200,
        albums
          .map((album) => ({
            id: album.id,
            albumName: album.albumName ?? '',
            assetCount: typeof album.assetCount === 'number' ? album.assetCount : undefined,
          }))
          .filter((album) => album.id && album.albumName)
          .sort((left, right) => left.albumName.localeCompare(right.albumName)),
      );
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/frame/displays') {
      const validation = validateRecordDisplaysRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_frame_displays_request', validation.error);
        return true;
      }
      const result = frameLedger.recordDisplays(
        validation.value.assetIds,
        validation.value.deviceId,
        validation.value.shownAt ?? new Date(),
        validation.value.reportId,
      );
      sendJson(response, 200, { recorded: result.recorded, duplicate: result.duplicate });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/frame/display-stats') {
      const validation = validateDisplayStatsRequest(await readJsonBody(request));
      if (validation.error) {
        sendError(response, 400, 'invalid_frame_display_stats_request', validation.error);
        return true;
      }
      sendJson(response, 200, { stats: frameLedger.getDisplayStats(validation.value.assetIds) });
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/frame/state') {
      const validation = validateFrameStateRequest(await readJsonBody(request, { maxBytes: 8 * 1024 }));
      if (validation.error) {
        sendError(response, 400, 'invalid_frame_state_request', validation.error);
        return true;
      }
      frameHub.publishState(validation.value);
      sendNoContent(response);
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/frame/command') {
      const validation = validateFrameCommandRequest(await readJsonBody(request, { maxBytes: 8 * 1024 }));
      if (validation.error) {
        sendError(response, 400, 'invalid_frame_command_request', validation.error);
        return true;
      }
      // deliveredCount is honest: a device-targeted command that found no
      // connection registered under that exact name reports 0 (delivered:
      // false) — it never falls back to other frames.
      const deliveredCount = frameHub.publishCommand(validation.value);
      activityLog?.frameCommand({
        command: validation.value.command,
        deviceId: validation.value.deviceId,
        deliveredCount,
        ...(validation.value.target ? { target: validation.value.target } : {}),
      });
      sendJson(response, 200, { delivered: deliveredCount > 0, deliveredCount });
      return true;
    }

    const thumbnailMatch = url.pathname.match(/^\/api\/frame\/asset-thumbnail\/([^/]+)$/);
    if (request.method === 'GET' && thumbnailMatch) {
      if (!requireImmich(response)) {
        return true;
      }
      const image = await immich.getAssetThumbnail(decodeURIComponent(thumbnailMatch[1]), 'thumbnail');
      sendImage(response, 200, image.data);
      return true;
    }

    return false;
  };

  function listKnownDevices() {
    const devices = new Map();
    for (const device of frameLedger.getLedgerSummary().devices) {
      devices.set(device.deviceId, {
        connected: false,
        deviceId: device.deviceId,
        lastDisplayAt: device.lastDisplayAt,
        lastStateAt: null,
        totalDisplays: device.totalDisplays,
      });
    }
    for (const device of frameHub.getHubStatus().devices) {
      const entry = devices.get(device.deviceId) ?? {
        connected: false,
        deviceId: device.deviceId,
        lastDisplayAt: null,
        lastStateAt: null,
        totalDisplays: 0,
      };
      entry.connected = device.connected;
      entry.lastStateAt = device.lastStateAt;
      devices.set(device.deviceId, entry);
    }
    return [...devices.values()].sort((left, right) => left.deviceId.localeCompare(right.deviceId));
  }

  async function getFrameStatsPayload() {
    const summary = frameLedger.getLedgerSummary();
    return {
      ...summary,
      eligibleAssetCount: await getEligibleAssetCount(),
    };
  }

  async function getEligibleAssetCount() {
    try {
      const eligibleTagId = await getFrameEligibleTagId(immich);
      if (!eligibleTagId) {
        return null;
      }
      const response = await immich.searchStatistics({
        isArchived: false,
        tagIds: [eligibleTagId],
        type: 'IMAGE',
        visibility: 'timeline',
      });
      return typeof response?.total === 'number' ? response.total : null;
    } catch (error) {
      console.warn(
        '[Pictaria] Unable to fetch frame eligible asset count.',
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
}
