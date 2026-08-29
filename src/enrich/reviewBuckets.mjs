// Review classification for the curation UI, driven by the taxonomy's review
// policy. Two independent axes:
//   bucket — what the AI thinks: candidates | should_review | unlikely (configurable)
//   state  — what the human decided: undecided | approved | rejected | reviewed
// Human decisions always win for display eligibility; buckets only organize
// the review queue.

const DEFAULT_BUCKETS = [
  {
    id: 'unlikely',
    label: 'Unlikely',
    priority: 1,
    match: { any_tag_prefixes: ['ai/exclude/'], any_hard_exclusions: true },
    sort: 'frame_worthy_score desc',
  },
  {
    id: 'candidates',
    label: 'Candidates',
    priority: 2,
    match: { any_tags: ['ai/quality/frame-worthy'] },
    sort: 'frame_worthy_score desc',
  },
  {
    id: 'should_review',
    label: 'Should Review',
    priority: 3,
    fallback: true,
    sort: 'frame_worthy_score desc',
  },
];

const DEFAULT_PRIVACY_REVIEW_TAGS = [
  'ai/exclude/private',
  'ai/exclude/document',
  'ai/exclude/receipt',
  'ai/exclude/text-heavy',
  'ai/exclude/financial',
  'ai/exclude/whiteboard',
  'ai/exclude/screenshot',
];

export function reviewConfig(taxonomy) {
  const raw = taxonomy.raw?.review ?? {};
  const buckets = Array.isArray(raw.buckets) && raw.buckets.length > 0 ? raw.buckets : DEFAULT_BUCKETS;
  return {
    buckets: buckets
      .map((bucket) => ({
        id: String(bucket.id),
        label: String(bucket.label ?? bucket.id),
        description: String(bucket.description ?? ''),
        priority: Number(bucket.priority ?? 100),
        fallback: Boolean(bucket.fallback),
        match: bucket.match ?? {},
        sort: String(bucket.sort ?? 'frame_worthy_score desc'),
      }))
      .sort((left, right) => left.priority - right.priority),
    privacyReviewTags: new Set(
      Array.isArray(raw.privacy_review_tags) ? raw.privacy_review_tags : DEFAULT_PRIVACY_REVIEW_TAGS,
    ),
  };
}

export function deriveReview(tags, taxonomy, { output = {} } = {}) {
  const config = reviewConfig(taxonomy);
  const state = deriveState(tags);
  const bucket = deriveBucket(tags, taxonomy, config);
  const reasons = deriveReasons(tags, taxonomy, config, output, bucket);
  const quality = isPlainObject(output.quality) ? output.quality : {};
  return {
    bucket: bucket.id,
    bucketLabel: bucket.label,
    state,
    autoDisplay: state === 'approved' || (state === 'undecided' && bucket.id === 'candidates'),
    reasons,
    frameScore: score(quality.frame_worthy_score),
    aestheticScore: score(quality.aesthetic_score),
  };
}

export function deriveState(tags) {
  if (tags.has('frame/never-show')) {
    return 'rejected';
  }
  if (tags.has('frame/eligible') || tags.has('frame/favorite')) {
    return 'approved';
  }
  if (tags.has('frame/reviewed')) {
    return 'reviewed';
  }
  return 'undecided';
}

function deriveBucket(tags, taxonomy, config) {
  for (const bucket of config.buckets) {
    if (bucket.fallback) {
      continue;
    }
    if (bucketMatches(bucket.match, tags, taxonomy)) {
      return bucket;
    }
  }
  const fallback = config.buckets.find((bucket) => bucket.fallback);
  if (!fallback) {
    throw new Error('review config must define a fallback bucket');
  }
  return fallback;
}

function bucketMatches(match, tags, taxonomy) {
  for (const tag of match.any_tags ?? []) {
    if (tags.has(tag)) {
      return true;
    }
  }
  for (const prefix of match.any_tag_prefixes ?? []) {
    for (const tag of tags) {
      if (tag.startsWith(prefix)) {
        return true;
      }
    }
  }
  if (match.any_hard_exclusions) {
    for (const tag of taxonomy.hardExclusionTags) {
      // Manual frame/* tags are the human axis, never bucket criteria.
      if (!tag.startsWith('frame/') && tags.has(tag)) {
        return true;
      }
    }
  }
  return false;
}

function deriveReasons(tags, taxonomy, config, output, bucket) {
  const reasons = [];
  const quality = isPlainObject(output.quality) ? output.quality : {};
  const frameScore = score(quality.frame_worthy_score);
  const thresholds = taxonomy.thresholds ?? {};
  const reviewLow = thresholds.review_low ?? 0.65;
  const frameWorthy = thresholds.frame_worthy ?? 0.78;
  const excludeThreshold = thresholds.exclude ?? 0.7;
  const privacyLow = thresholds.privacy_review_low ?? 0.45;

  const exclusionTags = [...tags].filter((tag) => tag.startsWith('ai/exclude/')).sort();
  if (exclusionTags.length > 0) {
    reasons.push(`excluded: ${exclusionTags.map((tag) => tag.replace('ai/exclude/', '')).join(', ')}`);
  }
  const hardQualityTags = [...taxonomy.hardExclusionTags]
    .filter((tag) => tag.startsWith('ai/quality/') && tags.has(tag))
    .sort();
  if (hardQualityTags.length > 0) {
    reasons.push(`quality: ${hardQualityTags.map((tag) => tag.replace('ai/quality/', '')).join(', ')}`);
  }

  for (const entry of output.exclusion_reasons ?? []) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const confidence = score(entry.confidence);
    if (
      config.privacyReviewTags.has(entry.tag) &&
      confidence !== null &&
      privacyLow <= confidence &&
      confidence < excludeThreshold
    ) {
      reasons.push(`privacy? ${entry.tag.replace('ai/exclude/', '')} ${confidence.toFixed(2)}`);
    }
  }

  if (bucket.id !== 'candidates' && frameScore !== null && reviewLow <= frameScore && frameScore < frameWorthy) {
    reasons.push(`borderline ${frameScore.toFixed(2)}`);
  }
  if (output.needs_review) {
    reasons.push('model requested review');
  }
  if (reasons.length === 0 && bucket.fallback) {
    reasons.push('no strong signal');
  }
  return reasons;
}

export function bucketSortComparator(bucket) {
  const [field, direction] = String(bucket.sort ?? 'frame_worthy_score desc').split(/\s+/);
  const sign = direction === 'asc' ? 1 : -1;
  return (left, right) => {
    const a = typeof left[field] === 'number' ? left[field] : left.frameScore ?? -1;
    const b = typeof right[field] === 'number' ? right[field] : right.frameScore ?? -1;
    if (a === b) {
      return 0;
    }
    return a < b ? -sign : sign;
  };
}

function score(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
