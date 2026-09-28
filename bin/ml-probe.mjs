#!/usr/bin/env node
// Validation probe for Immich's machine-learning service, used before relying
// on a new Immich release for image embeddings (see IMMICH-COMPATIBILITY.md).
// Sends synthetic images only, never a photo, and prints a JSON report:
// request/response shape, dimensions, repeat determinism, latency, error
// behavior and how strongly the calibration image reacts to a crop-versus-
// squash preprocessing change.
//
// Usage: node bin/ml-probe.mjs --url=http://immich-host:3003 [--model=ViT-B-32__openai] [--repeats=3]
//
// Using a model the service has not downloaded yet makes it fetch that model
// (0.6–1.7 GB) inside the first request. The default is Immich's own model.

import { performance } from 'node:perf_hooks';

import { CALIBRATION_MATCH, CALIBRATION_SIZE, calibrationImage, calibrationPixels, encodePng } from '../src/embeddings/calibration.mjs';
import { ImmichMlClient } from '../src/embeddings/client.mjs';
import { DEFAULT_EMBEDDING_MODEL } from '../src/embeddings/models.mjs';
import { cosineSimilarity } from '../src/embeddings/vectors.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
if (!args.url) {
  console.error('Usage: node bin/ml-probe.mjs --url=http://immich-host:3003 [--model=ViT-B-32__openai] [--repeats=3]');
  process.exit(2);
}
const model = args.model || DEFAULT_EMBEDDING_MODEL;
const repeats = Math.max(2, Math.min(10, Number(args.repeats) || 3));
const client = new ImmichMlClient({ baseUrl: args.url });

async function timed(work) {
  const started = performance.now();
  const value = await work();
  return { value, ms: Math.round(performance.now() - started) };
}

// Pillow-style separable resampling (8-bit rounding after each pass) so the
// probe can reproduce what the service does and alter one step at a time.
const FILTERS = {
  bilinear: { support: 1, weight: (x) => (x = Math.abs(x)) < 1 ? 1 - x : 0 },
  bicubic: { support: 2, weight: (x) => {
    const a = -0.5;
    x = Math.abs(x);
    return x < 1 ? ((a + 2) * x - (a + 3)) * x * x + 1 : x < 2 ? (((x - 5) * x + 8) * x - 4) * a : 0;
  } },
};

function pass(src, width, height, size, horizontal, filterName) {
  const inSize = horizontal ? width : height;
  const out = Buffer.alloc((horizontal ? size * height : width * size) * 3);
  const scale = inSize / size, filterScale = Math.max(scale, 1);
  for (let o = 0; o < size; o++) {
    let weights = [], first = 0;
    if (filterName === 'nearest') {
      first = Math.min(inSize - 1, Math.floor((o + 0.5) * scale));
      weights = [1];
    } else {
      const { support, weight } = FILTERS[filterName];
      const center = (o + 0.5) * scale, reach = support * filterScale;
      first = Math.max(Math.trunc(center - reach + 0.5), 0);
      const last = Math.min(Math.trunc(center + reach + 0.5), inSize);
      for (let i = first; i < last; i++) weights.push(weight((i - center + 0.5) / filterScale));
      const total = weights.reduce((sum, w) => sum + w, 0);
      weights = weights.map((w) => w / total);
    }
    const lines = horizontal ? height : width;
    for (let line = 0; line < lines; line++) {
      for (let c = 0; c < 3; c++) {
        let value = 0;
        for (let k = 0; k < weights.length; k++) {
          const i = first + k;
          value += weights[k] * src[((horizontal ? line * width + i : i * width + line) * 3) + c];
        }
        out[((horizontal ? line * size + o : o * width + line) * 3) + c] = Math.max(0, Math.min(255, Math.round(value)));
      }
    }
  }
  return out;
}

function resize(rgb, width, height, outWidth, outHeight, filterName) {
  const wide = pass(rgb, width, height, outWidth, true, filterName);
  return pass(wide, outWidth, height, outHeight, false, filterName);
}

function crop(rgb, width, x0, y0, cropWidth, cropHeight) {
  const out = Buffer.alloc(cropWidth * cropHeight * 3);
  for (let y = 0; y < cropHeight; y++) rgb.copy(out, y * cropWidth * 3, ((y0 + y) * width + x0) * 3, ((y0 + y) * width + x0 + cropWidth) * 3);
  return out;
}

const png = (rgb, width, height) => ({ data: encodePng(width, height, rgb), contentType: 'image/png' });

