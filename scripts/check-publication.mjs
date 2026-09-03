import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['.env.example']);
const restrictedTrackedPath = /(?:^|\/)(?:\.env[^/]*|data(?:\/|$)|backups(?:\/|$)|logs(?:\/|$)|id_(?:rsa|ed25519)$)|\.(?:pem|key|p8|p12|pfx|jks|keystore)$|\.(?:sqlite3?|db)(?:-[^/]*)?$/i;
const requiredGitIgnoreRules = [
  '.env*',
  '!.env.example',
  'data/',
  'backups/',
  'logs/',
  '*.pem',
  '*.key',
  '*.p8',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  'id_rsa',
  'id_ed25519',
  '*.sqlite',
  '*.sqlite-*',
  '*.sqlite3',
  '*.sqlite3-*',
  '*.db',
  '*.db-*',
];
const requiredDockerIgnoreRules = requiredGitIgnoreRules.map((rule) => {
  if (rule === '!.env.example') {
    return '!**/.env.example';
  }
  return `**/${rule}`;
});

const trackedResult = spawnSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
});
if (trackedResult.status !== 0) {
  throw new Error(`Could not enumerate tracked files: ${trackedResult.stderr.trim()}`);
}

const tracked = trackedResult.stdout.split('\0').filter(Boolean);
const restricted = tracked.filter((path) => !allowed.has(path) && restrictedTrackedPath.test(path));
if (restricted.length > 0) {
  throw new Error(`Restricted local files are tracked:\n${restricted.join('\n')}`);
}

for (const path of [
  'src/nested/enrichment.sqlite-backup',
  'src/nested/insights.sqlite3-copy',
  'src/nested/frame.db-export',
]) {
  if (!restrictedTrackedPath.test(path)) {
    throw new Error(`${path} is not recognized as restricted tracked database state.`);
  }
}

