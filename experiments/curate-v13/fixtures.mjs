// Invented metadata and expected labels; no photographs or user identifiers.
const start = Date.UTC(2025, 0, 1);
export function photo(id, seconds, { people, recognized = [], tone = 80, ...rest } = {}) {
  return { id, capturedAt: new Date(start + seconds * 1000).toISOString(), personIds: recognized,
    thumbhash: Buffer.alloc(25, tone).toString('base64'),
    ...(people === undefined ? {} : { facts: { contract: 'curate-facts-prototype-1', peopleCount: people } }), ...rest };
}
export const fixtures = [
  { name: 'landscape-couple-solo', photos: [photo('landscape', 0, { people: 0, tone: 0 }),
    photo('couple', 5, { people: 2, recognized: ['person-a', 'person-b'], tone: 100 }),
    photo('solo', 10, { people: 1, recognized: ['person-a'], tone: 240 })], expected: [['landscape'], ['couple'], ['solo']] },
  { name: 'missed-recognition', photos: [photo('a', 0, { people: 2, recognized: ['p', 'q'] }),
    photo('b', 5, { people: 2, recognized: ['p'], tone: 230 })], expected: [['a', 'b']] },
  { name: 'conflicting-counts', photos: [photo('a', 0, { people: 2, recognized: ['p'] }),
    photo('b', 5, { people: 1, recognized: ['p'], tone: 230 })], expected: [['a', 'b']] },
  { name: 'unsupported-custom-profile', photos: [photo('a', 0, { facts: { contract: 'custom-unknown', peopleCount: 0 } }),
    photo('b', 5, { people: 2, recognized: ['p', 'q'], tone: 230 })], expected: [['a', 'b']] },
  { name: 'same-count-different-identities-is-uncertain', photos: [photo('a', 0, { people: 1, recognized: ['p'] }),
    photo('b', 5, { people: 1, recognized: ['q'], tone: 230 })], expected: [['a', 'b']] },
  { name: 'thirty-alternatives', photos: Array.from({ length: 30 }, (_, i) => photo(`burst-${i}`, i * 5)),
    expected: [Array.from({ length: 30 }, (_, i) => `burst-${i}`)], keepers: ['burst-3', 'burst-4'] },
  { name: 'long-walk', photos: Array.from({ length: 60 }, (_, i) => photo(`walk-${i}`, i * 10)), maxSpanSeconds: 180 },
  { name: 'pending-newcomer', photos: [photo('kept', 0, { state: 'kept' }), photo('new', 5)], expected: [['kept', 'new']] },
];

export function dataset(pending, decided = 0) {
  return Array.from({ length: pending + decided }, (_, i) => photo(`synthetic-${i}`, Math.floor(i / 30) * 240 + (i % 30) * 5,
    { state: i < pending ? 'pending' : 'kept', people: 1, recognized: ['synthetic-person'] }));
}
