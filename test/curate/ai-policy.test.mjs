import test from 'node:test';
import assert from 'node:assert/strict';
import { candidateGroups } from '../../src/curate/candidate.mjs';
import { curateAiRoleEnabled, selectStackReferee } from '../../src/curate/ai-policy.mjs';
const available = { stack: true, keeper: true };
const config = { curateBurstGrouping: true, curateStackRefereeEnabled: true,
  curateKeeperRefereeEnabled: true, curateStackRefereeScope: 'uncertain' };
const settled = { memberCount: 2, pending: true, deterministicSettled: true, route: 'candidate-unconfirmed' };

test('roles are independent of each other and Enrich, gated by Stacks and real worker availability', () => {
  for (const enrichEnabled of [false, true]) for (const stacks of [false, true])
    for (const stack of [false, true]) for (const keeper of [false, true]) {
      const c = { ...config, enrichEnabled, curateBurstGrouping: stacks,
        curateStackRefereeEnabled: stack, curateKeeperRefereeEnabled: keeper };
      assert.equal(curateAiRoleEnabled(c, 'stack', available), stacks && stack);
      assert.equal(curateAiRoleEnabled(c, 'keeper', available), stacks && keeper);
      assert.equal(curateAiRoleEnabled(c, 'stack'), false, 'unconnected roles cannot run');
      assert.equal(curateAiRoleEnabled(c, 'keeper'), false);
    }
  assert.equal(curateAiRoleEnabled(config, 'unknown', available), false);
});

test('both scopes exclude singles, decided photos, current advice and unsettled deterministic work', () => {
  for (const scope of ['uncertain', 'all']) {
    const c = { ...config, curateStackRefereeScope: scope };
    for (const [change, reason] of [
      [{ memberCount: 1 }, 'not-pending-stack'], [{ pending: false }, 'not-pending-stack'],
      [{ currentCheck: true }, 'current-check'], [{ deterministicSettled: false }, 'deterministic-pending'],
    ]) assert.deepEqual(selectStackReferee(c, { ...settled, ...change }, available), { selected: false, reason });
    assert.equal(selectStackReferee(c, settled).selected, false);
  }
  assert.deepEqual(selectStackReferee({ ...config, curateStackRefereeScope: 'typo' }, settled, available),
    { selected: false, reason: 'invalid-scope' });
});

test('scope uses composition support, not missing tags, question-mark icons or descriptive text', () => {
  const rows = [1, 2].map(n => ({ id: String(n), time: n * 1000, materialKey: String(n), availability: 'observed' }));
  const select = (group, scope = 'uncertain') => selectStackReferee({ ...config, curateStackRefereeScope: scope },
    { ...settled, memberCount: group.ids.length, route: group.route }, available);
  const unresolved = candidateGroups(rows).groups[0];
  assert.equal(select(unresolved).selected, true, 'terminal incomplete similarity is eligible after settling');
  const supported = candidateGroups(rows.map(p => ({ ...p, thumbhash: Buffer.alloc(21, 0).toString('base64') }))).groups[0];
  assert.equal(supported.route, 'candidate-supported');
  assert.deepEqual(select(supported), { selected: false, reason: 'supported-by-grouping' }, 'unknown people is not a conflict');
  assert.deepEqual(select(supported, 'all'), { selected: true, reason: 'all-stacks' });
  assert.equal(select({ ...unresolved, reasons: ['Similarity checked'] }).selected, true);
  assert.equal(select({ ids: rows.map(p => p.id), route: 'manual-budget' }).selected, true,
    'selection does not waive the worker image limit');
  const split = candidateGroups(rows.map((p, i) => ({ ...p, peopleCategory: i ? 'one' : 'none' })));
  assert.ok(split.groups.every(g => !select(g, 'all').selected), 'scope does not rejoin people splits');
});
