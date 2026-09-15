import { fingerprint } from './contracts.mjs';

export const EVIDENCE_VERSION = 1;
export const MAX_EVIDENCE_BYTES = 4096;
export const MAX_PEOPLE = 100;
const text = (v, max = 256) => (typeof v === 'string' && v.length <= max ? v : null);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const has = (o, k) => Object.hasOwn(o, k);

export const hasObservationFields = (asset) =>
  ['people', 'isTrashed', 'isOffline', 'isEdited'].some((key) => has(asset, key)) ||
  (asset.exifInfo && has(asset.exifInfo, 'orientation'));

// Partial API responses replace only fields actually observed. An absent people
// list is unknown; even an explicit empty list never proves detection complete.
export function observeAsset(asset, previous = {}) {
  // Original identity, dimensions, duplicate ID and thumbnail already live in
  // assets. Retain only evidence that table cannot represent (also drops keys
  // duplicated by the first development format on the next observation).
  const next = { version: EVIDENCE_VERSION };
  for (const key of ['recognition', 'orientation', 'isTrashed', 'isOffline', 'isEdited'])
    if (has(previous, key)) next[key] = previous[key];
  if (has(asset, 'people')) {
    const valid = Array.isArray(asset.people) && asset.people.every((p) => text(p?.id, 128));
    const ids = valid ? [...new Set(asset.people.map((p) => p.id))].sort() : null;
    next.recognition = {
      ids: ids && ids.length <= MAX_PEOPLE ? ids : null,
      count: ids && ids.length <= MAX_PEOPLE ? ids.length : null,
      signature: ids ? fingerprint(ids) : null,
      completeness: 'unknown',
      omitted: !valid || ids.length > MAX_PEOPLE,
    };
  }
  // Exclude updatedAt: tags/descriptions also advance it. Actual observed image
  // edits below invalidate material input without treating every tag sync as an edit.
  for (const key of ['isTrashed', 'isOffline']) if (typeof asset[key] === 'boolean') next[key] = asset[key];
  const exif = asset.exifInfo;
  if (exif && has(exif, 'orientation')) next.orientation = text(exif.orientation, 32) ?? finite(exif.orientation);
  if (has(asset, 'isEdited')) next.isEdited = typeof asset.isEdited === 'boolean' ? asset.isEdited : null;
  // Unknown revision fields are deliberately not interpreted. A stable ID, or
  // isEdited=true on both reads, cannot detect all successive Immich edits.
  if (Buffer.byteLength(JSON.stringify(next)) > MAX_EVIDENCE_BYTES) {
    next.recognition = {
      ids: null,
      count: null,
      signature: next.recognition?.signature ?? null,
      completeness: 'unknown',
      omitted: true,
    };
  }
  return next;
}

// Read the producing schema, never today's active taxonomy or tag spellings.
// This adapter recognizes only the known explicit none/one/couple contract.
export function producingPeopleFact(output, schema, configurationId) {
  const props = schema?.properties;
  const values = props?.people_count?.enum;
  const supported =
    configurationId &&
    props?.has_people?.type === 'boolean' &&
    props?.people_count?.type === 'string' &&
    Array.isArray(values) &&
    values.length === 5 &&
    new Set(values).size === 5 &&
    ['none', 'one', 'couple', 'group', 'unknown'].every((v) => values.includes(v));
  const n = supported ? { none: 0, one: 1, couple: 2 }[output?.people_count] : undefined;
  const consistent = Number.isInteger(n) && typeof output?.has_people === 'boolean' && output.has_people === n > 0;
  return {
    peopleCount: consistent ? n : null,
    source: supported ? 'producing-enrich-schema' : 'unknown',
    configurationId: configurationId ?? null,
    contradiction: Number.isInteger(n) && !consistent,
  };
}

export function photoEvidence({ asset, observation = {}, output, schema, configurationId }) {
  const fact = producingPeopleFact(output, schema, configurationId);
  const recognition = observation.recognition ?? {
    ids: null,
    count: null,
    signature: null,
    completeness: 'unknown',
    omitted: false,
  };
  const availability =
    asset.missing_since || observation.isTrashed || observation.isOffline ? 'unavailable' : 'observed';
  const image = {
    checksum: asset.checksum ?? null,
    modified: asset.file_modified_at ?? null,
    width: asset.width ?? null,
    height: asset.height ?? null,
    thumbhash: asset.thumbhash ?? null,
    orientation: observation.orientation ?? null,
    isEdited: observation.isEdited ?? null,
  };
  // Original checksum is not enough for a check bypass: require observed visual
  // identity and no known edits. Equality supports grouping, not perfect freshness.
  const renditionKey =
    image.checksum &&
    image.thumbhash &&
    Number.isFinite(image.width) &&
    image.width > 0 &&
    Number.isFinite(image.height) &&
    image.height > 0 &&
    image.isEdited === false
      ? fingerprint({ ...image, modified: null })
      : null;
  const evidence = {
    version: EVIDENCE_VERSION,
    fact,
    recognition,
    image,
    availability,
    limitations: ['recognition completeness unknown', 'unobserved remote edits and access changes are not detected'],
  };
  if (Buffer.byteLength(JSON.stringify(evidence)) > MAX_EVIDENCE_BYTES) {
    evidence.recognition = { ...recognition, ids: null, count: null, omitted: true };
  }
  return {
    evidence,
    imageKey: fingerprint(image),
    renditionKey,
    // Producing configuration ID is provenance, not itself a material change.
    factsKey: fingerprint({
      peopleCount: fact.peopleCount,
      recognition: { count: evidence.recognition.count, signature: evidence.recognition.signature },
      availability,
    }),
    peopleCount: fact.peopleCount,
    recognizedCount: evidence.recognition.count,
    availability,
  };
}
