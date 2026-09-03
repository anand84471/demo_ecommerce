import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { type CategoryJson, get, type ProductJson } from '../helpers.js';
import { busiestCategory, categories, stack } from '../conftest.js';

// `stack` is autouse for this file, the way a pytest autouse fixture would be: every
// test below needs a running API, and one clear failure beats forty connection errors.
before(stack);

describe('GET /categories', () => {
  it('lists categories with product counts', async () => {
    const { status, body } = await get<CategoryJson[]>('/categories');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
    for (const c of body.data) {
      assert.equal(typeof c.slug, 'string');
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.productCount, 'number');
    }
  });

  it('is ordered by name', async () => {
    // The index is built from the table's own `ORDER BY c.name ASC`, and the ES listing sorts on
    // name.keyword to preserve it. A nav that reshuffles between requests is the failure here.
    const { body } = await get<CategoryJson[]>('/categories');
    const names = body.data.map((c) => c.name);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  });

  it('carries the url the products aggregation could never supply', async () => {
    // The reason /categories has an index of its own instead of a terms aggregation over
    // products: a product document does not carry its category's url, so the aggregation had to
    // report null for every one of them.
    const { body } = await get<CategoryJson[]>('/categories');
    assert.ok(
      body.data.some((c) => typeof c.url === 'string' && c.url.length > 0),
      'no category carried a url — the index is not being built from the table',
    );
  });

  it('counts sum to the product total', async () => {
    const [cats, products] = await Promise.all([
      get<CategoryJson[]>('/categories'),
      get<ProductJson[]>('/products?limit=1'),
    ]);
    const summed = cats.body.data.reduce((n, c) => n + c.productCount, 0);
    assert.equal(summed, products.body.meta.total);
  });

  it('rejects a query parameter it does not take', async () => {
    // /categories accepts none at all, and says so rather than answering 200 and ignoring it.
    const { status, body } = await get('/categories?source=redis');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /Unknown query parameter/);
  });
});

describe('GET /categories — fixture-driven consistency', () => {
  it('agrees with the product listing about how many each holds', async () => {
    // The counts come from MySQL's GROUP BY at index time; the filter is answered by
    // Elasticsearch. They are two stores describing the same fact, and this is the only test
    // that would notice them disagreeing.
    const category = await busiestCategory();
    const { body } = await get(`/products?category=${category.slug}&limit=1`);

    assert.equal(
      Number(body.meta.total),
      category.productCount,
      `/categories says ${category.slug} holds ${category.productCount}, the index disagrees`,
    );
  });

  it('lists each slug exactly once', async () => {
    // The categories index keys documents by slug precisely so a re-index overwrites rather than
    // appending a second copy that would render twice in a nav.
    const all = await categories();
    const slugs = all.map((category) => category.slug);
    assert.equal(new Set(slugs).size, slugs.length, `duplicate slug in ${slugs.join(', ')}`);
  });

  it('matches slugs case-insensitively, as the normalizer promises', async () => {
    const category = await busiestCategory();
    const [lower, upper] = await Promise.all([
      get(`/products?category=${category.slug}&limit=1`),
      get(`/products?category=${category.slug.toUpperCase()}&limit=1`),
    ]);
    assert.equal(Number(upper.body.meta.total), Number(lower.body.meta.total));
  });
});
