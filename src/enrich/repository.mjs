import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { addColumnIfMissing, migrateDatabase, tableExists } from '../migrations.mjs';
import { preparePrivateDatabasePath, restrictPrivateDatabaseModes } from '../privateDatabase.mjs';
import { sanitizeDiagnostic } from '../diagnostics.mjs';
import { validateAssetBatch } from './assetBatch.mjs';
import { ACTION_RULES } from './reviewActions.mjs';

const MAX_NORMALIZED_OUTPUT_BYTES = 64 * 1024;
const MAX_JOB_RUNS = 100;
const MAX_JOB_LOG_ENTRIES = 500;
const MAX_JOB_LOG_BYTES = 256 * 1024;
const MAX_PENDING_SYNC_ASSET_REFS = 10000;
const MAX_DEAD_SYNC_JOBS = 100;
const MAX_SYNC_JOB_ACTION_BYTES = 32;
const MAX_SYNC_JOB_TIMESTAMP_BYTES = 64;
const MAX_SAFE_SQLITE_INTEGER = Number.MAX_SAFE_INTEGER;
export const MAX_SYNC_JOB_ASSET_IDS_BYTES = 512 * 1024;
export const MAX_SYNC_JOB_TAGS_BYTES = 4 * 1024;
const MAX_SYNC_JOB_DIAGNOSTIC_BYTES = 4 * 1024;
const MAX_MANUAL_OVERRIDE_HISTORY_ROWS = 100000;
const MANUAL_OVERRIDE_PRUNE_INTERVAL_ROWS = 10000;
export const ENRICH_QUEUE_MAX_ITEMS_PER_OWNER = 100;
export const ENRICH_QUEUE_MAX_ITEMS_GLOBAL = 100;
export const ENRICH_QUEUE_MAX_TOTAL_BYTES = 512 * 1024;
// Real 500-city multilingual location groups encode below 64 KiB, while the
// distinct item ceiling prevents one request from consuming the whole queue.
export const ENRICH_QUEUE_MAX_ITEM_BYTES = 64 * 1024;
export const ENRICH_QUEUE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const ENRICH_QUEUE_DEFAULT_PAGE_SIZE = 50;
export const ENRICH_QUEUE_MAX_PAGE_SIZE = 100;

// Local source of truth for enrichment runs, tags, and review decisions.
// Uses the same SQLite schema as the Python reference implementation, so an
// existing enrichment database opens unchanged.

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');

