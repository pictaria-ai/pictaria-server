// Explicit evidence boundary for the evaluated three-by-ten keeper protocol.
// Planning/validation only: no inference, application grouping or decisions.
import { planRequest, validateAdvice } from './grouping.mjs';

export function planKeeperBatches(group, sizes, { orderedIds, maxImages, ...options }) {
  if (!Array.isArray(orderedIds) || orderedIds.length !== group.ids.length
    || new Set(orderedIds).size !== group.ids.length || orderedIds.some(id => !group.ids.includes(id))) throw Error('invalid image order');
  if (!Number.isSafeInteger(maxImages) || maxImages < 2) return { state: 'unsupported-provider' };
  // Preserve the total logical-comparison byte/size budget as well as each
  // provider request limit. A batch does not authorize more total image memory.
  const gate = planRequest(group, sizes, { ...options, role: 'keeper', maxImages: 30 });
  if (gate.state !== 'ready') return gate;
  const requests = [], count = Math.ceil(orderedIds.length / Math.min(30, maxImages));
  const small = Math.floor(orderedIds.length / count), extra = orderedIds.length % count;
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const size = small + Number(i < extra);
    requests.push(orderedIds.slice(offset, offset + size));
    offset += size;
  }
  // Do not fabricate comparative advice for a one-photo leftover. Production
  // routing must choose a supported layout or keep the comparison manual.
  if (requests.some(ids => ids.length < 2)) return { state: 'manual-batch-layout' };
  return { ...gate, requests, groupId: group.id,
    coverage: requests.length === 1 ? 'whole-group' : 'within-batches' };
}

export function collectKeeperBatches(plan, answers) {
  if (plan.state !== 'ready' || !Array.isArray(answers) || answers.length !== plan.requests.length) throw Error('invalid batch results');
  const batches = answers.map((answer, i) => {
    if (answer?.status !== 'valid') return { index: i, status: 'unavailable' };
    try {
      const output = validateAdvice(plan.requests[i], answer.output, 'keeper');
      return { index: i, status: 'valid', output };
    } catch { return { index: i, status: 'invalid-answer' }; }
  });
  const complete = batches.every(b => b.status === 'valid');
  return { state: complete ? 'complete' : 'partial', coverage: plan.coverage, groupId: plan.groupId,
    wholeGroupCompared: complete && plan.coverage === 'whole-group',
    // A union of local partitions is not a global grouping answer. Keep this
    // diagnostic structure distinct from validateAdvice's accepted contract.
    keeperIds: batches.flatMap(b => b.output?.groups.flatMap(g => g.keepers) ?? []), batches };
}
