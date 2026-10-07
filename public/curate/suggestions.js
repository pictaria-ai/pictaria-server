// Saved advice is advisory. These helpers never write choices or infer missing
// recommendations; every shortcut still loads a complete guarded comparison.
export function applicableAdvice(comparison) {
  const advice = comparison?.photoRecommendations;
  return Boolean(!comparison?.updated && advice?.state === 'complete' && advice.canApplyAll === true && !advice.unavailableReason);
}

export function gridSuggestion(group) {
  const advice = group?.photoReferee;
  if (group?.memberCount < 2 || group?.updated || [group?.similarity, group?.stackReferee, advice].some(s => s?.state === 'updated') ||
      advice?.state !== 'complete' || !advice.canApplyAll || advice.unavailableReason || !advice.suggestion?.key || !advice.suggestion?.keeperIds?.length) return null;
  return advice.suggestion;
}

export function suggestionMatches(shown, comparison) {
  const current = comparison?.photoReferee?.suggestion;
  return Boolean(shown?.key && applicableAdvice(comparison) && current?.key === shown.key &&
    shown.keeperIds.length === current.keeperIds.length && shown.keeperIds.every(id => current.keeperIds.includes(id)) &&
    shown.keeperIds.length === comparison.photoRecommendations.keeperIds.length &&
    shown.keeperIds.every(id => comparison.ids.includes(id) && comparison.photoRecommendations.keeperIds.includes(id)) &&
    comparison.photos.every(p => p.state === 'undecided'));
}

export function nextActionLabel(outcomes) {
  const values = Object.values(outcomes), kept = values.filter(v => ['approve', 'favorite'].includes(v)).length;
  if (kept) return `Keep ${kept} · Next`;
  return values.length && values.every(v => v === 'reviewed') ? 'Skip all · Next' : 'Save · Next';
}
