/**
 * Error types shared by every layer.
 *
 * Services throw these; the error middleware turns them into responses. That split is what lets
 * a service say "this product does not exist" without importing Express or knowing that the
 * answer happens to be HTTP 404.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Field-level context for a 400 — one entry per failed parameter. */
export interface ErrorDetail {
  field: string;
  message: string;
}

export class AppError extends Error {
  readonly status: number;

  readonly details?: ErrorDetail[];

  constructor(status: number, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message: string, details?: ErrorDetail[]): AppError => new AppError(400, message, details);
export const unauthorized = (message: string): AppError => new AppError(401, message);
export const notFound = (message: string): AppError => new AppError(404, message);
/** The request was valid but the resource's current state forbids it — a sync already running. */
export const conflict = (message: string): AppError => new AppError(409, message);
export const serviceUnavailable = (message: string): AppError => new AppError(503, message);

/** The message off an unknown throw. `catch (err)` gives `unknown` under strict mode. */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Wraps an async handler so a rejected promise reaches Express's error middleware.
 *
 * Express 4 does not await handlers, so without this a `throw` inside an async route is an
 * unhandled rejection and the request hangs until the client times out — the failure looks like
 * a network problem rather than the bug it is.
 */
export const asyncHandler = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};
