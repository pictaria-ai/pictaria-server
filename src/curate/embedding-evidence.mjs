import { EMBEDDING_BACKEND, normalizeEmbeddingModel } from '../embeddings/models.mjs';
import { EmbeddingStore } from '../embeddings/store.mjs';
import { cosineSimilarity } from '../embeddings/vectors.mjs';
import { fingerprint } from './contracts.mjs';

// Pictaria image embeddings as stacking evidence (candidate-4, PIC-392).
// Thresholds are per model, from judged stacking-lab groups (PIC-381): pairs at
// `near` or more were the same stack, pairs at `far` or less were different,
// and between them judgments went both ways. `average` joins a single photo to
// an established core. A model without an entry is never used for stacking.
export const STACK_EMBEDDING_THRESHOLDS = Object.freeze({
  'ViT-B-32__openai': Object.freeze({ near: 0.9, far: 0.75, average: 0.8 }),
});
// ThumbHash bands from the lab's combined evidence: a very close descriptor
// outweighs clearly different embeddings; a middle-band one corroborates a
// middle-band embedding.
export const STACK_EMBEDDING_LIMITS = Object.freeze({ veryCloseHash: 0.025, corroboratingHash: 0.15 });

// Embeddings take part only when Image embeddings is on, the Curate switch is
// on (the default), the selected model is calibrated and has a stored set.
export function stackEmbeddingPolicy(config, store) {
  if (config?.curateEmbeddingStacks === false || config?.enrichEmbeddings?.enabled !== true) return null;
  const model = normalizeEmbeddingModel(config.enrichEmbeddings.model);
  const thresholds = STACK_EMBEDDING_THRESHOLDS[model];
  const space = thresholds ? store?.latestSpace({ backend: EMBEDDING_BACKEND, model }) : null;
  if (!space) return null;
  const policy = { model, spaceId: space.id, ...thresholds };
  return { ...policy, key: fingerprint(policy) };
}

// Evidence for one rebuild, read from the caller's database snapshot. Vectors
// are loaded for one time candidate at a time; identities for every pending
// photo let cached groupings notice an embedding that arrived later.
export function embeddingEvidence(db, policy) {
  if (!policy) return null;
  const store = new EmbeddingStore(db);
  let vectors = new Map();
  const keys = new Map();
  return {
    key: policy.key, near: policy.near, far: policy.far, average: policy.average,
    loadKeys(ids) {
      const missing = ids.filter((id) => !keys.has(id));
      const found = store.currentKeys(policy.spaceId, missing);
      for (const id of missing) keys.set(id, found.get(id) ?? null);
    },
    // Changes when the policy or any member's current vector changes.
    signature(ids) {
      this.loadKeys(ids);
      return fingerprint({ policy: policy.key, members: ids.map((id) => [id, keys.get(id)]) });
    },
    prepare(ids) { vectors = store.vectors(policy.spaceId, ids); },
    // Cosine similarity of the two current vectors; null when either is unknown.
    similarity(a, b) {
      const left = vectors.get(a), right = vectors.get(b);
      return left && right ? cosineSimilarity(left, right) : null;
    },
  };
}
