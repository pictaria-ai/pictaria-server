export class OutputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutputValidationError';
  }
}

export const PEOPLE_COUNTS = new Set(['none', 'one', 'couple', 'group', 'unknown']);

const MAX_NORMALIZED_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTION_BYTES = 4 * 1024;
const MAX_SHORT_CAPTION_BYTES = 512;
const MAX_TEXT_BYTES = 512;
const MAX_REASON_BYTES = 1024;
const MAX_LIST_ITEMS = 50;
const CAPTION_TEMPLATE_LEAK = /^\s*(?:full|short)[ _-]+caption(?:[ _-]+here)?(?:\s*:|\s*[.!]?\s*$)/i;

const REQUIRED_TOP_LEVEL_FIELDS = [
  'caption',
  'short_caption',
  'is_photo',
  'is_screenshot',
  'is_document',
  'is_text_heavy',
  'has_private_info',
  'has_license_plate',
  'has_people',
  'people_count',
  'child_present',
  'quality',
  'scene',
  'subjects',
  'activities',
  'composition',
  'candidate_tags',
  'exclusion_reasons',
  'needs_review',
];

const REQUIRED_QUALITY_FIELDS = [
  'aesthetic_score',
  'sharpness_score',
  'brightness_score',
  'frame_worthy_score',
  'is_blurry',
  'is_dark',
  'is_low_resolution',
];

export function validateAiOutput(output, taxonomy) {
  if (!isPlainObject(output)) {
    throw new OutputValidationError('AI output must be a JSON object');
  }

  const missing = REQUIRED_TOP_LEVEL_FIELDS.filter((field) => !Object.hasOwn(output, field));
  if (missing.length > 0) {
    throw new OutputValidationError(`AI output missing fields: ${JSON.stringify(missing.sort())}`);
  }
  const normalized = projectAiOutput(output);

  validateString(normalized.caption, 'caption', MAX_CAPTION_BYTES);
  validateString(normalized.short_caption, 'short_caption', MAX_SHORT_CAPTION_BYTES);
  validateCaptionText(normalized.caption, 'caption');
  validateCaptionText(normalized.short_caption, 'short_caption');
  validateString(normalized.people_count, 'people_count', MAX_TEXT_BYTES);

  for (const field of [
    'is_photo',
    'is_screenshot',
    'is_document',
    'is_text_heavy',
    'has_private_info',
    'has_license_plate',
    'has_people',
    'child_present',
    'needs_review',
  ]) {
    if (typeof normalized[field] !== 'boolean') {
      throw new OutputValidationError(`${field} must be a boolean`);
    }
  }

  if (!PEOPLE_COUNTS.has(normalized.people_count)) {
    throw new OutputValidationError(`people_count must be one of ${JSON.stringify([...PEOPLE_COUNTS].sort())}`);
  }

  validateQuality(normalized.quality);
  validateScene(normalized.scene);
  validateStringList(normalized.subjects, 'subjects');
  validateStringList(normalized.activities, 'activities');
  validateStringList(normalized.composition, 'composition');
  validateTagEntries(normalized.candidate_tags, 'candidate_tags', taxonomy, { allowFrameReview: true });
  validateTagEntries(normalized.exclusion_reasons, 'exclusion_reasons', taxonomy, { requireExclude: true });
  validateContradictions(normalized);

  let encoded;
  try {
    encoded = JSON.stringify(normalized);
  } catch {
    throw new OutputValidationError('AI output must be serializable JSON');
  }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_NORMALIZED_OUTPUT_BYTES) {
    throw new OutputValidationError(`AI output exceeds the ${MAX_NORMALIZED_OUTPUT_BYTES}-byte limit`);
  }

  return normalized;
}

function projectAiOutput(output) {
  const normalized = projectKnownFields(output, REQUIRED_TOP_LEVEL_FIELDS);
  normalized.quality = projectKnownFields(output.quality, REQUIRED_QUALITY_FIELDS);
  normalized.scene = projectKnownFields(output.scene, ['primary', 'secondary']);
  normalized.candidate_tags = projectTagEntries(output.candidate_tags);
  normalized.exclusion_reasons = projectTagEntries(output.exclusion_reasons);
  return normalized;
}

function projectKnownFields(value, fields) {
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    fields.filter((field) => Object.hasOwn(value, field)).map((field) => [field, value[field]]),
  );
}

function projectTagEntries(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry) => projectKnownFields(entry, ['tag', 'confidence', 'reason']));
}

