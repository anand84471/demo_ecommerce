/**
 * The single place an error becomes a response.
 *
 * Services throw AppError with a status; anything else is an unexpected failure and becomes a
 * 500. Keeping this in one middleware is what lets every other layer throw freely without a
 * try/catch at each call site.
 */

import type { ErrorRequestHandler, Request, Response } from 'express';

import { AppError, errorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { failure } from '../utils/response.js';

/** 404 for a path no router claimed. Mounted after the routes, before the error handler. */
export function notFoundHandler(req: Request, res: Response): Response {
  return failure(res, 404, `No route for ${req.method} ${req.path}`);
}

// Express identifies an error handler by its arity — it must take four arguments, even though
// `next` is unused here. Renaming or dropping it silently turns this into ordinary middleware,
// which is why the parameter is kept and named with a leading underscore.
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  const status = err instanceof AppError ? err.status : 500;

  if (status >= 500) {
    // The stack goes to the log, never to the client.
    logger.error(`unhandled error on ${req.method} ${req.originalUrl}`, {
      message: errorMessage(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }

  return failure(
    res,
    status,
    // A generic message for internal failures: a driver error or stack leaked to a client is how
    // connection strings end up in bug reports.
    status >= 500 ? 'Internal server error' : errorMessage(err),
    err instanceof AppError ? err.details : undefined,
  );
};
