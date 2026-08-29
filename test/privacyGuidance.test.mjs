import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const paths = [
  '../README.md',
  '../.env.example',
  '../docs/ALBUMS.md',
  '../docs/BACKUP.md',
  '../docs/CONFIGURATION.md',
  '../docs/ENRICH.md',
  '../docs/GETTING-STARTED.md',
  '../docs/INSIGHTS.md',
  '../docs/UPGRADING.md',
  '../docs/VISION.md',
  '../public/albums.html',
  '../public/curate.html',
  '../public/enrich.html',
  '../public/index.html',
  '../public/metrics.html',
  '../public/settings.html',
  '../src/config.mjs',
  '../src/sessionTokens.mjs',
];
const guidance = new Map(
  await Promise.all(
    paths.map(async (path) => [path, await readFile(new URL(path, import.meta.url), 'utf8')]),
  ),
);

test('public guidance avoids superseded absolute privacy and recovery claims', () => {
  const superseded = [
    /nothing leaves (?:your|the) machine/i,
    /everything it does stays on your machine/i,
    /nothing ever phones home/i,
    /photos stay on your own hardware/i,
    /stay exactly where they are,\s*untouched/i,
    /nothing is ever moved,\s*edited,\s*or deleted/i,
    /nothing is ever deleted or modified/i,
    /everything runs on your hardware/i,
    /photos never leave home/i,
    /the one feature that can send photos/i,
    /enrichment itself never writes to Immich/i,
    /only logs browsers out/i,
    /never overwrites a human/i,
    /only empty descriptions are filled/i,
    /X-App-Password:\s*your-password/i,
  ];

  for (const [path, source] of guidance) {
    // Markdown prose is hard-wrapped in the repository. Collapse whitespace
    // before matching so a line break cannot hide a superseded phrase whose
    // pattern uses ordinary spaces between words.
    const normalizedSource = source.replace(/\s+/g, ' ');
    for (const pattern of superseded) {
      assert.doesNotMatch(normalizedSource, pattern, `${path} contains superseded guidance`);
    }
  }
});

test('public guidance uses the Pictaria Frame product name', () => {
  const deprecatedNames = [
    /(?<!-)\bframe app\b/i,
    /Pictaria app(?:'s)?/i,
  ];

  for (const [path, source] of guidance) {
    for (const pattern of deprecatedNames) {
      assert.doesNotMatch(source, pattern, `${path} contains a deprecated product name`);
    }
  }
});

test('decision-point guidance discloses independent egress and recovery effects', () => {
  assert.match(guidance.get('../README.md'), /Interesting[\s\S]+independently sends/i);
  assert.match(guidance.get('../README.md'), /Open-Meteo/);
  assert.match(guidance.get('../public/settings.html'), /independently of the Enrich switch/i);
  assert.match(guidance.get('../public/settings.html'), /city or US ZIP to Open-Meteo/i);
  assert.match(guidance.get('../public/settings.html'), /no telemetry, analytics, or Pictaria-operated cloud service/i);
  assert.match(guidance.get('../public/settings.html'), /verification makes no network request to Pictaria/i);
  assert.match(guidance.get('../public/settings.html'), /Model requests stay within infrastructure you operate/i);
  assert.match(guidance.get('../docs/VISION.md'), /original\s+photo files[\s\S]+never alters their bytes/i);
  assert.match(guidance.get('../docs/VISION.md'), /tags, descriptions, location[\s\S]+managed album membership/i);
  assert.match(guidance.get('../docs/VISION.md'), /configured cloud models receive them through[\s\S]+provider account/i);
  assert.match(guidance.get('../docs/BACKUP.md'), /pauses enabled Smart Album schedules as \*\*Needs review\*\*/);
  assert.match(guidance.get('../docs/UPGRADING.md'), /-H "@\$header_file"/);
});
