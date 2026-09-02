/**
 * Process entry point: bind the port, and shut down cleanly.
 */

import { createApp } from './app.js';
import { config } from './config/env.js';
import { closePool } from './config/database.js';
import { closeEsClient } from './config/elasticsearch.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info(`listening on http://0.0.0.0:${config.port}`);
  logger.info(`mysql ${config.mysql.host}:${config.mysql.port}/${config.mysql.database}`);
  logger.info(`elasticsearch ${config.elasticsearch.node} index=${config.elasticsearch.productsIndex}`);
});

/**
 * Stop accepting connections first, then close the pools, so in-flight requests finish against
 * live connections. Closing the pools first turns every `docker compose down` into a burst of
 * errors that look like application bugs.
 */
function shutdown(signal: string): void {
  logger.info(`${signal} received, shutting down`);
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
