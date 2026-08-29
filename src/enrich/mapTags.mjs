// Maps validated model output onto tag decisions using taxonomy thresholds.
// A TagDecision is { tag, confidence, source, reason } with source 'ai' | 'system'.

const DEFAULT_THRESHOLDS = {
  exclude: 0.7,
  semantic: 0.75,
  frameWorthy: 0.78,
  reviewLow: 0.65,
  privacyReviewLow: 0.45,
};

export function thresholdsFromTaxonomy(taxonomy) {
  const values = taxonomy.thresholds ?? {};
  return {
    exclude: values.exclude ?? DEFAULT_THRESHOLDS.exclude,
    semantic: values.semantic ?? DEFAULT_THRESHOLDS.semantic,
    frameWorthy: values.frame_worthy ?? DEFAULT_THRESHOLDS.frameWorthy,
    reviewLow: values.review_low ?? DEFAULT_THRESHOLDS.reviewLow,
    privacyReviewLow: values.privacy_review_low ?? DEFAULT_THRESHOLDS.privacyReviewLow,
  };
}

export function mapOutputToTags(output, taxonomy, thresholds = thresholdsFromTaxonomy(taxonomy)) {
  const decisions = new Map();

  const add = (tag, confidence, source, reason) => {
    if (!taxonomy.approvedTags.has(tag)) {
      return;
    }
    const decision = { tag, confidence: Number(confidence), source, reason };
    const existing = decisions.get(tag);
    if (!existing || decision.confidence > existing.confidence) {
      decisions.set(tag, decision);
    }
  };

  const exclusionConfidences = [];
  for (const entry of output.exclusion_reasons ?? []) {
    const confidence = Number(entry.confidence);
    exclusionConfidences.push(confidence);
    if (confidence >= thresholds.exclude) {
      add(entry.tag, confidence, 'ai', entry.reason);
    }
  }

  addBooleanExclusions(output, add);

  const quality = output.quality ?? {};
  if (quality.is_blurry) {
    add('ai/quality/blurry', 1.0, 'ai', 'Model marked image as blurry.');
  }
  if (quality.is_dark) {
    add('ai/quality/dark', 1.0, 'ai', 'Model marked image as dark.');
  }
  if (quality.is_low_resolution) {
    add('ai/quality/low-resolution', 1.0, 'ai', 'Model marked image as low resolution.');
  }

  const frameScore = Number(quality.frame_worthy_score ?? 0);
  const aestheticScore = Number(quality.aesthetic_score ?? 0);
  if (frameScore < 0.4 || aestheticScore < 0.35) {
    add('ai/quality/low', Math.max(1 - frameScore, 1 - aestheticScore), 'ai', 'Low display suitability score.');
  }

  const hasAnyExclusion = [...decisions.keys()].some((tag) => tag.startsWith('ai/exclude/'));
  const nearExclusion = exclusionConfidences.some((confidence) => confidence >= 0.6);
  const disqualifyingQuality = Boolean(
    quality.is_blurry ||
      quality.is_low_resolution ||
      output.is_screenshot ||
      output.is_document ||
      output.is_text_heavy ||
      output.has_private_info,
  );

  if (frameScore >= thresholds.frameWorthy && !hasAnyExclusion && !nearExclusion && !disqualifyingQuality) {
    add('ai/quality/frame-worthy', frameScore, 'ai', 'High display suitability score with no hard exclusions.');
  } else if (frameScore >= 0.6 && !hasAnyExclusion) {
    add('ai/quality/good', frameScore, 'ai', 'Usable visual quality, below frame-worthy threshold.');
  }

  addCandidateTags(output, thresholds, add);
  addPeopleTags(output, add);
  normalizeQualityDecisions(decisions);

  const privacyConfidence = maxConfidenceFor(
    output.exclusion_reasons ?? [],
    new Set(['ai/exclude/private', 'ai/exclude/financial']),
  );
  if (
    output.needs_review ||
    (thresholds.reviewLow <= frameScore && frameScore < thresholds.frameWorthy) ||
    (thresholds.privacyReviewLow <= privacyConfidence && privacyConfidence < thresholds.exclude)
  ) {
    add('frame/review', Math.max(frameScore, privacyConfidence, 0.5), 'system', 'Borderline or uncertain classification.');
  }

  return [...decisions.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

function normalizeQualityDecisions(decisions) {
  if (decisions.has('ai/quality/frame-worthy')) {
    decisions.delete('ai/quality/good');
  }
  if ([...decisions.keys()].some((tag) => tag.startsWith('ai/exclude/')) || decisions.has('ai/quality/low')) {
    decisions.delete('ai/quality/good');
  }
}

function addBooleanExclusions(output, add) {
  if (output.is_screenshot) {
    add('ai/exclude/screenshot', 1.0, 'ai', 'Model marked image as screenshot or UI capture.');
  }
  if (output.is_document) {
    add('ai/exclude/document', 1.0, 'ai', 'Model marked image as document-like.');
  }
  if (output.is_text_heavy) {
    add('ai/exclude/text-heavy', 1.0, 'ai', 'Model marked image as text-heavy.');
  }
  if (output.has_private_info) {
    add('ai/exclude/private', 1.0, 'ai', 'Model marked image as containing private information.');
  }
}

function addCandidateTags(output, thresholds, add) {
  for (const entry of output.candidate_tags ?? []) {
    const tag = entry.tag;
    const confidence = Number(entry.confidence);
    if (tag === 'ai/quality/frame-worthy') {
      continue;
    }
    if (tag.startsWith('ai/quality/')) {
      if (confidence >= thresholds.semantic) {
        add(tag, confidence, 'ai', entry.reason);
      }
    } else if (
      tag.startsWith('ai/scene/') ||
      tag.startsWith('ai/subject/') ||
      tag.startsWith('ai/activity/') ||
      tag.startsWith('ai/composition/')
    ) {
      if (confidence >= thresholds.semantic) {
        add(tag, confidence, 'ai', entry.reason);
      }
    } else if (tag === 'frame/review') {
      add(tag, confidence, 'system', entry.reason);
    }
  }
}

function addPeopleTags(output, add) {
  const peopleCount = output.people_count;
  if (['none', 'one', 'couple', 'group'].includes(peopleCount)) {
    add(`ai/people/${peopleCount}`, 1.0, 'ai', `Model counted people as ${peopleCount}.`);
  }
  if (output.child_present) {
    add('ai/people/child-present', 1.0, 'ai', 'Model marked child as present.');
  }
}

function maxConfidenceFor(entries, tags) {
  let confidence = 0;
  for (const entry of entries) {
    if (tags.has(entry.tag)) {
      confidence = Math.max(confidence, Number(entry.confidence ?? 0));
    }
  }
  return confidence;
}
