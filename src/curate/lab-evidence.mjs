import { producingPeopleFact } from './evidence.mjs';

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
