import { readFileSync } from 'node:fs';

// The taxonomy is user-editable configuration: the controlled tag vocabulary,
// thresholds, and exclusion policy that drive enrichment and review.

export function loadTaxonomy(path) {
  return buildTaxonomy(parseTaxonomyFile(path));
}

// The Settings override path: same validation as the shipped file, from text.
export function parseTaxonomySource(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`taxonomy must be valid JSON: ${error.message}`);
  }
  if (!isPlainObject(raw)) {
    throw new Error('taxonomy root must be an object');
  }
  return buildTaxonomy(raw);
}

// The taxonomy in force: the Settings override when present, else the shipped
// file. Settings load before this is first called at boot.
export function loadActiveTaxonomy(config) {
  return config.taxonomyOverrideJson
    ? parseTaxonomySource(config.taxonomyOverrideJson)
    : loadTaxonomy(config.taxonomyPath);
}

// Every service holds a reference to the one live taxonomy object; a settings
// change swaps its contents in place so they all see the new one immediately.
export function replaceTaxonomy(target, next) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, next);
  return target;
}

function buildTaxonomy(raw) {
  const categories = raw.categories;

  if (!isPlainObject(categories)) {
    throw new Error('taxonomy must contain a categories object');
  }

  const tagsByCategory = {};
  const allTags = new Set();

  for (const [category, entries] of Object.entries(categories)) {
    if (!Array.isArray(entries)) {
      throw new Error(`taxonomy category ${JSON.stringify(category)} must be a list`);
    }

    const tags = [];
    for (const entry of entries) {
      const tag = extractTag(entry, `categories.${category}`);
      validateTagShape(tag);
      tags.push(tag);
      allTags.add(tag);
    }
    tagsByCategory[category] = tags;
  }

  const manualTags = new Set((raw.manual_tags ?? []).map((entry) => extractTag(entry, 'manual_tags')));
  const systemReviewTags = new Set(
    (raw.system_review_tags ?? []).map((entry) => extractTag(entry, 'system_review_tags')),
  );
  for (const tag of [...manualTags, ...systemReviewTags]) {
    validateTagShape(tag);
    allTags.add(tag);
  }

  const hardExclusionTags = new Set(raw.hard_exclusion_tags ?? []);
  const unknownHardTags = [...hardExclusionTags].filter((tag) => !allTags.has(tag));
  if (unknownHardTags.length > 0) {
    throw new Error(`hard exclusion tags are not approved: ${JSON.stringify(unknownHardTags.sort())}`);
  }

  const rawThresholds = raw.thresholds ?? {};
  if (!isPlainObject(rawThresholds)) {
    throw new Error('taxonomy thresholds must be an object');
  }
  const thresholds = {};
  for (const [name, value] of Object.entries(rawThresholds)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`threshold ${JSON.stringify(name)} must be a number from 0 to 1`);
    }
    thresholds[name] = value;
  }

  return {
    version: String(raw.version ?? ''),
    raw,
    tagsByCategory,
    manualTags,
    systemReviewTags,
    approvedTags: allTags,
    hardExclusionTags,
    thresholds,
  };
}

export function categoryFor(taxonomy, tag) {
  for (const [category, tags] of Object.entries(taxonomy.tagsByCategory)) {
    if (tags.includes(tag)) {
      return category;
    }
  }
  if (taxonomy.manualTags.has(tag)) {
    return 'manual';
  }
  if (taxonomy.systemReviewTags.has(tag)) {
    return 'review';
  }
  return null;
}

export function approvedAiTags(taxonomy) {
  return [...taxonomy.approvedTags].filter((tag) => tag.startsWith('ai/')).sort();
}

export function approvedModelTags(taxonomy) {
  return [...taxonomy.approvedTags]
    .filter((tag) => tag.startsWith('ai/') || tag === 'frame/review')
    .sort();
}

function parseTaxonomyFile(path) {
  const text = readFileSync(path, 'utf8');
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${path} must be valid JSON (the taxonomy is strict JSON in Pictaria): ${error.message}`,
    );
  }
  if (!isPlainObject(data)) {
    throw new Error('taxonomy root must be an object');
  }
  return data;
}

function extractTag(entry, context) {
  if (typeof entry === 'string') {
    return entry;
  }
  if (isPlainObject(entry) && typeof entry.tag === 'string') {
    return entry.tag;
  }
  throw new Error(`${context} entry must be a tag string or object with tag`);
}

function validateTagShape(tag) {
  if (!tag || tag.trim() !== tag) {
    throw new Error(`invalid tag spacing: ${JSON.stringify(tag)}`);
  }
  if (!tag.includes('/')) {
    throw new Error(`tag must include a namespace: ${JSON.stringify(tag)}`);
  }
  if (tag.includes(' ')) {
    throw new Error(`tag must not contain spaces: ${JSON.stringify(tag)}`);
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
