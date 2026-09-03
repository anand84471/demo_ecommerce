/**
 * Shared fixtures — `conftest.py`, in TypeScript.
 *
 * Importing anything from this file installs the teardown hooks in the importing test file, so no
 * test has to remember to clean up. That is the whole bargain: declare what a test needs, get it
 * built on demand, and get it torn down whether the test passed or threw.
 *
 * The API fixtures below all depend on `stack`, so a suite run against a stopped stack fails once
 * with "run 'docker compose up -d' first" instead of forty connection errors — which is what the
 * old `before(requireRunningStack)` did, minus having to write it in every file.
 */

import assert from 'node:assert/strict';

import { factoryFixture, fixture, registerFixtureHooks } from './fixtures.js';
import {
  awaitRun, get, post,
  type CategoryJson, type ProductJson, type SyncRunJson,
} from './helpers.js';

registerFixtureHooks();

/**
 * The running stack, asserted once per test file.
 *
 * Not a value so much as a precondition — everything else depends on it, so the failure lands
 * here with an actionable message rather than inside whichever test ran first.
 */
export const stack = fixture('stack', async () => {
  let status: number;
  try {
    ({ status } = await get('/health'));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`API not reachable — run 'docker compose up -d' first. (${message})`);
  }
  assert.equal(status, 200, 'API reported unhealthy');

  const { body } = await get<ProductJson[]>('/products?limit=1');
  assert.ok(
    Number(body.meta?.total ?? 0) > 0,
    "no products indexed — run: docker compose exec api npm run seed",
  );
  return { ready: true as const };
});

/** One page of the catalogue, fetched once and shared by every test in the file. */
export const catalogue = fixture('catalogue', async (ctx): Promise<ProductJson[]> => {
  await ctx.use(stack);
  const { body } = await get<ProductJson[]>('/products?limit=100');
  assert.ok(body.data.length > 0, 'catalogue came back empty');
  return body.data;
});

/**
 * Some product that certainly exists.
 *
 * Deliberately "some" and not "product 1": a test that asserts on a hardcoded id is really
 * asserting about the upstream feed, and breaks the day the feed renumbers.
 */
export const anyProduct = fixture('anyProduct', async (ctx): Promise<ProductJson> => {
  const products = await ctx.use(catalogue);
  return products[0]!;
});

/** A product that has reviews — the ones worth asserting about are not guaranteed to be first. */
export const reviewedProduct = fixture('reviewedProduct', async (ctx): Promise<ProductJson> => {
  const products = await ctx.use(catalogue);
  const withReviews = products.find((product) => product.reviewCount > 0);
  assert.ok(withReviews, 'no product in the catalogue carries a review');
  return withReviews;
});

export const categories = fixture('categories', async (ctx): Promise<CategoryJson[]> => {
  await ctx.use(stack);
  const { body } = await get<CategoryJson[]>('/categories');
  assert.ok(body.data.length > 0, 'no categories');
  return body.data;
});

/** The most populated category, so a filter test has something to filter down to. */
export const busiestCategory = fixture('busiestCategory', async (ctx): Promise<CategoryJson> => {
  const all = await ctx.use(categories);
  return [...all].sort((a, b) => b.productCount - a.productCount)[0]!;
});

/**
 * A finished sync run.
 *
 * Session-scoped because triggering one is the expensive fixture in this file, and because two
 * at once would collide on the API's in-flight guard and 409. Unforced, so against a populated
 * stack it skips in milliseconds — the tests that use it care about the *record*, not a rebuild.
 */
export const completedSyncRun = fixture('completedSyncRun', async (ctx): Promise<SyncRunJson> => {
  await ctx.use(stack);
  const { status, body } = await post<SyncRunJson>('/sync');
  assert.equal(status, 202, `POST /sync answered ${status}: ${JSON.stringify(body)}`);
  return awaitRun(body.data.id);
});

/**
 * Build query strings without hand-rolling encodeURIComponent at every call site.
 *
 * A factory fixture: pytest's "fixture that returns a function", for when each test wants its own
 * object rather than a shared one.
 */
export const productQuery = factoryFixture(
  'productQuery',
  () => (params: Record<string, string | number>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) search.set(key, String(value));
    return `/products?${search.toString()}`;
  },
);
