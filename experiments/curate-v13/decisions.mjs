// A SQLite contract spike, not a production schema/migration or HTTP API.
import { DatabaseSync } from 'node:sqlite';
import { fingerprint } from './grouping.mjs';
import { ACTION_RULES } from '../../src/enrich/reviewActions.mjs';

const RULES = { ...ACTION_RULES,
  frame_favorite: { add: ['frame/favorite'], remove: [] },
  frame_hide: { add: ['frame/never-show'], remove: ['frame/eligible'] },
};

export class DecisionSpike {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY, input TEXT NOT NULL, available INTEGER NOT NULL, tags TEXT NOT NULL, revision TEXT);
      CREATE TABLE IF NOT EXISTS scopes(id TEXT PRIMARY KEY, ids TEXT NOT NULL, advice TEXT);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, payload TEXT NOT NULL, before_state TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, revision TEXT NOT NULL, patch TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  seed(rows) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT INTO photos VALUES(?,?,?,?,NULL)');
      for (const row of rows) insert.run(row.id, row.input ?? 'v1', 1, JSON.stringify(row.tags ?? []));
    });
  }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  scope(id, ids, advice = null) {
    if (!ids.length || new Set(ids).size !== ids.length) throw Error('invalid scope');
    if (advice && (!Array.isArray(advice.keepers) || new Set(advice.keepers).size !== advice.keepers.length
      || advice.keepers.some(key => !ids.includes(key)))) throw Error('invalid advice');
    this.db.prepare('INSERT OR REPLACE INTO scopes VALUES(?,?,?)').run(id, JSON.stringify([...ids].sort()), advice ? JSON.stringify(advice) : null);
  }
  photo(id) { return this.db.prepare('SELECT * FROM photos WHERE id=?').get(id); }
  snapshot(scopeId) {
    const scope = this.db.prepare('SELECT * FROM scopes WHERE id=?').get(scopeId);
    if (!scope) throw Error('missing scope');
    const ids = JSON.parse(scope.ids);
    const photos = ids.map(id => this.photo(id));
    if (photos.some(p => !p)) throw Error('missing photo');
    const material = photos.map(p => ({ id: p.id, input: p.input, available: p.available, revision: p.revision,
      decisionTags: JSON.parse(p.tags).filter(t => ['frame/eligible', 'frame/favorite', 'frame/reviewed', 'frame/never-show'].includes(t)).sort() }));
    return { scopeId, ids, material: fingerprint(material), advice: scope.advice ? fingerprint(JSON.parse(scope.advice)) : null };
  }
  apply({ requestId, snapshot, mode = 'manual', outcomes }, afterWrite = () => {}) {
    if (!requestId || !['manual', 'advice'].includes(mode)) throw Error('invalid operation');
    const payload = fingerprint({ snapshot, mode, outcomes });
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM operations WHERE id=?').get(requestId);
      if (old) {
        if (old.payload !== payload) throw Error('request ID reused');
        return JSON.parse(old.receipt);
      }
      const current = this.snapshot(snapshot.scopeId);
      if (current.material !== snapshot.material || fingerprint(current.ids) !== fingerprint(snapshot.ids)
        || (mode === 'advice' && (!current.advice || current.advice !== snapshot.advice))) throw Error('conflict');
      if (fingerprint(Object.keys(outcomes).sort()) !== fingerprint(current.ids)
        || Object.values(outcomes).some(action => !Object.hasOwn(RULES, action))) throw Error('incomplete outcomes');
      if (mode === 'advice') {
        const advice = JSON.parse(this.db.prepare('SELECT advice FROM scopes WHERE id=?').get(current.scopeId).advice);
        if (current.ids.some(id => outcomes[id] !== (advice.keepers.includes(id) ? 'approve' : 'reviewed'))) throw Error('outcomes differ from advice');
      }
      const before = current.ids.map(id => ({ ...this.photo(id), scope: [...RULES[outcomes[id]].add, ...RULES[outcomes[id]].remove] }));
      if (before.some(p => !p.available)) throw Error('unavailable');
      for (const row of before) {
        const rule = RULES[outcomes[row.id]], tags = new Set(JSON.parse(row.tags));
        rule.remove.forEach(t => tags.delete(t)); rule.add.forEach(t => tags.add(t));
        this.write(row.id, [...tags].sort(), requestId, row.scope);
        afterWrite(row.id); // fault-injection seam, never used by runtime code
      }
      const receipt = { requestId, ids: current.ids, sync: 'pending' };
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(requestId, payload, JSON.stringify(before), JSON.stringify(receipt));
      return receipt;
    });
  }
  write(id, tags, revision, scope) {
    const previous = this.db.prepare('SELECT patch FROM outbox WHERE id=?').get(id);
    const patch = { ...(previous ? JSON.parse(previous.patch) : {}) };
    for (const tag of scope) patch[tag] = tags.includes(tag);
    this.db.prepare('UPDATE photos SET tags=?, revision=? WHERE id=?').run(JSON.stringify(tags), revision, id);
    this.db.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?)').run(id, revision, JSON.stringify(patch));
  }
  undo(requestId, target) {
    if (!requestId) throw Error('invalid operation');
    const payload = fingerprint({ undo: target });
    return this.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM operations WHERE id=?').get(requestId);
      if (prior) { if (prior.payload !== payload) throw Error('request ID reused'); return JSON.parse(prior.receipt); }
      const operation = this.db.prepare('SELECT * FROM operations WHERE id=?').get(target);
      if (!operation) throw Error('unknown operation');
      const before = JSON.parse(operation.before_state), current = before.map(p => ({ ...this.photo(p.id), scope: p.scope }));
      if (current.some(p => !p || !p.available || p.revision !== target)) throw Error('undo conflict');
      before.forEach((row, index) => {
        const previous = new Set(JSON.parse(row.tags)), now = new Set(JSON.parse(current[index].tags));
        for (const tag of row.scope) { if (previous.has(tag)) now.add(tag); else now.delete(tag); }
        this.write(row.id, [...now].sort(), requestId, row.scope);
      });
      const receipt = { requestId, undoes: target, sync: 'pending' };
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(requestId, payload, JSON.stringify(current), JSON.stringify(receipt));
      return receipt;
    });
  }
  pending() { return this.db.prepare('SELECT * FROM outbox ORDER BY id').all().map(r => ({ ...r, patch: JSON.parse(r.patch) })); }
  acknowledge(id, revision) { return this.db.prepare('DELETE FROM outbox WHERE id=? AND revision=?').run(id, revision).changes > 0; }
}
