import { CALIBRATION_MATCH } from './calibration.mjs';
import { EmbeddingServiceError } from './client.mjs';
import { cosineSimilarity, decodeStoredVector, decodeVector, encodeHalfVector, encodeVector } from './vectors.mjs';

// Permanent Pictaria-owned image embeddings (schema 22). A space is one set of
// mutually comparable vectors: backend, model, dimensions and the calibration
// vector the service returned when the space was created. Vectors from
// different spaces are never compared.
//
// Source identity: the SHA-256 of the exact preview bytes embedded, plus the
// photo's original checksum and Immich thumbhash when they were embedded. A
// vector is current while the photo is present and both recorded values still
// match. Immich uses the thumbhash as its own thumbnail cache key, so edits,
// rotations and regenerated previews with different content read as stale.
// Whenever Enrich has the preview bytes again, their hash is compared too, so
// a regenerated preview with unchanged thumbhash (for example after changing
// Immich's preview size or format) is re-embedded at that point.
export const EMBEDDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS embedding_spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  backend TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL CHECK(dims BETWEEN 1 AND 4096),
  calibration_version INTEGER NOT NULL,
  calibration BLOB NOT NULL,
  created_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_embedding_spaces_model
  ON embedding_spaces(backend, model, verified_at DESC);
CREATE TABLE IF NOT EXISTS asset_embeddings (
  asset_id TEXT NOT NULL,
  space_id INTEGER NOT NULL REFERENCES embedding_spaces(id),
  source_checksum TEXT,
  source_thumbhash TEXT,
  image_sha256 TEXT NOT NULL,
  vector BLOB NOT NULL CHECK(length(vector) BETWEEN 4 AND 16384),
  created_at TEXT NOT NULL,
  PRIMARY KEY (asset_id, space_id)
);
CREATE INDEX IF NOT EXISTS idx_asset_embeddings_space ON asset_embeddings(space_id, asset_id);
`;

// SQL predicate over asset_embeddings e joined to assets a.
const CURRENT = 'a.missing_since IS NULL AND a.checksum IS e.source_checksum AND a.thumbhash IS e.source_thumbhash';
// Enriched photos: a successful enrichment, still in Immich, not discarded.
const ENRICHED = `FROM assets a JOIN latest_success ls ON ls.asset_id=a.asset_id
  WHERE a.missing_since IS NULL AND a.enrich_discarded_at IS NULL`;
// Correlated check that photo a has a current vector in space ?.
const HAS_CURRENT = `EXISTS (SELECT 1 FROM asset_embeddings e WHERE e.asset_id=a.asset_id AND e.space_id=?
  AND a.checksum IS e.source_checksum AND a.thumbhash IS e.source_thumbhash)`;
// Newest capture first; photos without a capture time last.
const CAPTURE_ORDER = `COALESCE(a.file_created_at, '')`;

export const EMBEDDING_STORE_LIMITS = Object.freeze({
  // A service whose output changes on every run would otherwise add a space
  // (and re-embed everything) each time. Stop and say so instead.
  spacesPerModel: 8,
  lookupChunk: 500,
  coverageCacheMs: 15_000,
  // Enriched-photo counts and the set list: short, so a new Enrich run or a
  // finished backfill shows promptly, while Settings polls during a backfill.
  statusCacheMs: 2_000,
});

export class EmbeddingStore {
  constructor(db, { limits = EMBEDDING_STORE_LIMITS, now = Date.now } = {}) {
    this.db = db;
    this.limits = limits;
    this.now = now;
    this.coverageCache = null;
  }

  // Read-only: the stored space this calibration vector belongs to, if any.
  matchSpace({ backend, model, calibrationVersion, calibration }) {
    const rows = this.db.prepare(`SELECT id, dims, calibration, created_at, verified_at FROM embedding_spaces
      WHERE backend=? AND model=? AND calibration_version=? AND dims=? ORDER BY verified_at DESC, id DESC`)
      .all(backend, model, calibrationVersion, calibration.length);
    for (const row of rows) {
      const similarity = cosineSimilarity(decodeVector(row.calibration), calibration);
      if (similarity !== null && similarity >= CALIBRATION_MATCH) {
        return { id: row.id, backend, model, dims: row.dims, createdAt: row.created_at, verifiedAt: row.verified_at, similarity };
      }
    }
    return null;
  }

  // Reuse the matching space or start a new one. Never merges spaces: changed
  // service output is a different space even under the same model name.
  resolveSpace({ backend, model, calibrationVersion, calibration, now = new Date().toISOString() }) {
    const match = this.matchSpace({ backend, model, calibrationVersion, calibration });
    if (match) {
      this.db.prepare('UPDATE embedding_spaces SET verified_at=? WHERE id=?').run(now, match.id);
      return { ...match, verifiedAt: now, created: false, replacesEarlier: false };
    }
    const earlier = this.db.prepare('SELECT COUNT(*) AS n FROM embedding_spaces WHERE backend=? AND model=?').get(backend, model).n;
    if (earlier >= this.limits.spacesPerModel) {
      throw new EmbeddingServiceError(
        `The machine-learning service has returned ${earlier} different sets of vectors for ${model}; embeddings are paused until its output is stable.`,
        'ml_unstable_output',
      );
    }
    const result = this.db.prepare(`INSERT INTO embedding_spaces
      (backend, model, dims, calibration_version, calibration, created_at, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(backend, model, calibration.length, calibrationVersion, encodeVector(calibration), now, now);
    this.coverageCache = null;
    return { id: Number(result.lastInsertRowid), backend, model, dims: calibration.length, createdAt: now, verifiedAt: now,
      created: true, replacesEarlier: earlier > 0 };
  }

  latestSpace({ backend, model }) {
    const row = this.db.prepare(`SELECT id, dims, created_at, verified_at FROM embedding_spaces
      WHERE backend=? AND model=? ORDER BY verified_at DESC, id DESC LIMIT 1`).get(backend, model);
    return row ? { id: row.id, backend, model, dims: row.dims, createdAt: row.created_at, verifiedAt: row.verified_at } : null;
  }

  // Identity of the rendition Enrich just recorded for this photo. Captured
  // before embedding so a later Immich edit makes the stored vector stale.
  sourceOf(assetId) {
    const row = this.db.prepare('SELECT checksum, thumbhash FROM assets WHERE asset_id=?').get(assetId);
    return { checksum: row?.checksum ?? null, thumbhash: row?.thumbhash ?? null };
  }

  // With imageSha256 (the bytes in hand), currency is exact; without it, it
  // rests on the recorded checksum/thumbhash described above.
  isCurrent(assetId, spaceId, { imageSha256 = null } = {}) {
    return this.db.prepare(`SELECT 1 FROM asset_embeddings e JOIN assets a ON a.asset_id=e.asset_id
      WHERE e.asset_id=? AND e.space_id=? AND ${CURRENT} AND (? IS NULL OR e.image_sha256=?)`)
      .get(assetId, spaceId, imageSha256, imageSha256) !== undefined;
  }

  // Identical preview bytes under changed metadata (an edit can change the
  // thumbhash without touching the unedited preview): record the new identity
  // instead of asking the service for the same vector again.
  adopt({ assetId, spaceId, source, imageSha256 }) {
    const result = this.db.prepare(`UPDATE asset_embeddings SET source_checksum=?, source_thumbhash=?
      WHERE asset_id=? AND space_id=? AND image_sha256=?`)
      .run(source.checksum ?? null, source.thumbhash ?? null, assetId, spaceId, imageSha256);
    return Number(result.changes) > 0;
  }

  save({ assetId, spaceId, source, imageSha256, vector, now = new Date().toISOString() }) {
    const space = this.db.prepare('SELECT dims FROM embedding_spaces WHERE id=?').get(spaceId);
    const encoded = encodeHalfVector(vector);
    if (!space || space.dims !== vector.length || encoded.length !== space.dims * 2) {
      throw new EmbeddingServiceError('The embedding does not match its stored space.', 'ml_output_changed');
    }
    if (!/^[0-9a-f]{64}$/.test(imageSha256)) throw new Error('image_sha256 must be a lowercase SHA-256 hex digest.');
    this.db.prepare(`INSERT INTO asset_embeddings
      (asset_id, space_id, source_checksum, source_thumbhash, image_sha256, vector, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(asset_id, space_id) DO UPDATE SET source_checksum=excluded.source_checksum,
        source_thumbhash=excluded.source_thumbhash, image_sha256=excluded.image_sha256,
        vector=excluded.vector, created_at=excluded.created_at`)
      .run(assetId, spaceId, source.checksum ?? null, source.thumbhash ?? null, imageSha256, encoded, now);
  }

  // Current vectors for explicit photos in one space. Stale or missing photos
  // are simply absent: callers treat them as unknown evidence.
  vectors(spaceId, assetIds) {
    const found = new Map();
    const ids = [...new Set(assetIds)];
    for (let i = 0; i < ids.length; i += this.limits.lookupChunk) {
      const chunk = ids.slice(i, i + this.limits.lookupChunk);
      // Stored rows are re-validated on read: exact length for the space
      // (float16, or float32 rows written before float16).
      const rows = this.db.prepare(`SELECT e.asset_id, e.vector, s.dims FROM asset_embeddings e
        JOIN assets a ON a.asset_id=e.asset_id JOIN embedding_spaces s ON s.id=e.space_id
        WHERE e.space_id=? AND e.asset_id IN (${chunk.map(() => '?').join(',')})
          AND ${CURRENT} AND length(e.vector) IN (s.dims*2, s.dims*4)`).all(spaceId, ...chunk);
      for (const row of rows) {
        const vector = decodeStoredVector(row.vector, row.dims);
        if (vector) found.set(row.asset_id, vector);
      }
    }
    return found;
  }

  // Identity of each photo's current vector (the exact preview hash and when
  // it was stored), without reading the vectors. Curate compares these to
  // know when a cached grouping saw different embeddings.
  currentKeys(spaceId, assetIds) {
    const found = new Map();
    const ids = [...new Set(assetIds)];
    for (let i = 0; i < ids.length; i += this.limits.lookupChunk) {
      const chunk = ids.slice(i, i + this.limits.lookupChunk);
      const rows = this.db.prepare(`SELECT e.asset_id, e.image_sha256, e.created_at FROM asset_embeddings e
        JOIN assets a ON a.asset_id=e.asset_id
        WHERE e.space_id=? AND e.asset_id IN (${chunk.map(() => '?').join(',')}) AND ${CURRENT}`).all(spaceId, ...chunk);
      for (const row of rows) found.set(row.asset_id, `${row.image_sha256}:${row.created_at}`);
    }
    return found;
  }

  // Changes whenever a vector in the space is stored or replaced.
  spaceRevision(spaceId) {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS at FROM asset_embeddings WHERE space_id=?').get(spaceId);
    return `${row.n}:${row.at ?? ''}`;
  }

  // Status-line counts; cached briefly because the Enrich page polls.
  coverage({ backend, model }) {
    const cached = this.coverageCache;
    if (cached && cached.model === model && cached.backend === backend && this.now() - cached.at < this.limits.coverageCacheMs) {
      return cached.value;
    }
    const space = this.latestSpace({ backend, model });
    const counts = space ? this.db.prepare(`SELECT COUNT(*) AS vectors,
        COALESCE(SUM(CASE WHEN a.asset_id IS NOT NULL AND ${CURRENT} THEN 1 ELSE 0 END), 0) AS current
      FROM asset_embeddings e LEFT JOIN assets a ON a.asset_id=e.asset_id WHERE e.space_id=?`).get(space.id) : null;
    const other = this.db.prepare('SELECT COUNT(*) AS n FROM asset_embeddings WHERE space_id IS NOT ?').get(space?.id ?? null).n;
    const value = {
      space: space ? { dims: space.dims, createdAt: space.createdAt, verifiedAt: space.verifiedAt } : null,
      vectors: counts?.vectors ?? 0,
      current: counts?.current ?? 0,
      otherVectors: other,
    };
    this.coverageCache = { backend, model, at: this.now(), value };
    return value;
  }

  // How many enriched photos have a current vector in the model's current
  // space. Cached like coverage, since Settings polls while a backfill runs.
  enrichedCoverage({ backend, model }) {
    const cached = this.enrichedCache;
    if (cached && cached.model === model && cached.backend === backend && this.now() - cached.at < this.limits.statusCacheMs) {
      return cached.value;
    }
    const space = this.latestSpace({ backend, model });
    const total = this.db.prepare(`SELECT COUNT(*) AS n ${ENRICHED}`).get().n;
    const current = space ? this.db.prepare(`SELECT COUNT(*) AS n ${ENRICHED} AND ${HAS_CURRENT}`).get(space.id).n : 0;
    const value = { total, current, missing: total - current };
    this.enrichedCache = { backend, model, at: this.now(), value };
    return value;
  }

  // Enriched photos without a current vector in this space, newest capture
  // first, one page at a time. `after` is the last row of the previous page.
  // Capture times can change between pages, so a caller that must see every
  // photo walks again from the top (EmbeddingBackfill does).
  missingEnriched(spaceId, { after = null, limit = 200 } = {}) {
    const rows = after
      ? this.db.prepare(`SELECT a.asset_id AS assetId, ${CAPTURE_ORDER} AS capturedAt ${ENRICHED} AND NOT ${HAS_CURRENT}
          AND (${CAPTURE_ORDER}, a.asset_id) < (?, ?) ORDER BY ${CAPTURE_ORDER} DESC, a.asset_id DESC LIMIT ?`)
        .all(spaceId, after.capturedAt, after.assetId, limit)
      : this.db.prepare(`SELECT a.asset_id AS assetId, ${CAPTURE_ORDER} AS capturedAt ${ENRICHED} AND NOT ${HAS_CURRENT}
          ORDER BY ${CAPTURE_ORDER} DESC, a.asset_id DESC LIMIT ?`).all(spaceId, limit);
    return rows.map((row) => ({ assetId: row.assetId, capturedAt: row.capturedAt }));
  }

  countMissingEnriched(spaceId) {
    return this.db.prepare(`SELECT COUNT(*) AS n ${ENRICHED} AND NOT ${HAS_CURRENT}`).get(spaceId).n;
  }

  // Every stored set with its photo counts, for Settings. A set in use is the
  // selected model's latest; others are kept but never mixed with it.
  sets({ backend, model }) {
    const cached = this.setsCache;
    if (cached && cached.model === model && cached.backend === backend && this.now() - cached.at < this.limits.statusCacheMs) {
      return cached.value;
    }
    const inUse = this.latestSpace({ backend, model })?.id ?? null;
    const value = this.db.prepare(`SELECT s.id, s.model, s.dims, s.created_at AS createdAt, s.verified_at AS verifiedAt,
        COUNT(e.asset_id) AS vectors,
        COALESCE(SUM(CASE WHEN a.asset_id IS NOT NULL AND ${CURRENT} THEN 1 ELSE 0 END), 0) AS current
      FROM embedding_spaces s LEFT JOIN asset_embeddings e ON e.space_id=s.id LEFT JOIN assets a ON a.asset_id=e.asset_id
      WHERE s.backend=? GROUP BY s.id ORDER BY s.id=? DESC, s.verified_at DESC, s.id DESC`).all(backend, inUse)
      .map((row) => ({ ...row, inUse: row.id === inUse, latestForModel: false }))
      .map((row, _, all) => ({ ...row, latestForModel: !all.some((other) => other.model === row.model && (other.verifiedAt > row.verifiedAt
        || (other.verifiedAt === row.verifiedAt && other.id > row.id))) }));
    this.setsCache = { backend, model, at: this.now(), value };
    return value;
  }
}
