import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
  awaitRun, get, post, type SyncRunJson,
} from '../helpers.js';
import { completedSyncRun, stack } from '../conftest.js';

// `stack` is autouse for this file, the way a pytest autouse fixture would be: every
// test below needs a running API, and one clear failure beats forty connection errors.
before(stack);

describe('GET /sync/status', () => {
  it('reports whether a sync is in flight and what the cron is set to', async () => {
    const { status, body } = await get<{
      running: boolean;
      cron: { enabled: boolean; schedule?: string; timezone?: string };
      lastSuccessfulRun: SyncRunJson | null;
    }>('/sync/status');

    assert.equal(status, 200);
    assert.equal(typeof body.data.running, 'boolean');
    assert.equal(typeof body.data.cron.enabled, 'boolean');
    if (body.data.cron.enabled) assert.equal(typeof body.data.cron.schedule, 'string');
  });
});

describe('GET /sync/runs', () => {
  it('lists runs newest first', async () => {
    const { status, body } = await get<SyncRunJson[]>('/sync/runs?limit=10');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0, 'no sync runs recorded — the seed writes one');

    const startedAt = body.data.map((run) => Date.parse(run.startedAt));
    assert.deepEqual(startedAt, [...startedAt].sort((a, b) => b - a));
  });

  it('carries the stage and the counters, not just an outcome', async () => {
    // The whole reason the table exists: a failed run has to say how far it got.
    const { body } = await get<SyncRunJson[]>('/sync/runs?limit=1');
    const run = body.data[0]!;
    assert.equal(typeof run.stage, 'string');
    assert.equal(typeof run.counts.productsFetched, 'number');
    assert.equal(typeof run.counts.categoriesIndexed, 'number');
    assert.ok(['cron', 'api', 'script'].includes(run.trigger));
  });

  it('filters to one day', async () => {
    const { body } = await get<SyncRunJson[]>('/sync/runs?limit=1');
    const { runDate } = body.data[0]!;

    const filtered = await get<SyncRunJson[]>(`/sync/runs?date=${runDate}`);
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.data.length > 0);
    for (const run of filtered.body.data) assert.equal(run.runDate, runDate);
  });

  it('rejects a date that is not a real day', async () => {
    // 2026-02-31 matches YYYY-MM-DD and is not a date; answering an empty list would be a lie.
    const { status, body } = await get('/sync/runs?date=2026-02-31');
    assert.equal(status, 400);
    assert.match(body.error!.message, /not a real date/);
  });

  it('rejects an unknown query parameter', async () => {
    const { status, body } = await get('/sync/runs?dat=2026-09-03');
    assert.equal(status, 400);
    assert.match(body.error!.message, /Unknown query parameter/);
  });
});

describe('GET /sync/runs/:id', () => {
  it('404s an id that does not exist', async () => {
    const { status, body } = await get('/sync/runs/99999999');
    assert.equal(status, 404);
    assert.match(body.error!.message, /not found/i);
  });

  it('400s an id that is not a number', async () => {
    const { status } = await get('/sync/runs/abc');
    assert.equal(status, 400);
  });
});

describe('POST /sync', () => {
  it('accepts the trigger and records a run to poll', async () => {
    // Unforced, so it skips against an already-populated stack — the point here is the
    // accept-and-record contract, not a rebuild.
    const { status, body } = await post<SyncRunJson>('/sync');
    assert.equal(status, 202, `expected 202, got ${status}: ${JSON.stringify(body)}`);
    assert.equal(body.data.trigger, 'api');
    assert.ok(body.data.id > 0);

    const finished = await awaitRun(body.data.id);
    assert.ok(['succeeded', 'skipped'].includes(finished.status), `run ${finished.status}`);
    assert.equal(finished.stage, 'done');
  });

  it('rejects an unknown query parameter instead of syncing anyway', async () => {
    const { status, body } = await post('/sync?forse=true');
    assert.equal(status, 400);
    assert.match(body.error!.message, /Unknown query parameter/);
  });

  it('rejects a non-boolean force', async () => {
    const { status } = await post('/sync?force=yes');
    assert.equal(status, 400);
  });
});

describe('sync run records — fixture-driven', () => {
  it('files a finished run under today, and lists it there', async () => {
    const run = await completedSyncRun();
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(run.runDate, today, 'a run was filed under the wrong day');

    const { body } = await get<SyncRunJson[]>(`/sync/runs?date=${run.runDate}&limit=50`);
    assert.ok(
      body.data.some((listed) => listed.id === run.id),
      `run ${run.id} is missing from its own day's listing`,
    );
  });

  it('returns the identical record by id', async () => {
    const run = await completedSyncRun();
    const { status, body } = await get<SyncRunJson>(`/sync/runs/${run.id}`);
    assert.equal(status, 200);
    assert.deepEqual(body.data, run);
  });

  it('closes the run: an outcome, a stage of done, and a duration', async () => {
    const run = await completedSyncRun();
    assert.ok(['succeeded', 'skipped'].includes(run.status), `run ended '${run.status}'`);
    assert.equal(run.stage, 'done');
    assert.ok(run.finishedAt, 'a finished run has no finishedAt');
    assert.ok(
      typeof run.durationMs === 'number' && run.durationMs >= 0,
      `durationMs is ${run.durationMs} — a sub-second run once stored a negative here`,
    );
  });

  it('reports the same run as the last success once one has done the work', async () => {
    const run = await completedSyncRun();
    const { body } = await get<{ lastSuccessfulRun: SyncRunJson | null }>('/sync/status');

    if (run.status !== 'succeeded') return; // a skipped run is not a success to report
    assert.ok(body.data.lastSuccessfulRun, '/sync/status forgot a run that just succeeded');
    assert.ok(body.data.lastSuccessfulRun.id >= run.id);
  });
});