export function enrichmentJsonSchema(taxonomy) {
  const approvedTags = [...taxonomy.approvedTags]
    .filter((tag) => tag.startsWith('ai/') || tag === 'frame/review')
    .sort();
  const excludeTags = approvedTags.filter((tag) => tag.startsWith('ai/exclude/'));

  return {
    type: 'object',
    additionalProperties: false,
    required: [...REQUIRED_TOP_LEVEL_FIELDS].sort(),
    properties: {
      // The descriptions are the caption style contract (prompt v2 repeats
      // them): OpenAI surfaces schema descriptions to the model natively;
      // Venice and cloud Ollama see them via the schema text embedded in
      // their prompts.
      caption: {
        type: 'string',
        maxLength: MAX_CAPTION_BYTES,
        description:
          'Two to three sentences, concrete and specific: who is in the photo, where it is, ' +
          'what is happening, and any readable text or signage. Feeds caption search and photo ' +
          'descriptions, so include details someone might later search for. Return caption text ' +
          'only, without a Full caption or Short caption label.',
      },
      short_caption: {
        type: 'string',
        maxLength: MAX_SHORT_CAPTION_BYTES,
        description: 'A few words used as the photo card label. Return only the label text, without a caption-field prefix.',
      },
      is_photo: { type: 'boolean' },
      is_screenshot: { type: 'boolean' },
      is_document: { type: 'boolean' },
      is_text_heavy: { type: 'boolean' },
      has_private_info: { type: 'boolean' },
      has_license_plate: { type: 'boolean' },
      has_people: { type: 'boolean' },
      people_count: { type: 'string', enum: [...PEOPLE_COUNTS].sort() },
      child_present: { type: 'boolean' },
      quality: {
        type: 'object',
        additionalProperties: false,
        required: [...REQUIRED_QUALITY_FIELDS].sort(),
        properties: {
          aesthetic_score: { type: 'number', minimum: 0, maximum: 1 },
          sharpness_score: { type: 'number', minimum: 0, maximum: 1 },
          brightness_score: { type: 'number', minimum: 0, maximum: 1 },
          frame_worthy_score: { type: 'number', minimum: 0, maximum: 1 },
          is_blurry: { type: 'boolean' },
          is_dark: { type: 'boolean' },
          is_low_resolution: { type: 'boolean' },
        },
      },
      scene: {
        type: 'object',
        additionalProperties: false,
        required: ['primary', 'secondary'],
        properties: {
          primary: { type: 'string', maxLength: MAX_TEXT_BYTES },
          secondary: {
            type: 'array',
            maxItems: MAX_LIST_ITEMS,
            items: { type: 'string', maxLength: MAX_TEXT_BYTES },
          },
        },
      },
      subjects: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string', maxLength: MAX_TEXT_BYTES } },
      activities: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string', maxLength: MAX_TEXT_BYTES } },
      composition: { type: 'array', maxItems: MAX_LIST_ITEMS, items: { type: 'string', maxLength: MAX_TEXT_BYTES } },
      candidate_tags: tagEntrySchema(approvedTags),
      exclusion_reasons: tagEntrySchema(excludeTags),
      needs_review: { type: 'boolean' },
    },
  };
}

// Human-readable version of the response contract, for the Enrich page's
// transparency panel. Several product features are fed by fields the prompt
// text never mentions — the schema itself demands them — and this list is
// where that becomes visible. Keep it in sync with enrichmentJsonSchema.
export function describeResponseFields() {
  return [
    { field: 'caption', type: 'text', usedFor: 'caption search (Insights, Best-of albums) and the optional Immich description writeback' },
    { field: 'short_caption', type: 'text', usedFor: 'the one-line caption on Curate cards' },
    { field: 'is_photo · is_screenshot · is_document · is_text_heavy', type: 'true/false', usedFor: 'screening screenshots, documents, and text-heavy images out of Candidates' },
    { field: 'has_private_info · has_license_plate', type: 'true/false', usedFor: 'the privacy review bucket' },
    { field: 'has_people · people_count · child_present', type: 'true/false · none/one/couple/group/unknown', usedFor: 'people tags and people-aware curation' },
    { field: 'quality', type: 'aesthetic / sharpness / brightness / frame-worthy scores (0–1) + is_blurry · is_dark · is_low_resolution', usedFor: 'frame-worthiness, star picks, bucket sorting, Best-of ranking' },
    { field: 'scene · subjects · activities · composition', type: 'free text', usedFor: 'context recorded with each run' },
    { field: 'candidate_tags', type: 'tag + confidence + reason — approved tags only', usedFor: 'becomes the photo’s ai/* tags after threshold checks' },
    { field: 'exclusion_reasons', type: 'tag + confidence + reason — exclude tags only', usedFor: 'exclusions that keep a photo off the frame' },
    { field: 'needs_review', type: 'true/false', usedFor: 'flags the photo for human review' },
  ];
}

