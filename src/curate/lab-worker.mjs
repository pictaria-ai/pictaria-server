import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { timeGroups } from '../../public/curate/stacking-model.js';
import { CurateRepository } from './repository.mjs';
import { labPeopleEvidence, labRecognizedIds } from './lab-evidence.mjs';

// Only cached evidence crosses this boundary; no credentials or provider calls.
const db = new DatabaseSync(workerData.path, { readOnly: true });
try {
  db.exec('BEGIN');
  const store = new CurateRepository({ db });
  const rows = db.prepare(`SELECT p.asset_id id,p.captured_ms time,
    p.recognized_count recognizedCount,p.availability,pr.configuration_id,
    CASE WHEN length(json_extract(p.evidence_json,'$.recognition'))<=4096
      THEN json_extract(p.evidence_json,'$.recognition') ELSE NULL END recognition,
    json_extract(pr.normalized_output_json,'$.people_count') people_count,
    json_extract(pr.normalized_output_json,'$.has_people') has_people,
    json_type(pr.normalized_output_json,'$.has_people') people_type,
    substr(a.original_path,-512) filename,
    CASE WHEN length(json_extract(p.evidence_json,'$.image.thumbhash'))<=128
      THEN json_extract(p.evidence_json,'$.image.thumbhash') ELSE NULL END thumbhash
    FROM curate_photos p JOIN assets a ON a.asset_id=p.asset_id
    LEFT JOIN latest_success ls ON ls.asset_id=p.asset_id
    LEFT JOIN processing_runs pr ON pr.id=ls.run_id
    WHERE p.state='undecided' LIMIT 50001`).all();
  if (rows.length > 50000) throw Error('The stacking lab supports up to 50,000 pending photos. No partial view was created.');
  const unavailable = rows.filter((p) => p.availability === 'unavailable').length;
  const photos = rows.filter((p) => p.availability !== 'unavailable').map(({
    availability, configuration_id, has_people, people_count, people_type, recognition, ...p
  }) => ({
    ...p, filename: p.filename?.split('/').pop() || p.id,
    recognizedIds: labRecognizedIds(recognition),
    ...labPeopleEvidence({
      has_people: ['true', 'false'].includes(people_type) ? Boolean(has_people) : null,
      people_count,
    }, store.schema(configuration_id), configuration_id),
  }));
  db.exec('COMMIT');
  let groups = timeGroups(photos, workerData.gapMs);
  if (workerData.sort === 'newest') {
    groups = [...groups.filter((g) => g[0].time !== null).reverse(), ...groups.filter((g) => g[0].time === null)];
  }
  const result = { groups, photoCount: photos.length, unavailable };
  // Bound both retained evidence and the worker-to-server message.
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
    throw Error('This library exceeds the stacking lab’s snapshot size limit. No partial view was created.');
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
} finally { db.close(); }
