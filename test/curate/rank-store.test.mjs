import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CurateRankStore, RANK_SCHEMA, rankReader } from '../../src/curate/rank-store.mjs';

test('durable rank storage respects bounds and never evicts unchanged evidence to make room', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(RANK_SCHEMA);
  t.after(() => db.close());
  const store = new CurateRankStore(db, 'connection', { records: 2, recordBytes: 100, bytes: 100 });
  const entry = (id) => ({ id, rows: { a: { b: 0 } }, coverage: {} });
  assert.equal(store.save(entry('a'), 1), true);
  assert.equal(store.save(entry('b'), 2), true);
  assert.equal(store.save(entry('c'), 3), false);
  assert.equal(store.save({ ...entry('a'), rows: { extra: 'x'.repeat(100) } }, 4), false);
  assert.deepEqual(rankReader(db, 'connection')('a').rows, { a: { b: 0 } });
  assert.equal(rankReader(db, 'different-connection')('a'), null);
  assert.equal(store.prune(new Set(['a'])), 1);
  assert.equal(store.save(entry('c'), 5), true);
  assert.equal(store.records.size, 2);
  assert.equal(new CurateRankStore(db, 'connection').records.size, 2);
  assert.equal(new CurateRankStore(db, 'different-connection').records.size, 0);
});

test('obsolete rank cleanup is bounded per pass', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(RANK_SCHEMA);
  t.after(() => db.close());
  const store = new CurateRankStore(db, 'connection');
  for (let i = 0; i < 200; i++) store.save({ id: String(i), rows: {}, coverage: {} }, i);
  assert.equal(store.prune(new Set()), 128);
  assert.equal(store.records.size, 72);
  assert.equal(store.prune(new Set()), 72);
  assert.equal(store.bytes, 0);
});

test('incomplete outcomes retain only a problem code and never supply grouping evidence', t => {
  const db = new DatabaseSync(':memory:'); db.exec(RANK_SCHEMA); t.after(() => db.close());
  const store = new CurateRankStore(db, 'connection');
  assert.equal(store.save({ id: 'failed', problemCode: 'similarity_embedding_missing',
    rows: { private: { partial: 1 } }, coverage: { private: {} } }, 1), true);
  assert.deepEqual(store.read('failed'), { problemCode: 'similarity_embedding_missing' });
  assert.equal(rankReader(db, 'connection')('failed'), null);
  const restarted = new CurateRankStore(db, 'connection');
  assert.equal(restarted.problem('failed'), 'similarity_embedding_missing');
  restarted.prune(new Set()); assert.equal(restarted.problems.size, 0);
});