// Immich 2.7.5–3.2.2 CLIP preprocessing: shortest side to the model size
// (224 for the suggested base models) with bicubic resampling, then a centre
// crop. Sending an image already at 224 × 224 skips both on the service side.
function preprocessed({ filter = 'bicubic', mode = 'shortest', size = 224, transform = null } = {}) {
  const { width: W, height: H } = CALIBRATION_SIZE;
  let rgb;
  if (mode === 'squash') rgb = resize(calibrationPixels(), W, H, size, size, filter);
  else {
    const scaledWidth = Math.trunc((W / H) * size);
    const scaled = resize(calibrationPixels(), W, H, scaledWidth, size, filter);
    rgb = crop(scaled, scaledWidth, Math.trunc(scaledWidth / 2 - size / 2), 0, size, size);
  }
  if (transform) rgb = transform(Buffer.from(rgb));
  return png(rgb, size, size);
}

const swapChannels = (rgb) => { for (let i = 0; i < rgb.length; i += 3) [rgb[i], rgb[i + 2]] = [rgb[i + 2], rgb[i]]; return rgb; };
// A CLIP-mean/std model normalised with SigLIP's 0.5/0.5 instead: send pixels
// that the service's correct normalisation maps to the wrong values.
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073], CLIP_STD = [0.26862954, 0.26130258, 0.27577711];
const renormalise = (rgb) => {
  for (let i = 0; i < rgb.length; i++) {
    const c = i % 3, p = rgb[i] / 255;
    rgb[i] = Math.max(0, Math.min(255, Math.round(255 * (CLIP_MEAN[c] + (CLIP_STD[c] * (p - 0.5)) / 0.5))));
  }
  return rgb;
};

async function expectFailure(label, work) {
  try {
    await work();
    return { label, outcome: 'unexpected success' };
  } catch (error) {
    return { label, code: error.code ?? error.name, status: error.status ?? null };
  }
}

const report = { url: args.url, model, calibrationMatch: CALIBRATION_MATCH, node: process.version };
report.ping = await timed(() => client.ping({ timeoutMs: 60_000 })).then(({ ms }) => ({ ok: true, ms }));

const calibration = [];
for (let i = 0; i < repeats; i++) {
  calibration.push(await timed(() => client.embedImage(calibrationImage(), { model, timeoutMs: 10 * 60_000 })));
}
const reference = calibration[0].value;
report.dims = reference.length;
report.norm = Math.sqrt(reference.reduce((sum, x) => sum + x * x, 0));
report.calibrationMs = calibration.map(({ ms }) => ms);
report.repeatCosine = calibration.slice(1).map(({ value }) => cosineSimilarity(reference, value));
report.repeatExact = calibration.slice(1).every(({ value }) => value.every((x, i) => x === reference[i]));

// Each variant changes exactly one preprocessing step. The first reproduces
// the service's own pipeline and should match the reference almost exactly.
const variants = {
  emulatedService: preprocessed(),
  bilinearResampling: preprocessed({ filter: 'bilinear' }),
  nearestResampling: preprocessed({ filter: 'nearest' }),
  squashInsteadOfCrop: preprocessed({ mode: 'squash' }),
  swappedRedBlue: preprocessed({ transform: swapChannels }),
  siglipNormalisation: preprocessed({ transform: renormalise }),
};
// `cosine` compares with the service's own result for the calibration image;
// `vsEmulated` isolates the one changed step even if the emulation is imperfect.
report.preprocessing = {};
const vectors = {};
for (const [name, image] of Object.entries(variants)) vectors[name] = await client.embedImage(image, { model });
for (const [name, vector] of Object.entries(vectors)) {
  const similarity = cosineSimilarity(reference, vector);
  report.preprocessing[name] = { cosine: similarity, vsEmulated: cosineSimilarity(vectors.emulatedService, vector),
    separateSpace: similarity < CALIBRATION_MATCH };
}

const photoSized = png(resize(calibrationPixels(), CALIBRATION_SIZE.width, CALIBRATION_SIZE.height, 1440, 960, 'bicubic'), 1440, 960);
report.photoSizedMs = [];
for (let i = 0; i < repeats; i++) report.photoSizedMs.push((await timed(() => client.embedImage(photoSized, { model }))).ms);

report.failures = [
  await expectFailure('undecodable image', () => client.embedImage({ data: Buffer.from('not an image'), contentType: 'image/jpeg' }, { model })),
  await expectFailure('unknown model', () => client.embedImage(calibrationImage(), { model: 'Not-A-Model__probe' })),
];

console.log(JSON.stringify(report, null, 2));
