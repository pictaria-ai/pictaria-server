import { CurateError, fingerprint } from './contracts.mjs';
import { EmbeddingServiceError } from '../embeddings/client.mjs';
import { EMBEDDING_BACKEND } from '../embeddings/models.mjs';
import { cosineSimilarity } from '../embeddings/vectors.mjs';

export const LAB_EMBEDDING_LIMITS = Object.freeze({ perPass: 60, passMs: 5 * 60_000 });

// Explicit, bounded embedding passes for one open lab group (PIC-381 spike).
// Vectors go to the same permanent store under the same identity rules as the
// Enrich step; the browser receives only rounded pairwise similarities.
export class LabEmbeddings {
  constructor(lab, service) {
    this.lab = lab;
    this.service = service;
  }

  #state({ viewId, groupId } = {}) {
    const { photos } = this.lab.comparison(viewId, groupId);
    const { enabled, url, model } = this.service.settings();
    const store = this.service.repo.embeddings;
    const space = store.latestSpace({ backend: EMBEDDING_BACKEND, model });
    const vectors = space ? store.vectors(space.id, photos.map((p) => p.id)) : new Map();
    const missing = photos.filter((p) => !vectors.has(p.id)).map((p) => p.id);
    const batch = missing.slice(0, LAB_EMBEDDING_LIMITS.perPass);
    return { photos, url, model, enrichEnabled: enabled, space, vectors, missing, batch,
      admission: fingerprint([viewId, groupId, url, model, space?.id ?? null, missing]) };
  }

  // Read-only coverage and similarity for the open group; never contacts the
  // machine-learning service.
  plan(body = {}) {
    const state = this.#state(body);
    return {
      configured: Boolean(state.url), enrichEnabled: state.enrichEnabled, model: state.model,
      space: state.space ? { dims: state.space.dims, verifiedAt: state.space.verifiedAt } : null,
      total: state.photos.length, current: state.vectors.size, missing: state.missing.length,
      newEmbeddings: state.batch.length, remaining: state.missing.length - state.batch.length,
      busy: this.service.enrichActive(), admission: state.admission,
      similarity: similarity(state.photos, state.vectors),
    };
  }

  async run(body, { signal, emit }) {
    const state = this.#state(body);
    if (body.admission !== state.admission) {
      throw new CurateError('The embedding estimate changed. Review the updated estimate and start again.', 'lab_embedding_estimate_changed');
    }
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(LAB_EMBEDDING_LIMITS.passMs)]);
    const messages = [];
    let pass;
    try {
      pass = this.service.labPass({ log: (message) => messages.push(message), signal: deadline });
    } catch (error) {
      if (error instanceof EmbeddingServiceError) throw new CurateError(error.message, 'lab_embeddings_busy', 503);
      throw error;
    }
    const immich = this.lab.curate.immich;
    const check = () => {
      deadline.throwIfAborted();
      // The lab snapshot must still exist; the group itself is fixed.
      this.lab.comparison(body.viewId, body.groupId);
    };
    try {
      await emit({ type: 'start', model: state.model, newEmbeddings: state.batch.length, remaining: state.missing.length - state.batch.length });
      await emit({ type: 'calibrating' });
      await pass.start({ waitForModel: true });
      check();
      if (pass.stopped || !pass.space) {
        await emit({ type: 'done', stopped: true, message: lastReason(pass, messages) });
        return;
      }
      let completed = 0;
      for (const assetId of state.batch) {
        check();
        if (this.service.enrichActive()) {
          await emit({ type: 'done', stopped: true,
            message: 'An Enrich run started embedding photos, so this pass stopped to leave the machine-learning service to it. Completed photos are kept.' });
          return;
        }
        await emit({ type: 'progress', assetId, completed, total: state.batch.length });
        const pending = pass.embed({ assetId,
          loadImage: (requestSignal) => immich.getAssetThumbnail(assetId, 'preview', { signal: requestSignal }) });
        const outcome = pending ? await pending : pass.stopped ? 'paused' : 'current';
        completed++;
        await emit({ type: 'photo', assetId, outcome });
        if (pass.stopped) {
          await emit({ type: 'done', stopped: true, message: lastReason(pass, messages) });
          return;
        }
      }
      check();
      await emit({ type: 'done', stopped: false,
        message: state.missing.length > state.batch.length ? 'Pass complete. More photos remain without embeddings.' : 'Pass complete.' });
    } finally {
      await pass.close({ cancelled: deadline.aborted });
    }
  }
}

// Upper-triangle cosine similarities in photo order, rounded for display and
// the experiment rules; null where either photo lacks a current vector.
function similarity(photos, vectors) {
  const values = [];
  for (let i = 0; i < photos.length; i++) {
    for (let j = i + 1; j < photos.length; j++) {
      const value = cosineSimilarity(vectors.get(photos[i].id), vectors.get(photos[j].id));
      values.push(value === null ? null : Math.round(value * 10_000) / 10_000);
    }
  }
  return { ids: photos.map((p) => p.id), values };
}

function lastReason(pass, messages) {
  const reason = pass.reason ?? messages.at(-1) ?? 'The machine-learning service is unavailable.';
  return reason.replace(/^image embeddings( paused for this run| paused for the rest of this run| stopped for this run)?: /, '');
}
