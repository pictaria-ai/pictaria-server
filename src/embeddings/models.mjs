// Immich machine-learning CLIP models. The setting accepts any model name the
// Immich service allows; this list only documents tested suggestions. Sizes are
// the one-time Hugging Face download the service makes on first use (it fetches
// the textual half too), measured 2026-09-27.
export const EMBEDDING_BACKEND = 'immich_ml';
export const DEFAULT_EMBEDDING_MODEL = 'ViT-B-32__openai';

export const SUGGESTED_EMBEDDING_MODELS = Object.freeze([
  Object.freeze({ name: 'ViT-B-32__openai', dims: 512, downloadMb: 611, license: 'MIT',
    note: 'Immich’s default: usually already downloaded and loaded.' }),
  Object.freeze({ name: 'ViT-B-16-SigLIP__webli', dims: 768, downloadMb: 815, license: 'Apache-2.0',
    note: 'Higher Immich-measured recall per GB of RAM.' }),
  Object.freeze({ name: 'ViT-B-16-SigLIP2__webli', dims: 768, downloadMb: 1536, license: 'Apache-2.0',
    note: 'SigLIP 2 base model.' }),
  Object.freeze({ name: 'ViT-L-14__openai', dims: 768, downloadMb: 1716, license: 'MIT',
    note: 'Needed by the LAION aesthetic predictor.' }),
]);

// Immich model names are single path segments such as ViT-B-32__openai. The
// service strips an "immich-app/" repository prefix; do the same so one model
// cannot appear under two names in stored embedding spaces.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function normalizeEmbeddingModel(value) {
  const name = String(value ?? '').trim().replace(/^immich-app\//i, '');
  return name || DEFAULT_EMBEDDING_MODEL;
}

// Known output sizes guard against a misrouted or misbehaving service.
export function expectedDimensions(model) {
  return SUGGESTED_EMBEDDING_MODELS.find((entry) => entry.name === model)?.dims ?? null;
}

export function validEmbeddingModel(value) {
  return typeof value === 'string' && MODEL_NAME.test(value);
}
