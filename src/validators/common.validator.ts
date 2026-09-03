/**
 * Query-parameter schemas, shared by every validator.
 *
 * Zod plays the part pydantic plays in a Python service: a request's accepted parameters are
 * *declared* — type, bounds, allowed values, default — and one parser turns an untrusted
 * `req.query` into a typed object or a 400 that says exactly what was wrong. The static type of
 * that object is inferred from the same declaration, so a validator and the service it feeds
 * cannot drift apart without the compiler noticing.
 *
 * Everything off the wire is a string, an array of strings (`?limit=1&limit=2`) or absent, which
 * is why these primitives are built on `z.unknown()` rather than `z.string()`: the raw shape is
 * genuinely unknown, and saying so lets each parameter own its own error message instead of
 * leaking a generic "expected string, received array".
 */

import { z } from 'zod';

import { config } from '../config/env.js';
import { type AppError, badRequest, type ErrorDetail } from '../utils/errors.js';

interface Bounds {
  min?: number;
  max?: number;
}

/**
 * One raw query value, trimmed. An empty value (`?limit=`) counts as absent — a caller who sends
 * an empty parameter means "no opinion", and erroring on it would be pedantry.
 */
const scalar = (name: string) => z.unknown().transform((raw, ctx): string | undefined => {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    // Express parses a repeated parameter into an array, and silently taking the last one is
    // how `?category=beauty&category=furniture` returns a filter the caller did not ask for.
    ctx.addIssue({ code: 'custom', message: `'${name}' must be given exactly once` });
    return z.NEVER;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
});

/**
 * A parameter with a default, e.g. `?limit=` -> 20.
 *
 * The transform applies to a key that is missing *or* empty, which `.default()` alone would not
 * do — it only fires on a missing one. Applying it here rather than inside each primitive is
 * what keeps `intParam` returning one type instead of two.
 */
export function withDefault<T extends string | number>(
  schema: z.ZodType<T | undefined>,
  fallback: T,
): z.ZodType<T> {
  return schema.transform((value) => value ?? fallback);
}

/** An integer parameter, e.g. `?limit=20`. */
export function intParam(name: string, { min, max }: Bounds = {}): z.ZodType<number | undefined> {
  const schema = scalar(name).transform((value, ctx): number | undefined => {
    if (value === undefined) return undefined;
    // A bare `Number()` would accept " " as 0 and `parseInt` would accept "12abc" as 12; this
    // insists on an integer, so a typo becomes a 400 rather than a silently different page.
    if (!/^-?\d+$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be an integer (got '${value}')` });
      return z.NEVER;
    }
    const parsed = Number.parseInt(value, 10);
    if (min !== undefined && parsed < min) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be >= ${min} (got ${parsed})` });
      return z.NEVER;
    }
    if (max !== undefined && parsed > max) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be <= ${max} (got ${parsed})` });
      return z.NEVER;
    }
    return parsed;
  });
  return schema.optional();
}

/** A decimal parameter, e.g. `?minPrice=9.99`. */
export function numberParam(name: string, { min, max }: Bounds = {}): z.ZodType<number | undefined> {
  const schema = scalar(name).transform((value, ctx): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be a number (got '${value}')` });
      return z.NEVER;
    }
    if (min !== undefined && parsed < min) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be >= ${min} (got ${parsed})` });
      return z.NEVER;
    }
    if (max !== undefined && parsed > max) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be <= ${max} (got ${parsed})` });
      return z.NEVER;
    }
    return parsed;
  });
  return schema.optional();
}

/**
 * A closed set of values, matched case-insensitively.
 *
 * The literal union survives into the inferred type, so `options.order` is `'asc' | 'desc'`
 * rather than `string` and a service switching on it gets exhaustiveness for free.
 */
export function enumParam<T extends string>(
  name: string,
  allowed: readonly T[],
): z.ZodType<T | undefined> {
  const schema = scalar(name).transform((value, ctx): T | undefined => {
    if (value === undefined) return undefined;
    const lowered = value.toLowerCase() as T;
    if (!allowed.includes(lowered)) {
      ctx.addIssue({
        code: 'custom',
        message: `'${name}' must be one of ${allowed.join(', ')} (got '${value}')`,
      });
      return z.NEVER;
    }
    return lowered;
  });
  return schema.optional();
}

/**
 * A calendar day, `YYYY-MM-DD`.
 *
 * The format is checked *and* the date is: `2026-02-31` matches the pattern and is not a day, and
 * a query filtered on it would answer an empty list as if that were the truth.
 */
