import { reasonCodes } from './explanation-copy.js';
import { refereeReasonShort } from './referee-status.js';

// One status per stack, the same in every view (PIC-371). Exactly one grouping
// badge, highest first: Checking, AI checked, Unsure, Not fully checked, then
// Checked. A single photo shows Kept apart only when it was actively separated
// from photos taken at the same time; plain singles and decided photos show
// none. The Photo Referee's keeper star (PIC-116) can appear beside any badge.
// Server states in, words out: rendering lives in photos.js and explanation.js.
export const BADGE_WORDS = Object.freeze({
  checking: 'Checking', 'ai-checked': 'AI checked', unsure: 'Unsure',
  partial: 'Not fully checked', checked: 'Checked', apart: 'Kept apart',
});
const DETAILS = {
  checking: 'Checks are running, so this stack may change. You can still choose which photos to keep.',
  'ai-checked': 'The Stack Referee checked this grouping. Photo choices are still yours.',
  unsure: 'The evidence was inconclusive. The Stack Referee or you decide.',
  partial: 'A limit applied, so not every check ran. You can still choose which photos to keep.',
  checked: 'Pictaria’s checks settled this grouping.',
  apart: 'Kept apart from photos taken at the same time.',
};
const APART = new Set(['embedding-apart', 'people-apart', 'rank-contrast', 'saved-split', 'photo-split']);
// candidate-unconfirmed, or standard-1's time stacks without candidate stacking.
const UNSURE_ROUTES = new Set(['candidate-unconfirmed', 'uncertain']);
const LIMITED = new Set(['incomplete', 'paused', 'limited', 'unavailable']);

// "updated" describes a newer grouping for the next view, never the one shown.
function similarityPhase(s) {
  if (!s || s.state === 'updated') return null;
  if (s.paused || LIMITED.has(s.state)) return 'limited';
  if (s.state === 'checking' || s.checking) return 'running';
  if (s.state === 'waiting') return 'queued';
  return null;
}
// Configuration blockers belong to the page header, not to every card.
function refereePhase(r) {
  if (!r || r.scope === 'configuration' && r.state !== 'checked') return null;
  return { checking: 'running', waiting: 'queued', checked: 'done', paused: 'limited', incomplete: 'limited' }[r.state] ?? null;
}
const step = (name, state, text, detail) => ({ name, state, text, ...(detail ? { detail } : {}) });

function groupingStep(group, unsure) {
  const s = group.similarity;
  switch (similarityPhase(s)) {
    case 'running': return step('Grouping', 'running', Number.isFinite(s.done) && s.total > 0
      ? `checking similarity, ${s.done} of ${s.total}` : 'checking similarity');
    case 'queued': return step('Grouping', 'queued', 'queued for similarity checks');
    case 'limited': return step('Grouping', 'limited', {
      paused: 'similarity checks paused', incomplete: 'a similarity check could not finish',
      limited: s.total ? 'saved-check storage is full' : 'over the automatic checking limit',
      unavailable: 'similarity checks unavailable',
    }[s.state] ?? 'similarity checks paused', s.problem);
  }
  if (group.route === 'manual-budget') return step('Grouping', 'limited', 'too many photos to compare, grouped by time');
  return unsure ? step('Grouping', 'unsure', 'unsure') : step('Grouping', 'done', 'done');
}
function aiStep(group) {
  const r = group.stackReferee, n = group.memberCount;
  switch (r?.state) {
    case 'checked': return step('AI check', 'done', r.split ? 'split a larger stack' : r.split === false ? 'confirmed' : 'done');
    case 'checking': return step('AI check', 'running', 'running');
    case 'waiting': return step('AI check', 'queued', r.reason === 'shared-provider' ? 'queued for the shared AI provider' : 'queued');
    case 'updated': return step('AI check', 'skipped', 'waits for the updated grouping');
    case 'skipped': return r.reason === 'deterministic-pending' ? step('AI check', 'queued', 'waits for similarity checks')
      : ['disabled', 'invalid-scope'].includes(r.reason) ? step('AI check', 'off', 'off') : step('AI check', 'skipped', 'not needed');
    // A configuration problem is the page header's to report; here it reads as off.
    case 'paused': return step('AI check', r.scope === 'configuration' ? 'off' : 'limited', `paused, ${refereeReasonShort(r, n)}`);
    case 'incomplete': return step('AI check', r.scope === 'configuration' ? 'off' : 'limited', `not possible, ${refereeReasonShort(r, n)}`);
    default: return step('AI check', 'off', 'off');
  }
}
// The keeper slot: PIC-116 supplies group.photoReferee (state, plus `keepers`
// once complete) and comparison.photoRecommendations.keeperIds.
export function keeperCount(group) {
  if (group?.photoReferee?.state !== 'complete') return null;
  const n = group.photoReferee.keepers ?? group.photoRecommendations?.keeperIds?.length;
  return Number.isInteger(n) && n >= 0 && !(n === 0 && group.photoReferee.canApplyAll === false) ? n : null;
}
function keeperStep(group) {
  const r = group.photoReferee;
  switch (r?.state) {
    case 'complete': {
      const n = keeperCount(group);
      return step('Keepers', 'done', n === null ? (r.canApplyAll === false ? 'review manually' : 'done') : n ? `${n} suggested` : 'none suggested',
        r.unavailableReason ? 'Stack checking is not ready; review the suggestions manually.'
          : r.canApplyAll === false ? 'Separate comparisons found different subjects; review the suggestions manually.'
          : r.coverage === 'within-batches' ? 'Compared in separate batches, not against every photo in this stack.' : undefined);
    }
    case 'checking': return step('Keepers', 'running', 'running');
    case 'waiting': return step('Keepers', 'queued', r.reason === 'stack-pending' ? 'waits for the AI check'
      : r.reason === 'deterministic-pending' ? 'waits for similarity checks' : 'queued');
    case 'updated': return step('Keepers', 'skipped', 'waits for the updated grouping');
    case 'off': return step('Keepers', 'off', 'off');
    case 'paused': return step('Keepers', 'limited', `paused, ${refereeReasonShort(r)}`);
    case 'incomplete': return step('Keepers', 'limited', `not possible, ${refereeReasonShort(r)}`);
    default: return null; // Not offered for this group, or not available yet.
  }
}

