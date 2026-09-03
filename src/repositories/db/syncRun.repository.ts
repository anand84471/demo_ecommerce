/**
 * Persistence for the sync's own history.
 *
 * The only repository here that both reads and writes on a request path: the API lists runs out
 * of it, and the sync writes its progress into it as it goes. It deliberately does not use the
 * seed's transaction — a run's row has to be visible and up to date *while* the run is in
 * flight, and anything inside the catalogue transaction would only appear once that commits.
 */

import { execute, query } from '../../config/database.js';
import {
  toDateKey, toSyncRun,
  type SyncRun, type SyncRunCounts, type SyncRunProgress, type SyncRunRow, type SyncStage,
  type SyncStatus, type SyncTrigger,
} from '../../models/db/syncRun.model.js';

const COLUMNS = `id, run_date, trigger_source, status, stage, started_at, finished_at,
  duration_ms, products_fetched, categories_upserted, tags_upserted, products_upserted,
  products_indexed, categories_indexed, error, created_at, updated_at`;

/** camelCase count -> its column, so a partial update writes only what the caller knows. */
const COUNT_COLUMNS: Record<keyof SyncRunCounts, string> = {
  productsFetched: 'products_fetched',
  categoriesUpserted: 'categories_upserted',
  tagsUpserted: 'tags_upserted',
  productsUpserted: 'products_upserted',
  productsIndexed: 'products_indexed',
  categoriesIndexed: 'categories_indexed',
};

/** Open a run: one row, `running`, with today's date and the clock started. */
export async function startRun(trigger: SyncTrigger): Promise<SyncRun> {
  const startedAt = new Date();
  const result = await execute(
    `INSERT INTO sync_runs (run_date, trigger_source, status, stage, started_at)
     VALUES (?, ?, 'running', 'starting', ?)`,
    [toDateKey(startedAt), trigger, startedAt],
  );
  const run = await findRunById(result.insertId);
  // The row was inserted a statement ago; it cannot be missing unless something else deleted it.
  if (!run) throw new Error(`sync run ${result.insertId} vanished immediately after insert`);
  return run;
}

/**
 * Record how far a running sync has got.
 *
 * Built as a partial UPDATE rather than a whole-row write so that two concurrent callers could
 * not clobber each other's counters — and so that a caller reporting only `stage` is not forced
 * to restate numbers it does not have.
 */
export async function recordProgress(id: number, progress: SyncRunProgress): Promise<void> {
  const assignments: string[] = [];
  const params: Array<string | number> = [];

  if (progress.stage !== undefined) {
    assignments.push('stage = ?');
    params.push(progress.stage);
  }
  for (const [key, column] of Object.entries(COUNT_COLUMNS)) {
    const value = progress.counts?.[key as keyof SyncRunCounts];
    if (value !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (assignments.length === 0) return;

  params.push(id);
  await execute(`UPDATE sync_runs SET ${assignments.join(', ')} WHERE id = ?`, params);
}

export interface FinishRunOptions {
  status: Exclude<SyncStatus, 'running'>;
  stage: SyncStage;
  error?: string | null;
}

/**
 * Close a run.
 *
 * `duration_ms` is computed from the row's own `started_at` rather than from a timestamp the
 * caller carries, so it measures the run MySQL recorded and cannot disagree with it. GREATEST
 * clamps it at zero: the column is UNSIGNED, and a clock adjustment mid-run would otherwise make
 * closing the row fail — which is the one write that must never fail, since it is what stops the
 * row claiming to be running forever.
 */
export async function finishRun(
  id: number,
  { status, stage, error = null }: FinishRunOptions,
): Promise<void> {
  await execute(
    `UPDATE sync_runs
     SET status = ?, stage = ?, error = ?, finished_at = NOW(3),
         duration_ms = GREATEST(TIMESTAMPDIFF(MICROSECOND, started_at, NOW(3)) DIV 1000, 0)
     WHERE id = ?`,
    // TEXT holds far more, but a message that long is a stack trace someone pasted in by
    // accident, and truncating beats storing a page of it on every failure.
    [status, stage, error === null ? null : error.slice(0, 2000), id],
  );
}

export async function findRunById(id: number): Promise<SyncRun | null> {
  const rows = await query<SyncRunRow>(`SELECT ${COLUMNS} FROM sync_runs WHERE id = ?`, [id]);
  const row = rows[0];
  return row ? toSyncRun(row) : null;
}

export interface ListRunsOptions {
  /** YYYY-MM-DD. Omitted lists across every day. */
  date?: string | undefined;
  limit: number;
}

/** Newest first, optionally narrowed to one day. */
export async function listRuns({ date, limit }: ListRunsOptions): Promise<SyncRun[]> {
  // `limit` is interpolated, not bound: MySQL will not accept a placeholder in LIMIT on a
  // prepared statement. It is an integer from the validator, never a caller's string.
  const where = date ? 'WHERE run_date = ?' : '';
  const rows = await query<SyncRunRow>(
    `SELECT ${COLUMNS} FROM sync_runs ${where}
     ORDER BY started_at DESC, id DESC
     LIMIT ${Math.trunc(limit)}`,
    date ? [date] : [],
  );
  return rows.map(toSyncRun);
}

/** The most recent run that actually did the work, or null if none ever has. */
export async function findLastSuccessfulRun(): Promise<SyncRun | null> {
  const rows = await query<SyncRunRow>(
    `SELECT ${COLUMNS} FROM sync_runs WHERE status = 'succeeded'
     ORDER BY started_at DESC, id DESC LIMIT 1`,
  );
  const row = rows[0];
  return row ? toSyncRun(row) : null;
}

/**
 * Mark runs left `running` by a process that died as failed.
 *
 * Called at startup: a container killed mid-sync leaves a row that would otherwise say `running`
 * forever, and block every later run on the in-flight check.
 */
export async function failStaleRuns(): Promise<number> {
  const result = await execute(
    `UPDATE sync_runs
     SET status = 'failed', error = 'interrupted — the process did not finish this run',
         finished_at = NOW()
     WHERE status = 'running'`,
  );
  return result.affectedRows;
}