export function dateParam(name: string): z.ZodType<string | undefined> {
  const schema = scalar(name).transform((value, ctx): string | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      ctx.addIssue({ code: 'custom', message: `'${name}' must be YYYY-MM-DD (got '${value}')` });
      return z.NEVER;
    }
    // Round-tripping is what catches a well-formed non-day: Date normalises 2026-02-31 to
    // 2026-03-03, which no longer equals what was sent.
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      ctx.addIssue({ code: 'custom', message: `'${name}' is not a real date (got '${value}')` });
      return z.NEVER;
    }
    return value;
  });
  return schema.optional();
}

/** Free text, trimmed. Anything non-empty is acceptable — the stores are queried with placeholders. */
export function stringParam(name: string): z.ZodType<string | undefined> {
  return scalar(name).optional();
}

/**
 * limit / skip with guard rails, plus the window check that goes with them.
 *
 * The window cap exists because Elasticsearch refuses `from + size > index.max_result_window`
 * (10k by default) with an error most clients surface as a 500. Rejecting it here makes the limit
 * explicit and the message actionable. Deep paging is the wrong tool anyway — `search_after` is.
 */
export const pagingShape = {
  limit: withDefault(
    intParam('limit', { min: 1, max: config.paging.maxLimit }),
    config.paging.defaultLimit,
  ),
  skip: withDefault(intParam('skip', { min: 0 }), 0),
};

export function checkPagingWindow(
  { limit, skip }: { limit: number; skip: number },
  ctx: z.RefinementCtx,
): void {
  if (skip + limit > config.paging.maxWindow) {
    ctx.addIssue({
      code: 'custom',
      message: `Paging window too deep: skip + limit must be <= ${config.paging.maxWindow}. `
        + 'Narrow the result set with query/category filters instead.',
    });
  }
}

/** A cross-parameter rule — pydantic's model validator, minus the decorator. */
export type QueryCheck<T> = (value: T, ctx: z.RefinementCtx) => void;

/**
 * Turns a shape of parameter schemas into `(req.query) => typed options`.
 *
 * Unknown keys are rejected rather than ignored: a typo'd `?catagory=beauty` that silently
 * returns the whole catalogue is a worse experience than an error, because the caller believes a
 * filter applied when it did not. The allowed list in that message comes from the shape itself,
 * so it cannot fall out of date.
 */
export function queryParser<S extends z.ZodRawShape>(
  shape: S,
  ...checks: Array<QueryCheck<z.output<z.ZodObject<S>>>>
): (query: unknown) => z.output<z.ZodObject<S>> {
  const allowed = Object.keys(shape);
  let schema: z.ZodType<z.output<z.ZodObject<S>>> = z.strictObject(shape);
  for (const check of checks) schema = schema.superRefine(check);

  return (query: unknown) => {
    const result = schema.safeParse(query);
    if (result.success) return result.data;
    throw toBadRequest(result.error, allowed);
  };
}

/** Validates a single path parameter, e.g. `/products/:id`. */
export function parsePathParam<T>(schema: z.ZodType<T | undefined>, name: string, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    // A path parameter has no key of its own in the error, so it is named here instead.
    const details: ErrorDetail[] = result.error.issues.map((issue) => ({
      field: name,
      message: issue.message,
    }));
    throw badRequest(details[0]?.message ?? `'${name}' is invalid`, details);
  }
  if (result.data === undefined) throw badRequest(`'${name}' is required`);
  return result.data;
}

function describe(issue: z.core.$ZodIssue, allowed: string[]): string {
  if (issue.code === 'unrecognized_keys') {
    // An endpoint with an empty shape needs its own wording — "Allowed: " with nothing after it
    // reads like the list failed to render rather than like there is nothing to list.
    const permitted = allowed.length > 0
      ? `Allowed: ${allowed.join(', ')}`
      : 'This endpoint takes no query parameters.';
    return `Unknown query parameter(s): ${issue.keys.join(', ')}. ${permitted}`;
  }
  return issue.message;
}

/**
 * A ZodError becomes one 400: the first problem as the message (what a human reads), every
 * problem in `details` (what a client can render field by field).
 */
function toBadRequest(error: z.ZodError, allowed: string[]): AppError {
  const details: ErrorDetail[] = error.issues.map((issue) => ({
    field: issue.path.map(String).join('.') || '(query)',
    message: describe(issue, allowed),
  }));
  return badRequest(details[0]?.message ?? 'Invalid request', details);
}
