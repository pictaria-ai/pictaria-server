import { readJsonBody, sendBinary, sendError, sendJson, sendNoContent } from '../http.mjs';
import { inspectWakeWordModel, WakeWordModelValidationError } from '../wakeword/modelInspector.mjs';
import { WakeWordModelStoreError } from '../wakeword/store.mjs';

export const MAX_WAKE_WORD_MODEL_BYTES = 5 * 1024 * 1024;
const MAX_UPLOAD_BODY_BYTES = 8 * 1024 * 1024;
// Wake-word uploads encode models up to 5 MiB as base64 JSON, so keep a
// longer but finite allowance for slower supported private-VPN links.
const MAX_UPLOAD_BODY_TIMEOUT_MS = 120_000;

export function createWakeWordRoutes({ store }) {
  return async function handleWakeWordRoute(request, response, url) {
    if (!url.pathname.startsWith('/api/frame/wake-word-models')) {
      return false;
    }

    if (request.method === 'GET' && url.pathname === '/api/frame/wake-word-models') {
      try {
        const models = await store.listModels();
        sendJson(response, 200, {
          featureStack: 'pictaria-openwakeword-v1',
          models: models.map(toApiModel),
          version: 1,
        }, { 'Cache-Control': 'no-store' });
      } catch (error) {
        if (sendStoreError(response, error)) {
          return true;
        }
        throw error;
      }
      return true;
    }

    if (request.method === 'POST' && url.pathname === '/api/frame/wake-word-models') {
      try {
        const body = await readJsonBody(request, {
          maxBytes: MAX_UPLOAD_BODY_BYTES,
          timeoutMs: MAX_UPLOAD_BODY_TIMEOUT_MS,
        });
        const upload = validateUpload(body);
        const inspection = inspectWakeWordModel(upload.bytes);
        const model = await store.addModel({ ...upload, inspection });
        sendJson(response, 201, toApiModel({ ...model, available: true, unavailableReason: null }));
      } catch (error) {
        if (error instanceof WakeWordModelValidationError) {
          sendError(response, 400, error.code, error.message);
          return true;
        }
        if (sendStoreError(response, error)) {
          return true;
        }
        throw error;
      }
      return true;
    }

    const match = url.pathname.match(/^\/api\/frame\/wake-word-models\/([^/]+)(\/download)?$/);
    if (!match) {
      return false;
    }
    const modelId = decodeURIComponent(match[1]);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(modelId)) {
      sendError(response, 400, 'invalid_wake_word_model_id', 'Wake-word model id is invalid.');
      return true;
    }

    if (request.method === 'GET' && match[2] === '/download') {
      try {
        const { bytes, model } = await store.readModel(modelId);
        sendBinary(response, 200, bytes, 'application/vnd.tflite', {
          'Cache-Control': 'private, max-age=31536000, immutable',
          'Content-Disposition': 'attachment; filename="wake-word-model.tflite"',
          ETag: `"sha256-${model.sha256}"`,
          'X-Content-SHA256': model.sha256,
        });
      } catch (error) {
        if (sendStoreError(response, error)) {
          return true;
        }
        throw error;
      }
      return true;
    }

    if (request.method === 'DELETE' && !match[2]) {
      try {
        if (!(await store.deleteModel(modelId))) {
          sendError(response, 404, 'wake_word_model_not_found', 'Wake-word model not found.');
          return true;
        }
        sendNoContent(response);
      } catch (error) {
        if (sendStoreError(response, error)) {
          return true;
        }
        throw error;
      }
      return true;
    }

    return false;
  };
}

function sendStoreError(response, error) {
  if (error instanceof WakeWordModelStoreError) {
    sendError(response, error.status, error.code, error.message);
    return true;
  }
  return false;
}

function validateUpload(body) {
  const displayName = cleanText(body?.displayName, 60);
  const phrase = cleanText(body?.phrase, 100);
  const originalFilename = cleanText(body?.filename, 120);
  const defaultThreshold = Number(body?.defaultThreshold);
  if (!displayName) {
    throw new WakeWordModelValidationError('Model name is required (60 characters maximum).');
  }
  if (!phrase) {
    throw new WakeWordModelValidationError('Spoken wake phrase is required (100 characters maximum).');
  }
  if (!originalFilename || !/\.tflite$/i.test(originalFilename)) {
    throw new WakeWordModelValidationError('Choose a .tflite wake-word model file.');
  }
  if (!Number.isFinite(defaultThreshold) || defaultThreshold < 0.05 || defaultThreshold >= 0.95) {
    throw new WakeWordModelValidationError('Default threshold must be between 0.05 and 0.94.');
  }
  if (body?.rightsConfirmed !== true) {
    throw new WakeWordModelValidationError('Confirm that you have the right to use and distribute this model.');
  }
  const bytes = decodeBase64(body?.modelBase64);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_WAKE_WORD_MODEL_BYTES) {
    throw new WakeWordModelValidationError('Wake-word model must be no larger than 5 MB.');
  }
  return {
    bytes,
    defaultThreshold,
    displayName,
    originalFilename,
    phrase,
  };
}

function cleanText(value, maxLength) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return text && text.length <= maxLength ? text : '';
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new WakeWordModelValidationError('Model payload must be valid base64.');
  }
  return Buffer.from(value, 'base64');
}

function toApiModel(model) {
  return {
    id: model.id,
    displayName: model.displayName,
    phrase: model.phrase,
    defaultThreshold: model.defaultThreshold,
    filename: model.originalFilename,
    byteSize: model.byteSize,
    sha256: model.sha256,
    createdAt: model.createdAt,
    updatedAt: model.updatedAt,
    rightsConfirmedAt: model.rightsConfirmedAt,
    featureStack: model.featureStack,
    inputFrames: model.inputFrames,
    embeddingDimension: model.embeddingDimension,
    available: model.available !== false,
    unavailableReason: model.unavailableReason ?? null,
    downloadPath: `/api/frame/wake-word-models/${encodeURIComponent(model.id)}/download`,
  };
}
