import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { CurateRepository } from './repository.mjs';
import { groupPhotos } from './grouping.mjs';
import { candidateGroups } from './candidate.mjs';

// Read-only worker: source/projection writes stay on the server's existing
// SQLite connection. One short WAL read snapshot gives the rebuild coherent
// rows and constraints; no credentials or raw enrichment records cross threads.
const db = new DatabaseSync(workerData.path, { readOnly: true });
try {
  db.exec('BEGIN');
  const store = new CurateRepository({ db });
  const generation = store.generation(),
    rows = workerData.candidate ? store.candidateRows() : store.pending(),
    separations = store.separations();
  db.exec('COMMIT');
  const result = workerData.candidate
    ? candidateGroups(rows, { stacks: workerData.stacks, separations, ranks: workerData.ranks })
    : groupPhotos(rows, { stacks: workerData.stacks, separations });
  parentPort.postMessage({ generation, ...result });
} finally {
  db.close();
}
