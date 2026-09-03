/**
 * Shared test helpers.
 *
 * The suites are integration tests against a running stack rather than unit tests with mocks,
 * because almost everything worth testing here IS the integration: the Elasticsearch query DSL,
 * the SQL, and the mapping between them. A mocked Elasticsearch would happily confirm that a
 * broken query is well-formed.
 *
 * The response types below are declared here rather than imported from `src`: these tests assert
 * on the JSON a client actually receives, and borrowing the server's own types would let a
 * wrong-but-internally-consistent rename pass unnoticed.
 */

import assert from 'node:assert/strict';

export const BASE = process.env.API_BASE_URL ?? 'http://localhost:3000';

export interface CategoryJson {
  slug: string;
  name: string;
  url: string | null;
  productCount: number;
}

/**
 * A product as every read endpoint returns it.
 *
 * Nothing is optional: the index stores one fully precomputed document, so the listing and the
 * detail view answer with the same fields. A `?` here would quietly permit the regression these
 * tests exist to catch.
 */
export interface ProductJson {
  id: number;
  title: string;
  price: number;
  category: { slug: string; name: string } | null;
  dimensions: { width: number | null; height: number | null; depth: number | null };
  images: string[];
  tags: string[];
  reviews: unknown[];
  reviewCount: number;
  meta: {
    barcode: string | null;
    qrCode: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  };
}

export interface ApiError {
  status: number;
  message: string;
  details?: Array<{ field: string; message: string }>;
}

/** The `{ data, meta }` / `{ error }` envelope every endpoint answers with. */
export interface Envelope<T> {
  data: T;
  meta: Record<string, number | string | undefined>;
  error?: ApiError;
}

export interface Result<T> {
  status: number;
  body: Envelope<T>;
}

export async function get<T = unknown>(path: string): Promise<Result<T>> {
  const res = await fetch(`${BASE}${path}`);
  // A body that is not JSON is a failure the assertions should report, not one to swallow here.
  const body = await res.json().catch(() => ({})) as Envelope<T>;
  return { status: res.status, body };
}

export async function post<T = unknown>(
  path: string,
  headers: Record<string, string> = {},
): Promise<Result<T>> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers });
  const body = await res.json().catch(() => ({})) as Envelope<T>;
  return { status: res.status, body };
}

/** One sync run, as GET /sync/runs returns it. */
export interface SyncRunJson {
  id: number;
  runDate: string;
  trigger: string;
  status: string;
  stage: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  counts: {
    productsFetched: number;
    categoriesUpserted: number;
    tagsUpserted: number;
    productsUpserted: number;
    productsIndexed: number;
    categoriesIndexed: number;
  };
  error: string | null;
}

/**
 * Wait for a run to leave `running`.
 *
 * Tests that trigger a sync have to leave the stack idle for the next one, or a later POST gets
 * the 409 this helper exists to avoid.
 */
export async function awaitRun(id: number, timeoutMs = 60_000): Promise<SyncRunJson> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await get<SyncRunJson>(`/sync/runs/${id}`);
    if (body.data && body.data.status !== 'running') return body.data;
    if (Date.now() > deadline) throw new Error(`sync run ${id} still running after ${timeoutMs}ms`);
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
}

/** Fail once, with a useful message, instead of twenty confusing connection errors. */
export async function requireRunningStack(): Promise<void> {
  let health: Result<unknown>;
  try {
    health = await get('/health');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`API not reachable at ${BASE} — run 'docker compose up -d' first. (${message})`);
  }
  assert.equal(health.status, 200, `API unhealthy: ${JSON.stringify(health.body)}`);

  const { body } = await get<ProductJson[]>('/products?limit=1');
  assert.ok(
    Number(body.meta?.total ?? 0) > 0,
    'no products indexed — run: docker compose exec api npm run seed',
  );
}
