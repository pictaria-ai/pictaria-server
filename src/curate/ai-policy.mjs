// Capabilities belong to the server composition, never to saved user settings.
// Turn on each role only when its worker and lifecycle gates are connected.
export const CURATE_AI_AVAILABILITY = Object.freeze({ stack: false, keeper: false });
export const STACK_REFEREE_SCOPES = Object.freeze(['uncertain', 'all']);

export function curateAiRoleEnabled(config, role, availability = CURATE_AI_AVAILABILITY) {
  const preference = role === 'stack' ? config.curateStackRefereeEnabled
    : role === 'keeper' ? config.curateKeeperRefereeEnabled : false;
  return config.curateBurstGrouping !== false && availability[role] === true && preference === true;
}

// Scope selection only: not permission to submit a request. The worker must
// still enforce image limits, budgets, pauses and current material revisions.
// A valid check includes a split result; do not recursively re-check its output.
export function selectStackReferee(config, {
  memberCount, pending, deterministicSettled, currentCheck = false, route,
}, availability = CURATE_AI_AVAILABILITY) {
  if (!curateAiRoleEnabled(config, 'stack', availability)) return { selected: false, reason: 'disabled' };
  if (pending !== true || !Number.isInteger(memberCount) || memberCount < 2)
    return { selected: false, reason: 'not-pending-stack' };
  if (currentCheck) return { selected: false, reason: 'current-check' };
  if (deterministicSettled !== true) return { selected: false, reason: 'deterministic-pending' };
  const scope = config.curateStackRefereeScope ?? 'uncertain';
  if (!STACK_REFEREE_SCOPES.includes(scope)) return { selected: false, reason: 'invalid-scope' };
  // This is a cost/coverage policy, not proof that the grouping is correct or
  // AI-checked. Missing individual facts do not invalidate a supported route.
  if (scope === 'uncertain' && route === 'candidate-supported')
    return { selected: false, reason: 'supported-by-grouping' };
  return { selected: true, reason: scope === 'all' ? 'all-stacks' : 'uncertain-composition' };
}