// These read-only performance indexes intentionally run AFTER numbered schema
// migrations. Some pre-v1 databases lack the modern timestamp/id columns until
// migration 1 rebuilds them, so putting these in schema.sql would make its
// migration-time base-schema exec fail before the rebuild can happen. Indexes
// are backward-compatible metadata, not a persisted-data contract change.
const ACTIVITY_HISTORY_INDEXES = [
  {
    table: 'processing_runs',
    columns: ['started_at', 'id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_processing_runs_started_at ON processing_runs(started_at DESC, id DESC)',
  },
  {
    table: 'processing_runs',
    columns: ['provider', 'started_at', 'id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_processing_runs_provider_started_at ON processing_runs(provider, started_at DESC, id DESC)',
  },
  {
    table: 'processing_runs',
    columns: ['model', 'started_at', 'id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_processing_runs_model_started_at ON processing_runs(model, started_at DESC, id DESC)',
  },
  {
    table: 'manual_overrides',
    columns: ['created_at', 'id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_manual_overrides_created_at ON manual_overrides(created_at DESC, id DESC)',
  },
  {
    table: 'job_runs',
    columns: ['finished_at', 'id'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_job_runs_finished_at ON job_runs(finished_at DESC, id DESC)',
  },
  {
    table: 'referee_groups',
    columns: ['refereed_at', 'group_key'],
    sql: 'CREATE INDEX IF NOT EXISTS idx_referee_groups_refereed_at ON referee_groups(refereed_at DESC, group_key DESC)',
  },
];

export function utcNow() {
  return new Date().toISOString();
}

const SYNC_JOB_ROW_PROJECTION = `
  CAST(id AS TEXT) AS storage_id,
  CASE
    WHEN typeof(id) = 'integer' AND id BETWEEN 1 AND ${MAX_SAFE_SQLITE_INTEGER}
    THEN id
    ELSE NULL
  END AS id,
  CASE
    WHEN typeof(action) = 'text'
      AND length(CAST(action AS BLOB)) <= ${MAX_SYNC_JOB_ACTION_BYTES}
    THEN action
    ELSE NULL
  END AS action,
  CASE
    WHEN typeof(asset_ids_json) = 'text'
      AND length(CAST(asset_ids_json AS BLOB)) <= ${MAX_SYNC_JOB_ASSET_IDS_BYTES}
    THEN asset_ids_json
    ELSE NULL
  END AS asset_ids_json,
  CASE
    WHEN typeof(add_tags_json) = 'text'
      AND length(CAST(add_tags_json AS BLOB)) <= ${MAX_SYNC_JOB_TAGS_BYTES}
    THEN add_tags_json
    ELSE NULL
  END AS add_tags_json,
  CASE
    WHEN typeof(remove_tags_json) = 'text'
      AND length(CAST(remove_tags_json AS BLOB)) <= ${MAX_SYNC_JOB_TAGS_BYTES}
    THEN remove_tags_json
    ELSE NULL
  END AS remove_tags_json,
  CASE
    WHEN typeof(attempts) = 'integer'
      AND attempts BETWEEN 0 AND ${MAX_SAFE_SQLITE_INTEGER}
    THEN attempts
    ELSE NULL
  END AS attempts,
  CASE
    WHEN last_error IS NULL THEN NULL
    WHEN typeof(last_error) = 'text'
      AND length(CAST(last_error AS BLOB)) <= ${MAX_SYNC_JOB_DIAGNOSTIC_BYTES}
    THEN last_error
    ELSE 'Stored diagnostic exceeded its recovery limit.'
  END AS last_error,
  CASE
    WHEN typeof(created_at) = 'text'
      AND length(CAST(created_at AS BLOB)) <= ${MAX_SYNC_JOB_TIMESTAMP_BYTES}
    THEN created_at
    ELSE NULL
  END AS created_at,
  CASE
    WHEN dead_at IS NULL THEN NULL
    WHEN typeof(dead_at) = 'text'
      AND length(CAST(dead_at AS BLOB)) <= ${MAX_SYNC_JOB_TIMESTAMP_BYTES}
    THEN dead_at
    ELSE 'invalid'
  END AS dead_at
`;

function syncJobFromRow(row) {
  const numericId = Number(row.id);
  const storageId = typeof row.storage_id === 'string' ? row.storage_id : '';
  const id = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : storageId;
  const attempts = Number(row.attempts);
  const safe = {
    id,
    action: 'invalid',
    assetIds: [],
    add: [],
    remove: [],
    attempts: Number.isSafeInteger(attempts) && attempts >= 0 ? attempts : 0,
    lastError: typeof row.last_error === 'string' ? row.last_error : null,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    deadAt: typeof row.dead_at === 'string' ? row.dead_at : null,
    invalidReason: null,
  };
  try {
    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new Error('invalid row identifier');
    }
    if (!Object.hasOwn(ACTION_RULES, row.action)) {
      throw new Error('unsupported decision action');
    }
    if (!Number.isSafeInteger(attempts) || attempts < 0) {
      throw new Error('invalid attempt count');
    }
    const assetIds = parseSyncJobArray(row.asset_ids_json, 'asset ids');
    if (new Set(assetIds).size !== assetIds.length) {
      throw new Error('duplicate asset identifiers');
    }
    validateAssetBatch(assetIds, {
      code: 'invalid_restored_sync_job',
      max: MAX_PENDING_SYNC_ASSET_REFS,
    });
    const add = parseSyncJobTags(row.add_tags_json, 'add tags');
    const remove = parseSyncJobTags(row.remove_tags_json, 'remove tags');
    if (add.some((tag) => remove.includes(tag))) {
      throw new Error('the same frame tag cannot be added and removed');
    }
    const expected = ACTION_RULES[row.action];
    // Older queued decisions may contain only a subset of today's canonical
    // rule (for example, before reviewed-tag cleanup was added). Preserve
    // those compatible jobs, but never let restored state reverse an action.
    if (!isStringSubset(add, expected.add) || !isStringSubset(remove, expected.remove)) {
      throw new Error('stored frame tags do not match the decision action');
    }
    validateSyncJobTimestamp(row.created_at, 'created timestamp');
    if (row.dead_at !== null) {
      validateSyncJobTimestamp(row.dead_at, 'dead-letter timestamp');
    }
    return {
      ...safe,
      action: row.action,
      assetIds,
      add,
      remove,
    };
  } catch (error) {
    return {
      ...safe,
      invalidReason: `Malformed restored review sync job: ${sanitizeDiagnostic(
        error instanceof Error ? error.message : error,
      )}`,
    };
  }
}

function isStringSubset(actual, expected) {
  return actual.every((value) => expected.includes(value));
}

function parseSyncJobArray(value, label) {
  if (typeof value !== 'string') {
    throw new Error(`${label} are missing or exceed the recovery limit`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} contain invalid JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be an array`);
  }
  return parsed;
}

function parseSyncJobTags(value, label) {
  const tags = parseSyncJobArray(value, label);
  if (tags.length > 4
    || tags.some((tag) => typeof tag !== 'string' || !/^frame\/(?:eligible|favorite|never-show|reviewed)$/.test(tag))
    || new Set(tags).size !== tags.length) {
    throw new Error(`${label} contain invalid frame tags`);
  }
  return tags;
}

function validateSyncJobTimestamp(value, label) {
  if (typeof value !== 'string' || value.length > 64) {
    throw new Error(`${label} is invalid`);
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`${label} is invalid`);
  }
}

function queueItemFromRow(row) {
  return {
    id: Number(row.id),
    title: row.title,
    filters: JSON.parse(row.filters_json),
    estimatedCount: row.estimated_count === null ? null : Number(row.estimated_count),
    requestedAt: row.requested_at,
  };
}

function queueItemBytes({ title, filtersJson, estimatedCount }) {
  const payload = `{"title":${JSON.stringify(title)},"filters":${filtersJson},"estimatedCount":${
    estimatedCount === null ? 'null' : String(estimatedCount)
  }}`;
  return Buffer.byteLength(payload, 'utf8');
}

function enrichQueueError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

// Migration 1 is the pre-user_version era: every probe-based fixup this
// repository ever applied, verbatim. All idempotent — a database already in
// the current shape passes through unchanged and just gains the stamp.
const ENRICH_MIGRATIONS = [
  {
    version: 1,
    up(db, { schemaSql, hadReviewList, hadCaptionIndex }) {
      // The seeds below insert into tables this same upgrade creates.
      db.exec(schemaSql);
      migrateManualOverrides(db, schemaSql);
      // One-time grandfather when the review-list concept first arrives:
      // every already-enriched photo behaves as if it had been sent to
      // Curate, which is exactly what the pre-review-list behavior was.
      if (!hadReviewList) {
        db.prepare(
          `
          INSERT OR IGNORE INTO review_list (asset_id, source, added_at)
          SELECT DISTINCT asset_id, 'migration', ?
          FROM processing_runs WHERE status = 'succeeded'
          `,
        ).run(utcNow());
      }
      // One-time backfill when the caption index first appears: index each
      // photo's latest successful caption. New runs write through afterwards.
      if (!hadCaptionIndex) {
        db.exec(`
          INSERT INTO caption_index (asset_id, caption, short_caption)
          SELECT
            pr.asset_id,
            COALESCE(json_extract(pr.normalized_output_json, '$.caption'), ''),
            COALESCE(json_extract(pr.normalized_output_json, '$.short_caption'), '')
          FROM processing_runs pr
          JOIN (
            SELECT asset_id, MAX(id) AS id
            FROM processing_runs
            WHERE status = 'succeeded'
            GROUP BY asset_id
          ) latest ON latest.id = pr.id
        `);
      }
      addColumnIfMissing(db, 'job_runs', 'log_json', 'TEXT'); // predates per-run logs
      addColumnIfMissing(db, 'assets', 'thumbhash', 'TEXT'); // near-dup grouping visuals
      addColumnIfMissing(db, 'assets', 'duplicate_id', 'TEXT');
      addColumnIfMissing(db, 'referee_picks', 'subject_group', 'INTEGER'); // referee-v2 splitting
      addColumnIfMissing(db, 'referee_groups', 'duration_ms', 'INTEGER'); // activity timing
    },
  },
  {
    version: 2,
    up(db) {
      // Review-sync dead-letter state: parked jobs keep their history but stop
      // blocking the head of the queue.
      addColumnIfMissing(db, 'pending_sync_jobs', 'dead_at', 'TEXT');
    },
  },
  {
    version: 3,
    up(db, { schemaSql }) {
      // latest_success arrives: project each asset's latest succeeded run
      // into the review-path columns (see schema.sql). The projection runs
      // in JS because exclusion_reasons must shrink to {tag, confidence}
      // pairs — beyond what SQL json_extract expresses. New runs write
      // through afterwards.
      db.exec(schemaSql); // the table (and the backfill's index) must exist before the base-schema exec
      const insert = prepareLatestSuccessUpsert(db);
      const rows = db
        .prepare(
          `
          SELECT pr.asset_id, pr.id, pr.model, pr.taxonomy_version, pr.finished_at, pr.normalized_output_json
          FROM processing_runs pr
          JOIN (
            SELECT asset_id, MAX(id) AS id
            FROM processing_runs
            WHERE status = 'succeeded'
            GROUP BY asset_id
          ) latest ON latest.id = pr.id
          WHERE pr.normalized_output_json IS NOT NULL
          `,
        )
        .all();
      for (const row of rows) {
        let output = {};
        try {
          output = JSON.parse(row.normalized_output_json) ?? {};
        } catch {
          output = {};
        }
        runLatestSuccessUpsert(insert, {
          assetId: row.asset_id,
          runId: row.id,
          model: row.model,
          taxonomyVersion: row.taxonomy_version,
          finishedAt: row.finished_at,
          projection: reviewProjection(output),
        });
      }
    },
  },
  {
    version: 4,
    up(db) {
      // A targeted fetch that confirms an asset is gone from Immich stamps
      // it missing, so its old failure rows stop feeding the retry strip.
      addColumnIfMissing(db, 'assets', 'missing_since', 'TEXT');
    },
  },
  {
    version: 5,
    up(db) {
      // A human decision that enrichment should stop trying this photo.
      // Local-only: nothing is written to Immich, and display (frame/*) is
      // untouched. Unlike missing_since, upsertAsset never clears the stamp;
      // only an explicit restore does.
      addColumnIfMissing(db, 'assets', 'enrich_discarded_at', 'TEXT');
    },
  },
  {
    version: 6,
    up(db) {
      // Raw provider envelopes are neither a product record nor a useful
      // diagnostic. SQLite migrations are additive, so the legacy column
      // remains for compatibility but is cleared and never written again.
      // Keep only the newest normalized result per asset; older run metadata
      // remains available without carrying repeated payloads.
      addColumnIfMissing(db, 'processing_runs', 'raw_output_json', 'TEXT');
      addColumnIfMissing(db, 'processing_runs', 'normalized_output_json', 'TEXT');
      db.exec(`
        UPDATE processing_runs SET raw_output_json = NULL WHERE raw_output_json IS NOT NULL;
        UPDATE processing_runs
        SET normalized_output_json = NULL
        WHERE normalized_output_json IS NOT NULL
          AND id NOT IN (
            SELECT MAX(id) FROM processing_runs
            WHERE status = 'succeeded' AND normalized_output_json IS NOT NULL
            GROUP BY asset_id
          );
        DELETE FROM job_runs
        WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT ${MAX_JOB_RUNS});
      `);
    },
  },
];

// The review projection of a normalized output: exactly the fields the
// review path reads (reviewService/reviewBuckets), stored raw — thresholds
// and taxonomy policy apply at read time, so their changes never need a
// re-projection. exclusion_reasons keeps only {tag, confidence} pairs
// (tens of bytes) instead of the multi-KB full output.
function reviewProjection(output) {
  const quality = isPlainObject(output.quality) ? output.quality : {};
  const reasons = (Array.isArray(output.exclusion_reasons) ? output.exclusion_reasons : [])
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({ tag: entry.tag, confidence: entry.confidence }));
  return {
    shortCaption: typeof output.short_caption === 'string' ? output.short_caption : null,
    frameScore: finiteScore(quality.frame_worthy_score),
    aestheticScore: finiteScore(quality.aesthetic_score),
    needsReview: output.needs_review ? 1 : 0,
    exclusionReasonsJson: reasons.length > 0 ? JSON.stringify(reasons) : null,
  };
}

function prepareLatestSuccessUpsert(db) {
  return db.prepare(
    `
    INSERT OR REPLACE INTO latest_success (
      asset_id, run_id, model, taxonomy_version, finished_at,
      short_caption, frame_score, aesthetic_score, needs_review, exclusion_reasons_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );
}

function runLatestSuccessUpsert(statement, { assetId, runId, model, taxonomyVersion, finishedAt, projection }) {
  statement.run(
    assetId,
    runId,
    model,
    taxonomyVersion,
    finishedAt,
    projection.shortCaption,
    projection.frameScore,
    projection.aestheticScore,
    projection.needsReview,
    projection.exclusionReasonsJson,
  );
}

function finiteScore(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Older databases keyed manual_overrides on (asset_id, tag), which kept only
// the latest decision per asset. Migrate to the append-only shape.
function migrateManualOverrides(db, schemaSql) {
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('manual_overrides')")
    .all()
    .map((row) => row.name);
  if (columns.length === 0 || columns.includes('id')) {
    return;
  }
  // Runs inside the migration framework's per-migration transaction, so no
  // BEGIN/COMMIT here — a failure rolls back the whole migration.
  db.exec('ALTER TABLE manual_overrides RENAME TO manual_overrides_legacy');
  db.exec(schemaSql);
  db.exec(`
    INSERT INTO manual_overrides (asset_id, tag, action, reason, created_at)
    SELECT asset_id, tag, action, reason, created_at FROM manual_overrides_legacy
  `);
  db.exec('DROP TABLE manual_overrides_legacy');
}

export class Repository {
  constructor(databasePath) {
    this.databasePath = String(databasePath);
    preparePrivateDatabasePath(this.databasePath);
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    // Decisions, tags, and captions are personal data: keep the DB (and its
    // WAL/SHM sidecars) private to the server user even under a permissive
    // umask. Some filesystems reject chmod — warn and continue.
    restrictPrivateDatabaseModes(this.databasePath);
  }

  close() {
    this.db.close();
  }

  initSchema() {
    const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
    const result = migrateDatabase(this.db, {
      schema: schemaSql,
      migrations: ENRICH_MIGRATIONS,
      prepare: (db) => ({
        schemaSql,
        hadReviewList: tableExists(db, 'review_list'),
        hadCaptionIndex: tableExists(db, 'caption_index'),
      }),
    });
    for (const index of ACTIVITY_HISTORY_INDEXES) {
      // A few synthetic pre-v1 fixtures intentionally carry only the columns
      // needed by their historical feature. Keep those readable and let the
      // unified feed omit that unavailable source rather than failing boot.
      if (tableHasColumns(this.db, index.table, index.columns)) {
        this.db.exec(index.sql);
      }
    }
    return result;
  }

  backupTo(outputPath) {
    mkdirSync(dirname(String(outputPath)), { recursive: true });
    // Checkpoint the WAL so a plain file copy is a complete snapshot.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(this.databasePath, String(outputPath));
    return String(outputPath);
  }

  // Monotonic counter of writes to review-relevant state: assets, processing
  // runs (with caption_index + latest_success), asset_tags, review_list,
  // referee verdicts, manual overrides. ReviewService caches its assembled
  // rows against this, so EVERY method that writes any of those tables must
  // call #reviewStateChanged() — a missed bump means a stale Curate queue
  // after a decision. Queue/bookkeeping tables (pending_sync_jobs,
  // caption_writeback, enrich_queue, job_runs, immich_tag_map) deliberately
  // do not bump: none of them feeds review rows, and the caption-writeback
  // worker marks rows every few seconds. A bump inside a rolled-back
  // transaction only costs one spurious recompute.
  #generation = 0;

  // Reconcile pre-existing excess on the first decision after boot, then
  // prune only after another bounded block of audit inserts. The retained
  // contract is newest 100k rows plus every asset's newest decision; running
  // that full-table projection after every human gesture needlessly stalls
  // the one Node thread once a library reaches the retention window.
  #nextManualOverridePruneId = null;

  get generation() {
    return this.#generation;
  }

  #reviewStateChanged() {
    this.#generation += 1;
  }

  // Re-entrant: a transaction() call inside an open transaction() joins it —
  // the outermost call owns commit/rollback. Lets callers compose repository
  // methods (which guard their own writes) into one atomic unit.
  #inTransaction = false;

  transaction(work) {
    if (this.#inTransaction) {
      return work();
    }
    const manualOverridePruneIdBefore = this.#nextManualOverridePruneId;
    this.#inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      // The prune cadence is process-local, but its update occurs inside the
      // same composed transaction as the DELETE. Restore it whenever SQLite
      // rolls back so a failed outer write cannot postpone reconciliation.
      this.#nextManualOverridePruneId = manualOverridePruneIdBefore;
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  upsertAsset(asset) {
    this.#reviewStateChanged();
    const now = utcNow();
    const exif = asset.exifInfo ?? {};
    this.db
      .prepare(
        `
        INSERT INTO assets (
          asset_id, original_path, checksum, file_created_at, file_modified_at,
          width, height, mime_type, immich_updated_at, thumbhash, duplicate_id,
          first_seen_at, last_seen_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          original_path=excluded.original_path,
          checksum=excluded.checksum,
          file_created_at=excluded.file_created_at,
          file_modified_at=excluded.file_modified_at,
          width=excluded.width,
          height=excluded.height,
          mime_type=excluded.mime_type,
          immich_updated_at=excluded.immich_updated_at,
          thumbhash=COALESCE(excluded.thumbhash, assets.thumbhash),
          duplicate_id=COALESCE(excluded.duplicate_id, assets.duplicate_id),
          missing_since=NULL,
          last_seen_at=excluded.last_seen_at
        `,
      )
      .run(
        asset.id,
        asset.originalPath ?? null,
        asset.checksum ?? null,
        asset.fileCreatedAt ?? null,
        asset.fileModifiedAt ?? null,
        exif.exifImageWidth ?? asset.width ?? exif.imageWidth ?? null,
        exif.exifImageHeight ?? asset.height ?? exif.imageHeight ?? null,
        asset.mimeType ?? null,
        asset.updatedAt ?? null,
        asset.thumbhash ?? null,
        asset.duplicateId ?? null,
        now,
        now,
      );
  }

  // Visual descriptors (thumbhash + Immich duplicate group) for near-dup
  // burst grouping; backfilled from library pages for rows that predate the
  // columns, kept current by upsertAsset.
  updateAssetVisuals(assetId, { thumbhash = null, duplicateId = null }) {
    this.#reviewStateChanged();
    const result = this.db
      .prepare(
        `
        UPDATE assets
        SET thumbhash = COALESCE(?, thumbhash), duplicate_id = COALESCE(?, duplicate_id)
        WHERE asset_id = ?
        `,
      )
      .run(thumbhash, duplicateId, assetId);
    return Number(result.changes);
  }

  reviewListMissingThumbhashCount() {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM review_list rl
        JOIN assets a ON a.asset_id = rl.asset_id
        WHERE a.thumbhash IS NULL
        `,
      )
      .get();
    return Number(row?.count ?? 0);
  }

  recordProcessingRun({
    assetId,
    provider,
    model,
    promptVersion,
    taxonomyVersion,
    status,
    normalizedOutput = null,
    error = null,
  }) {
    this.#reviewStateChanged();
    const now = utcNow();
    const finishedAt = ['succeeded', 'failed', 'failed_infra', 'skipped'].includes(status) ? now : null;
    const result = this.db
      .prepare(
        `
        INSERT INTO processing_runs (
          asset_id, provider, model, model_version, prompt_version,
          taxonomy_version, status, started_at, finished_at, error,
          raw_output_json, normalized_output_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        assetId,
        provider,
        model,
        null,
        promptVersion,
        taxonomyVersion,
        status,
        now,
        finishedAt,
        error === null ? null : sanitizeDiagnostic(error),
        null,
        normalizedOutput === null ? null : boundedNormalizedOutput(normalizedOutput),
      );
    if (status === 'succeeded' && normalizedOutput !== null) {
      // The latest successful result is the product state. Preserve older
      // run metadata, but not a duplicate provider payload for every retry.
      this.db.prepare(`
        UPDATE processing_runs SET normalized_output_json = NULL
        WHERE asset_id = ? AND id <> ? AND normalized_output_json IS NOT NULL
      `).run(assetId, Number(result.lastInsertRowid));
      // The caption index tracks the latest successful run per asset.
      this.db.prepare('DELETE FROM caption_index WHERE asset_id = ?').run(assetId);
      this.db
        .prepare('INSERT INTO caption_index (asset_id, caption, short_caption) VALUES (?, ?, ?)')
        .run(
          assetId,
          typeof normalizedOutput.caption === 'string' ? normalizedOutput.caption : '',
          typeof normalizedOutput.short_caption === 'string' ? normalizedOutput.short_caption : '',
        );
      // latest_success mirrors the same latest-run contract as a queryable
      // projection; a re-enrichment replaces the row (new run id is always
      // the newest).
      runLatestSuccessUpsert(prepareLatestSuccessUpsert(this.db), {
        assetId,
        runId: Number(result.lastInsertRowid),
        model,
        taxonomyVersion,
        finishedAt,
        projection: reviewProjection(normalizedOutput),
      });
    }
    return Number(result.lastInsertRowid);
  }

  hasSuccessfulRun({ assetId, provider, model, promptVersion, taxonomyVersion }) {
    const row = this.db
      .prepare(
        `
        SELECT 1 FROM processing_runs
        WHERE asset_id = ? AND provider = ? AND model = ?
          AND prompt_version = ? AND taxonomy_version = ? AND status = 'succeeded'
        LIMIT 1
        `,
      )
      .get(assetId, provider, model, promptVersion, taxonomyVersion);
    return row !== undefined;
  }

  hasAnySuccessfulRun(assetId) {
    const row = this.db
      .prepare("SELECT 1 FROM processing_runs WHERE asset_id = ? AND status = 'succeeded' LIMIT 1")
      .get(assetId);
    return row !== undefined;
  }

  failureCount({ assetId, provider, model, promptVersion, taxonomyVersion }) {
    const row = this.db
      .prepare(
        `
        SELECT COUNT(*) AS count FROM processing_runs
        WHERE asset_id = ? AND provider = ? AND model = ?
          AND prompt_version = ? AND taxonomy_version = ? AND status = 'failed'
        `,
      )
      .get(assetId, provider, model, promptVersion, taxonomyVersion);
    return Number(row?.count ?? 0);
  }

  // Which of these assets would a run actually analyze? The batched mirror
  // of the runner's per-photo skip checks (any successful run when
  // skipAnySuccessful, the matching-config success otherwise, plus the
  // content-failure limit — 'failed_infra' rows never count). Used by
  // skip-aware slice resolution so capped slices collect photos that need
  // work; the runner still re-checks each photo at run time. Dropped ids
  // come back classified: `successful` feeds the Curate review-listing the
  // runner's skip path would have done, and `failureLimited` and
  // `discarded` keep the "fully covered" report honest. An asset that is
  // both successful and at the failure limit (or discarded) counts as
  // successful, matching the runner's check order.
  assetIdsNeedingWork(assetIds, { runKey, skipAnySuccessful = true, maxFailuresPerAsset = 0 }) {
    const { provider, model, promptVersion, taxonomyVersion } = runKey;
    const needy = new Set(assetIds.filter((id) => typeof id === 'string' && id));
    const successful = new Set();
    const failureLimited = new Set();
    const discarded = new Set();
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      // Human-discarded photos are dropped first and never run, but a
      // successful classification still wins below, matching the runner's
      // check order.
      for (const row of this.db
        .prepare(`SELECT asset_id FROM assets WHERE enrich_discarded_at IS NOT NULL AND asset_id IN (${marks})`)
        .all(...chunk)) {
        needy.delete(row.asset_id);
        discarded.add(row.asset_id);
      }
      if (skipAnySuccessful) {
        for (const row of this.db
          .prepare(`SELECT DISTINCT asset_id FROM processing_runs WHERE status = 'succeeded' AND asset_id IN (${marks})`)
          .all(...chunk)) {
          needy.delete(row.asset_id);
          successful.add(row.asset_id);
        }
      } else {
        for (const row of this.db
          .prepare(
            `SELECT DISTINCT asset_id FROM processing_runs
             WHERE status = 'succeeded' AND provider = ? AND model = ?
               AND prompt_version = ? AND taxonomy_version = ? AND asset_id IN (${marks})`,
          )
          .all(provider, model, promptVersion, taxonomyVersion, ...chunk)) {
          needy.delete(row.asset_id);
          successful.add(row.asset_id);
        }
      }
      if (maxFailuresPerAsset > 0) {
        for (const row of this.db
          .prepare(
            `SELECT asset_id FROM processing_runs
             WHERE status = 'failed' AND provider = ? AND model = ?
               AND prompt_version = ? AND taxonomy_version = ? AND asset_id IN (${marks})
             GROUP BY asset_id HAVING COUNT(*) >= ?`,
          )
          .all(provider, model, promptVersion, taxonomyVersion, ...chunk, maxFailuresPerAsset)) {
          needy.delete(row.asset_id);
          if (!successful.has(row.asset_id) && !discarded.has(row.asset_id)) {
            failureLimited.add(row.asset_id);
          }
        }
      }
    }
    // Successful wins over discarded, same as it wins over failure-limited:
    // a photo with data is covered, whatever else is true of it.
    for (const id of successful) {
      discarded.delete(id);
    }
    return { needy, successful, failureLimited, discarded };
  }

  // A targeted fetch confirmed these assets are gone from Immich (404 on
  // metadata). Stamped so their old failure rows stop feeding the retry
  // strip — without this, a deleted photo would sit in the stuck set
  // forever, and at the front of a capped window it would never rotate
  // (rotation rides on new failure rows, which a skipped photo never
  // writes). upsertAsset clears the stamp if the photo ever reappears.
  markAssetsMissing(assetIds) {
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return 0;
    }
    const now = utcNow();
    let marked = 0;
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      marked += this.db
        .prepare(`UPDATE assets SET missing_since = ? WHERE asset_id IN (${marks})`)
        .run(now, ...chunk).changes;
    }
    return marked;
  }

  // A human decision that enrichment should stop trying these photos.
  // Local-only: nothing is written to Immich, and display (frame/*) is
  // untouched — a discarded photo still shows on the frame if already
  // approved. Stamps only unstamped rows so the original
  // discard time survives a repeat click. The ids come from a client
  // snapshot of the stuck set, so eligibility is re-checked inside the
  // UPDATE itself: a photo with a successful run anywhere is refused
  // ("has data" beats a stale popup — it must not be quietly locked out
  // of future re-enrichment), as is one that isn't genuinely give-up-able
  // — marked missing from Immich (it left the stuck set; if it reappears
  // it should get fresh attempts, since the discard stamp deliberately
  // survives upsertAsset) or without a single content failure on record.
  // Refusals come back counted: `skippedSuccessful` for has-data,
  // `skippedNotStuck` for the rest.
  discardAssets(assetIds) {
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return { discarded: 0, skippedSuccessful: 0, skippedNotStuck: 0 };
    }
    const now = utcNow();
    let discarded = 0;
    let skippedSuccessful = 0;
    let skippedNotStuck = 0;
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      skippedSuccessful += Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM assets a
             WHERE a.asset_id IN (${marks}) AND a.enrich_discarded_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM processing_runs s
                 WHERE s.asset_id = a.asset_id AND s.status = 'succeeded'
               )`,
          )
          .get(...chunk)?.count ?? 0,
      );
      skippedNotStuck += Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM assets a
             WHERE a.asset_id IN (${marks}) AND a.enrich_discarded_at IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM processing_runs s
                 WHERE s.asset_id = a.asset_id AND s.status = 'succeeded'
               )
               AND (
                 a.missing_since IS NOT NULL
                 OR NOT EXISTS (
                   SELECT 1 FROM processing_runs f
                   WHERE f.asset_id = a.asset_id AND f.status = 'failed'
                 )
               )`,
          )
          .get(...chunk)?.count ?? 0,
      );
      discarded += this.db
        .prepare(
          `UPDATE assets SET enrich_discarded_at = ?
           WHERE asset_id IN (${marks}) AND enrich_discarded_at IS NULL
             AND missing_since IS NULL
             AND EXISTS (
               SELECT 1 FROM processing_runs f
               WHERE f.asset_id = assets.asset_id AND f.status = 'failed'
             )
             AND NOT EXISTS (
               SELECT 1 FROM processing_runs s
               WHERE s.asset_id = assets.asset_id AND s.status = 'succeeded'
             )`,
        )
        .run(now, ...chunk).changes;
    }
    return { discarded, skippedSuccessful, skippedNotStuck };
  }

  // The one door back in: clears the discard stamp so the photo re-enters
  // runs (and, while its failure history still qualifies, the stuck set).
  restoreAssets(assetIds) {
    if (!Array.isArray(assetIds) || assetIds.length === 0) {
      return 0;
    }
    let restored = 0;
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      restored += this.db
        .prepare(
          `UPDATE assets SET enrich_discarded_at = NULL
           WHERE asset_id IN (${marks}) AND enrich_discarded_at IS NOT NULL`,
        )
        .run(...chunk).changes;
    }
    return restored;
  }

  isAssetDiscarded(assetId) {
    const row = this.db
      .prepare('SELECT 1 FROM assets WHERE asset_id = ? AND enrich_discarded_at IS NOT NULL')
      .get(assetId);
    return row !== undefined;
  }

  discardedCount() {
    return Number(
      this.db
        .prepare('SELECT COUNT(*) AS count FROM assets WHERE enrich_discarded_at IS NOT NULL')
        .get()?.count ?? 0,
    );
  }

  // The reference list behind Settings → Discarded Photos and the popup's
  // restore section: discarded assets, newest discard first, each with
  // its most recent failure message (any status, any run key — the point is
  // "why did I discard this", not the current run key's view). Capped so
  // the two rendering surfaces stay bounded; callers pair it with
  // discardedCount() to report the true total.
  discardedAssets({ limit = 500 } = {}) {
    return this.db
      .prepare(
        `
        SELECT a.asset_id, a.original_path, a.file_created_at, a.enrich_discarded_at,
               f.error AS last_error, f.finished_at AS last_failed_at
        FROM assets a
        LEFT JOIN processing_runs f ON f.id = (
          SELECT MAX(id) FROM processing_runs
          WHERE asset_id = a.asset_id AND status IN ('failed', 'failed_infra')
        )
        WHERE a.enrich_discarded_at IS NOT NULL
        ORDER BY a.enrich_discarded_at DESC, a.asset_id
        LIMIT ?
        `,
      )
      .all(limit)
      .map((row) => ({
        assetId: row.asset_id,
        originalPath: row.original_path ?? null,
        fileCreatedAt: row.file_created_at ?? null,
        discardedAt: row.enrich_discarded_at,
        lastError: row.last_error ?? null,
        lastFailedAt: row.last_failed_at ?? null,
      }));
  }

  // Popup fuel for the stuck strip: per-asset context for the given ids —
  // filename and capture date from the asset row, plus the newest
  // content-failure message under this run key (the message that put the
  // photo in the stuck set). Returned in the input order.
  assetFailureDetails(assetIds, { runKey }) {
    const { provider, model, promptVersion, taxonomyVersion } = runKey;
    const byId = new Map();
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      for (const row of this.db
        .prepare(
          `
          SELECT a.asset_id, a.original_path, a.file_created_at,
                 f.error AS last_error, f.finished_at AS last_failed_at
          FROM assets a
          LEFT JOIN processing_runs f ON f.id = (
            SELECT MAX(id) FROM processing_runs
            WHERE asset_id = a.asset_id AND status = 'failed'
              AND provider = ? AND model = ?
              AND prompt_version = ? AND taxonomy_version = ?
          )
          WHERE a.asset_id IN (${marks})
          `,
        )
        .all(provider, model, promptVersion, taxonomyVersion, ...chunk)) {
        byId.set(row.asset_id, {
          assetId: row.asset_id,
          originalPath: row.original_path ?? null,
          fileCreatedAt: row.file_created_at ?? null,
          lastError: row.last_error ?? null,
          lastFailedAt: row.last_failed_at ?? null,
        });
      }
    }
    return assetIds.map((id) => byId.get(id)).filter(Boolean);
  }

  // The library-wide stuck set behind the Enrich page's retry affordance:
  // every asset whose content failures under this run key reached the limit
  // and that no qualifying success has covered since. Mirror of
  // assetIdsNeedingWork's failureLimited classification — same status
  // semantics ('failed' only; 'failed_infra' never counts), successful wins
  // over limited — but scanned from the failure rows instead of a
  // caller-supplied id list. Ordered least-recently-failed first: a retried
  // photo that content-fails again writes a newer row and rotates to the
  // back, so a stuck set larger than `limit` cycles instead of starving its
  // tail behind the same front window.
  failureLimitedAssetIds({ runKey, maxFailuresPerAsset, skipAnySuccessful = true, limit = 10000 }) {
    if (!(maxFailuresPerAsset > 0)) {
      return { count: 0, assetIds: [], truncated: false };
    }
    const { provider, model, promptVersion, taxonomyVersion } = runKey;
    const successClause = skipAnySuccessful
      ? "SELECT 1 FROM processing_runs s WHERE s.asset_id = f.asset_id AND s.status = 'succeeded'"
      : `SELECT 1 FROM processing_runs s WHERE s.asset_id = f.asset_id AND s.status = 'succeeded'
         AND s.provider = ? AND s.model = ? AND s.prompt_version = ? AND s.taxonomy_version = ?`;
    const params = [provider, model, promptVersion, taxonomyVersion];
    if (!skipAnySuccessful) {
      params.push(provider, model, promptVersion, taxonomyVersion);
    }
    const rows = this.db
      .prepare(
        `
        WITH candidates AS (
          SELECT f.asset_id, MAX(f.id) AS last_failure_id
          FROM processing_runs f
          WHERE f.status = 'failed' AND f.provider = ? AND f.model = ?
            AND f.prompt_version = ? AND f.taxonomy_version = ?
            AND NOT EXISTS (${successClause})
            AND NOT EXISTS (
              SELECT 1 FROM assets a
              WHERE a.asset_id = f.asset_id
                AND (a.missing_since IS NOT NULL OR a.enrich_discarded_at IS NOT NULL)
            )
          GROUP BY f.asset_id HAVING COUNT(*) >= ?
        )
        SELECT asset_id, COUNT(*) OVER() AS total
        FROM candidates
        ORDER BY last_failure_id ASC
        LIMIT ?
        `,
      )
      .all(...params, maxFailuresPerAsset, limit + 1);
    const assetIds = rows.slice(0, limit).map((row) => row.asset_id);
    const count = Number(rows[0]?.total ?? 0);
    return { count, assetIds, truncated: count > assetIds.length };
  }

  replaceAssetTags({ assetId, decisions, model, taxonomyVersion }) {
    this.#reviewStateChanged();
    const now = utcNow();
    this.transaction(() => {
      this.db
        .prepare("DELETE FROM asset_tags WHERE asset_id = ? AND source IN ('ai', 'system')")
        .run(assetId);
      const insert = this.db.prepare(
        `
        INSERT OR REPLACE INTO asset_tags (
          asset_id, tag, confidence, source, reason, model, taxonomy_version, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const decision of decisions) {
        insert.run(assetId, decision.tag, decision.confidence, decision.source, decision.reason, model, taxonomyVersion, now);
      }
    });
  }

  upsertImmichTagMap(tag, immichTagId) {
    this.db
      .prepare(
        `
        INSERT INTO immich_tag_map (tag, immich_tag_id, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(tag) DO UPDATE SET immich_tag_id=excluded.immich_tag_id
        `,
      )
      .run(tag, immichTagId, utcNow());
  }

  deleteAssetTagDecisions(tag) {
    this.#reviewStateChanged();
    const result = this.db.prepare('DELETE FROM asset_tags WHERE tag = ?').run(tag);
    return Number(result.changes);
  }

  // Enrichment + quality signals for exactly these assets (a row means the
  // asset has a succeeded run). Chunked for SQLite's parameter limit.
  latestSuccessFor(assetIds) {
    const rows = [];
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      rows.push(
        ...this.db
          .prepare(
            `SELECT asset_id, frame_score, aesthetic_score FROM latest_success WHERE asset_id IN (${marks})`,
          )
          .all(...chunk),
      );
    }
    return rows;
  }

  // The full caption lives only in the run JSON (latest_success stores the
  // short one) and is read per asset when the Curate lightbox opens — it is
  // deliberately never joined into the full review-rows payload. Provider
  // and model ride along for the lightbox's attribution note.
  latestEnrichment(assetId) {
    const row = this.db
      .prepare(
        `SELECT pr.provider, pr.model,
                json_extract(pr.normalized_output_json, '$.caption') AS caption
         FROM latest_success ls
         JOIN processing_runs pr ON pr.id = ls.run_id
         WHERE ls.asset_id = ?`,
      )
      .get(assetId);
    if (!row) return null;
    return {
      caption: typeof row.caption === 'string' && row.caption ? row.caption : null,
      provider: row.provider,
      model: row.model,
    };
  }

  reviewListAdd(assetIds, source) {
    this.#reviewStateChanged();
    const now = utcNow();
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO review_list (asset_id, source, added_at) VALUES (?, ?, ?)',
    );
    let added = 0;
    this.transaction(() => {
      for (const assetId of assetIds) {
        if (typeof assetId === 'string' && assetId) {
          added += Number(insert.run(assetId, String(source), now).changes);
        }
      }
    });
    return added;
  }

  reviewListMembership(assetIds) {
    const members = new Set();
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      for (const row of this.db.prepare(`SELECT asset_id FROM review_list WHERE asset_id IN (${marks})`).all(...chunk)) {
        members.add(row.asset_id);
      }
    }
    return members;
  }

  // BM25-ranked caption search. The query is free text; it's tokenized and
  // turned into prefix terms ("beach"* "sunse"*) so FTS5 syntax characters
  // can't break the MATCH expression. AND semantics across tokens.
  searchCaptions(query, { limit = 100 } = {}) {
    const tokens = String(query ?? '')
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .slice(0, 12);
    if (tokens.length === 0) {
      return [];
    }
    const match = tokens.map((token) => `"${token}"*`).join(' ');
    const cap = Math.max(1, Math.min(Number(limit) || 100, 1000));
    return this.db
      .prepare(
        `
        SELECT asset_id, caption, short_caption
        FROM caption_index
        WHERE caption_index MATCH ?
        ORDER BY rank
        LIMIT ?
        `,
      )
      .all(match, cap)
      .map((row) => ({ assetId: row.asset_id, caption: row.caption, shortCaption: row.short_caption }));
  }

  // Term -> photo-count statistics from the caption index (word cloud).
  // Grammatical stopwords are dropped here; content-word tuning (e.g.
  // "background", "close-up") is a presentation decision, left to callers.
  captionTerms({ limit = 150 } = {}) {
    const cap = Math.max(1, Math.min(Number(limit) || 150, 500));
    const rows = this.db
      .prepare(
        `
        SELECT term, doc FROM caption_vocab
        WHERE length(term) >= 3
        ORDER BY doc DESC
        LIMIT ?
        `,
      )
      .all(cap * 3);
    return rows
      .filter((row) => !CAPTION_STOPWORDS.has(row.term))
      .slice(0, cap)
      .map((row) => ({ term: row.term, count: Number(row.doc) }));
  }

  // --- Caption writeback queue (captions → Immich descriptions) ---

  // (Re-)queue assets for description writeback. A row that already exists
  // is reset to pending — the worker re-checks against Immich, so this is
  // always safe: human text is re-detected and re-skipped, unchanged
  // captions are cheap no-ops, and changed captions get updated.
  captionWritebackEnqueue(assetIds) {
    const now = utcNow();
    const upsert = this.db.prepare(
      `
      INSERT INTO caption_writeback (asset_id, status, attempts, updated_at)
      VALUES (?, 'pending', 0, ?)
      ON CONFLICT(asset_id) DO UPDATE
        SET status = 'pending', attempts = 0, last_error = NULL, updated_at = excluded.updated_at
        WHERE caption_writeback.status != 'pending'
      `,
    );
    let queued = 0;
    this.transaction(() => {
      for (const assetId of assetIds) {
        if (typeof assetId === 'string' && assetId) {
          queued += Number(upsert.run(assetId, now).changes);
        }
      }
    });
    return queued;
  }

  // Queue every enriched photo that has a caption: new assets, failed rows,
  // and previously written rows whose caption has since changed (knowable
  // locally — no Immich call). Skipped rows (human text) stay skipped, and
  // written rows with unchanged captions aren't re-checked.
  captionWritebackBackfill() {
    const now = utcNow();
    return this.transaction(() => {
      const inserted = this.db
        .prepare(
          `
          INSERT OR IGNORE INTO caption_writeback (asset_id, status, attempts, updated_at)
          SELECT asset_id, 'pending', 0, ? FROM caption_index WHERE caption != ''
          `,
        )
        .run(now);
      const retried = this.db
        .prepare(
          `
          UPDATE caption_writeback
          SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
          WHERE status = 'failed'
          `,
        )
        .run(now);
      const changed = this.db
        .prepare(
          `
          UPDATE caption_writeback
          SET status = 'pending', attempts = 0, last_error = NULL, updated_at = ?
          WHERE status = 'written' AND asset_id IN (
            SELECT ci.asset_id FROM caption_index ci
            JOIN caption_writeback cw ON cw.asset_id = ci.asset_id
            WHERE cw.status = 'written' AND ci.caption != ''
              AND cw.written_description IS NOT NULL
              AND cw.written_description != ci.caption
          )
          `,
        )
        .run(now);
      return Number(inserted.changes) + Number(retried.changes) + Number(changed.changes);
    });
  }

  // Two steps on purpose: joining caption_index (FTS5) by its unindexed
  // asset_id forces a full-index scan per probe — done inside a join across
  // a library-sized queue that's minutes, done once per small batch it's
  // milliseconds.
  captionWritebackNext(limit = 10) {
    const rows = this.db
      .prepare(
        `
        SELECT asset_id, attempts, written_description FROM caption_writeback
        WHERE status = 'pending'
        ORDER BY attempts, updated_at, asset_id
        LIMIT ?
        `,
      )
      .all(Math.max(1, Number(limit) || 10));
    if (rows.length === 0) {
      return [];
    }
    const placeholders = rows.map(() => '?').join(', ');
    const captions = new Map(
      this.db
        .prepare(`SELECT asset_id, caption FROM caption_index WHERE asset_id IN (${placeholders})`)
        .all(...rows.map((row) => row.asset_id))
        .map((row) => [row.asset_id, row.caption]),
    );
    return rows.map((row) => ({
      assetId: row.asset_id,
      attempts: Number(row.attempts),
      writtenDescription: row.written_description,
      caption: captions.get(row.asset_id) ?? '',
    }));
  }

  captionWritebackMark(assetId, { status, writtenDescription = null, note = null }) {
    this.db
      .prepare(
        `
        UPDATE caption_writeback
        SET status = ?, written_description = COALESCE(?, written_description),
            last_error = ?, updated_at = ?
        WHERE asset_id = ?
        `,
      )
      .run(String(status), writtenDescription, note, utcNow(), assetId);
  }

  // Failed pushes rotate behind fresh rows (attempts-first ordering) and
  // give up after maxAttempts — one unreachable asset can't stall the rest.
  captionWritebackFailure(assetId, error, { maxAttempts = 5 } = {}) {
    this.db
      .prepare(
        `
        UPDATE caption_writeback
        SET attempts = attempts + 1, last_error = ?,
            status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
            updated_at = ?
        WHERE asset_id = ?
        `,
      )
      .run(sanitizeDiagnostic(error), maxAttempts, utcNow(), assetId);
  }

  captionWritebackCounts() {
    const counts = { pending: 0, written: 0, skipped: 0, failed: 0 };
    for (const row of this.db
      .prepare('SELECT status, COUNT(*) AS count FROM caption_writeback GROUP BY status')
      .all()) {
      if (row.status in counts) {
        counts[row.status] = Number(row.count);
      }
    }
    return counts;
  }

  // Coverage signals for the Insights browser: which of these photos are
  // enriched (any successful run) and which carry a human decision
  // (frame/* tags). Pure local reads, chunked for SQLite's param limit.
  coverageFor(assetIds) {
    const coverage = {};
    for (const id of new Set(assetIds.filter((id) => typeof id === 'string' && id))) {
      coverage[id] = { enriched: false, curated: false };
    }
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      for (const row of this.db
        .prepare(`SELECT DISTINCT asset_id FROM processing_runs WHERE status = 'succeeded' AND asset_id IN (${marks})`)
        .all(...chunk)) {
        coverage[row.asset_id].enriched = true;
      }
      for (const row of this.db
        .prepare(
          `SELECT DISTINCT asset_id FROM asset_tags
           WHERE tag IN ('frame/eligible', 'frame/favorite', 'frame/never-show', 'frame/reviewed')
             AND asset_id IN (${marks})`,
        )
        .all(...chunk)) {
        coverage[row.asset_id].curated = true;
      }
    }
    return coverage;
  }

  // The Curate queue's source rows: review-list members with their asset
  // metadata and latest-success projection (its columns null for photos sent
  // to Curate without enrichment — latest_run_id is the enriched marker).
  reviewListRows() {
    return this.db
      .prepare(
        `
        SELECT
          rl.asset_id,
          a.original_path,
          a.width,
          a.height,
          a.file_created_at,
          a.thumbhash,
          a.duplicate_id,
          ls.run_id AS latest_run_id,
          ls.finished_at,
          ls.short_caption,
          ls.frame_score,
          ls.aesthetic_score,
          ls.needs_review,
          ls.exclusion_reasons_json,
          ref.group_key AS referee_group_key,
          ref.rank AS referee_rank,
          ref.keep AS referee_keep,
          ref.eyes_closed AS referee_eyes_closed,
          ref.note AS referee_note,
          ref.subject_group AS referee_subject_group
        FROM review_list rl
        LEFT JOIN assets a ON a.asset_id = rl.asset_id
        LEFT JOIN referee_picks ref ON ref.asset_id = rl.asset_id
        LEFT JOIN latest_success ls ON ls.asset_id = rl.asset_id
        ORDER BY rl.added_at DESC, rl.asset_id
        `,
      )
      .all();
  }

  // Tag rows for review-list members only (the review path's tag source):
  // work scales with the queue, not with library-wide asset_tags.
  reviewAssetTagRows() {
    const rows = this.db
      .prepare(
        `
        SELECT t.asset_id, t.tag, t.confidence, t.source, t.reason, t.created_at
        FROM asset_tags t
        JOIN review_list rl ON rl.asset_id = t.asset_id
        ORDER BY t.asset_id, t.tag
        `,
      )
      .all();
    const grouped = {};
    for (const row of rows) {
      (grouped[row.asset_id] ??= []).push({ ...row });
    }
    return grouped;
  }

  // --- group referee ---

  refereeHasGroup(groupKey) {
    return Boolean(this.db.prepare('SELECT 1 FROM referee_groups WHERE group_key = ?').get(groupKey));
  }

  refereeRecordGroup({ groupKey, memberCount, sameSubject, provider, model, picks, durationMs = null }) {
    this.#reviewStateChanged();
    const insertGroup = this.db.prepare(`
      INSERT OR REPLACE INTO referee_groups (group_key, member_count, same_subject, provider, model, refereed_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPick = this.db.prepare(`
      INSERT OR REPLACE INTO referee_picks (asset_id, group_key, rank, keep, eyes_closed, note, subject_group)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      insertGroup.run(groupKey, memberCount, sameSubject === null ? null : Number(Boolean(sameSubject)), provider, model ?? null, utcNow(), durationMs);
      for (const pick of picks) {
        insertPick.run(
          pick.assetId,
          groupKey,
          pick.rank,
          Number(Boolean(pick.keep)),
          pick.eyesClosed ?? null,
          pick.note ?? null,
          pick.subjectGroup ?? null,
        );
      }
    });
  }

  // Latest judged groups for the activity popup. Subject counts come from
  // the picks; superseded groups (re-judged after membership changed) may
  // count approximately since picks are per-asset.
  refereeRecentGroups(limit = 20) {
    return this.db
      .prepare(`
        SELECT g.member_count, g.provider, g.model, g.refereed_at, g.duration_ms,
               (SELECT COUNT(DISTINCT COALESCE(p.subject_group, 1))
                  FROM referee_picks p WHERE p.group_key = g.group_key) AS subjects
        FROM referee_groups g
        ORDER BY g.refereed_at DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(100, Number(limit) || 20)))
      .map((row) => ({
        memberCount: Number(row.member_count),
        provider: row.provider,
        model: row.model,
        refereedAt: row.refereed_at,
        durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
        subjects: Number(row.subjects) || 1,
      }));
  }

  refereeStats() {
    const groups = this.db.prepare('SELECT COUNT(*) AS n, MAX(refereed_at) AS last FROM referee_groups').get();
    const photos = this.db.prepare('SELECT COUNT(*) AS n FROM referee_picks').get();
    return {
      groups: Number(groups?.n ?? 0),
      photos: Number(photos?.n ?? 0),
      lastRefereedAt: groups?.last ?? null,
    };
  }

  // Tag names for exactly these assets, grouped per asset. Chunked for
  // SQLite's parameter limit; there is deliberately no unscoped variant —
  // every caller knows which assets it is working on.
  loadAssetTagsFor(assetIds, { prefix = null } = {}) {
    const grouped = {};
    for (const chunk of idChunks(assetIds)) {
      const marks = chunk.map(() => '?').join(', ');
      let query = `SELECT asset_id, tag FROM asset_tags WHERE asset_id IN (${marks})`;
      const params = [...chunk];
      if (prefix !== null) {
        query += ' AND tag LIKE ?';
        params.push(`${prefix}%`);
      }
      query += ' ORDER BY asset_id, tag';
      for (const row of this.db.prepare(query).all(...params)) {
        (grouped[row.asset_id] ??= []).push(row.tag);
      }
    }
    return grouped;
  }

  // Applies a manual review decision locally and enqueues its Immich sync job
  // in one transaction, so decisions and their pushes can never diverge.
  recordDecision({ assetIds, addTags, removeTags, action }) {
    const now = utcNow();
    return this.transaction(() => {
      const queuedRefs = Number(this.db.prepare(`
        SELECT COALESCE(SUM(
          CASE WHEN json_valid(asset_ids_json) THEN json_array_length(asset_ids_json) ELSE ? END
        ), 0) AS count
        FROM pending_sync_jobs
      `).get(MAX_PENDING_SYNC_ASSET_REFS)?.count ?? 0);
      if (queuedRefs + assetIds.length > MAX_PENDING_SYNC_ASSET_REFS) {
        const error = new Error('The review sync backlog is full. Wait for pending work or dismiss failed jobs, then retry.');
        error.code = 'review_sync_backlog_full';
        error.status = 409;
        throw error;
      }
      this.#applyManualFrameTags(assetIds, addTags, removeTags, action, now);
      const result = this.db
        .prepare(
          `
          INSERT INTO pending_sync_jobs (action, asset_ids_json, add_tags_json, remove_tags_json, attempts, created_at)
          VALUES (?, ?, ?, ?, 0, ?)
          `,
        )
        .run(action, JSON.stringify(assetIds), JSON.stringify(addTags), JSON.stringify(removeTags), now);
      this.#pruneManualOverrideHistoryIfDue();
      return Number(result.lastInsertRowid);
    });
  }

  setManualFrameTags({ assetIds, addTags, removeTags, action }) {
    const now = utcNow();
    this.transaction(() => {
      this.#applyManualFrameTags(assetIds, addTags, removeTags, action, now);
      this.#pruneManualOverrideHistoryIfDue();
    });
  }

  #applyManualFrameTags(assetIds, addTags, removeTags, action, now) {
    this.#reviewStateChanged();
    const remove = this.db.prepare('DELETE FROM asset_tags WHERE asset_id = ? AND tag = ?');
    const insert = this.db.prepare(
      `
      INSERT OR REPLACE INTO asset_tags (
        asset_id, tag, confidence, source, reason, model, taxonomy_version, created_at
      )
      VALUES (?, ?, 1.0, 'manual', ?, NULL, NULL, ?)
      `,
    );
    const audit = this.db.prepare(
      `
      INSERT INTO manual_overrides (asset_id, tag, action, reason, created_at)
      VALUES (?, 'frame/decision', ?, NULL, ?)
      `,
    );
    for (const assetId of assetIds) {
      for (const tag of removeTags) {
        remove.run(assetId, tag);
      }
      for (const tag of addTags) {
        insert.run(assetId, tag, `human decision: ${action}`, now);
      }
      audit.run(assetId, action, now);
    }
  }

  #pruneManualOverrideHistoryIfDue() {
    const newestId = Number(this.db.prepare(
      'SELECT COALESCE(MAX(id), 0) AS id FROM manual_overrides',
    ).get()?.id ?? 0);
    if (this.#nextManualOverridePruneId !== null && newestId < this.#nextManualOverridePruneId) {
      return;
    }
    this.db.prepare(`
      DELETE FROM manual_overrides
      WHERE id NOT IN (
        SELECT MAX(id) FROM manual_overrides GROUP BY asset_id
        UNION
        SELECT id FROM (
          SELECT id FROM manual_overrides ORDER BY id DESC LIMIT ?
        )
      )
    `).run(MAX_MANUAL_OVERRIDE_HISTORY_ROWS);
    this.#nextManualOverridePruneId = newestId + MANUAL_OVERRIDE_PRUNE_INTERVAL_ROWS;
  }

  nextSyncJob() {
    // Every selected field is bounded or converted by the SQL projection
    // before the driver materializes it. This remains a pure read: the worker
    // owns the logged dead-letter transition for invalid envelopes.
    const row = this.db.prepare(`
      SELECT ${SYNC_JOB_ROW_PROJECTION}
      FROM pending_sync_jobs
      WHERE dead_at IS NULL
      ORDER BY id
      LIMIT 1
    `).get();
    if (row === undefined) {
      return null;
    }
    return syncJobFromRow(row);
  }

  completeSyncJob(jobId) {
    this.db.prepare('DELETE FROM pending_sync_jobs WHERE id = ?').run(jobId);
  }

  completeSyncJobSlice(jobId, completedCount) {
    this.transaction(() => {
      const row = this.db.prepare('SELECT asset_ids_json FROM pending_sync_jobs WHERE id = ?').get(jobId);
      if (!row) return;
      const remaining = JSON.parse(row.asset_ids_json).slice(completedCount);
      if (remaining.length === 0) {
        this.db.prepare('DELETE FROM pending_sync_jobs WHERE id = ?').run(jobId);
        return;
      }
      this.db.prepare(`
        UPDATE pending_sync_jobs
        SET asset_ids_json = ?, attempts = 0, last_error = NULL
        WHERE id = ?
      `).run(JSON.stringify(remaining), jobId);
    });
  }

  recordSyncJobFailure(jobId, error) {
    this.db
      .prepare('UPDATE pending_sync_jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?')
      .run(sanitizeDiagnostic(error), jobId);
  }

  // Park a job that keeps failing so it stops blocking the queue. It keeps
  // its history and can be retried or dismissed explicitly.
  deadLetterSyncJob(jobId, error) {
    this.db
      .prepare('UPDATE pending_sync_jobs SET attempts = attempts + 1, last_error = ?, dead_at = ? WHERE id = ?')
      .run(sanitizeDiagnostic(error), utcNow(), jobId);
  }

  deadSyncJobs() {
    return this.db
      .prepare(`
        SELECT ${SYNC_JOB_ROW_PROJECTION}
        FROM pending_sync_jobs
        WHERE dead_at IS NOT NULL
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(MAX_DEAD_SYNC_JOBS)
      .map(syncJobFromRow);
  }

  // Re-queue dead jobs (one by id, or all when id is null). Attempts reset so
  // the retry gets the full allowance again.
  retryDeadSyncJobs(jobId = null) {
    const result = jobId === null
      ? this.db.prepare('UPDATE pending_sync_jobs SET dead_at = NULL, attempts = 0 WHERE dead_at IS NOT NULL').run()
      : this.db.prepare('UPDATE pending_sync_jobs SET dead_at = NULL, attempts = 0 WHERE id = ? AND dead_at IS NOT NULL').run(jobId);
    return Number(result.changes);
  }

  dismissDeadSyncJob(jobId) {
    return this.db.prepare('DELETE FROM pending_sync_jobs WHERE id = ? AND dead_at IS NOT NULL').run(jobId).changes > 0;
  }

  pendingSyncJobCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_sync_jobs WHERE dead_at IS NULL').get();
    return Number(row?.count ?? 0);
  }

  deadSyncJobCount() {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_sync_jobs WHERE dead_at IS NOT NULL').get();
    return Number(row?.count ?? 0);
  }

  queueAdd({ title, filters, estimatedCount = null, protectedIds = [], now = new Date() }) {
    const safeTitle = String(title || 'Photo slice').slice(0, 120);
    const filtersJson = JSON.stringify(filters);
    const safeEstimatedCount = Number.isSafeInteger(estimatedCount) && estimatedCount >= 0 ? estimatedCount : null;
    const encodedBytes = queueItemBytes({ title: safeTitle, filtersJson, estimatedCount: safeEstimatedCount });
    if (encodedBytes > ENRICH_QUEUE_MAX_ITEM_BYTES) {
      throw enrichQueueError(
        `A queued slice may use at most ${ENRICH_QUEUE_MAX_ITEM_BYTES} encoded bytes.`,
        'enrich_queue_item_too_large',
        413,
      );
    }
    return this.transaction(() => {
      this.queueMaintain({ protectedIds, now });
      const duplicate = this.db.prepare(
        'SELECT * FROM enrich_queue WHERE filters_json = ? ORDER BY id LIMIT 1',
      ).get(filtersJson);
      if (duplicate) {
        return { id: Number(duplicate.id), duplicate: true };
      }
      const rows = this.db.prepare(
        'SELECT title, filters_json, estimated_count FROM enrich_queue',
      ).all();
      const count = rows.length;
      const bytes = rows.reduce((sum, row) => sum + queueItemBytes({
        title: row.title,
        filtersJson: row.filters_json,
        estimatedCount: row.estimated_count === null ? null : Number(row.estimated_count),
      }), 0);
      if (
        count >= ENRICH_QUEUE_MAX_ITEMS_PER_OWNER
        || count >= ENRICH_QUEUE_MAX_ITEMS_GLOBAL
        || bytes + encodedBytes > ENRICH_QUEUE_MAX_TOTAL_BYTES
      ) {
        throw enrichQueueError(
          'The enrichment queue is full. Run or remove queued work before adding another slice.',
          'enrich_queue_full',
          409,
        );
      }
      const result = this.db.prepare(
        'INSERT INTO enrich_queue (title, filters_json, estimated_count, requested_at) VALUES (?, ?, ?, ?)',
      ).run(safeTitle, filtersJson, safeEstimatedCount, new Date(now).toISOString());
      return { id: Number(result.lastInsertRowid), duplicate: false };
    });
  }

  // One shared APP_PASSWORD means one installation owner today, so the
  // per-owner and global ceilings intentionally cover the same rows. Cleanup
  // is lazy and deterministic: expired entries first, then newest excess.
  // A running/resolving item is never evicted from under continuation work.
  queueMaintain({ protectedIds = [], now = new Date() } = {}) {
    const protectedSet = new Set(
      protectedIds.filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    return this.transaction(() => {
      let removed = 0;
      const protectedList = [...protectedSet];
      const protectedClause = protectedList.length > 0
        ? `AND id NOT IN (${protectedList.map(() => '?').join(', ')})`
        : '';
      const cutoff = new Date(new Date(now).getTime() - ENRICH_QUEUE_MAX_AGE_MS).toISOString();
      removed += Number(this.db.prepare(
        `DELETE FROM enrich_queue WHERE requested_at < ? ${protectedClause}`,
      ).run(cutoff, ...protectedList).changes);

      const count = Number(this.db.prepare('SELECT COUNT(*) AS count FROM enrich_queue').get()?.count ?? 0);
      if (count > ENRICH_QUEUE_MAX_ITEMS_GLOBAL) {
        const priority = protectedList.length > 0
          ? `CASE WHEN id IN (${protectedList.map(() => '?').join(', ')}) THEN 0 ELSE 1 END, id ASC`
          : 'id ASC';
        const keep = this.db.prepare(
          `SELECT id FROM enrich_queue ORDER BY ${priority} LIMIT ?`,
        ).all(...protectedList, ENRICH_QUEUE_MAX_ITEMS_GLOBAL).map((row) => Number(row.id));
        const marks = keep.map(() => '?').join(', ');
        removed += Number(this.db.prepare(`DELETE FROM enrich_queue WHERE id NOT IN (${marks})`).run(...keep).changes);
      }

      const rows = this.db.prepare('SELECT id, title, filters_json, estimated_count FROM enrich_queue ORDER BY id').all();
      const encodedRows = rows.map((row) => ({
        ...row,
        encodedBytes: queueItemBytes({
          title: row.title,
          filtersJson: row.filters_json,
          estimatedCount: row.estimated_count === null ? null : Number(row.estimated_count),
        }),
      }));
      let totalBytes = encodedRows.reduce((sum, row) => sum + row.encodedBytes, 0);
      const removeIds = [];
      for (let index = encodedRows.length - 1; index >= 0; index -= 1) {
        const row = encodedRows[index];
        const oversized = row.encodedBytes > ENRICH_QUEUE_MAX_ITEM_BYTES;
        if (!protectedSet.has(Number(row.id)) && (oversized || totalBytes > ENRICH_QUEUE_MAX_TOTAL_BYTES)) {
          removeIds.push(Number(row.id));
          totalBytes -= row.encodedBytes;
        }
      }
      if (removeIds.length > 0) {
        const marks = removeIds.map(() => '?').join(', ');
        removed += Number(this.db.prepare(`DELETE FROM enrich_queue WHERE id IN (${marks})`).run(...removeIds).changes);
      }
      return removed;
    });
  }

  queuePage({ afterId = 0, limit = ENRICH_QUEUE_DEFAULT_PAGE_SIZE } = {}) {
    const rows = this.db.prepare(
      'SELECT * FROM enrich_queue WHERE id > ? ORDER BY id ASC LIMIT ?',
    ).all(afterId, limit + 1);
    const items = rows.slice(0, limit).map(queueItemFromRow);
    return {
      items,
      nextAfterId: rows.length > limit ? items.at(-1)?.id ?? null : null,
      total: Number(this.db.prepare('SELECT COUNT(*) AS count FROM enrich_queue').get()?.count ?? 0),
    };
  }

  queueGet(id) {
    const row = this.db.prepare('SELECT * FROM enrich_queue WHERE id = ?').get(id);
    return row ? queueItemFromRow(row) : null;
  }

  queueRemove(id) {
    return this.db.prepare('DELETE FROM enrich_queue WHERE id = ?').run(id).changes > 0;
  }

  recordJobRun({ title, provider, model, promptVersion, taxonomyVersion, targeted, status, error, counters, log, startedAt, finishedAt }) {
    const safeError = error === null || error === undefined ? null : sanitizeDiagnostic(error);
    const safeLog = boundedJobLog(log);
    this.db.prepare(`
      INSERT INTO job_runs (title, provider, model, prompt_version, taxonomy_version, targeted, status, error, counters_json, log_json, started_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, provider, model ?? null, promptVersion ?? null, taxonomyVersion ?? null, targeted ?? null,
      status, safeError, counters ? JSON.stringify(counters) : null,
      safeLog?.length > 0 ? JSON.stringify(safeLog) : null, startedAt, finishedAt);
    this.db.prepare(`
      DELETE FROM job_runs
      WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT ?)
    `).run(MAX_JOB_RUNS);
  }

  // Reconstruct the per-photo failures that belong to one historical job.
  // Runs are single-flight, so the exact provider/model/prompt/taxonomy key
  // plus the job's time window identifies its processing rows without adding
  // a job id to the durable processing history. The set is evaluated live:
  // any success (under any setup), a confirmed Immich deletion, or a human
  // discard removes the photo before a retry can start.
  jobRunRetryFailures(id, { limit = 10000 } = {}) {
    const runId = Number(id);
    if (!Number.isSafeInteger(runId) || runId < 1) return null;
    const run = this.db.prepare(`
      SELECT id, title, provider, model, prompt_version, taxonomy_version,
             started_at, finished_at
      FROM job_runs WHERE id = ?
    `).get(runId);
    if (!run) return null;

    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.max(0, Math.min(limit, 10000))
      : 10000;
    const rows = this.db.prepare(`
      WITH candidates AS (
        SELECT f.asset_id, MIN(f.id) AS first_failure_id
        FROM processing_runs f
        WHERE f.status IN ('failed', 'failed_infra')
          AND f.provider IS ? AND f.model IS ?
          AND f.prompt_version IS ? AND f.taxonomy_version IS ?
          AND f.started_at >= ? AND f.started_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM processing_runs s
            WHERE s.asset_id = f.asset_id AND s.status = 'succeeded'
          )
          AND NOT EXISTS (
            SELECT 1 FROM assets a
            WHERE a.asset_id = f.asset_id
              AND (a.missing_since IS NOT NULL OR a.enrich_discarded_at IS NOT NULL)
          )
        GROUP BY f.asset_id
      )
      SELECT asset_id, COUNT(*) OVER() AS total
      FROM candidates
      ORDER BY first_failure_id ASC
      LIMIT ?
    `).all(
      run.provider,
      run.model,
      run.prompt_version,
      run.taxonomy_version,
      run.started_at,
      run.finished_at,
      boundedLimit + 1,
    );
    const assetIds = rows.slice(0, boundedLimit).map((row) => row.asset_id);
    const count = Number(rows[0]?.total ?? 0);
    return {
      runId: Number(run.id),
      title: run.title,
      provider: run.provider,
      model: run.model,
      promptVersion: run.prompt_version,
      taxonomyVersion: run.taxonomy_version,
      count,
      assetIds,
      // A zero-id query is the cheap count-only mode used by history cards,
      // not a page callers can meaningfully describe as truncated.
      truncated: boundedLimit === 0 ? false : count > assetIds.length,
    };
  }

  listJobRuns(limit = 20) {
    // The log stays out of the list payload (it can be hundreds of KB);
    // fetch it per run via getJobRunLog.
    return this.db.prepare(`
      SELECT id, title, provider, model, prompt_version, taxonomy_version, targeted,
             status, error, counters_json, log_json IS NOT NULL AS has_log, started_at, finished_at
      FROM job_runs ORDER BY id DESC LIMIT ?
    `).all(limit).map((row) => {
      const id = Number(row.id);
      const counters = row.counters_json ? JSON.parse(row.counters_json) : null;
      // Modern completed runs record failed=0 authoritatively. Avoid a
      // historical-window query for those overwhelmingly common clean cards;
      // legacy/interrupted rows with absent counters still get reconstructed.
      const retryableFailures = Number.isFinite(counters?.failed) && counters.failed === 0
        ? 0
        : this.jobRunRetryFailures(id, { limit: 0 })?.count ?? 0;
      return {
        id,
        title: row.title,
        provider: row.provider,
        model: row.model,
        promptVersion: row.prompt_version,
        taxonomyVersion: row.taxonomy_version,
        targeted: row.targeted === null ? null : Number(row.targeted),
        status: row.status,
        error: row.error,
        counters,
        hasLog: Boolean(row.has_log),
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        retryableFailures,
      };
    });
  }

  getJobRunLog(id) {
    const row = this.db.prepare(`
      SELECT title, provider, model, prompt_version, taxonomy_version, status, log_json
      FROM job_runs WHERE id = ?
    `).get(id);
    if (!row) {
      return null;
    }
    return {
      title: row.title,
      provider: row.provider,
      model: row.model,
      promptVersion: row.prompt_version,
      taxonomyVersion: row.taxonomy_version,
      status: row.status,
      log: row.log_json ? JSON.parse(row.log_json) : [],
    };
  }

  // --- structured activity events ---

  recordActivityEvent({
    at,
    category,
    type,
    source = null,
    deviceId = null,
    assetId = null,
    provider = null,
    model = null,
    outcome = null,
    summary,
    detailJson = null,
  }) {
    const result = this.db.prepare(`
      INSERT INTO activity_log (
        at, category, type, source, device_id, asset_id,
        provider, model, outcome, summary, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      at,
      category,
      type,
      source,
      deviceId,
      assetId,
      provider,
      model,
      outcome,
      summary,
      detailJson,
    );
    return Number(result.lastInsertRowid);
  }

  pruneActivityEvents(before) {
    return Number(this.db.prepare('DELETE FROM activity_log WHERE at < ?').run(before).changes) || 0;
  }

  listActivityEvents({
    limit = 50,
    before = null,
    since = null,
    until = null,
    category = null,
    type = null,
    provider = null,
    model = null,
  } = {}) {
    const clauses = [];
    const parameters = [];
    if (before?.at && Number.isInteger(before.id)) {
      clauses.push('(at < ? OR (at = ? AND id < ?))');
      parameters.push(before.at, before.at, before.id);
    }
    if (since) {
      clauses.push('at >= ?');
      parameters.push(since);
    }
    if (until) {
      clauses.push('at <= ?');
      parameters.push(until);
    }
    for (const [column, value] of [
      ['category', category],
      ['type', type],
      ['provider', provider],
      ['model', model],
    ]) {
      if (value) {
        clauses.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(Number(limit) || 50)));
    const rows = this.db.prepare(`
      SELECT id, at, category, type, source, device_id, asset_id,
             provider, model, outcome, summary, detail_json
      FROM activity_log
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY at DESC, id DESC
      LIMIT ?
    `).all(...parameters, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const events = rows.slice(0, boundedLimit).map(activityEventFromRow);
    const last = events.at(-1);
    return {
      events,
      nextCursor: hasMore && last ? { at: last.at, id: last.id } : null,
    };
  }

  // Unified, privacy-bounded Activity feed. Each source query takes only the
  // newest page-sized window before the small in-memory merge, so a library's
  // full per-photo processing history is never materialized for one request.
  // `before` is a global (timestamp, namespaced-key) cursor shared by every
  // source; this preserves strict ordering when different tables use the same
  // timestamp. Domain errors, logs, prompts, captions, titles, referee notes,
  // and raw model output are deliberately absent from every projection.
  listActivityHistory({
    limit = 50,
    before = null,
    since = null,
    operationalSince = null,
    until = null,
    category = null,
    type = null,
    provider = null,
    model = null,
  } = {}) {
    const boundedLimit = Math.max(1, Math.min(5000, Math.floor(Number(limit) || 50)));
    const sources = [
      {
        category: null,
        type: null,
        operational: true,
        table: 'activity_log',
        columns: ['id', 'at', 'category', 'type', 'source', 'device_id', 'asset_id', 'provider', 'model', 'outcome', 'summary', 'detail_json'],
        sql: `
          SELECT
            '5:' || printf('%020d', id) AS sort_key,
            at, category, type, source, device_id, asset_id,
            provider, model, outcome, summary, detail_json,
            'rolling_90_days' AS retention
          FROM activity_log
        `,
      },
      {
        category: 'enrich',
        type: 'enrich.photo',
        table: 'processing_runs',
        columns: ['id', 'started_at', 'asset_id', 'provider', 'model', 'status'],
        sql: `
          SELECT
            '4:' || printf('%020d', id) AS sort_key,
            started_at AS at,
            'enrich' AS category,
            'enrich.photo' AS type,
            'enrich' AS source,
            NULL AS device_id,
            asset_id,
            provider,
            model,
            CASE status
              WHEN 'succeeded' THEN 'succeeded'
              WHEN 'failed' THEN 'failed'
              WHEN 'failed_infra' THEN 'failed'
              WHEN 'skipped' THEN 'skipped'
              ELSE 'other'
            END AS outcome,
            CASE status
              WHEN 'succeeded' THEN 'Photo enriched'
              WHEN 'failed' THEN 'Photo enrichment failed'
              WHEN 'failed_infra' THEN 'Photo enrichment failed'
              WHEN 'skipped' THEN 'Photo enrichment skipped'
              ELSE 'Photo enrichment status recorded'
            END AS summary,
            NULL AS detail_json,
            'domain_history' AS retention
          FROM processing_runs
        `,
      },
      {
        category: 'enrich',
        type: 'enrich.run',
        table: 'job_runs',
        columns: ['id', 'finished_at', 'provider', 'model', 'targeted', 'status'],
        sql: `
          SELECT
            '3:' || printf('%020d', id) AS sort_key,
            finished_at AS at,
            'enrich' AS category,
            'enrich.run' AS type,
            'enrich' AS source,
            NULL AS device_id,
            NULL AS asset_id,
            provider,
            model,
            CASE status
              WHEN 'finished' THEN 'succeeded'
              WHEN 'succeeded' THEN 'succeeded'
              WHEN 'interrupted' THEN 'interrupted'
              WHEN 'cancelled' THEN 'cancelled'
              WHEN 'failed' THEN 'failed'
              ELSE 'other'
            END AS outcome,
            CASE status
              WHEN 'finished' THEN 'Enrichment run finished'
              WHEN 'succeeded' THEN 'Enrichment run finished'
              WHEN 'interrupted' THEN 'Enrichment run interrupted'
              WHEN 'cancelled' THEN 'Enrichment run cancelled'
              ELSE 'Enrichment run failed'
            END AS summary,
            CASE WHEN targeted IS NULL THEN NULL
                 ELSE json_object('targeted', MAX(0, targeted))
            END AS detail_json,
            'domain_history' AS retention
          FROM job_runs
        `,
      },
      {
        category: 'curation',
        type: 'curation.decision',
        table: 'manual_overrides',
        columns: ['id', 'created_at', 'asset_id', 'action'],
        sql: `
          SELECT
            '2:' || printf('%020d', id) AS sort_key,
            created_at AS at,
            'curation' AS category,
            'curation.decision' AS type,
            'curate' AS source,
            NULL AS device_id,
            asset_id,
            NULL AS provider,
            NULL AS model,
            'succeeded' AS outcome,
            CASE action
              WHEN 'approve' THEN 'Photo approved in Curate'
              WHEN 'reject' THEN 'Photo marked Never Show in Curate'
              WHEN 'clear' THEN 'Photo decision cleared in Curate'
              ELSE 'Photo decision recorded in Curate'
            END AS summary,
            CASE action
              WHEN 'approve' THEN json_object('decision', 'approve')
              WHEN 'reject' THEN json_object('decision', 'reject')
              WHEN 'clear' THEN json_object('decision', 'clear')
              ELSE NULL
            END AS detail_json,
            'domain_history' AS retention
          FROM manual_overrides
        `,
      },
      {
        category: 'curation',
        type: 'curation.referee',
        table: 'referee_groups',
        columns: ['group_key', 'refereed_at', 'member_count', 'duration_ms', 'provider', 'model'],
        sql: `
          SELECT
            '1:' || group_key AS sort_key,
            refereed_at AS at,
            'curation' AS category,
            'curation.referee' AS type,
            'referee' AS source,
            NULL AS device_id,
            NULL AS asset_id,
            provider,
            model,
            'succeeded' AS outcome,
            'Curate referee evaluated a photo group' AS summary,
            json_object(
              'photoCount', MAX(0, member_count),
              'durationMs', CASE WHEN duration_ms IS NULL THEN NULL ELSE MAX(0, duration_ms) END
            ) AS detail_json,
            'domain_history' AS retention
          FROM referee_groups
        `,
      },
    ];

    const rows = [];
    for (const source of sources) {
      if (!tableHasColumns(this.db, source.table, source.columns)) {
        continue;
      }
      if ((source.category && category && category !== source.category)
          || (source.type && type && type !== source.type)) {
        continue;
      }
      const clauses = [];
      const parameters = [];
      if (before?.at && typeof before.key === 'string') {
        clauses.push('(at < ? OR (at = ? AND sort_key < ?))');
        parameters.push(before.at, before.at, before.key);
      }
      if (since) {
        clauses.push('at >= ?');
        parameters.push(since);
      }
      if (source.operational && operationalSince) {
        clauses.push('at >= ?');
        parameters.push(operationalSince);
      }
      if (until) {
        clauses.push('at <= ?');
        parameters.push(until);
      }
      for (const [column, value] of [
        ['category', category],
        ['type', type],
        ['provider', provider],
        ['model', model],
      ]) {
        if (value) {
          clauses.push(`${column} = ?`);
          parameters.push(value);
        }
      }
      rows.push(...this.db.prepare(`
        SELECT * FROM (${source.sql})
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY at DESC, sort_key DESC
        LIMIT ?
      `).all(...parameters, boundedLimit + 1));
    }

    rows.sort((left, right) => compareTextDescending(left.at, right.at)
      || compareTextDescending(left.sort_key, right.sort_key));
    const hasMore = rows.length > boundedLimit;
    const events = rows.slice(0, boundedLimit).map(activityHistoryEventFromRow);
    const last = events.at(-1);
    return {
      events,
      nextCursor: hasMore && last ? { at: last.at, key: last.id } : null,
    };
  }

  activityVoiceCommandSignal({ since }) {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE
          WHEN json_valid(detail_json)
            AND json_extract(detail_json, '$.command') = 'unrecognized'
          THEN 1 ELSE 0
        END) AS unrecognized
      FROM activity_log
      WHERE type = 'voice.command' AND at >= ?
    `).get(since);
    return {
      total: Number(row?.total ?? 0),
      unrecognized: Number(row?.unrecognized ?? 0),
    };
  }

  libraryStats() {
    const enriched = this.db
      .prepare("SELECT COUNT(DISTINCT asset_id) AS count FROM processing_runs WHERE status = 'succeeded'")
      .get();
    const curated = this.db
      .prepare('SELECT COUNT(DISTINCT asset_id) AS count FROM manual_overrides')
      .get();
    return {
      enrichedTotal: Number(enriched?.count ?? 0),
      curatedTotal: Number(curated?.count ?? 0),
    };
  }
}

// ISO timestamps and namespaced cursor keys use SQLite's default binary
// collation. Comparing them as code-unit strings here keeps the in-memory
// merge identical to each source query's ORDER BY semantics.
function compareTextDescending(left, right) {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function activityEventFromRow(row) {
  let detail = null;
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = null;
    }
  }
  return {
    id: Number(row.id),
    at: row.at,
    category: row.category,
    type: row.type,
    source: row.source ?? null,
    deviceId: row.device_id ?? null,
    assetId: row.asset_id ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    outcome: row.outcome ?? null,
    summary: row.summary,
    detail,
  };
}

function activityHistoryEventFromRow(row) {
  let detail = null;
  if (row.detail_json) {
    try {
      detail = JSON.parse(row.detail_json);
    } catch {
      detail = null;
    }
  }
  return {
    id: row.sort_key,
    at: row.at,
    category: row.category,
    type: row.type,
    source: row.source ?? null,
    deviceId: row.device_id ?? null,
    assetId: row.asset_id ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    outcome: row.outcome ?? null,
    summary: row.summary,
    detail,
    retention: row.retention,
  };
}

function tableHasColumns(db, table, expected) {
  const columns = new Set(db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name));
  return expected.every((column) => columns.has(column));
}

