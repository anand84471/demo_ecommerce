import { Router } from 'express';

import { getPool } from '../config/database.js';
import { getEsClient } from '../config/elasticsearch.js';
import { asyncHandler, errorMessage } from '../utils/errors.js';

export const healthRoutes = Router();

interface HealthChecks {
  api: 'ok';
  mysql: string;
  elasticsearch: string;
}

/**
 * Liveness + dependency check.
 *
 * Reports each dependency separately and returns 503 when either is down, so the compose
 * healthcheck and a human get the same answer. "The API is up but Elasticsearch is not" is the
 * distinction worth surfacing — a single boolean would send someone debugging the wrong process.
 */
healthRoutes.get('/', asyncHandler(async (_req, res) => {
  const checks: HealthChecks = { api: 'ok', mysql: 'unknown', elasticsearch: 'unknown' };

  await Promise.all([
    getPool().query('SELECT 1')
      .then(() => { checks.mysql = 'ok'; })
      .catch((err: unknown) => { checks.mysql = `error: ${errorMessage(err)}`; }),
    getEsClient().ping()
      .then(() => { checks.elasticsearch = 'ok'; })
      .catch((err: unknown) => { checks.elasticsearch = `error: ${errorMessage(err)}`; }),
  ]);

  const healthy = checks.mysql === 'ok' && checks.elasticsearch === 'ok';
  return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', checks });
}));
