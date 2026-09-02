/**
 * MySQL connection pool — the system of record.
 *
 * A pool rather than a connection: Express handles requests concurrently, and a single shared
 * connection would serialise every query behind the slowest one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql, { type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';

import { config } from './env.js';
import { createLogger } from '../utils/logger.js';
import { errorMessage } from '../utils/errors.js';

const log = createLogger('mysql');
const here = path.dirname(fileURLToPath(import.meta.url));
// Resolved next to the compiled output; `npm run build` copies schema.sql into dist alongside it.
const SCHEMA_PATH = path.join(here, '..', 'models', 'schema.sql');

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
 * Apply models/schema.sql. Every statement is CREATE TABLE IF NOT EXISTS, so this runs on every
 * seed — which is the point: the schema travels with the code rather than with whoever happened
 * to create the Docker volume first. (`docker-entrypoint-initdb.d` only runs on a first-time
 * init of an empty volume, so a schema change would silently skip existing installs.)
 */
export async function applySchema(): Promise<void> {
  const sql = await fs.readFile(SCHEMA_PATH, 'utf8');

  // Comments are stripped BEFORE splitting on ';'. Splitting first looks equivalent and is not:
  // a semicolon inside a `-- comment` would end a statement mid-table and hand MySQL a fragment.
  // MySQL only treats `--` as a comment when whitespace follows, which is what the pattern
  // matches. (No string literal in this DDL contains `--`; one would need a real parser.)
  const statements = sql
    .split('\n')
    .map((line) => line.replace(/(^|\s)--\s.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const conn = await getPool().getConnection();
  try {
    for (const statement of statements) {
      await conn.query(statement);
    }
    log.info(`applied schema (${statements.length} statements)`);
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
