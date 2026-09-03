/**
 * Sync controllers — the HTTP face of the job the cron runs.
 *
 * Validate, delegate, respond, as everywhere else. The one thing specific to this endpoint lives
 * here rather than in the service: the shared-secret check, because it is a fact about the
 * transport (a header) and not about syncing.
 */

import type { Request, Response } from 'express';

import { config } from '../config/env.js';
import * as syncService from '../services/sync.service.js';
import { notFound, unauthorized } from '../utils/errors.js';
import { collection, item } from '../utils/response.js';
import {
  validateListRuns, validateRunId, validateTriggerSync,
} from '../validators/sync.validator.js';

/**
 * A shared secret, when one is configured.
 *
 * `POST /sync` drops and rebuilds both Elasticsearch indexes, which is the most expensive thing
 * an anonymous caller could ask this service to do. An unset token leaves it open — right for a
 * laptop, wrong for anywhere with a public address, and .env.example says so.
 */
function assertMayTrigger(req: Request): void {
  const expected = config.sync.triggerToken;
  if (!expected) return;
  if (req.get('x-sync-token') !== expected) {
    throw unauthorized('A valid X-Sync-Token header is required to trigger a sync.');
  }
}

/**
 * POST /sync
 *
 * 202, not 200: the run is accepted and started, and a full rebuild outlives a sensible request
 * timeout. The body is the run's row at the moment it opened — poll `GET /sync/runs/:id` to
 * watch `stage` and the counters advance.
 */
export async function triggerSync(req: Request, res: Response): Promise<Response> {
  assertMayTrigger(req);
  const { force } = validateTriggerSync(req.query);

  const run = await syncService.startSync({
    trigger: 'api',
    ...(force === undefined ? {} : { force }),
  });
  return item(res.status(202), run, { pollUrl: `/sync/runs/${run.id}` });
}

/**
 * GET /sync/runs
 *
 * The history, newest first. `?date=YYYY-MM-DD` narrows it to one day, which is the question the
 * table exists to answer.
 */
export async function listRuns(req: Request, res: Response): Promise<Response> {
  const options = validateListRuns(req.query);
  const runs = await syncService.listRuns(options);

  return collection(res, runs, {
    total: runs.length,
    limit: options.limit,
    ...(options.date ? { date: options.date } : {}),
  });
}

/** GET /sync/runs/:id */
export async function getRun(req: Request, res: Response): Promise<Response> {
  const id = validateRunId(req.params.id);
  const run = await syncService.getRun(id);
  if (!run) throw notFound(`Sync run ${id} not found`);
  return item(res, run);
}

/**
 * GET /sync/status
 *
 * The one-glance answer: is a sync happening now, and when did one last actually work. Separate
 * from /health because a stale catalogue is not an unhealthy process — the API still serves the
 * data it has, and conflating the two makes an orchestrator restart a container that is fine.
 */
export async function getStatus(_req: Request, res: Response): Promise<Response> {
  const lastSuccess = await syncService.getLastSuccessfulRun();

  return item(res, {
    running: syncService.isSyncRunning(),
    cron: config.sync.cronEnabled
      ? { enabled: true, schedule: config.sync.cronSchedule, timezone: config.sync.cronTimezone }
      : { enabled: false },
    lastSuccessfulRun: lastSuccess,
  });
}
