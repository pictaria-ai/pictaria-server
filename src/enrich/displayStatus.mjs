// Derives the review-UI bucket for an asset from its tags and model output.
//
// Ported as-is from the Python implementation for the parity gate. Phase 1e
// moves these hardcoded tag sets and the bucket policy into the editable
// taxonomy file so users can tune review behavior without code changes.

export const PRIVACY_REVIEW_TAGS = new Set([
  'ai/exclude/private',
  'ai/exclude/document',
  'ai/exclude/receipt',
  'ai/exclude/text-heavy',
  'ai/exclude/financial',
  'ai/exclude/whiteboard',
  'ai/exclude/screenshot',
]);

export const HARD_QUALITY_TAGS = new Set([
  'ai/quality/low',
  'ai/quality/blurry',
  'ai/quality/low-resolution',
]);

export function deriveDisplayStatus(tags, taxonomy, { output = {} } = {}) {
  const quality = isPlainObject(output.quality) ? output.quality : {};
  const frameScore = score(quality.frame_worthy_score);
  const privacyUncertainty = privacyUncertaintyReason(output, taxonomy);

  if (tags.has('frame/never-show') && tags.has('frame/reviewed')) {
    return status('reviewed_excluded', 'reviewed manual never-show tag is present', false);
  }

  if (tags.has('frame/never-show')) {
    return status('excluded', 'manual never-show tag is present', false);
  }

  if (tags.has('frame/eligible') || tags.has('frame/favorite')) {
    return status('manual_eligible', 'manual positive frame tag is present', true);
  }

  const hardExclusions = [...tags]
    .filter(
      (tag) => tag.startsWith('ai/exclude/') || taxonomy.hardExclusionTags.has(tag) || HARD_QUALITY_TAGS.has(tag),
    )
    .sort();
  if (hardExclusions.length > 0) {
    if (tags.has('frame/reviewed')) {
      return status('reviewed_excluded', `reviewed hard exclusions: ${hardExclusions.join(', ')}`, false);
    }
    return status('excluded', `hard exclusion tags: ${hardExclusions.join(', ')}`, false);
  }

  if (tags.has('frame/reviewed')) {
    return status('reviewed', 'reviewed and left out of display', false);
  }

  if (tags.has('ai/quality/frame-worthy')) {
    return status('auto_candidate', 'frame-worthy with no hard exclusions', true);
  }

  if (tags.has('frame/review')) {
    if (privacyUncertainty) {
      return status('review_privacy', privacyUncertainty, false);
    }
    const reviewLow = taxonomy.thresholds.review_low ?? 0.65;
    if (frameScore !== null && frameScore >= reviewLow) {
      return status('review_quality', `borderline frame score ${frameScore.toFixed(2)}`, false);
    }
    return status('review_general', 'model requested review without a hard exclusion', false);
  }

  if (tags.has('ai/quality/good')) {
    return status('good_not_candidate', 'good quality but below automatic frame-worthy threshold', false);
  }

  return status('neutral', 'no display-positive quality tag', false);
}

function privacyUncertaintyReason(output, taxonomy) {
  const excludeThreshold = taxonomy.thresholds.exclude ?? 0.7;
  const privacyLow = taxonomy.thresholds.privacy_review_low ?? 0.45;
  const reasons = [];
  for (const entry of output.exclusion_reasons ?? []) {
    if (!isPlainObject(entry)) {
      continue;
    }
    const confidence = score(entry.confidence);
    if (PRIVACY_REVIEW_TAGS.has(entry.tag) && confidence !== null && privacyLow <= confidence && confidence < excludeThreshold) {
      reasons.push(`${entry.tag} uncertainty ${confidence.toFixed(2)}`);
    }
  }
  return reasons.length > 0 ? reasons.join('; ') : null;
}

function status(statusName, reason, autoDisplay) {
  return { status: statusName, reason, autoDisplay };
}

function score(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
