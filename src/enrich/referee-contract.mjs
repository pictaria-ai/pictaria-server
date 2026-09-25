// Released keeper-quality contract, extracted unchanged from v1.2.1.
// Shared by the legacy worker and the offline baseline evaluator, so lifecycle
// changes cannot silently change the prompt, schema or normalization evidence.
export const REFEREE_PROMPT_VERSION = 'referee-v2';

const SYSTEM_PROMPT = [
  'You are a photo-culling referee. You receive several photos taken moments apart',
  '(a burst, re-shoots, or duplicates) and rank them by which is most worth keeping',
  'for display in a home photo frame.',
  '',
  'Ranking rules, in priority order:',
  '1. A photo that clearly shows people beats a photo of the same scene without',
  '   people — unless the people shot is technically bad (badly blurred, person',
  '   cut off, all eyes closed).',
  '2. Among photos of people: everyone sharp, eyes open, and natural expressions',
  '   beat blinks, grimaces, and motion blur.',
  '3. Otherwise judge sharpness, composition, and overall appeal.',
  '',
  'For every photo, check each clearly visible face for closed eyes or mid-blink.',
  'Use "unsure" when faces are too small to judge confidently.',
  'Also assign every photo a subject_group number. Photos of essentially the',
  'same subject share a number (start at 1). Use a second group ONLY when the',
  'set clearly contains different subjects — e.g. shots of people AND separate',
  'shots of just the scenery, or two genuinely different scenes. Near-identical',
  'shots, re-framings, and small zoom changes are the SAME subject. When in',
  'doubt, use one group.',
  'Mark keep=true for the best photo of each subject_group.',
  'Keep each note short (one sentence) and concrete: it is shown to the user as',
  'the reason for the pick.',
  'Return strict JSON only.',
].join('\n');

export function refereeJsonSchema(memberCount) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['same_subject', 'photos'],
    properties: {
      same_subject: {
        type: 'boolean',
        description: 'Whether all photos show essentially the same subject (vs a mixed set that merely shares a time and place).',
      },
      photos: {
        type: 'array',
        minItems: memberCount,
        maxItems: memberCount,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['photo', 'rank', 'keep', 'eyes_closed', 'note', 'subject_group'],
          properties: {
            photo: { type: 'integer', description: '1-based index of the photo, in the order provided.' },
            rank: { type: 'integer', description: '1 = most worth keeping.' },
            subject_group: { type: 'integer', minimum: 1, description: 'Photos of the same subject share a number; a clearly different subject gets the next number. When in doubt, 1.' },
            keep: { type: 'boolean' },
            eyes_closed: { type: 'string', enum: ['yes', 'no', 'unsure'] },
            note: { type: 'string' },
          },
        },
      },
    },
  };
}

export function buildRefereeUserPrompt(members) {
  const lines = members.map((member, index) => {
    const facts = [];
    if (member.capturedAt) facts.push(`taken ${String(member.capturedAt).replace('T', ' ').slice(0, 19)}`);
    facts.push(describePeople(member));
    return `Photo ${index + 1}: ${facts.filter(Boolean).join(' · ')}`;
  });
  return [
    `These ${members.length} photos were taken within minutes of each other.`,
    'Known facts from face detection and prior analysis:',
    ...lines,
    '',
    'Rank them by keeper quality following your rules, check faces for closed',
    'eyes, and pick the best 1-2 to keep.',
  ].join('\n');
}

function describePeople(member) {
  const tags = member.aiTags ?? [];
  if (tags.includes('ai/people/group')) return '3+ people detected';
  if (tags.includes('ai/people/couple')) return '2 people detected';
  if (tags.includes('ai/people/one')) return '1 person detected';
  if (tags.includes('ai/people/none')) return 'no people detected';
  return 'people unknown (not yet analyzed)';
}

export function buildRefereeRequest(members) {
  return {
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: buildRefereeUserPrompt(members),
    jsonSchema: refereeJsonSchema(members.length),
    schemaName: 'pictaria_group_referee',
  };
}

// Turn the model's photo-indexed answers into asset-keyed picks, defending
// against duplicate/missing indices: every member ends up with exactly one
// rank, holes filled in model order.
export function normalizePicks(output, members) {
  const answers = Array.isArray(output?.photos) ? output.photos : [];
  const byIndex = new Map();
  for (const answer of answers) {
    const index = Number(answer?.photo);
    if (Number.isInteger(index) && index >= 1 && index <= members.length && !byIndex.has(index)) {
      byIndex.set(index, answer);
    }
  }
  const usedRanks = new Set();
  const picks = members.map((member, position) => {
    const answer = byIndex.get(position + 1) ?? {};
    let rank = Number.isInteger(Number(answer.rank)) ? Number(answer.rank) : null;
    if (rank === null || rank < 1 || rank > members.length || usedRanks.has(rank)) rank = null;
    if (rank !== null) usedRanks.add(rank);
    return {
      assetId: member.assetId,
      rank,
      keep: Boolean(answer.keep),
      eyesClosed: ['yes', 'no', 'unsure'].includes(answer.eyes_closed) ? answer.eyes_closed : null,
      note: typeof answer.note === 'string' ? answer.note.slice(0, 300) : null,
      subjectGroup:
        Number.isInteger(Number(answer.subject_group)) && Number(answer.subject_group) >= 1 && Number(answer.subject_group) <= members.length
          ? Number(answer.subject_group)
          : 1,
    };
  });
  let nextFree = 1;
  for (const pick of picks) {
    if (pick.rank !== null) continue;
    while (usedRanks.has(nextFree)) nextFree += 1;
    pick.rank = nextFree;
    usedRanks.add(nextFree);
  }
  return picks;
}
