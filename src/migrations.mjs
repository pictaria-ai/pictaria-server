// Numbered schema migrations on PRAGMA user_version, shared by Pictaria's
// SQLite databases. The contract:
//
// - The base schema (CREATE TABLE IF NOT EXISTS ...) always describes the
//   CURRENT shape and is exec'd on every boot.
// - A brand-new database gets the base schema and is stamped at the latest
//   migration version — migrations never run against it.
// - An existing database runs every migration numbered above its stamp, in
//   order, and carries the new stamp — BEFORE the base schema is exec'd, so
//   ALTERs land before the base schema's indexes reference the new columns.
//   Each migration and its user_version stamp commit as ONE transaction, so
//   a crash mid-migration rolls back to the prior version instead of leaving
//   changed schema under an old stamp. Migrations must therefore never issue
//   their own BEGIN/COMMIT (use SAVEPOINT if a migration needs partial
//   rollback internally).
//   A migration that needs base-schema tables mid-flight (seeding a table
//   the same upgrade creates) execs the schema itself. Databases from before
//   this runner existed read as version 0, and each DB's migration 1 is
//   exactly the old probe-based fixups, so they land unchanged.
// - `prepare(db)` runs against the pre-boot shape of an existing database;
//   its result is passed to every migration. Use it for decisions that need
//   to know what existed before boot touched anything (e.g. "was this table
//   just created?" seeding).
//
// frame.db (display ledger + voice counters) deliberately still uses plain
// IF NOT EXISTS creation: it is opened by two modules, and two handles
// stamping one user_version would fight. When frame.db first needs an ALTER,
// move both tables behind a single migrateDatabase call in one place.

export function migrateDatabase(db, { schema, migrations = [], prepare = () => ({}) }) {
  let previous = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previous) {
      throw new Error(`migrations must have ascending integer versions; saw ${migration.version} after ${previous}`);
    }
    previous = migration.version;
  }

  const fresh = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")
    .get().n === 0;
  const latest = migrations.length > 0 ? migrations[migrations.length - 1].version : 0;
  const from = getUserVersion(db);

  if (fresh) {
    db.exec(schema);
    if (latest > 0) {
      setUserVersion(db, latest);
    }
    return { fresh: true, from, applied: [] };
  }

  const context = prepare(db);
  const applied = [];
  for (const migration of migrations) {
    if (migration.version <= from) {
      continue;
    }
    db.exec('BEGIN');
    try {
      migration.up(db, context);
      setUserVersion(db, migration.version);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
  }
  db.exec(schema);
  return { fresh: false, from, applied };
}

export function getUserVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version);
}

function setUserVersion(db, version) {
  db.exec(`PRAGMA user_version = ${Number(version)}`);
}

export function tableExists(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

// No-op when the table does not exist (the base schema just created it in
// the current shape) or already has the column.
export function addColumnIfMissing(db, table, column, type) {
  const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map((row) => row.name);
  if (columns.length > 0 && !columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
