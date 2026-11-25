import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');

test('the Docker Node tag matches .node-version and retains a pinned digest', () => {
  const version = read('.node-version').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, '.node-version must pin an exact release');
  const base = read('Dockerfile').match(/^FROM node:(\d+\.\d+\.\d+)-alpine[\d.]+@sha256:([a-f0-9]{64})$/m);
  assert.ok(base, 'Docker must pin an exact Node Alpine tag and SHA-256 digest');
  assert.equal(base[1], version, 'Docker and .node-version must use the same Node release');
});

test('all setup-node workflows use the shared .node-version file', () => {
  let setups = 0;
  for (const name of readdirSync(new URL('.github/workflows/', root))) {
    if (!/\.ya?ml$/.test(name)) continue;
    const workflow = read(`.github/workflows/${name}`);
    assert.doesNotMatch(workflow, /^\s*node-version:/m, `${name} must not duplicate the Node version`);
    const count = [...workflow.matchAll(/uses: actions\/setup-node@/g)].length;
    const files = [...workflow.matchAll(/^\s*node-version-file: \.node-version\s*$/gm)].length;
    assert.equal(files, count, `${name}: every setup-node step must use .node-version`);
    setups += count;
  }
  assert.ok(setups > 0, 'expected Node setup in the workflows');
});
