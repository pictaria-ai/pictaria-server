import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireServerOwner } from '../../src/ai/owner.mjs';
import { Repository } from '../../src/enrich/repository.mjs';

const ownerModule = new URL('../../src/ai/owner.mjs', import.meta.url).href;
test('exclusive server ownership blocks other processes, allows repository readers/writes, and releases on crash', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pictaria-owner-'));
  const path = join(dir, 'enrichment.sqlite');
  let child, owner, repo;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    owner?.close(); repo?.close(); rmSync(dir, { recursive: true, force: true });
  });
  repo = new Repository(path); repo.initSchema();
  child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireServerOwner} from ${JSON.stringify(ownerModule)};
    const owner=acquireServerOwner(process.argv[1]);process.send('owned');setInterval(()=>{},1000);`, path],
  { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  assert.deepEqual(await once(child, 'message'), ['owned', undefined]);
  assert.throws(() => acquireServerOwner(path), /Another server/);
  const alias = join(dir, 'alias.sqlite'); symlinkSync(path, alias);
  assert.throws(() => acquireServerOwner(alias), /Another server/);
  repo.db.exec('CREATE TABLE owner_test(value TEXT); INSERT INTO owner_test VALUES(\'read-write\')');
  assert.equal(repo.db.prepare('SELECT value FROM owner_test').get().value, 'read-write');
  child.kill('SIGKILL'); await once(child, 'exit');
  owner = acquireServerOwner(path);
  assert.throws(() => acquireServerOwner(path), /Another server/);
});
