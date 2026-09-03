/**
 * MySQL connection pool — the system of record.
 *
 * A pool rather than a connection: Express handles requests concurrently, and a single shared
 * connection would serialise every query behind the slowest one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql, {
  type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket,
} from 'mysql2/promise';

import { config } from './env.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';

const log = createLogger('mysql');
const here = path.dirname(fileURLToPath(import.meta.url));
// db/migrations lives at the repo root, outside src, because it is not TypeScript and not the
// application — it is the database's own history. Resolved relative to the compiled output;
// `npm run build` copies the directory into dist, so this path is dist/db/migrations at runtime.
const MIGRATIONS_DIR = path.join(here, '..', '..', 'db', 'migrations');

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      waitForConnections: true,
      connectionLimit: config.mysql.connectionLimit,
      // Keep DECIMAL as a JS number. Without this, mysql2 returns strings to protect precision,
      // and every price would serialise as "9.99" in quotes.
      decimalNumbers: true,
      // DATE columns as 'YYYY-MM-DD' strings. As Dates they arrive at *local* midnight, so a
      // process running east of UTC reads a stored 2026-09-03 back as 2026-09-02 — which is
      // exactly the bug a table keyed by day cannot afford. DATETIME and TIMESTAMP are
      // unaffected and still come back as Dates.
      dateStrings: ['DATE'],
      charset: 'utf8mb4_unicode_ci',
    });
  }
  return pool;
}

/** What a prepared statement will accept as a placeholder value. */
export type SqlParam = string | number | boolean | Date | null;

/**
 * A SELECT, typed by its caller.
 *
 * The driver can only promise "rows" — the shape is whatever the SQL a few lines above asked
 * for, which no type system can read. Each model declares that shape as a `Row` interface and
 * passes it here, so the cast happens once, in one place, instead of at every call site.
 */
export async function query<Row>(sql: string, params: SqlParam[] = []): Promise<Row[]> {
  const [rows] = await getPool().execute<RowDataPacket[]>(sql, params);
  return rows as Row[];
}

/**
 * An INSERT / UPDATE / DELETE, returning the driver's result header — `insertId` after an
 * INSERT, `affectedRows` after an UPDATE. `query` above cannot: a write returns no rows.
 */
export async function execute(sql: string, params: SqlParam[] = []): Promise<ResultSetHeader> {
  const [result] = await getPool().execute<ResultSetHeader>(sql, params);
  return result;
}

/**
 * The same, on a caller-supplied connection.
 *
 * A read inside a transaction has to run on that transaction's connection, or it sees the state
 * before it — so the repositories the seed drives take a connection and reach for this.
 */
export async function queryOn<Row>(
  conn: PoolConnection,
  sql: string,
  params: SqlParam[] = [],
): Promise<Row[]> {
  const [rows] = await conn.execute<RowDataPacket[]>(sql, params);
  return rows as Row[];
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * The `-- migrate:up` block of a dbmate migration.
 *
 * Extracting it is not optional politeness towards a tool we do not run: the file's other half is
 * `DROP TABLE`, so a runner that fed the whole thing to MySQL would create the schema and then
 * delete it. A file with no directive is treated as all-up, which is what an ordinary .sql file
 * dropped into the directory means.
 *
 * The directives are matched on their own lines, anchored, so the words appearing inside a
 * comment — as they do in this very file's neighbours — cannot split a migration by accident.
 */
export function extractUpSection(sql: string): string {
  const up = /^--\s*migrate:up\b.*$/m.exec(sql);
  if (!up) return sql;

  const rest = sql.slice(up.index + up[0].length);
  const down = /^--\s*migrate:down\b.*$/m.exec(rest);
  return down ? rest.slice(0, down.index) : rest;
}

/** One .sql file split into the statements it holds. */
function parseStatements(sql: string): string[] {
  // Comments are stripped BEFORE splitting on ';'. Splitting first looks equivalent and is not:
  // a semicolon inside a `-- comment` would end a statement mid-table and hand MySQL a fragment.
  // MySQL only treats `--` as a comment when whitespace follows, which is what the pattern
  // matches. (No string literal in this DDL contains `--`; one would need a real parser.)
  return sql
    .split('\n')
    .map((line) => line.replace(/(^|\s)--\s.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply the up section of every migration in db/migrations, in filename order.
 *
 * The files are dbmate's format — a `YYYYMMDDHHMMSS_name.sql` name and `-- migrate:up` /
 * `-- migrate:down` blocks — so `dbmate up` would run this directory unchanged, and so a reviewer
 * reads a layout they already know. What is deliberately *not* dbmate is the runner: applying the
 * schema from inside the seed keeps the whole stack to `docker compose up`, with no second binary
 * to install and no DATABASE_URL to assemble.
 *
 * Ordered lexically, which is what the timestamp prefix is for: it makes the directory listing
 * and the intended order the same thing, and it is why two people adding migrations on separate
 * branches do not collide the way a `002_` counter would.
 *
 * Re-run in full on every seed rather than tracked in a `schema_migrations` table, because every
 * up statement is idempotent (`CREATE TABLE IF NOT EXISTS`) and the point is that the schema
 * travels with the code rather than with whoever happened to create the Docker volume first.
 * (`docker-entrypoint-initdb.d` only runs on a first-time init of an empty volume, so a schema
 * change would silently skip existing installs.) A migration that is not idempotent — a column
 * rename, a backfill — is the point at which this needs a ledger, and the point at which handing
 * the directory to dbmate itself becomes the cheaper answer.
 */
export async function applyMigrations(): Promise<void> {
  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const conn = await getPool().getConnection();
  try {
    for (const file of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      const statements = parseStatements(extractUpSection(sql));
      for (const statement of statements) {
        await conn.query(statement);
      }
      log.info(`applied ${file} (${statements.length} statements)`);
    }
  } finally {
    conn.release();
  }
}

/** Resolves once MySQL answers, or throws after the retry budget. */
export async function waitForMysql({ attempts = 30, delayMs = 2000 } = {}): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) {
        throw new Error(`MySQL not reachable after ${attempts} attempts: ${errorMessage(err)}`);
      }
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
