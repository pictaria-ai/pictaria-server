#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const ZERO_SHA = /^0+$/;
const SIGN_OFF = /^Signed-off-by:\s+.+\s+<[^<>\s@]+@[^<>\s]+>\s*$/m;

const base = process.env.DCO_BASE_SHA?.trim();
const head = process.env.DCO_HEAD_SHA?.trim() || 'HEAD';
const revision = base && !ZERO_SHA.test(base) ? `${base}..${head}` : null;

let commits;
try {
  const args = revision
    ? ['rev-list', '--reverse', revision]
    : ['rev-parse', '--verify', `${head}^{commit}`];
  commits = execFileSync('git', args, { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
} catch {
  console.error(`Unable to enumerate commits in ${revision ?? head}.`);
  process.exit(2);
}

if (commits.length === 0) {
  console.error(`No commits found in ${revision ?? head}.`);
  process.exit(2);
}

const missing = [];
for (const commit of commits) {
  const message = execFileSync('git', ['show', '-s', '--format=%B', commit], {
    encoding: 'utf8',
  });
  if (!SIGN_OFF.test(message)) missing.push(commit);
}

if (missing.length > 0) {
  console.error('The following commits are missing a valid Signed-off-by trailer:');
  for (const commit of missing) console.error(`  ${commit}`);
  console.error('Amend each commit with `git commit --amend -s` and update the branch.');
  process.exit(1);
}

console.log(`Verified DCO sign-off on ${commits.length} commit(s).`);
