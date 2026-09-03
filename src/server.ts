/**
 * Process entry point: bind the port, and shut down cleanly.
 */

import { createApp } from './app.js';
import { config } from './config/env.js';
import { closePool } from './config/database.js';
import { closeEsClient } from './config/elasticsearch.js';
import { startSyncScheduler, stopSyncScheduler } from './jobs/sync.job.js';
import { failStaleRuns } from './repositories/db/syncRun.repository.js';
import { errorMessage } from './utils/errors.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`listening on http://0.0.0.0:${config.port}`);
  logger.info(`mysql ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
  logger.info(`elasticsearch ${config.elasticsearch.node} `
    + `indexes=${config.elasticsearch.productsIndex},${config.elasticsearch.categoriesIndex}`);

  // Any run still marked `running` belongs to a process that is gone — this one just started.
  // Left alone it would say a sync is in flight forever and refuse every later one.
  failStaleRuns()
    .then((closed) => {
      if (closed > 0) logger.warn(`closed ${closed} sync run(s) left running by a previous process`);
    })
    .catch((err: unknown) => { logger.warn(`could not close stale sync runs: ${errorMessage(err)}`); });
});

// After listen, so a bad SYNC_CRON_SCHEDULE fails the boot loudly rather than silently never
// firing. The port is already bound at that point, which is what makes the crash visible.
startSyncScheduler();

/**
 * Stop accepting connections first, then close the pools, so in-flight requests finish against
 * live connections. Closing the pools first turns every `docker compose down` into a burst of
 * errors that look like application bugs.
 */
function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
  // Before the pools close: a firing that started after them would fail on every query.
  stopSyncScheduler();
  server.close(() => {
    void Promise.allSettled([closePool(), closeEsClient()]).then(() => {
      process.exit(0);
    });
  });
  // Never hang forever on a stuck connection.
  setTimeout(() => {
    logger.warn('forced exit after shutdown timeout');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => { shutdown('SIGTERM'); });
process.on('SIGINT', () => { shutdown('SIGINT'); });
