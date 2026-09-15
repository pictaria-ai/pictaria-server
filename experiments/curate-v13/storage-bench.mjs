#!/usr/bin/env node
// Synthetic sizing of the chosen compact record shapes, not a production
// migration or memory benchmark. All SQLite files are temporary and removed.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const uuid = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const mib = n => Math.round(n / 1024 / 1024 * 100) / 100;
const measure = (photos, evidenceBytes, operations) => {
  const directory = mkdtempSync(join(tmpdir(), 'curate-storage-'));
  const db = new DatabaseSync(join(directory, 'size.sqlite'));
  try {
    db.exec(`CREATE TABLE evidence(id TEXT PRIMARY KEY, hot TEXT NOT NULL, provenance TEXT NOT NULL);
      CREATE TABLE groups(id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE cohorts(photo_id TEXT PRIMARY KEY, cohort_id TEXT NOT NULL);
      CREATE INDEX cohort_members ON cohorts(cohort_id);
      CREATE TABLE receipts(id TEXT PRIMARY KEY, body TEXT NOT NULL, completed_at INTEGER NOT NULL);
      CREATE INDEX receipt_expiry ON receipts(completed_at);`);
    const baseline = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    const evidence = db.prepare('INSERT INTO evidence VALUES(?,?,?)'), group = db.prepare('INSERT INTO groups VALUES(?,?)');
    const cohort = db.prepare('INSERT INTO cohorts VALUES(?,?)'), receipt = db.prepare('INSERT INTO receipts VALUES(?,?,?)');
    let hotBytes = 0, groupBytes = 0, receiptBytes = 0;
    db.exec('BEGIN');
    for (let i = 0; i < photos; i++) {
      const id = uuid(i), hot = JSON.stringify({ id, capturedMs: 1700000000000 + i * 1000, checksum: 'a'.repeat(44),
        inputHash: 'b'.repeat(64), peopleCount: 1, observedPersonCount: 1, personSetHash: 'c'.repeat(64), available: true, state: 'pending' });
      const detail = { producingConfig: 'd'.repeat(64), recognizedIds: [uuid(photos + 1)], completeness: 'unknown', padding: '' };
      detail.padding = 'x'.repeat(evidenceBytes - Buffer.byteLength(JSON.stringify(detail)));
      hotBytes += Buffer.byteLength(hot); evidence.run(id, hot, JSON.stringify(detail));
      cohort.run(id, uuid(photos + 100 + Math.floor(i / 30)));
    }
    for (let i = 0; i < photos; i += 30) {
      const ids = Array.from({ length: Math.min(30, photos - i) }, (_, j) => uuid(i + j));
      const body = JSON.stringify({ ids, contextIds: [], inputHash: 'd'.repeat(64), method: 1, reasons: ['time-candidate'], lineage: uuid(photos + 100 + i / 30) });
      groupBytes += Buffer.byteLength(body); group.run(uuid(i), body);
    }
    for (let i = 0; i < operations; i++) {
      const ids = Array.from({ length: Math.min(30, photos) }, (_, j) => uuid((i * 30 + j) % photos));
      const body = JSON.stringify({ payloadHash: 'e'.repeat(64), before: ids.map(id => ({ id, decisionTags: ['frame/reviewed'], revision: uuid(photos + i), scope: ['frame/eligible', 'frame/reviewed', 'frame/never-show'] })),
        outcomes: ids.map((id, j) => [id, j ? 'reviewed' : 'approve']), receipt: { id: uuid(i), ids, sync: 'complete' } });
      receiptBytes += Buffer.byteLength(body); receipt.run(uuid(i), body, i);
    }
    db.exec('COMMIT');
    const bytes = db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size;
    return { photos, evidenceBytesPerPhoto: evidenceBytes, operations,
      hotJsonMiB: mib(hotBytes), groupJsonMiB: mib(groupBytes), receiptJsonMiB: mib(receiptBytes),
      meanReceiptBytes: Math.round(receiptBytes / operations), sqliteMiB: mib(bytes), baselineSqliteMiB: mib(baseline) };
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
};

console.log(JSON.stringify({ scope: 'synthetic record sizing only; not final schema, retained JS memory, WAL, full Enrich data or full server',
  node: process.version, results: [measure(1000, 512, 100), measure(30000, 512, 3000), measure(30000, 4096, 3000)] }, null, 2));