export function stackStatus(group, { decided = false } = {}) {
  if (!group || decided) return null;
  const count = group.memberCount ?? group.ids?.length ?? 0, single = count === 1;
  const similarity = similarityPhase(group.similarity), referee = refereePhase(group.stackReferee);
  const unsure = UNSURE_ROUTES.has(group.route) || group.similarity?.state === 'checked' && group.similarity.uncertain === true;
  let badge;
  if ([similarity, referee].some(phase => phase === 'running' || phase === 'queued')) badge = 'checking';
  // Only an answer that divided the photos keeps a single apart: decisions can
  // shrink a confirmed stack to one photo.
  else if (single) badge = referee === 'done' && group.stackReferee.split === true ||
    reasonCodes(group.reasons).codes.some(code => APART.has(code)) ? 'apart' : null;
  else if (referee === 'done') badge = 'ai-checked';
  else if (unsure) badge = 'unsure';
  else if (group.route === 'manual-budget' || similarity === 'limited' || referee === 'limited') badge = 'partial';
  else badge = 'checked';
  const keepers = keeperCount(group);
  return {
    badge, word: BADGE_WORDS[badge] ?? null,
    detail: badge === 'checking' && single ? 'Checks are running, so this photo may join a stack.' : DETAILS[badge] ?? '',
    steps: single ? [] : [groupingStep({ ...group, memberCount: count }, unsure), aiStep({ ...group, memberCount: count }),
      keeperStep(group)].filter(Boolean),
    keepers, updated: group.updated === true || STATUS_KEYS.some(key => group[key]?.state === 'updated'),
  };
}

// Merge polled statuses into the shown group (a card's, or the open
// comparison's). "updated" means a newer grouping supersedes the shown photos:
// the shown badge keeps a settled verdict, such as AI checked or a finished
// check, until the view adopts the new grouping, while finished work stops
// counting as checking. Any of the three roles can report it.
const STATUS_KEYS = ['similarity', 'stackReferee', 'photoReferee'];
const settled = value => Boolean(value) && !['waiting', 'checking', 'updated'].includes(value.state) && !value.checking;
export function mergeStatus(target, patch) {
  const keys = STATUS_KEYS.filter(key => Object.hasOwn(patch, key));
  for (const key of keys) {
    if (patch[key]?.state === 'updated' && settled(target[key])) continue;
    target[key] = patch[key];
  }
  if (keys.length) target.updated = keys.some(key => patch[key]?.state === 'updated');
  if (Object.hasOwn(patch, 'reasons')) target.reasons = patch.reasons;
  return target;
}

// Page-header counts over the loaded cards, with the cards' icons.
export function statusCounts(groups) {
  const counts = { checking: 0, unsure: 0, partial: 0 };
  for (const group of groups) {
    const badge = stackStatus(group)?.badge;
    if (Object.hasOwn(counts, badge)) counts[badge]++;
  }
  return counts;
}
