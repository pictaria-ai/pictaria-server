import { fingerprint } from './contracts.mjs';
import { PHOTO_REFEREE_CONTRACT, collectPhotoRefereeComparisons } from './photo-referee-contract.mjs';
import { validatePhotoRefereePlan } from './photo-referee-plan.mjs';

const same = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

// One bounded record per overlapping pending scope, using the existing advice
// tables. Partial batches have no fabricated global partition or generic advice.
export function readPhotoRefereeRecord(store, ids, { subset = false } = {}) {
  if (!ids.length) return null;
  const row = store.prepare(`SELECT a.json FROM curate_advice a JOIN curate_advice_members m
    ON m.role=a.role AND m.input_key=a.input_key
    WHERE a.role='keeper' AND a.schema_version=? AND m.asset_id=?`)
    .get(PHOTO_REFEREE_CONTRACT, ids[0]);
  if (!row) return null;
  const record = JSON.parse(row.json);
  return (same(record.ids, ids) || subset && ids.every(id => record.ids.includes(id))) && record.photoReferee ? record : null;
}

// Called inside the executor's current-input transaction. Image bytes and raw
// provider envelopes never enter this record. Context is not indexed as owned
// membership, so two comparisons sharing an approved photo cannot erase advice.
export function savePhotoRefereeAnswer(store, snapshot, plan, answer, { configurationKey, checkCoverage }) {
  validatePhotoRefereePlan(plan);
  const index = answer.provenance?.requestIndex, request = plan.requests[index];
  if (!request || !same(snapshot.ids, plan.orderedIds) || !same(snapshot.actionable, request.ids) ||
      !same(snapshot.contextIds, plan.contextIds) || answer.provenance.inputKey !== snapshot.inputKey)
    throw new Error('Photo Referee answer does not match the current comparison.');
  const previous = readPhotoRefereeRecord(store, snapshot.ids);
  const reusable = previous?.photoReferee.snapshot.material === snapshot.material &&
    previous.photoReferee.snapshot.groupId === snapshot.groupId;
  if (reusable && (previous.photoReferee.plan.planKey !== plan.planKey ||
      previous.photoReferee.configurationKey !== configurationKey))
    throw new Error('Photo Referee comparison changed between batches.');
  const answers = reusable ? [...previous.photoReferee.answers] : plan.requests.map(() => null);
  if (answers[index]) throw new Error('Photo Referee batch is already saved.');
  answers[index] = answer;
  const collected = collectPhotoRefereeComparisons(plan, answers);
  if (collected.batches[index].status !== 'valid') throw new Error('Invalid Photo Referee batch.');
  const inputKey = fingerprint(snapshot.ids.map(id => [id, store.photo(id)?.inputKey]));
  const members = snapshot.ids.map(id => {
    const p = store.photo(id);
    return [id, p.inputKey, p.availability, store.separationKey(id), p.humanKey];
  });
  const contextMembers = snapshot.contextIds.map(id => {
    const p = store.photo(id);
    return [id, p.materialKey, p.availability, store.separationKey(id)];
  });
  const record = { ids: [...snapshot.ids], photoReferee: { snapshot, plan, answers, configurationKey, checkCoverage, members, contextMembers } };
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > 64 * 1024) throw new Error('Photo Referee record is too large.');
  for (const id of snapshot.ids) store.prepare(`DELETE FROM curate_advice WHERE role='keeper' AND input_key IN
    (SELECT input_key FROM curate_advice_members WHERE role='keeper' AND asset_id=?)`).run(id);
  store.prepare('INSERT INTO curate_advice VALUES(?,?,?,?)').run('keeper', inputKey, PHOTO_REFEREE_CONTRACT, json);
  const insert = store.prepare('INSERT INTO curate_advice_members VALUES(?,?,?)');
  for (const id of snapshot.ids) insert.run('keeper', inputKey, id);
  store.bump();
}

// Explicit projection for API/UI consumers. Applicability is checked by the
// worker before calling this; no internal snapshots, hashes or connection details
// leak into the ordinary comparison response. This never writes human choices.
export function photoRefereeRecommendations(record, ids = record.ids) {
  const { plan, answers, checkCoverage } = record.photoReferee;
  const result = collectPhotoRefereeComparisons(plan, answers);
  const selected = new Set(ids), subset = !same(ids, record.ids);
  if (subset && (!result.wholeGroupCompared || !result.partition?.some(part => same(part.ids.filter(id => record.ids.includes(id)), ids)))) return null;
  const groups = values => values.map(part => ({ ...part, ids: part.ids.filter(id => selected.has(id)),
    keepers: part.keepers.filter(id => selected.has(id)) })).filter(part => part.ids.length);
  const keeperIds = result.keeperIds.filter(id => selected.has(id));
  const provenance = answers.find(Boolean)?.provenance;
  return { state: result.state, coverage: result.coverage, checkCoverage,
    wholeGroupCompared: result.wholeGroupCompared, canApplyAll: result.canApplyAll,
    noneRecommended: result.canApplyAll && keeperIds.length === 0, keeperIds,
    partition: result.partition && groups(result.partition),
    provider: provenance?.provider, model: provenance?.model,
    batches: result.batches.map(b => ({ index: b.index, status: b.status,
      ...(b.status === 'valid' ? { groups: groups(b.result.groups), assessments: b.assessments.filter(p => selected.has(p.id)) } : {}) })) };
}