// Split ids into IN()-sized chunks (SQLite parameter limit), deduplicated
// and cleaned. Shared by every scoped per-asset read.
function idChunks(assetIds, size = 500) {
  const unique = [...new Set(assetIds.filter((id) => typeof id === 'string' && id))];
  const chunks = [];
  for (let start = 0; start < unique.length; start += size) {
    chunks.push(unique.slice(start, start + size));
  }
  return chunks;
}

// Grammar-only stopword list for caption term statistics; content-word
// filtering (e.g. "background") is deliberately left to presentation layers.
const CAPTION_STOPWORDS = new Set([
  'the', 'and', 'with', 'are', 'from', 'that', 'this', 'then', 'them', 'they',
  'has', 'have', 'had', 'for', 'its', 'his', 'her', 'she', 'him', 'their',
  'there', 'was', 'were', 'not', 'but', 'can', 'all', 'also', 'into', 'onto',
  'over', 'under', 'near', 'while', 'being', 'been', 'each', 'both', 'some',
  'several', 'two', 'three', 'one', 'other', 'another',
]);

// Sort keys so stored JSON is byte-stable across runs, matching the Python
// implementation's sort_keys=True.
function stableJson(value) {
  return JSON.stringify(sortKeysDeep(value));
}

function boundedNormalizedOutput(value) {
  const serialized = stableJson(value);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_NORMALIZED_OUTPUT_BYTES) {
    throw new RangeError(`Normalized provider output exceeds the ${MAX_NORMALIZED_OUTPUT_BYTES}-byte storage limit.`);
  }
  return serialized;
}

function boundedJobLog(log) {
  if (!Array.isArray(log) || log.length === 0) return null;
  let omitted = Math.max(0, log.length - MAX_JOB_LOG_ENTRIES);
  const entries = log.slice(-MAX_JOB_LOG_ENTRIES).map((entry) => sanitizeDiagnostic(entry));
  const marker = () => `… ${omitted} earlier log entr${omitted === 1 ? 'y' : 'ies'} omitted`;
  while (entries.length > 0) {
    const projected = omitted > 0 ? [marker(), ...entries] : entries;
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') <= MAX_JOB_LOG_BYTES) {
      return projected;
    }
    entries.shift();
    omitted += 1;
  }
  return omitted > 0 ? [marker()] : null;
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeysDeep(value[key])]),
    );
  }
  return value;
}
