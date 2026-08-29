import { DatabaseSync } from 'node:sqlite';

import { addColumnIfMissing, migrateDatabase } from '../migrations.mjs';
import { preparePrivateDatabasePath, restrictPrivateDatabaseModes } from '../privateDatabase.mjs';
import { isValidCalendarDay } from './dates.mjs';

export const MAX_INSIGHTS_TAG_ID_LENGTH = 128;
export const MAX_INSIGHTS_KNOWN_TAGS = 10_000;

// Local cache for Insights. The asset sweep lands here so aggregate stats
// (places, cameras, dark matter) are cheap SQL instead of API storms; the
// finished snapshot is stored as JSON so the page renders instantly.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS swept_assets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  taken_at TEXT,
  year INTEGER,
  day TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  make TEXT,
  model TEXT,
  lens TEXT,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  is_archived INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER,
  lat REAL,
  lon REAL
);
CREATE INDEX IF NOT EXISTS idx_swept_assets_year ON swept_assets (year);
CREATE INDEX IF NOT EXISTS idx_swept_assets_country ON swept_assets (country);
CREATE INDEX IF NOT EXISTS idx_swept_assets_day ON swept_assets (day);
CREATE TABLE IF NOT EXISTS asset_people (
  asset_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (asset_id, person_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_asset_people_person ON asset_people (person_id);
CREATE TABLE IF NOT EXISTS people_stats (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pair_stats (
  person_a TEXT NOT NULL,
  person_b TEXT NOT NULL,
  name_a TEXT NOT NULL,
  name_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (person_a, person_b)
);
CREATE TABLE IF NOT EXISTS tag_stats (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS city_groups (
  city TEXT PRIMARY KEY,
  grp TEXT NOT NULL
) WITHOUT ROWID;
`;

// Migration 1 is the pre-user_version era: v1 databases predate the
// day/lat/lon columns on swept_assets. Old rows stay null until the next
// sweep repopulates everything.
const INSIGHTS_MIGRATIONS = [
  {
    version: 1,
    up(db) {
      addColumnIfMissing(db, 'swept_assets', 'day', 'TEXT');
      addColumnIfMissing(db, 'swept_assets', 'lat', 'REAL');
      addColumnIfMissing(db, 'swept_assets', 'lon', 'REAL');
    },
  },
];

export class InsightsRepository {
  constructor(dbPath) {
    this.dbPath = String(dbPath);
    preparePrivateDatabasePath(this.dbPath);
    this.db = new DatabaseSync(this.dbPath);
    // The sweep cache mirrors private library metadata (people, places,
    // dates) — keep it readable by the server user only, even on a bind
    // mount with a permissive umask. Tolerate failure (exotic filesystems);
    // the warning is enough.
    this.db.exec('PRAGMA journal_mode = WAL');
    restrictPrivateDatabaseModes(this.dbPath);
    migrateDatabase(this.db, { schema: SCHEMA, migrations: INSIGHTS_MIGRATIONS });
    this.locationGroups = [];
    this.groupsByName = new Map();
    this.txDepth = 0;
  }

  close() {
    this.db.close();
  }

  // Re-entrant: nested calls compose into the outermost BEGIN...COMMIT, so
  // the collector's publish step can bundle the sweep swap and every
  // replace* helper (each transactional on its own) into one atomic commit.
  // An inner error propagates to the outermost frame, which rolls back.
  transaction(work) {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return work();
      } finally {
        this.txDepth -= 1;
      }
    }
    this.db.exec('BEGIN');
    this.txDepth = 1;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.txDepth = 0;
    }
  }

  // --- staged sweep ---
  //
  // A refresh never mutates the live sweep while collecting: pages land in
  // staging tables, and only a COMPLETE run swaps them live — inside the
  // collector's single publish transaction, together with every derived
  // table and the snapshot. A failed or cancelled refresh leaves the last
  // good generation (sweep, drill-downs, and snapshot) fully intact.

  beginSweepStaging() {
    this.db.exec(`
      DROP TABLE IF EXISTS swept_assets_staging;
      DROP TABLE IF EXISTS asset_people_staging;
      CREATE TABLE swept_assets_staging AS SELECT * FROM swept_assets WHERE 0;
      CREATE TABLE asset_people_staging AS SELECT * FROM asset_people WHERE 0;
    `);
  }

  commitSweepStaging() {
    this.transaction(() => {
      this.db.exec('DELETE FROM swept_assets');
      this.db.exec('DELETE FROM asset_people');
      // OR REPLACE / OR IGNORE: the staging tables carry no constraints, so
      // an asset repeated across sweep pages collapses here.
      this.db.exec('INSERT OR REPLACE INTO swept_assets SELECT * FROM swept_assets_staging');
      this.db.exec('INSERT OR IGNORE INTO asset_people SELECT * FROM asset_people_staging');
    });
    this.abortSweepStaging();
  }

  abortSweepStaging() {
    this.db.exec('DROP TABLE IF EXISTS swept_assets_staging');
    this.db.exec('DROP TABLE IF EXISTS asset_people_staging');
  }

  // --- location groups (synthetic locations) ---

  // Mirror the settings-defined groups into a lookup table so every city
  // aggregate can LEFT JOIN it and report the group label instead of the raw
  // city. Raw sweep data is untouched; changing groups never needs a resweep.
  setLocationGroups(groups) {
    this.locationGroups = Array.isArray(groups) ? groups : [];
    this.groupsByName = new Map(this.locationGroups.map((group) => [group.name, group]));
    this.transaction(() => {
      this.db.exec('DELETE FROM city_groups');
      const insert = this.db.prepare('INSERT OR REPLACE INTO city_groups (city, grp) VALUES (?, ?)');
      for (const group of this.locationGroups) {
        for (const city of group.cities) {
          insert.run(city, group.name);
        }
      }
    });
  }

  // The cities a place label stands for: a group's members, or the label
  // itself when it is a plain city.
  citiesForPlace(label) {
    return this.groupsByName?.get(label)?.cities ?? [label];
  }

  #decoratePlace(row) {
    const group = this.groupsByName?.get(row.name);
    return {
      name: row.name,
      count: Number(row.count),
      ...(group ? { isGroup: true, members: group.cities } : {}),
    };
  }

  // Every distinct raw city with its dominant state/country (for homonym
  // disambiguation), photo count, geo centroid (for the "add nearby" helper),
  // and current group membership. Feeds the settings group editor.
  citySummaries() {
    const totals = this.db
      .prepare(`
        SELECT city, COUNT(*) AS count, AVG(lat) AS lat, AVG(lon) AS lon
        FROM swept_assets
        WHERE COALESCE(city, '') != ''
        GROUP BY city ORDER BY count DESC
      `)
      .all();
    const regions = this.db
      .prepare(`
        SELECT city, state, country FROM (
          SELECT city, state, country, ROW_NUMBER() OVER (PARTITION BY city ORDER BY COUNT(*) DESC) AS rn
          FROM swept_assets
          WHERE COALESCE(city, '') != ''
          GROUP BY city, state, country
        ) WHERE rn = 1
      `)
      .all();
    const regionByCity = new Map(regions.map((row) => [row.city, row]));
    const groupByCity = new Map();
    for (const group of this.locationGroups ?? []) {
      for (const city of group.cities) {
        groupByCity.set(city, group.name);
      }
    }
    return totals.map((row) => ({
      name: row.city,
      count: Number(row.count),
      state: regionByCity.get(row.city)?.state ?? null,
      country: regionByCity.get(row.city)?.country ?? null,
      lat: row.lat === null ? null : Number(row.lat),
      lon: row.lon === null ? null : Number(row.lon),
      group: groupByCity.get(row.city) ?? null,
    }));
  }

  insertAssets(rows, { staging = false } = {}) {
    const assetTable = staging ? 'swept_assets_staging' : 'swept_assets';
    const peopleTable = staging ? 'asset_people_staging' : 'asset_people';
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO ${assetTable}
        (id, type, taken_at, year, day, city, state, country, make, model, lens, is_favorite, is_archived, file_size, lat, lon)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertPerson = this.db.prepare(
      `INSERT OR IGNORE INTO ${peopleTable} (asset_id, person_id) VALUES (?, ?)`,
    );
    this.transaction(() => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.type,
          row.takenAt ?? null,
          row.year ?? null,
          row.day ?? null,
          row.city ?? null,
          row.state ?? null,
          row.country ?? null,
          row.make ?? null,
          row.model ?? null,
          row.lens ?? null,
          row.isFavorite ? 1 : 0,
          row.isArchived ? 1 : 0,
          row.fileSize ?? null,
          row.lat ?? null,
          row.lon ?? null,
        );
        for (const personId of row.personIds ?? []) {
          insertPerson.run(row.id, personId);
        }
      }
    });
  }

  replacePeople(rows) {
    this.transaction(() => {
      this.db.exec('DELETE FROM people_stats');
      const insert = this.db.prepare('INSERT INTO people_stats (id, name, asset_count) VALUES (?, ?, ?)');
      for (const row of rows) {
        insert.run(row.id, row.name, row.assetCount);
      }
    });
  }

  replacePairs(rows) {
    this.transaction(() => {
      this.db.exec('DELETE FROM pair_stats');
      const insert = this.db.prepare(
        'INSERT INTO pair_stats (person_a, person_b, name_a, name_b, count) VALUES (?, ?, ?, ?, ?)',
      );
      for (const row of rows) {
        insert.run(row.personA, row.personB, row.nameA, row.nameB, row.count);
      }
    });
  }

  replaceTags(rows) {
    this.transaction(() => {
      this.db.exec('DELETE FROM tag_stats');
      const insert = this.db.prepare('INSERT INTO tag_stats (id, value, count) VALUES (?, ?, ?)');
      for (const row of rows) {
        insert.run(row.id, row.value, row.count);
      }
    });
  }

  replaceKnownTagIds(ids) {
    const known = [...new Set((Array.isArray(ids) ? ids : [])
      .map((id) => String(id ?? '').trim())
      .filter((id) => id && id.length <= MAX_INSIGHTS_TAG_ID_LENGTH))]
      .slice(0, MAX_INSIGHTS_KNOWN_TAGS);
    this.transaction(() => {
      // Lens values are generation-bound already. Removing them here also
      // keeps persistent cache keys bounded to tags in the current directory.
      this.db.prepare("DELETE FROM meta WHERE key LIKE 'tagLens:%'").run();
      this.setMeta('knownTagIds', known);
    });
  }

  hasKnownTag(id) {
    const value = String(id ?? '').trim();
    if (!value || value.length > MAX_INSIGHTS_TAG_ID_LENGTH) {
      return false;
    }
    const known = this.getMeta('knownTagIds');
    if (Array.isArray(known)) {
      return known.includes(value);
    }
    // Existing pre-publication databases gain the full directory on their
    // next sweep. Until then, retain lenses for their already-counted tags.
    return this.db.prepare('SELECT 1 FROM tag_stats WHERE id = ?').get(value) !== undefined;
  }

  setMeta(key, value) {
    this.db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getMeta(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    if (!row) {
      return null;
    }
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  // --- aggregates over the sweep ---

  sweepTotals() {
    const byType = this.db
      .prepare('SELECT type, COUNT(*) AS count FROM swept_assets GROUP BY type')
      .all();
    const row = this.db
      .prepare(`
        SELECT COUNT(*) AS total,
               SUM(is_favorite) AS favorites,
               SUM(is_archived) AS archived,
               SUM(COALESCE(file_size, 0)) AS storage,
               MIN(taken_at) AS first_taken,
               MAX(taken_at) AS last_taken
        FROM swept_assets
      `)
      .get();
    const counts = Object.fromEntries(byType.map((entry) => [entry.type, Number(entry.count)]));
    return {
      assetsSwept: Number(row?.total ?? 0),
      photos: counts.IMAGE ?? 0,
      videos: counts.VIDEO ?? 0,
      favorites: Number(row?.favorites ?? 0),
      archived: Number(row?.archived ?? 0),
      storageBytes: Number(row?.storage ?? 0),
      firstTakenAt: row?.first_taken ?? null,
      lastTakenAt: row?.last_taken ?? null,
    };
  }

  yearHistogram() {
    return this.db
      .prepare('SELECT year, COUNT(*) AS count FROM swept_assets WHERE year IS NOT NULL GROUP BY year ORDER BY year')
      .all()
      .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
  }

  topPlaces(limit = 10) {
    const cities = this.db
      .prepare(`
        SELECT COALESCE(g.grp, sa.city) AS name, COUNT(*) AS count
        FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
        WHERE sa.city IS NOT NULL AND sa.city != ''
        GROUP BY name ORDER BY count DESC, name LIMIT ?
      `)
      .all(limit)
      .map((row) => this.#decoratePlace(row));
    const countries = this.db
      .prepare(`
        SELECT country AS name, COUNT(*) AS count FROM swept_assets
        WHERE country IS NOT NULL AND country != ''
        GROUP BY country ORDER BY count DESC LIMIT ?
      `)
      .all(limit)
      .map((row) => ({ name: row.name, count: Number(row.count) }));
    return { cities, countries };
  }

  topCameras(limit = 10) {
    return this.db
      .prepare(`
        SELECT make, model, TRIM(COALESCE(make, '') || ' ' || COALESCE(model, '')) AS name, COUNT(*) AS count
        FROM swept_assets
        WHERE COALESCE(model, '') != ''
        GROUP BY name ORDER BY count DESC LIMIT ?
      `)
      .all(limit)
      .map((row) => ({ name: row.name, make: row.make ?? null, model: row.model ?? null, count: Number(row.count) }));
  }

  darkMatter() {
    const row = this.db
      .prepare(`
        SELECT
          SUM(CASE WHEN COALESCE(city, '') = '' AND COALESCE(country, '') = '' THEN 1 ELSE 0 END) AS no_location,
          SUM(CASE WHEN COALESCE(model, '') = '' THEN 1 ELSE 0 END) AS no_camera
        FROM swept_assets
      `)
      .get();
    return {
      noLocation: Number(row?.no_location ?? 0),
      noCamera: Number(row?.no_camera ?? 0),
    };
  }

  topPeople(limit = 15) {
    return this.db
      .prepare('SELECT id, name, asset_count FROM people_stats ORDER BY asset_count DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.asset_count) }));
  }

  topPairs(limit = 10) {
    return this.db
      .prepare('SELECT person_a, person_b, name_a, name_b, count FROM pair_stats ORDER BY count DESC LIMIT ?')
      .all(limit)
      .map((row) => ({
        aId: row.person_a,
        bId: row.person_b,
        aName: row.name_a,
        bName: row.name_b,
        count: Number(row.count),
      }));
  }

  topTags(limit = 20) {
    return this.db
      .prepare('SELECT id, value, count FROM tag_stats ORDER BY count DESC LIMIT ?')
      .all(limit)
      .map((row) => ({ id: row.id, value: row.value, count: Number(row.count) }));
  }

  // --- people from the sweep join table ---

  // Asset counts for the given people, straight from the local join table.
  // Replaces the per-person Immich statistics calls of v1/v2. `staging`
  // counts against the in-flight sweep instead of the live one, so derived
  // stats describe the generation being built, not the one being replaced —
  // the table name is a boolean-picked constant, never caller input.
  personCountsFor(personIds, { staging = false } = {}) {
    if (personIds.length === 0) {
      return new Map();
    }
    const table = staging ? 'asset_people_staging' : 'asset_people';
    const placeholders = personIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`
        SELECT person_id, COUNT(*) AS count FROM ${table}
        WHERE person_id IN (${placeholders})
        GROUP BY person_id
      `)
      .all(...personIds);
    return new Map(rows.map((row) => [row.person_id, Number(row.count)]));
  }

  // All co-occurrence pairs among named people (people_stats must be
  // populated first — it defines "named"). Local SQL replaces the pairwise
  // Immich statistics calls, and covers every pair, not just the top few.
  pairsFromSweep(limit = 100) {
    return this.db
      .prepare(`
        SELECT a.person_id AS person_a, b.person_id AS person_b,
               pa.name AS name_a, pb.name AS name_b, COUNT(*) AS count
        FROM asset_people a
        JOIN asset_people b ON b.asset_id = a.asset_id AND b.person_id > a.person_id
        JOIN people_stats pa ON pa.id = a.person_id
        JOIN people_stats pb ON pb.id = b.person_id
        GROUP BY a.person_id, b.person_id
        ORDER BY count DESC
        LIMIT ?
      `)
      .all(limit)
      .map((row) => ({
        personA: row.person_a,
        personB: row.person_b,
        nameA: row.name_a,
        nameB: row.name_b,
        count: Number(row.count),
      }));
  }

  personYearHistogram(personId) {
    return this.db
      .prepare(`
        SELECT sa.year AS year, COUNT(*) AS count
        FROM asset_people ap JOIN swept_assets sa ON sa.id = ap.asset_id
        WHERE ap.person_id = ? AND sa.year IS NOT NULL
        GROUP BY sa.year ORDER BY sa.year
      `)
      .all(personId)
      .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
  }

  placeYearHistogram({ city = null, country = null }) {
    if (city !== null) {
      // Matches a group label as well as a raw city.
      return this.db
        .prepare(`
          SELECT sa.year AS year, COUNT(*) AS count
          FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
          WHERE COALESCE(g.grp, sa.city) = ? AND sa.year IS NOT NULL
          GROUP BY sa.year ORDER BY sa.year
        `)
        .all(city)
        .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
    }
    return this.db
      .prepare(`
        SELECT year, COUNT(*) AS count FROM swept_assets
        WHERE country = ? AND year IS NOT NULL
        GROUP BY year ORDER BY year
      `)
      .all(country)
      .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
  }

  // Named people ranked within one year — local replacement for the year
  // drill-down's live Immich statistics calls.
  peopleForYear(year, limit = 15) {
    return this.db
      .prepare(`
        SELECT ps.id AS id, ps.name AS name, COUNT(*) AS count
        FROM asset_people ap
        JOIN swept_assets sa ON sa.id = ap.asset_id
        JOIN people_stats ps ON ps.id = ap.person_id
        WHERE sa.year = ?
        GROUP BY ps.id ORDER BY count DESC, ps.name LIMIT ?
      `)
      .all(year, limit)
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.count) }));
  }

  // The month-scoped variant, for the year panel's month drill. Month
  // filtering matches the months histogram: the year index plus the day
  // column's MM digits, so a NULL day never matches.
  peopleForMonth(year, month, limit = 15) {
    return this.db
      .prepare(`
        SELECT ps.id AS id, ps.name AS name, COUNT(*) AS count
        FROM asset_people ap
        JOIN swept_assets sa ON sa.id = ap.asset_id
        JOIN people_stats ps ON ps.id = ap.person_id
        WHERE sa.year = ? AND SUBSTR(sa.day, 6, 2) = ?
        GROUP BY ps.id ORDER BY count DESC, ps.name LIMIT ?
      `)
      .all(year, String(month).padStart(2, '0'), limit)
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.count) }));
  }

  // Everything the person card needs, from the local sweep: totals, the
  // first/last time they appear, where they're photographed most, and the
  // people they share the most photos with. One person at a time, so plain
  // indexed queries are plenty fast even for the most photographed person.
  personDetail(personId, connectionLimit = 10) {
    const person = this.db
      .prepare('SELECT id, name, asset_count FROM people_stats WHERE id = ?')
      .get(personId);
    if (!person) {
      return null;
    }
    const span = this.db
      .prepare(`
        SELECT MIN(sa.day) AS first_day, MAX(sa.day) AS last_day
        FROM asset_people ap JOIN swept_assets sa ON sa.id = ap.asset_id
        WHERE ap.person_id = ? AND sa.day IS NOT NULL AND sa.day >= '1900-01-01'
      `)
      .get(personId);
    const places = this.db
      .prepare(`
        SELECT COALESCE(g.grp, sa.city) AS name, COUNT(*) AS count
        FROM asset_people ap
        JOIN swept_assets sa ON sa.id = ap.asset_id
        LEFT JOIN city_groups g ON g.city = sa.city
        WHERE ap.person_id = ? AND COALESCE(sa.city, '') != ''
        GROUP BY name ORDER BY count DESC, name LIMIT 5
      `)
      .all(personId)
      .map((row) => this.#decoratePlace(row));
    const connections = this.db
      .prepare(`
        SELECT b.person_id AS id, ps.name AS name, COUNT(*) AS count
        FROM asset_people a
        JOIN asset_people b ON b.asset_id = a.asset_id AND b.person_id != a.person_id
        JOIN people_stats ps ON ps.id = b.person_id
        WHERE a.person_id = ?
        GROUP BY b.person_id ORDER BY count DESC, ps.name LIMIT ?
      `)
      .all(personId, connectionLimit)
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.count) }));
    return {
      id: person.id,
      name: person.name,
      count: Number(person.asset_count),
      firstDay: span?.first_day ?? null,
      lastDay: span?.last_day ?? null,
      years: this.personYearHistogram(personId),
      places,
      connections,
    };
  }

  // Everything the location card needs, for a raw city or a group label:
  // totals, first/last dates, per-year counts, the people photographed there,
  // and (for groups) the member breakdown. All local SQL over the sweep.
  placeDetail(label, peopleLimit = 10) {
    const cities = this.citiesForPlace(label);
    const group = this.groupsByName.get(label) ?? null;
    const marks = cities.map(() => '?').join(', ');
    const totals = this.db
      .prepare(`SELECT COUNT(*) AS count FROM swept_assets WHERE city IN (${marks})`)
      .get(...cities);
    const count = Number(totals?.count ?? 0);
    if (count === 0) {
      return null;
    }
    const span = this.db
      .prepare(`
        SELECT MIN(day) AS first_day, MAX(day) AS last_day FROM swept_assets
        WHERE city IN (${marks}) AND day IS NOT NULL AND day >= '1900-01-01'
      `)
      .get(...cities);
    const years = this.db
      .prepare(`
        SELECT year, COUNT(*) AS count FROM swept_assets
        WHERE city IN (${marks}) AND year IS NOT NULL
        GROUP BY year ORDER BY year
      `)
      .all(...cities)
      .map((row) => ({ year: Number(row.year), count: Number(row.count) }));
    const people = this.db
      .prepare(`
        SELECT ps.id AS id, ps.name AS name, COUNT(*) AS count
        FROM asset_people ap
        JOIN swept_assets sa ON sa.id = ap.asset_id
        JOIN people_stats ps ON ps.id = ap.person_id
        WHERE sa.city IN (${marks})
        GROUP BY ps.id ORDER BY count DESC, ps.name LIMIT ?
      `)
      .all(...cities, peopleLimit)
      .map((row) => ({ id: row.id, name: row.name, count: Number(row.count) }));
    const busiestDay = this.db
      .prepare(`
        SELECT day, COUNT(*) AS count FROM swept_assets
        WHERE city IN (${marks}) AND day IS NOT NULL AND day >= '1900-01-01'
        GROUP BY day ORDER BY count DESC, day DESC LIMIT 1
      `)
      .get(...cities);
    const country = this.db
      .prepare(`
        SELECT country FROM (
          SELECT country, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rn
          FROM swept_assets
          WHERE city IN (${marks}) AND COALESCE(country, '') != ''
          GROUP BY country
        ) WHERE rn = 1
      `)
      .get(...cities);
    const members = group
      ? this.db
          .prepare(`
            SELECT city AS name, COUNT(*) AS count FROM swept_assets
            WHERE city IN (${marks})
            GROUP BY city ORDER BY count DESC
          `)
          .all(...cities)
          .map((row) => ({ name: row.name, count: Number(row.count) }))
      : null;
    return {
      name: label,
      isGroup: Boolean(group),
      cities,
      country: country?.country ?? null,
      count,
      firstDay: span?.first_day ?? null,
      lastDay: span?.last_day ?? null,
      years,
      people,
      busiestDay: busiestDay ? { day: busiestDay.day, count: Number(busiestDay.count) } : null,
      members,
    };
  }

  // Per-day rollup for the timeline: photo count, the day's dominant city
  // (and its country), and the centroid of its DOMINANT ~11km geo cell — not
  // the mean of all coordinates, which lands mid-ocean on days photographed
  // in two distant places.
  timelineDays() {
    const counts = this.db
      .prepare(`
        SELECT day, COUNT(*) AS count, COUNT(lat) AS geo_count
        FROM swept_assets
        WHERE day IS NOT NULL AND day >= '1900-01-01' AND strftime('%Y-%m-%d', day) = day
        GROUP BY day ORDER BY day
      `)
      .all();
    const cells = this.db
      .prepare(`
        SELECT day, alat, alon FROM (
          SELECT day, ROUND(lat, 1) AS rlat, ROUND(lon, 1) AS rlon,
                 AVG(lat) AS alat, AVG(lon) AS alon,
                 ROW_NUMBER() OVER (PARTITION BY day ORDER BY COUNT(*) DESC) AS rn
          FROM swept_assets
          WHERE day IS NOT NULL AND strftime('%Y-%m-%d', day) = day AND lat IS NOT NULL
          GROUP BY day, rlat, rlon
        ) WHERE rn = 1
      `)
      .all();
    const cellByDay = new Map(cells.map((row) => [row.day, row]));
    const cities = this.db
      .prepare(`
        SELECT day, city, country FROM (
          SELECT sa.day AS day, COALESCE(g.grp, sa.city) AS city, sa.country AS country, COUNT(*) AS cnt,
                 ROW_NUMBER() OVER (PARTITION BY sa.day ORDER BY COUNT(*) DESC) AS rn
          FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
          WHERE sa.day IS NOT NULL AND strftime('%Y-%m-%d', sa.day) = sa.day AND COALESCE(sa.city, '') != ''
          GROUP BY sa.day, COALESCE(g.grp, sa.city), sa.country
        ) WHERE rn = 1
      `)
      .all();
    const cityByDay = new Map(cities.map((row) => [row.day, row]));
    return counts.map((row) => {
      const place = cityByDay.get(row.day);
      const cell = cellByDay.get(row.day);
      return {
        day: row.day,
        count: Number(row.count),
        city: place?.city ?? null,
        country: place?.country ?? null,
        lat: cell ? Number(cell.alat) : null,
        lon: cell ? Number(cell.alon) : null,
      };
    });
  }

  // Per-day, per-place photo counts for a window — the truth behind the
  // timeline's Locations list. Unlike the day rollup (one dominant label
  // carries the whole day), these count each photo under its own label, and
  // images only, so the list agrees with what clicking a place actually
  // opens. Rows without a city fall back to their country label; rows with
  // no location at all come back with a NULL label (the "No location" row).
  timelinePlaces(from, to) {
    return this.db
      .prepare(`
        SELECT sa.day AS day,
               NULLIF(COALESCE(NULLIF(COALESCE(g.grp, sa.city), ''), sa.country, ''), '') AS label,
               MAX(CASE WHEN COALESCE(sa.city, '') != '' THEN 1 ELSE 0 END) AS is_city,
               COUNT(*) AS count
        FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
        WHERE sa.day >= ? AND sa.day <= ? AND strftime('%Y-%m-%d', sa.day) = sa.day AND sa.type = 'IMAGE'
        GROUP BY sa.day, NULLIF(COALESCE(NULLIF(COALESCE(g.grp, sa.city), ''), sa.country, ''), '')
        ORDER BY sa.day
      `)
      .all(String(from), String(to))
      .map((row) => ({
        day: row.day,
        label: row.label ?? null,
        isCity: Boolean(row.is_city),
        count: Number(row.count),
      }));
  }

  // --- superlatives ---

  busiestDays(limit = 5) {
    return this.db
      .prepare(`
        SELECT day, COUNT(*) AS count FROM swept_assets
        WHERE day IS NOT NULL AND strftime('%Y-%m-%d', day) = day
        GROUP BY day ORDER BY count DESC, day DESC LIMIT ?
      `)
      .all(limit)
      .map((row) => ({ day: row.day, count: Number(row.count) }));
  }

  busiestMonths(limit = 5) {
    return this.db
      .prepare(`
        SELECT SUBSTR(day, 1, 7) AS month, COUNT(*) AS count FROM swept_assets
        WHERE day IS NOT NULL AND strftime('%Y-%m-%d', day) = day
        GROUP BY month ORDER BY count DESC, month DESC LIMIT ?
      `)
      .all(limit)
      .map((row) => ({ month: row.month, count: Number(row.count) }));
  }

  // Distinct shooting days in order; the longest-gap superlative walks these
  // in JS. Pre-1900 "days" are scanner/EXIF garbage, not photographs.
  distinctDays() {
    return this.db
      .prepare("SELECT DISTINCT day FROM swept_assets WHERE day IS NOT NULL AND day >= '1900-01-01' AND strftime('%Y-%m-%d', day) = day ORDER BY day")
      .all()
      .map((row) => row.day);
  }

  oldestAsset() {
    const row = this.db
      .prepare(`
        SELECT id, taken_at, day, city, country FROM swept_assets
        WHERE taken_at IS NOT NULL AND year >= 1900 AND strftime('%Y-%m-%d', day) = day
        ORDER BY taken_at ASC LIMIT 1
      `)
      .get();
    return row
      ? { id: row.id, takenAt: row.taken_at, day: row.day ?? null, city: row.city ?? null, country: row.country ?? null }
      : null;
  }

  geoRows() {
    return this.db
      .prepare(`
        SELECT id, day, city, country, lat, lon FROM swept_assets
        WHERE lat IS NOT NULL AND lon IS NOT NULL AND NOT (lat = 0 AND lon = 0)
      `)
      .all()
      .map((row) => ({
        id: row.id,
        day: isValidCalendarDay(row.day) ? row.day : null,
        city: row.city ?? null,
        country: row.country ?? null,
        lat: Number(row.lat),
        lon: Number(row.lon),
      }));
  }

  // Everything the year drill-down can answer from the local sweep; the
  // per-year people counts come from live Immich queries in the route.
  yearDetail(year) {
    const totals = this.db
      .prepare('SELECT COUNT(*) AS count, SUM(is_favorite) AS favorites FROM swept_assets WHERE year = ?')
      .get(year);
    const months = this.db
      .prepare(`
        SELECT SUBSTR(day, 6, 2) AS month, COUNT(*) AS count FROM swept_assets
        WHERE year = ? AND day IS NOT NULL
        GROUP BY month ORDER BY month
      `)
      .all(year)
      .map((row) => ({ month: Number(row.month), count: Number(row.count) }));
    const cities = this.db
      .prepare(`
        SELECT COALESCE(g.grp, sa.city) AS name, COUNT(*) AS count
        FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
        WHERE sa.year = ? AND COALESCE(sa.city, '') != ''
        GROUP BY name ORDER BY count DESC LIMIT 5
      `)
      .all(year)
      .map((row) => this.#decoratePlace(row));
    const countries = this.db
      .prepare(`
        SELECT country AS name, COUNT(*) AS count FROM swept_assets
        WHERE year = ? AND COALESCE(country, '') != ''
        GROUP BY country ORDER BY count DESC LIMIT 5
      `)
      .all(year)
      .map((row) => ({ name: row.name, count: Number(row.count) }));
    const cameras = this.db
      .prepare(`
        SELECT TRIM(COALESCE(make, '') || ' ' || COALESCE(model, '')) AS name, COUNT(*) AS count
        FROM swept_assets
        WHERE year = ? AND COALESCE(model, '') != ''
        GROUP BY name ORDER BY count DESC LIMIT 3
      `)
      .all(year)
      .map((row) => ({ name: row.name, count: Number(row.count) }));
    const busiestDay = this.db
      .prepare(`
        SELECT day, COUNT(*) AS count FROM swept_assets
        WHERE year = ? AND day IS NOT NULL
        GROUP BY day ORDER BY count DESC, day DESC LIMIT 1
      `)
      .get(year);
    return {
      year,
      count: Number(totals?.count ?? 0),
      favorites: Number(totals?.favorites ?? 0),
      months,
      cities,
      countries,
      cameras,
      busiestDay: busiestDay ? { day: busiestDay.day, count: Number(busiestDay.count) } : null,
    };
  }

  // One month inside the year drill-down: the total and top places, scoped
  // like yearDetail; the people counts come from peopleForMonth in the route.
  monthDetail(year, month) {
    const mm = String(month).padStart(2, '0');
    const totals = this.db
      .prepare('SELECT COUNT(*) AS count FROM swept_assets WHERE year = ? AND SUBSTR(day, 6, 2) = ?')
      .get(year, mm);
    const cities = this.db
      .prepare(`
        SELECT COALESCE(g.grp, sa.city) AS name, COUNT(*) AS count
        FROM swept_assets sa LEFT JOIN city_groups g ON g.city = sa.city
        WHERE sa.year = ? AND SUBSTR(sa.day, 6, 2) = ? AND COALESCE(sa.city, '') != ''
        GROUP BY name ORDER BY count DESC LIMIT 5
      `)
      .all(year, mm)
      .map((row) => this.#decoratePlace(row));
    return { year, month, count: Number(totals?.count ?? 0), cities };
  }
}
