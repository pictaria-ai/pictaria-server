import { mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A separate SQLite file is an OS-released lifetime mutex, not application
// state. Keeping the transaction off the main database lets ordinary readers,
// writes and backups continue. Never unlink this file: that could create two
// lock inodes. SQLite releases ownership on exit/crash without PID guessing.
export function acquireServerOwner(databasePath) {
  const path = resolve(databasePath);
  mkdirSync(dirname(path), { recursive: true });
  let canonical;
  try { canonical = realpathSync(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    canonical = resolve(realpathSync(dirname(path)), basename(path));
  }
  const db = new DatabaseSync(`${canonical}.server-owner.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    return { close: () => db.close() };
  } catch {
    db.close();
    throw new Error('Cannot claim the Pictaria database. Another server may already be using it; stop that server before starting this one.');
  }
}
