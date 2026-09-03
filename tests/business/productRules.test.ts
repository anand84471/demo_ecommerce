/**
 * The two rules the product service enforces before it will ask Elasticsearch anything.
 *
 * Both are checked in the service rather than the validator because each is about two parameters
 * *together*, which a per-parameter schema cannot see. They are worth testing here rather than
 * over HTTP because both reject before any store is touched — so these run with no stack, and
 * prove the guard is the thing rejecting rather than an empty result set coming back.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { listProducts } from '../../src/services/product.service.js';
import { AppError } from '../../src/utils/errors.js';
import type { ListProductsOptions } from '../../src/validators/product.validator.js';

/** A valid request, which each test then breaks in exactly one way. */
const options = (overrides: Partial<ListProductsOptions> = {}): ListProductsOptions => ({
  text: undefined,
  category: undefined,
  tag: undefined,
  minPrice: undefined,
  maxPrice: undefined,
  sort: undefined,
  order: undefined,
  limit: 20,
  skip: 0,
  ...overrides,
});

async function rejectsWith(input: ListProductsOptions, pattern: RegExp): Promise<void> {
  await assert.rejects(
    () => listProducts(input),
    (err: unknown) => {
      assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
      assert.equal(err.status, 400);
      assert.match(err.message, pattern);
      return true;
    },
  );
}

describe('listProducts — cross-parameter rules', () => {
  it('rejects an inverted price range', async () => {
    // Elasticsearch would answer this with a cheerful empty list, which reads as "nothing in
    // stock" rather than "you asked for something impossible".
    await rejectsWith(options({ minPrice: 100, maxPrice: 10 }), /minPrice/);
  });

  it('accepts a range that is merely narrow, or open at one end', async () => {
    // Guarding the boundary: equal bounds are a legitimate exact-price filter, and one-sided
    // ranges must not trip a rule about two values.
    for (const range of [
      { minPrice: 10, maxPrice: 10 },
      { minPrice: 10 },
      { maxPrice: 10 },
    ]) {
      await assert.doesNotReject(async () => {
        try {
          await listProducts(options(range));
        } catch (err) {
          // A store that is not running is not this rule rejecting; only a 400 would be.
          if (err instanceof AppError && err.status === 400) throw err;
        }
      }, `${JSON.stringify(range)} should pass the range rule`);
    }
  });

  it('rejects sort=relevance without something to score', async () => {
    // `_score` is meaningless with no query behind it, so ES would sort every document by the
    // same constant and return an arbitrary order that looks deliberate.
    await rejectsWith(options({ sort: 'relevance' }), /relevance/);
  });

  it('allows sort=relevance once there is a query', async () => {
    await assert.doesNotReject(async () => {
      try {
        await listProducts(options({ sort: 'relevance', text: 'monopod' }));
      } catch (err) {
        if (err instanceof AppError && err.status === 400) throw err;
      }
    });
  });
});
