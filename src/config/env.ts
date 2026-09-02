/**
 * All configuration in one place, read from the environment through a Zod schema.
 *
 * The schema is doing what pydantic's BaseSettings does: every variable is declared once with
 * its type, its bounds and its default, and the process refuses to start on a value it cannot
 * use. `MAX_LIMIT=1oo` is a typo that used to fall back to 100 silently and now fails at boot,
 * which is the only moment it is cheap to notice.
 *
 * Defaults point at localhost so `npm start` works against a compose-hosted MySQL/Elasticsearch
 * with no extra setup.
 */

import { z } from 'zod';

/** An integer variable. Unset or empty means "use the default"; anything unusable is an error. */
const intVar = (fallback: number, { min }: { min?: number } = {}) => z
  .string()
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined || raw.trim() === '') return fallback;
    if (!/^-?\d+$/.test(raw.trim())) {
      ctx.addIssue({ code: 'custom', message: `must be an integer (got '${raw}')` });
      return z.NEVER;
    }
    const value = Number.parseInt(raw, 10);
    if (min !== undefined && value < min) {
      ctx.addIssue({ code: 'custom', message: `must be >= ${min} (got ${value})` });
      return z.NEVER;
    }
    return value;
  });

const stringVar = (fallback: string) => z
  .string()
  .optional()
  .transform((raw) => (raw === undefined || raw.trim() === '' ? fallback : raw));

const boolVar = (fallback: boolean) => z
  .enum(['true', 'false'])
  .optional()
  .transform((raw) => (raw === undefined ? fallback : raw === 'true'));

const envSchema = z.object({
  PORT: intVar(3000, { min: 1 }),

  MYSQL_HOST: stringVar('127.0.0.1'),
  MYSQL_PORT: intVar(3306, { min: 1 }),
  MYSQL_DATABASE: stringVar('ecommerce'),
  MYSQL_USER: stringVar('shop'),
  MYSQL_PASSWORD: stringVar('shoppw'),
  MYSQL_POOL_SIZE: intVar(10, { min: 1 }),

  ELASTICSEARCH_NODE: stringVar('http://127.0.0.1:9200'),
  ES_PRODUCTS_INDEX: stringVar('products'),

  DUMMYJSON_URL: stringVar('https://dummyjson.com'),
  SEED_FORCE: boolVar(false),
  // The bulk size for ES indexing. 194 products fit in one request, but batching keeps the
  // script honest if the source ever grows.
  SEED_BATCH_SIZE: intVar(500, { min: 1 }),

  DEFAULT_LIMIT: intVar(20, { min: 1 }),
  MAX_LIMIT: intVar(100, { min: 1 }),
  MAX_WINDOW: intVar(10_000, { min: 1 }),
});

function loadEnv(source: NodeJS.ProcessEnv): z.infer<typeof envSchema> {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(env)'}: ${issue.message}`)
      .join('\n');
    // Thrown at import time, before anything binds a port or opens a pool: a misconfigured
    // process should die with the variable's name in the message, not serve wrong numbers.
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

const env = loadEnv(process.env);

export const config = {
  port: env.PORT,

  mysql: {
    host: env.MYSQL_HOST,
    port: env.MYSQL_PORT,
    database: env.MYSQL_DATABASE,
    user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD,
    connectionLimit: env.MYSQL_POOL_SIZE,
  },

  elasticsearch: {
    node: env.ELASTICSEARCH_NODE,
    productsIndex: env.ES_PRODUCTS_INDEX,
  },

  seed: {
    sourceUrl: env.DUMMYJSON_URL,
    force: env.SEED_FORCE,
    batchSize: env.SEED_BATCH_SIZE,
  },

  // Paging guard rails. Without a ceiling, `?limit=100000` turns one request into a heavy scan
  // of both stores — and ES refuses windows past 10k anyway, so the cap makes the failure a
  // clear 400 instead of an opaque ES error.
  paging: {
    defaultLimit: env.DEFAULT_LIMIT,
    maxLimit: env.MAX_LIMIT,
    maxWindow: env.MAX_WINDOW,
  },
} as const;

export type Config = typeof config;
