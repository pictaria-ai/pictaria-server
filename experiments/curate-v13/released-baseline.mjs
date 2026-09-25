// Evaluation adapter only. Use the unchanged released request contract directly;
// never instantiate a worker, fetch images or write state.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildRefereeRequest, normalizePicks } from '../../src/enrich/referee-contract.mjs';

export const RELEASED_BASELINE = 'v1.2.1-referee-v2';
// Extracted from the v1.2.1 service (SHA256 a96070cf…44894), with identical
// request objects verified for every supported 2–10-photo input size.
const CONTRACT_SHA256 = 'd7fbe87d391ef88f7c13ec8b9dd9212a23f7a657695e1f7ec19bda66d9758fbd';

export async function releasedPrompt(ids, photos = []) {
  if (ids.length < 2 || ids.length > 10 || new Set(ids).size !== ids.length
    || photos.length !== ids.length || photos.some((p, i) => p.id !== ids[i]
      || (p.capturedAt != null && typeof p.capturedAt !== 'string')
      || (p.aiTags != null && (!Array.isArray(p.aiTags) || p.aiTags.some(t => typeof t !== 'string'))))) {
    throw Error('invalid released baseline inputs');
  }
  const source = readFileSync(new URL('../../src/enrich/referee-contract.mjs', import.meta.url));
  if (createHash('sha256').update(source).digest('hex') !== CONTRACT_SHA256) {
    throw Error('released baseline contract changed');
  }
  return buildRefereeRequest(photos.map((p, i) => ({
    assetId: ids[i], capturedAt: p.capturedAt, aiTags: p.aiTags,
  })));
}

// The released normalizer can fill missing ranks and coerce values. Preserve its
// result for diagnosis, but never score repaired data as valid model judgment.
export function inspectReleasedAnswer(ids, modelAnswer) {
  const rows = modelAnswer?.photos;
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const inRange = value => Number.isInteger(value) && value >= 1 && value <= ids.length;
  const valid = object(modelAnswer) && typeof modelAnswer.same_subject === 'boolean'
    && Object.keys(modelAnswer).every(k => ['same_subject', 'photos'].includes(k))
    && Array.isArray(rows) && rows.length === ids.length && rows.every(p => object(p)
      && Object.keys(p).every(k => ['photo', 'rank', 'keep', 'eyes_closed', 'note', 'subject_group'].includes(k))
      && inRange(p.photo) && inRange(p.rank) && inRange(p.subject_group)
      && typeof p.keep === 'boolean' && typeof p.note === 'string'
      && ['yes', 'no', 'unsure'].includes(p.eyes_closed))
    && new Set(rows.map(p => p.photo)).size === ids.length
    && new Set(rows.map(p => p.rank)).size === ids.length;
  const normalizedPicks = normalizePicks(modelAnswer, ids.map(assetId => ({ assetId })));
  const output = { modelAnswer, normalizedPicks };
  if (!valid) return { valid: false, output };
  const groups = new Map();
  for (const p of normalizedPicks) {
    if (!groups.has(p.subjectGroup)) groups.set(p.subjectGroup, []);
    groups.get(p.subjectGroup).push(p);
  }
  // Within a frozen input batch, show the rank projection separately from keep
  // flags. Singletons leave the stack in the released UI and receive no star.
  output.bestRankedId = normalizedPicks.find(p => p.rank === 1).assetId;
  output.keepIds = normalizedPicks.filter(p => p.keep).map(p => p.assetId);
  output.stackHighlights = [...groups.values()].filter(g => g.length > 1)
    .map(g => g.reduce((a, b) => a.rank < b.rank ? a : b).assetId);
  output.singlePhotoIds = [...groups.values()].filter(g => g.length === 1).map(g => g[0].assetId);
  return { valid: true, output };
}
