/**
 * The sync-run row mapper, and the day key it is filed under.
 *
 * Both are places where a wrong answer is invisible: a status that fell outside the union would
 * flow into the API as-is, and an off-by-one day key would file a run under yesterday. Neither
 * shows up as an error anywhere.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCategoryWithCount } from '../../src/models/db/category.model.js';
import {
  emptyCounts, toDateKey, toSyncRun, type SyncRunRow,
} from '../../src/models/db/syncRun.model.js';

/** A healthy row, which each test then bends in one direction. */
const row = (overrides: Partial<SyncRunRow> = {}): SyncRunRow => ({
  id: 1,
  run_date: '2026-09-03',
  trigger_source: 'cron',
  status: 'succeeded',
  stage: 'done',
  started_at: new Date('2026-09-03T03:00:00.000Z'),
  finished_at: new Date('2026-09-03T03:00:01.334Z'),
  duration_ms: 1334,
  products_fetched: 194,
  categories_upserted: 24,
  tags_upserted: 138,
  products_upserted: 194,
  products_indexed: 194,
  categories_indexed: 24,
  error: null,
  created_at: new Date('2026-09-03T03:00:00.000Z'),
  updated_at: new Date('2026-09-03T03:00:01.000Z'),
  ...overrides,
});

describe('toSyncRun', () => {
  it('maps a row to the shape the API returns', () => {
    const run = toSyncRun(row());

    assert.equal(run.runDate, '2026-09-03');
    assert.equal(run.trigger, 'cron');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.startedAt, '2026-09-03T03:00:00.000Z');
    assert.equal(run.finishedAt, '2026-09-03T03:00:01.334Z');
    assert.deepEqual(run.counts, {
      productsFetched: 194,
      categoriesUpserted: 24,
      tagsUpserted: 138,
      productsUpserted: 194,
      productsIndexed: 194,
      categoriesIndexed: 24,
    });
  });

  it('leaves an unfinished run’s finish fields null rather than inventing them', () => {
    const run = toSyncRun(row({ status: 'running', stage: 'fetching', finished_at: null, duration_ms: null }));
    assert.equal(run.status, 'running');
    assert.equal(run.finishedAt, null);
    assert.equal(run.durationMs, null);
  });

  it('narrows values the columns could hold but the union cannot', () => {
    // status/stage/trigger are VARCHAR, so an older build or a hand-edited row can put anything
    // there. Passing it through would hand the API a value it claims is impossible.
    const run = toSyncRun(row({ status: 'exploded', stage: 'somewhere', trigger_source: 'gremlin' }));

    assert.equal(run.status, 'failed', 'an unknown status must not read as success');
    assert.equal(run.stage, 'starting');
    assert.equal(run.trigger, 'script');
  });

  it('treats skipped as its own outcome, not a success', () => {
    // A week of `skipped` means the freshness check is broken; folding it into `succeeded`
    // would hide exactly that.
    assert.equal(toSyncRun(row({ status: 'skipped' })).status, 'skipped');
  });
});

describe('toDateKey', () => {
  it('is UTC, so the day does not depend on the machine that asked', () => {
    // 23:30 in Delhi is already the next day in UTC. The cron and the API can sit in different
    // zones and still agree what "today" was.
    assert.equal(toDateKey(new Date('2026-09-03T18:30:00.000Z')), '2026-09-03');
    assert.equal(toDateKey(new Date('2026-09-03T23:59:59.999Z')), '2026-09-03');
    assert.equal(toDateKey(new Date('2026-09-04T00:00:00.000Z')), '2026-09-04');
  });

  it('defaults to now', () => {
    assert.match(toDateKey(), /^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('emptyCounts', () => {
  it('starts every counter at zero, and hands back a fresh object each time', () => {
    const first = emptyCounts();
    first.productsIndexed = 99;
    assert.equal(emptyCounts().productsIndexed, 0, 'counts must not be shared between runs');
  });
});

describe('toCategoryWithCount', () => {
  it('coerces the COUNT() column, which MySQL may return as a string', () => {
    // The reason the row type says `number | string`: with some driver settings COUNT() arrives
    // quoted, and "5" would serialise into the nav as a string.
    const fromString = toCategoryWithCount({
      id: 1, slug: 'beauty', name: 'Beauty', url: null, product_count: '5',
    });
    assert.strictEqual(fromString.productCount, 5);

    const fromNumber = toCategoryWithCount({
      id: 1, slug: 'beauty', name: 'Beauty', url: null, product_count: 5,
    });
    assert.strictEqual(fromNumber.productCount, 5);
  });

  it('keeps an empty category at zero rather than dropping it', () => {
    const empty = toCategoryWithCount({
      id: 2, slug: 'empty', name: 'Empty', url: null, product_count: 0,
    });
    assert.equal(empty.productCount, 0);
  });
});
