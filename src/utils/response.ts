/**
 * The response envelope, in one place.
 *
 * Every endpoint answers with the same shape — `{ data, meta }` on success, `{ error }` on
 * failure — so a client writes one unwrapping function instead of one per route. Centralising it
 * here is what stops the shape drifting as endpoints are added.
 */

import type { Response } from 'express';

import type { ErrorDetail } from './errors.js';

export interface CollectionMeta {
  total?: number;
  limit?: number;
  skip?: number;
  /** The store that answered: `mysql` | `elasticsearch`. */
  source?: string;
  [key: string]: unknown;
}

/** A single resource: `{ data: {...} }`. */
export function item<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  return res.json({ data, ...(meta ? { meta } : {}) });
}

/**
 * A collection: `{ data: [...], meta: { total, limit, skip, source, ... } }`.
 *
 * `source` names the store that answered (mysql | elasticsearch). It is in the payload rather
 * than a header because this API deliberately reads from two stores, and "which one told me
 * this" is the first question when the two disagree.
 */
export function collection<T>(res: Response, data: T[], meta: CollectionMeta = {}): Response {
  const { total, limit, skip, source, ...rest } = meta;
  return res.json({
    data,
    meta: {
      total: total ?? data.length,
      ...(limit !== undefined ? { limit } : {}),
      ...(skip !== undefined ? { skip } : {}),
      ...(source ? { source } : {}),
      ...rest,
    },
  });
}

/** An error: `{ error: { status, message, details? } }`. */
export function failure(
  res: Response,
  status: number,
  message: string,
  details?: ErrorDetail[],
): Response {
  return res.status(status).json({
    error: { status, message, ...(details && details.length > 0 ? { details } : {}) },
  });
}
