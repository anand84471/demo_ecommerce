/**
 * The scheduled catalogue sync.
 *
 * A cron inside the API process rather than a container of its own or a crontab entry, because
 * the job is already a function this process can call and the alternative is a second deployment
 * artifact that has to be kept in step with it. The trade is that the schedule only runs while
 * the API does — which is true of the API's own uptime anyway — and that two replicas would each
 * fire it. See the in-flight note in sync.service.ts.
 *
 * The schedule is validated when the scheduler starts, not when it first fires: a typo'd
 * `SYNC_CRON_SCHEDULE` should be a boot failure with the expression in the message, not silence
 * followed by a sync that never happens.
 */

import cron, { type ScheduledTask } from 'node-cron';

import { config } from '../config/env.js';
import * as syncService from '../services/sync.service.js';
import { errorMessage } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('cron');

let task: ScheduledTask | null = null;

/**
 * Schedule the sync, or explain why it is not scheduled.
 *
 * Returns the task so a caller can stop it; null when the cron is disabled, which is the default
 * outside compose.
 */
export function startSyncScheduler(): ScheduledTask | null {
  if (task) return task;

  if (!config.sync.cronEnabled) {
    log.info('catalogue sync cron disabled (SYNC_CRON_ENABLED=false)');
    return null;
  }

  const { cronSchedule, cronTimezone } = config.sync;
  if (!cron.validate(cronSchedule)) {
    throw new Error(
      `Invalid SYNC_CRON_SCHEDULE '${cronSchedule}': expected a five-field cron expression, `
      + "e.g. '0 3 * * *' for 03:00 daily.",
    );
  }

  task = cron.schedule(cronSchedule, () => { void tick(); }, { timezone: cronTimezone });
  log.info(`catalogue sync scheduled: '${cronSchedule}' (${cronTimezone})`);
  return task;
}

/**
 * One firing.
 *
 * Swallows everything. An hourly job that takes the process down on a bad night is worse than
 * one that logs and waits for the next window — and the run's row already holds the detail, so
 * nothing is lost by not throwing here. A 409 is the ordinary case of a manual sync still
 * running, and says so rather than looking like a fault.
 */
async function tick(): Promise<void> {
  try {
    const run = await syncService.runSync({ trigger: 'cron' });
    log.info(`run ${run.id} ${run.status} in ${run.durationMs ?? 0}ms `
      + `(${run.counts.productsIndexed} products, ${run.counts.categoriesIndexed} categories)`);
  } catch (err) {
    log.warn(`scheduled sync did not start: ${errorMessage(err)}`);
  }
}

/** Stop the schedule — part of a clean shutdown, so a firing cannot outlive the pools. */
export function stopSyncScheduler(): void {
  if (!task) return;
  task.stop();
  task = null;
  log.info('catalogue sync cron stopped');
}
