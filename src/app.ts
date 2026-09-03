/**
 * Express app assembly — middleware, routes, error handling. No listening happens here.
 *
 * Separating this from server.ts means tests can import the app and drive it without binding a
 * port, and the process lifecycle stays in one file.
 */

import express, { type Express } from 'express';

import { errorHandler, notFoundHandler } from './middleware/error.middleware.js';
import { requestLogger } from './middleware/logger.middleware.js';
import { categoryRoutes } from './routes/category.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import { productRoutes } from './routes/product.routes.js';
import { syncRoutes } from './routes/sync.routes.js';

export function createApp(): Express {
  const app = express();

  // Nothing gained by advertising the framework and version to a scanner.
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(requestLogger);

  // A self-describing root, so the first thing a reviewer hits tells them where to go next.
  app.get('/', (_req, res) => {
    res.json({
      name: 'demo-ecommerce-api',
      endpoints: {
        'GET /health': 'liveness + dependency status',
        'GET /categories': 'all categories with product counts',
        'GET /products': 'list products (?limit&skip&sort&order)',
        'GET /products?query=': 'full-text search (?q= also accepted)',
        'GET /products?category=': 'filter by category slug, tag, minPrice, maxPrice',
        'GET /products/:id': 'one product with images, tags and reviews',
        'POST /sync': 'trigger a catalogue sync (?force=true to ignore the freshness check)',
        'GET /sync/status': 'is a sync running, and when did one last succeed',
        'GET /sync/runs': 'sync history, newest first (?date=YYYY-MM-DD&limit=)',
        'GET /sync/runs/:id': 'one sync run, with its stage and counters',
      },
      // Every read is served by Elasticsearch; MySQL is the system of record behind the index.
      readModel: 'elasticsearch',
    });
  });

  app.use('/health', healthRoutes);
  app.use('/categories', categoryRoutes);
  app.use('/products', productRoutes);
  app.use('/sync', syncRoutes);

  // Order matters: unmatched paths become a 404 body, then the error handler has the last word.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
