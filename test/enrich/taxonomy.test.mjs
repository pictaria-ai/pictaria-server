import test from 'node:test';
import assert from 'node:assert/strict';

import { approvedModelTags } from '../../src/enrich/taxonomy.mjs';
import { loadV1Taxonomy } from './helpers.mjs';

test('v1 taxonomy loads and contains expected tags', () => {
  const taxonomy = loadV1Taxonomy();

  assert.equal(taxonomy.version, 'v1.2');
  assert.ok(taxonomy.approvedTags.has('ai/quality/frame-worthy'));
  assert.ok(taxonomy.approvedTags.has('ai/quality/eyes-closed'));
  assert.ok(!taxonomy.hardExclusionTags.has('ai/quality/eyes-closed'));
  // v1.2: validated against real decisions
  assert.ok(!taxonomy.approvedTags.has('ai/quality/duplicate-ish'));
  assert.ok(!taxonomy.hardExclusionTags.has('ai/quality/low-resolution'));
  assert.ok(taxonomy.approvedTags.has('ai/activity/wedding'));
  assert.ok(taxonomy.approvedTags.has('ai/activity/birthday'));
  assert.ok(!taxonomy.approvedTags.has('ai/exclude/license-plate'));
  assert.ok(!taxonomy.approvedTags.has('ai/exclude/medical'));
  assert.ok(taxonomy.approvedTags.has('frame/never-show'));
  assert.ok(approvedModelTags(taxonomy).includes('frame/review'));
  assert.ok(!approvedModelTags(taxonomy).includes('frame/eligible'));
});

test('hard exclusions are approved tags', () => {
  const taxonomy = loadV1Taxonomy();
  const unknown = [...taxonomy.hardExclusionTags].filter((tag) => !taxonomy.approvedTags.has(tag));

  assert.deepEqual(unknown, []);
});

test('parseTaxonomySource validates like the file loader; replaceTaxonomy swaps in place', async () => {
  const { parseTaxonomySource, replaceTaxonomy } = await import('../../src/enrich/taxonomy.mjs');

  assert.throws(() => parseTaxonomySource('{broken'), /valid JSON/);
  assert.throws(() => parseTaxonomySource('[]'), /root must be an object/);
  assert.throws(() => parseTaxonomySource(JSON.stringify({ version: 'x' })), /categories object/);

  const parsed = parseTaxonomySource(JSON.stringify({
    version: 'v9',
    categories: { scene: ['ai/scene/beach'] },
    thresholds: { frame_worthy: 0.5 },
  }));
  assert.equal(parsed.version, 'v9');
  assert.ok(parsed.approvedTags.has('ai/scene/beach'));

  // In-place swap: holders of the old reference see the new taxonomy.
  const live = loadV1Taxonomy();
  const holder = { taxonomy: live };
  replaceTaxonomy(live, parsed);
  assert.equal(holder.taxonomy.version, 'v9');
  assert.ok(holder.taxonomy.approvedTags.has('ai/scene/beach'));
  assert.equal(holder.taxonomy.approvedTags.has('ai/quality/frame-worthy'), false);
});
