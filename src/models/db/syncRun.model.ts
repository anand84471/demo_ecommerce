/**
 * The `sync_runs` table — the catalogue sync's history.
 *
 * The allowed values for `status`, `stage` and `trigger_source` are declared here rather than as
 * MySQL ENUMs, so they are one union type the compiler checks and adding one is a code change
 * instead of a table rewrite. The column is a VARCHAR; this file is the contract.
 */

/** Where a run came from. */
export const SYNC_TRIGGERS = ['cron', 'api', 'script'] as const;
export type SyncTrigger = typeof SYNC_TRIGGERS[number];

/**
 * A run's outcome. `skipped` is a success that did no work — the stores were already populated
 * and the run was not forced — and it is distinct from `succeeded` on purpose: a week of
 * `skipped` rows means the freshness check is wrong, which a week of `succeeded` would hide.
 */
export const SYNC_STATUSES = ['running', 'succeeded', 'skipped', 'failed'] as const;
export type SyncStatus = typeof SYNC_STATUSES[number];

/** How far a run got. Ordered as the sync performs them. */
export const SYNC_STAGES = [
  'starting',
  'checking',
  'fetching',
  'writing-mysql',
  'indexing-products',
  'indexing-categories',
  'done',
] as const;
export type SyncStage = typeof SYNC_STAGES[number];

/** A row of `sync_runs` — every column, in DDL order. */
export interface SyncRunRow {
  id: number;
  /**
   * DATE, as a 'YYYY-MM-DD' string — the pool sets `dateStrings: ['DATE']`. Left as a Date it
   * would arrive at *local* midnight, so a process east of UTC would read 2026-09-03 back as
   * 2026-09-02 the moment anyone called toISOString on it.
   */
  run_date: string;
  trigger_source: string;
  status: string;
  stage: string;
  started_at: Date;
  finished_at: Date | null;
  duration_ms: number | null;
  products_fetched: number;
  categories_upserted: number;
  tags_upserted: number;
  products_upserted: number;
  products_indexed: number;
  categories_indexed: number;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * What one run counted, in the order the sync produces them.
 *
 * Every field is required and defaults to zero rather than being optional: a run that has not
 * reached indexing yet has indexed zero products, which is a fact, where `undefined` would be a
 * question.
 */
export interface SyncRunCounts {
  productsFetched: number;
  categoriesUpserted: number;
  tagsUpserted: number;
  productsUpserted: number;
  productsIndexed: number;
  categoriesIndexed: number;
}

export const emptyCounts = (): SyncRunCounts => ({
  productsFetched: 0,
  categoriesUpserted: 0,
  tagsUpserted: 0,
  productsUpserted: 0,
  productsIndexed: 0,
  categoriesIndexed: 0,
});

/** A run as every layer above the repository sees it, and as the API returns it. */
export interface SyncRun {
  id: number;
  /** YYYY-MM-DD — the day the run belongs to. */
  runDate: string;
  trigger: SyncTrigger;
  status: SyncStatus;
  stage: SyncStage;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  counts: SyncRunCounts;
  error: string | null;
}

/** What the repository writes as a run progresses: a stage, and whatever counts are known yet. */
export interface SyncRunProgress {
  stage?: SyncStage;
  counts?: Partial<SyncRunCounts>;
}

/**
 * YYYY-MM-DD in UTC — the form `run_date` is written and compared in.
 *
 * UTC rather than the host's zone so that a run's day does not depend on which machine started
 * it: the cron and the API can be in different timezones and still agree what "today" was.
 */
export const toDateKey = (date: Date = new Date()): string => date.toISOString().slice(0, 10);

/**
 * Row -> domain.
 *
 * The three VARCHAR columns are narrowed here rather than trusted: a value written by an older
 * version of the code, or by hand, should not silently become an invalid union member that the
 * rest of the app switches on.
 */
export function toSyncRun(row: SyncRunRow): SyncRun {
  return {
    id: Number(row.id),
    runDate: row.run_date,
    trigger: narrow(row.trigger_source, SYNC_TRIGGERS, 'script'),
    status: narrow(row.status, SYNC_STATUSES, 'failed'),
    stage: narrow(row.stage, SYNC_STAGES, 'starting'),
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: row.duration_ms,
    counts: {
      productsFetched: row.products_fetched,
      categoriesUpserted: row.categories_upserted,
      tagsUpserted: row.tags_upserted,
      productsUpserted: row.products_upserted,
      productsIndexed: row.products_indexed,
      categoriesIndexed: row.categories_indexed,
    },
    error: row.error,
  };
}

function narrow<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
