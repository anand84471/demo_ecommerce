/**
 * Sync request validation.
 *
 * `POST /sync` takes its options as query parameters rather than a JSON body, so that triggering
 * a sync by hand is a curl with no `-d` and no content type — the shape of a thing an operator
 * runs at 2am, not of an API a client integrates against.
 */

import {
  dateParam, enumParam, intParam, parsePathParam, queryParser, withDefault,
} from './common.validator.js';

export const TRIGGER_FORCE = ['true', 'false'] as const;

/** POST /sync */
const parseTriggerQuery = queryParser({
  // A boolean spelled as an enum: `?force=yes` should be a 400 that lists what is accepted, not
  // a silent falsy that runs the wrong thing.
  force: enumParam('force', TRIGGER_FORCE),
});

export function validateTriggerSync(reqQuery: unknown): { force: boolean | undefined } {
  const { force } = parseTriggerQuery(reqQuery);
  return { force: force === undefined ? undefined : force === 'true' };
}

/** The typed result of validating `GET /sync/runs`. */
export interface ListRunsOptions {
  date: string | undefined;
  limit: number;
}

/**
 * GET /sync/runs
 *
 * Its own small paging rather than the shared `pagingShape`: this listing has no `skip` — a
 * history is read from the top — and a default of 20 runs, not the catalogue's page size.
 */
const parseListRunsQuery = queryParser({
  date: dateParam('date'),
  limit: withDefault(intParam('limit', { min: 1, max: 200 }), 20),
});

export function validateListRuns(reqQuery: unknown): ListRunsOptions {
  return parseListRunsQuery(reqQuery);
}

const runId = intParam('id', { min: 1 });

/** GET /sync/runs/:id */
export function validateRunId(rawId: unknown): number {
  return parsePathParam(runId, 'id', rawId);
}
