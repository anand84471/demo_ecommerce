import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { type CategoryJson, get, type ProductJson, requireRunningStack } from './helpers.js';

before(requireRunningStack);

describe('GET /categories', () => {
  it('lists categories with product counts', async () => {
    const { status, body } = await get<CategoryJson[]>('/categories');
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length > 0);
    assert.equal(body.meta.source, 'mysql');
    for (const c of body.data) {
      assert.equal(typeof c.slug, 'string');
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.productCount, 'number');
    }
  });

  it('agrees between the MySQL and Elasticsearch sources', async () => {
    // The two stores derive categories differently (table vs terms aggregation). Drift here
    // means the seed populated them inconsistently — the failure this design exists to avoid.
    const [db, es] = await Promise.all([
      get<CategoryJson[]>('/categories?source=db'),
      get<CategoryJson[]>('/categories?source=es'),
    ]);
    assert.equal(es.body.meta.source, 'elasticsearch');
    const dbCounts = new Map(db.body.data.map((c) => [c.slug, c.productCount]));
    for (const c of es.body.data) {
      assert.equal(dbCounts.get(c.slug), c.productCount, `count mismatch for '${c.slug}'`);
    }
  });

  it('counts sum to the product total', async () => {
    const [cats, products] = await Promise.all([
      get<CategoryJson[]>('/categories'),
      get<ProductJson[]>('/products?limit=1'),
    ]);
    const summed = cats.body.data.reduce((n, c) => n + c.productCount, 0);
    assert.equal(summed, products.body.meta.total);
  });

  it('rejects an unknown source', async () => {
    const { status } = await get('/categories?source=redis');
    assert.equal(status, 400);
  });
});
