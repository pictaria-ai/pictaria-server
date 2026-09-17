import { producingPeopleFact, MAX_EVIDENCE_BYTES, MAX_PEOPLE } from './evidence.mjs';

// Keep missing, omitted or malformed observations unknown. An empty list is
// usable display evidence, but cannot establish that nobody is in the photo.
export function labRecognizedIds(serialized) {
  if (typeof serialized !== 'string' || serialized.length > MAX_EVIDENCE_BYTES) return null;
  try {
    const recognition = JSON.parse(serialized);
    if (recognition?.omitted !== false || !Array.isArray(recognition.ids) ||
        recognition.ids.length > MAX_PEOPLE || !recognition.ids.every((id) =>
          typeof id === 'string' && id.length > 0 && id.length <= 128)) return null;
    return [...new Set(recognition.ids)].sort();
  } catch { return null; }
}

// Lab-only categorical experiment. Keep the production exact-count adapter
// unchanged, and use the saved producing contract rather than guessing from tags.
export function labPeopleEvidence(output, schema, configurationId) {
  const fact = producingPeopleFact(output, schema, configurationId);
  if (fact.source !== 'producing-enrich-schema')
    return { peopleCategory: null, peopleStatus: 'unsupported' };
  const category = output?.people_count;
  if (!['none', 'one', 'couple', 'group'].includes(category))
    return { peopleCategory: null, peopleStatus: 'unknown' };
  if (typeof output?.has_people !== 'boolean' || output.has_people !== (category !== 'none'))
    return { peopleCategory: null, peopleStatus: 'conflicting' };
  return { peopleCategory: category, peopleStatus: 'known' };
}
