import type { RequestHandler } from 'express';

import { logger } from '../utils/logger.js';

/**
 * One line per completed request.
 *
 * Logged on `finish` rather than on entry so the line carries the status and duration — an
 * access log that records only "a request arrived" cannot tell you which requests failed or
 * which were slow, which is most of what an access log is for.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms.toFixed(1)}ms)`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.info(line);
  });

  next();
};
