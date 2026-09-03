#!/usr/bin/env node
/**
 * Run the catalogue sync once, from the command line.
 *
 * There is no logic here any more, and that is the point: fetching the feed, writing MySQL and
 * rebuilding the Elasticsearch indexes live in services/sync.service.ts, which the cron and
 * `POST /sync` call too. A script that reimplemented any of it would be a fourth behaviour to
 * keep in step with three others.
 *
 * What this file does own is being a *process*: it waits for the stores, applies the migrations,
 * reports the run, and sets an exit code — none of which the in-process callers want.
 *
 *   npm run seed          # skips if both stores already hold data
 *   npm run seed:force    # re-fetches and rewrites regardless
 */

import { applyMigrations, closePool, waitForMysql } from '../config/database.js';
import { closeEsClient, waitForElasticsearch } from '../config/elasticsearch.js';
import * as syncService from '../services/sync.service.js';
import { errorMessage } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('seed');

async function main(): Promise<void> {
  log.info('waiting for MySQL and Elasticsearch…');
  await Promise.all([waitForMysql(), waitForElasticsearch()]);

  // Before the sync, not as part of it: the sync writes to `sync_runs`, so the table has to
  // exist before there is a run to record. This is also the only entry point that migrates —
  // the API and the cron assume a database that has already been brought up to date.
  await applyMigrations();

  const run = await syncService.runSync({ trigger: 'script' });
  const { counts } = run;

  log.info(`run ${run.id} ${run.status} in ${((run.durationMs ?? 0) / 1000).toFixed(1)}s — `
    + `${counts.productsUpserted} products to MySQL, ${counts.productsIndexed} products and `
    + `${counts.categoriesIndexed} categories to Elasticsearch`);

  if (run.status === 'skipped') {
    log.info('both stores already populated — re-run with SEED_FORCE=true to refresh');
  }
  if (run.status === 'failed') {
    // The run recorded its own failure rather than throwing, so the exit code is set here.
    log.error(`FAILED at stage '${run.stage}': ${run.error ?? 'unknown error'}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err: unknown) => {
    log.error(`FAILED: ${errorMessage(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closePool(), closeEsClient()]);
  });