function tagEntrySchema(tags) {
  return {
    type: 'array',
    maxItems: MAX_LIST_ITEMS,
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['tag', 'confidence', 'reason'],
      properties: {
        tag: { type: 'string', enum: tags },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        reason: { type: 'string', maxLength: MAX_REASON_BYTES },
      },
    },
  };
}

function validateQuality(quality) {
  if (!isPlainObject(quality)) {
    throw new OutputValidationError('quality must be an object');
  }
  const missing = REQUIRED_QUALITY_FIELDS.filter((field) => !(field in quality));
  if (missing.length > 0) {
    throw new OutputValidationError(`quality missing fields: ${JSON.stringify(missing.sort())}`);
  }
  for (const field of ['aesthetic_score', 'sharpness_score', 'brightness_score', 'frame_worthy_score']) {
    validateConfidence(quality[field], `quality.${field}`);
  }
  for (const field of ['is_blurry', 'is_dark', 'is_low_resolution']) {
    if (typeof quality[field] !== 'boolean') {
      throw new OutputValidationError(`quality.${field} must be a boolean`);
    }
  }
}

function validateScene(scene) {
  if (!isPlainObject(scene)) {
    throw new OutputValidationError('scene must be an object');
  }
  validateString(scene.primary, 'scene.primary', MAX_TEXT_BYTES);
  validateStringList(scene.secondary, 'scene.secondary');
}

function validateStringList(value, field) {
  if (!Array.isArray(value)) {
    throw new OutputValidationError(`${field} must be a list of strings`);
  }
  if (value.length > MAX_LIST_ITEMS) {
    throw new OutputValidationError(`${field} contains too many items`);
  }
  value.forEach((item, index) => validateString(item, `${field}[${index}]`, MAX_TEXT_BYTES));
}

function validateTagEntries(entries, field, taxonomy, { requireExclude = false, allowFrameReview = false } = {}) {
  if (!Array.isArray(entries)) {
    throw new OutputValidationError(`${field} must be a list`);
  }
  if (entries.length > 50) {
    throw new OutputValidationError(`${field} contains too many tags`);
  }
  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      throw new OutputValidationError(`${field} entries must be objects`);
    }
    for (const required of ['tag', 'confidence', 'reason']) {
      if (!(required in entry)) {
        throw new OutputValidationError(`${field} entry missing ${required}`);
      }
    }
    const tag = entry.tag;
    if (!taxonomy.approvedTags.has(tag)) {
      throw new OutputValidationError(`${field} contains unapproved tag: ${tag}`);
    }
    if (typeof tag === 'string' && tag.startsWith('frame/') && !(allowFrameReview && tag === 'frame/review')) {
      throw new OutputValidationError(`${field} cannot contain manual frame tag: ${tag}`);
    }
    if (requireExclude && !tag.startsWith('ai/exclude/')) {
      throw new OutputValidationError(`${field} must contain only ai/exclude/* tags`);
    }
    validateConfidence(entry.confidence, `${field}.${tag}.confidence`);
    validateString(entry.reason, `${field}.${tag}.reason`, MAX_REASON_BYTES);
  }
}

function validateString(value, field, maxBytes) {
  if (typeof value !== 'string') {
    throw new OutputValidationError(`${field} must be a string`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new OutputValidationError(`${field} exceeds the ${maxBytes}-byte limit`);
  }
}

function validateCaptionText(value, field) {
  if (CAPTION_TEMPLATE_LEAK.test(value)) {
    throw new OutputValidationError(`${field} repeats a caption prompt label or placeholder`);
  }
}

function validateConfidence(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new OutputValidationError(`${field} must be a number from 0 to 1`);
  }
}

function validateContradictions(output) {
  const candidateTags = new Set(output.candidate_tags.map((entry) => entry.tag));
  const exclusionTags = new Set(output.exclusion_reasons.map((entry) => entry.tag));

  if (output.is_screenshot && candidateTags.has('ai/quality/frame-worthy') && !exclusionTags.has('ai/exclude/screenshot')) {
    throw new OutputValidationError('screenshot cannot be frame-worthy without ai/exclude/screenshot');
  }
  if (output.is_document && candidateTags.has('ai/quality/frame-worthy') && !exclusionTags.has('ai/exclude/document')) {
    throw new OutputValidationError('document cannot be frame-worthy without ai/exclude/document');
  }
  if (output.has_private_info && candidateTags.has('ai/quality/frame-worthy') && !exclusionTags.has('ai/exclude/private')) {
    throw new OutputValidationError('private-info image cannot be frame-worthy without ai/exclude/private');
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
