import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CurateRetryStore, RETRY_SCHEMA, RETRY_LIMITS } from '../../src/curate/retry-store.mjs';

const entry = id => ({ id, rows: { photo: { partner: 1 } }, coverage: { photo: { returned: 50, limit: 50, outside: 49 } },
  errors: { partner: { code: 'similarity_embedding_missing', attempts: 1, retryAt: 900000 } }, retryAt: 0, failures: 0, admittedAt: 0 });
const summary = { done: 1, failedReferences: 1, problemCodes: ['similarity_embedding_missing'], eligibleAt: 900000, retryAt: 900000 };

test('parked checkpoints enforce count, per-record and total byte limits without evicting evidence', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close()); db.exec(RETRY_SCHEMA);
  const store = new CurateRetryStore(db, 'connection', { ...RETRY_LIMITS, records: 2 });
  assert.equal(store.save(entry('a'), summary), true); assert.equal(store.save(entry('b'), summary), true);
  assert.equal(store.save(entry('c'), summary), false);
  const original = store.read('a'), bytes = store.bytes;
  store.limits = { ...store.limits, bytes };
  assert.equal(store.save({ ...entry('a'), coverage: { photo: 'x'.repeat(1000) } }, summary), false);
  assert.deepEqual(store.read('a'), original); assert.equal(store.bytes, bytes);
  store.limits = { ...RETRY_LIMITS, recordBytes: 1 };
  assert.equal(store.save(entry('a'), summary), false);
  const reopened = new CurateRetryStore(db, 'connection');
  assert.deepEqual(reopened.read('a'), original); assert.equal(reopened.bytes, bytes);
  assert.equal(reopened.records.get('a').done, 1); assert.equal(reopened.records.get('a').rows, undefined);
  assert.equal(reopened.prune(new Set(['a'])), 1); assert.equal(reopened.records.size, 1);
  const changed = new CurateRetryStore(db, 'changed');
  assert.equal(changed.records.size, 0); assert.equal(changed.bytes, 0); assert.equal(changed.read('a'), null);
});