for (const [filename, requiredRules] of [
  ['.gitignore', requiredGitIgnoreRules],
  ['.dockerignore', requiredDockerIgnoreRules],
]) {
  const rules = new Set(
    readFileSync(resolve(root, filename), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
  const missing = requiredRules.filter((rule) => !rules.has(rule));
  if (missing.length > 0) {
    throw new Error(`${filename} is missing publication rules:\n${missing.join('\n')}`);
  }
}

const ignoreChecks = [
  ['.env', true],
  ['src/nested/publication-probe.key', true],
  ['prompts/nested/publication-probe.sqlite', true],
  ['data/enrichment.sqlite', true],
  ['src/nested/.env.example', false],
];
for (const [path, expectedIgnored] of ignoreChecks) {
  const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', path], {
    cwd: root,
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Could not check ignore policy for ${path}: ${result.stderr?.toString().trim()}`);
  }
  const ignored = result.status === 0;
  if (ignored !== expectedIgnored) {
    throw new Error(`${path} is ${ignored ? '' : 'not '}ignored contrary to publication policy.`);
  }
}

const publicGuidancePaths = tracked.filter(
  (path) =>
    path === 'README.md' ||
    path === 'CHANGELOG.md' ||
    path === '.env.example' ||
    path === 'docker-compose.yml' ||
    (path.startsWith('docs/') && path.endsWith('.md')) ||
    (path.startsWith('public/') && path.endsWith('.html')),
);
const publicGuidance = new Map(
  publicGuidancePaths.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
);
const packageManifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const changelog = publicGuidance.get('CHANGELOG.md');
const readme = publicGuidance.get('README.md');
const insightsGuide = publicGuidance.get('docs/INSIGHTS.md');
if (!/^# Insights$/m.test(insightsGuide)) {
  throw new Error('docs/INSIGHTS.md must use a durable, unversioned title.');
}
if (/^## v\d/im.test(insightsGuide) || /^## .*candidates/im.test(insightsGuide)) {
  throw new Error('docs/INSIGHTS.md must describe current behavior, not iteration logs or candidates.');
}
if (!readme.includes('[SECURITY.md](SECURITY.md)')) {
  throw new Error('README.md must link the public security policy.');
}
const documentedNodeRequirement = `**Node:** \`${packageManifest.engines?.node}\``;
if (!packageManifest.engines?.node || !changelog.includes(documentedNodeRequirement)) {
  throw new Error(
    `CHANGELOG.md must state the package.json Node requirement exactly: ${documentedNodeRequirement}`,
  );
}
const immichCompatibilityPaths = [
  'CHANGELOG.md',
  'README.md',
  'docs/GETTING-STARTED.md',
  'docs/IMMICH-COMPATIBILITY.md',
];
for (const path of immichCompatibilityPaths) {
  const guidance = publicGuidance.get(path);
  for (const testedImmichVersion of ['2.7.5', '3.1.0']) {
    const escapedVersion = testedImmichVersion.replaceAll('.', '\\.');
    const contextualVersion = new RegExp(
      `Immich(?:[^\\n]*\\n){0,4}[^\\n]*\\b${escapedVersion}\\b`,
      'i',
    );
    if (!contextualVersion.test(guidance)) {
      throw new Error(`${path} must name tested Immich version ${testedImmichVersion}.`);
    }
  }
}
const publishWorkflowPath = '.github/workflows/publish.yml';
const publishWorkflow = readFileSync(resolve(root, publishWorkflowPath), 'utf8');
const workflowUses = [...publishWorkflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)]
  .map((match) => match[1]);
const unpinnedWorkflowUses = workflowUses.filter(
  (action) => !/^[^/]+\/[^/@]+@[0-9a-f]{40}$/.test(action),
);
if (workflowUses.length === 0 || unpinnedWorkflowUses.length > 0) {
  throw new Error(
    `${publishWorkflowPath} must pin every action to a full commit SHA:` +
      `\n${unpinnedWorkflowUses.join('\n')}`,
  );
}
if (!/^\s*tags:\s*\n\s*-\s*['"]v\*\.\*\.\*['"]\s*$/m.test(publishWorkflow)) {
  throw new Error(`${publishWorkflowPath} must publish only from semantic version tags.`);
}
if (/^\s*branches(?:-ignore)?:/m.test(publishWorkflow)) {
  throw new Error(`${publishWorkflowPath} must not publish from branch pushes.`);
}
for (const forbiddenTag of ['edge', 'type=semver,pattern={{major}}', 'type=semver,pattern={{major}}.{{minor}}']) {
  if (publishWorkflow.includes(forbiddenTag)) {
    throw new Error(`${publishWorkflowPath} must not publish the moving or partial tag: ${forbiddenTag}`);
  }
}
for (const requiredTag of ['type=semver,pattern={{version}}', 'latest=auto']) {
  if (!publishWorkflow.includes(requiredTag)) {
    throw new Error(`${publishWorkflowPath} is missing release tag rule: ${requiredTag}`);
  }
}
if (publishWorkflow.includes('type=raw,value=latest')) {
  throw new Error(`${publishWorkflowPath} must not move latest with an unconditional raw tag.`);
}
for (const requiredDigestContract of [
  'id: build',
  '${{ steps.build.outputs.digest }}',
  'GITHUB_STEP_SUMMARY',
]) {
  if (!publishWorkflow.includes(requiredDigestContract)) {
    throw new Error(
      `${publishWorkflowPath} must surface the published manifest digest: ${requiredDigestContract}`,
    );
  }
}
const mutableImageReference =
  /(?:ghcr\.io\/pictaria-ai\/pictaria-server:|PICTARIA_IMAGE_TAG:-)(?:latest|edge)\b/i;
const tagOnlyImmutableClaim =
  /(?:\bimmutable\s+(?:(?:Pictaria|release|versioned)\s+){0,2}(?:image|tag|version|reference)\b|\b(?:Pictaria\s+)?(?:image|tag|version|reference)\s+is\s+immutable\b)/i;
const releaseGuidanceChecks = [
  {
    paths: ['README.md'],
    pattern: /raw\.githubusercontent\.com\/pictaria-ai\/pictaria-server\/main\//i,
    message: 'Production quick start must not download deployment inputs from moving main.',
  },
  {
    paths: ['docs/RUNNING.md'],
    pattern: /\bgit pull\b/i,
    message: 'Service guidance must use the reviewed-release upgrade procedure, not git pull.',
  },
  {
    paths: publicGuidancePaths,
    pattern: mutableImageReference,
    message: 'Public guidance must not install a moving latest or edge image.',
  },
  {
    paths: publicGuidancePaths,
    pattern: tagOnlyImmutableClaim,
    message: 'A tag-only Pictaria image must not be described as immutable.',
  },
];

for (const unsafe of [
  'ghcr.io/pictaria-ai/pictaria-server:latest',
  'ghcr.io/pictaria-ai/pictaria-server:edge',
  '${PICTARIA_IMAGE_TAG:-latest}',
  '${PICTARIA_IMAGE_TAG:-edge}',
]) {
  if (!mutableImageReference.test(unsafe)) {
    throw new Error(`Publication check does not recognize mutable image reference: ${unsafe}`);
  }
}
for (const unsafe of [
  'immutable image tag',
  'immutable release image',
  'Pictaria image is immutable',
]) {
  if (!tagOnlyImmutableClaim.test(unsafe)) {
    throw new Error(`Publication check does not recognize tag-only immutability claim: ${unsafe}`);
  }
}

const compose = publicGuidance.get('docker-compose.yml');
if (/\bPIC-\d+\b/.test(compose)) {
  throw new Error('docker-compose.yml must not expose internal tracker references.');
}
const composeDefault = compose.match(/PICTARIA_IMAGE_TAG:-([^}\s]+)/)?.[1];
if (!composeDefault || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(composeDefault)) {
  throw new Error('docker-compose.yml must default PICTARIA_IMAGE_TAG to an explicit release version.');
}
const composeEnvironmentKeys = new Set(
  [...compose.matchAll(/^\s{6}([A-Z][A-Z0-9_]+):/gm)].map((match) => match[1]),
);
const serverConfigSource = readFileSync(resolve(root, 'src/config.mjs'), 'utf8');
const serverEnvironmentKeys = new Set(
  [...serverConfigSource.matchAll(/\benv\.([A-Z][A-Z0-9_]*)\b/g)].map((match) => match[1]),
);
const providerEnvironmentPrefixes = [
  // Add a provider's prefix here when its first env-backed configuration is
  // introduced; prefix-based discovery keeps later knobs self-maintaining.
  'CURATE_',
  'ELEVENLABS_',
  'ENRICH_',
  'GEOCODING_',
  'LMSTUDIO_',
  'OLLAMA_',
  'OPENAI_',
  'OPENROUTER_',
  'VENICE_',
  'VOICE_',
];
const providerEnvironmentNames = new Set([
  'CAPTION_WRITEBACK',
  'DEFAULT_PROVIDER',
  'GEOAPIFY_API_KEY',
  'IMAGE_SOURCE',
  'INFERENCE_HOST_LABEL',
  'MAX_FAILURES_PER_ASSET',
  'PROMPT_VERSION',
  'REFEREE_GROUP_BUDGET_MB',
  'STT_PROVIDER',
  'TTS_PROVIDER',
]);
const providerEnvironmentKeys = [...serverEnvironmentKeys]
  .filter((key) => providerEnvironmentNames.has(key)
    || providerEnvironmentPrefixes.some((prefix) => key.startsWith(prefix)))
  .sort();
const missingProviderEnvironmentKeys = providerEnvironmentKeys
  .filter((key) => !composeEnvironmentKeys.has(key));
if (missingProviderEnvironmentKeys.length > 0) {
  throw new Error(
    `docker-compose.yml must forward every supported AI and enrichment environment variable; missing: ${missingProviderEnvironmentKeys.join(', ')}.`,
  );
}
const configuration = publicGuidance.get('docs/CONFIGURATION.md');
if (!configuration.includes(`| \`PICTARIA_IMAGE_TAG\` | \`${composeDefault}\` |`)) {
  throw new Error(
    `docs/CONFIGURATION.md must document the Compose image default ${composeDefault}.`,
  );
}

for (const check of releaseGuidanceChecks) {
  for (const path of check.paths) {
    if (check.pattern.test(publicGuidance.get(path))) {
      throw new Error(`${check.message}\nFound in ${path}.`);
    }
  }
}

console.log(`Publication hygiene passed for ${tracked.length} tracked files.`);
