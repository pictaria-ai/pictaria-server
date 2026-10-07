import { savedOutcome } from './photos.js';
import { applicableAdvice } from './suggestions.js';

// Suggestions seed a new, untouched pending draft only. A status poll never
// calls this function; Save remains an explicit human decision for every photo.
export function initialPhotoChoices(comparison, { decided = false } = {}) {
  const advice = comparison.photoRecommendations;
  const eligible = !decided && applicableAdvice(comparison);
  const keepers = new Set(eligible ? advice.keeperIds : []);
  return Object.fromEntries(comparison.photos.map(photo =>
    [photo.id, savedOutcome(photo) || (keepers.has(photo.id) ? 'approve' : 'reviewed')]));
}

export function photoAssessment(advice, id) {
  for (const batch of advice?.batches ?? []) {
    if (batch.status !== 'valid') continue;
    const assessment = batch.assessments?.find(photo => photo.id === id);
    if (assessment) return { ...assessment, suggested: advice.keeperIds.includes(id) };
  }
  return null;
}

export function photoAdviceSummary(advice) {
  if (!advice) return '';
  let text = advice.unavailableReason ? 'Photo Referee suggestions are from an earlier check. Stack checking is not ready; review manually.'
    : advice.state !== 'complete' ? 'Photo Referee: partial suggestions. Review manually.'
    : !advice.canApplyAll ? 'Photo Referee: separate comparisons found different subjects. Review manually.'
      : advice.noneRecommended ? 'Photo Referee: none suggested. You can still mark any photo Yes or Fav.'
        : `Photo Referee: ${advice.keeperIds.length} suggested. Review the choices, then save.`;
  if (advice.coverage === 'within-batches') text += ' Compared in separate batches.';
  if (advice.checkCoverage === 'unchecked-size') text += ' Stack not checked: too large.';
  else if (advice.checkCoverage === 'incomplete') text += ' Stack checking finished incomplete.';
  return text;
}
