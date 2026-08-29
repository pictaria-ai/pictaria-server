import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadTaxonomy } from '../../src/enrich/taxonomy.mjs';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadV1Taxonomy() {
  return loadTaxonomy(join(REPO_ROOT, 'taxonomy', 'v1.json'));
}

export function sampleOutput() {
  return {
    caption: 'A mountain lake under a bright sky.',
    short_caption: 'Mountain lake.',
    is_photo: true,
    is_screenshot: false,
    is_document: false,
    is_text_heavy: false,
    has_private_info: false,
    has_license_plate: false,
    has_people: false,
    people_count: 'none',
    child_present: false,
    quality: {
      aesthetic_score: 0.86,
      sharpness_score: 0.82,
      brightness_score: 0.79,
      frame_worthy_score: 0.91,
      is_blurry: false,
      is_dark: false,
      is_low_resolution: false,
    },
    scene: { primary: 'mountains', secondary: ['lake'] },
    subjects: [],
    activities: ['hiking'],
    composition: ['wide-shot'],
    candidate_tags: [
      { tag: 'ai/scene/mountains', confidence: 0.93, reason: 'Mountain range is prominent.' },
      { tag: 'ai/scene/water', confidence: 0.88, reason: 'Lake is visible.' },
    ],
    exclusion_reasons: [],
    needs_review: false,
  };
}
