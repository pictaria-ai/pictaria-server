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

// Bilinear sample of the calibration pixels into a new width × height image,
// reading the source rectangle [x0, x0 + sw) × [y0, y0 + sh).
function resample(width, height, { x0 = 0, y0 = 0, sw = CALIBRATION_SIZE.width, sh = CALIBRATION_SIZE.height } = {}) {
  const src = calibrationPixels(), { width: W, height: H } = CALIBRATION_SIZE;
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const fx = Math.min(W - 1, Math.max(0, x0 + ((x + 0.5) * sw) / width - 0.5));
      const fy = Math.min(H - 1, Math.max(0, y0 + ((y + 0.5) * sh) / height - 0.5));
      const ix = Math.floor(fx), iy = Math.floor(fy), dx = fx - ix, dy = fy - iy;
      for (let c = 0; c < 3; c++) {
        const at = (px, py) => src[(Math.min(H - 1, py) * W + Math.min(W - 1, px)) * 3 + c];
        const value = at(ix, iy) * (1 - dx) * (1 - dy) + at(ix + 1, iy) * dx * (1 - dy)
          + at(ix, iy + 1) * (1 - dx) * dy + at(ix + 1, iy + 1) * dx * dy;
        out[(y * width + x) * 3 + c] = Math.round(value);
      }
    }
  }
  return { data: encodePng(width, height, out), contentType: 'image/png' };
}

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

// What the service does itself (shortest-side resize, centre crop) versus a
// release that squashes the whole frame instead.
const cropped = await client.embedImage(resample(256, 256, { x0: 64, sw: 256 }), { model });
const squashed = await client.embedImage(resample(256, 256), { model });
const larger = await client.embedImage(resample(768, 512), { model });
report.preprocessing = {
  centreCropCosine: cosineSimilarity(reference, cropped),
  squashCosine: cosineSimilarity(reference, squashed),
  upscaledCosine: cosineSimilarity(reference, larger),
  squashDetected: cosineSimilarity(reference, squashed) < CALIBRATION_MATCH,
};

const photoSized = resample(1440, 960);
report.photoSizedMs = [];
for (let i = 0; i < repeats; i++) report.photoSizedMs.push((await timed(() => client.embedImage(photoSized, { model }))).ms);

report.failures = [
  await expectFailure('undecodable image', () => client.embedImage({ data: Buffer.from('not an image'), contentType: 'image/jpeg' }, { model })),
  await expectFailure('unknown model', () => client.embedImage(calibrationImage(), { model: 'Not-A-Model__probe' })),
];

console.log(JSON.stringify(report, null, 2));
