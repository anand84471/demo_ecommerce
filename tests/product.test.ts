import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { get, type ProductJson, requireRunningStack } from './helpers.js';

before(requireRunningStack);

describe('GET /products — listing', () => {
  it('paginates and reports a total', async () => {
    const { status, body } = await get<ProductJson[]>('/products?limit=5');
    assert.equal(status, 200);
    assert.equal(body.data.length, 5);
    assert.equal(body.meta.limit, 5);
    assert.ok(Number(body.meta.total) >= 5);
    assert.equal(body.meta.source, 'elasticsearch');
  });

  it('returns a disjoint second page', async () => {
    // Guards the sort tiebreaker: without a stable one, equal-scoring documents reorder between
    // requests, so a product appears on both pages while another is never shown at all.
    const [p1, p2] = await Promise.all([
      get<ProductJson[]>('/products?limit=5&skip=0'),
      get<ProductJson[]>('/products?limit=5&skip=5'),
    ]);
    const ids = [...p1.body.data.map((p) => p.id), ...p2.body.data.map((p) => p.id)];
    assert.equal(new Set(ids).size, 10, 'pages overlap');
  });

  it('agrees with MySQL on the total', async () => {
    const [es, db] = await Promise.all([
      get<ProductJson[]>('/products?limit=1'),
      get<ProductJson[]>('/products?limit=1&source=db'),
    ]);
    assert.equal(es.body.meta.total, db.body.meta.total);
    assert.equal(db.body.meta.source, 'mysql');
  });

  it('sorts by price ascending', async () => {
    const { body } = await get<ProductJson[]>('/products?limit=10&sort=price&order=asc');
    const prices = body.data.map((p) => p.price);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });
});

describe('GET /products?query= — full-text search', () => {
  it('finds products by a word in the title', async () => {
    const { status, body } = await get<ProductJson[]>('/products?query=mascara');
    assert.equal(status, 200);
    assert.ok(Number(body.meta.total) > 0, 'expected at least one mascara');
    assert.match(body.data[0]!.title.toLowerCase(), /mascara/);
  });

  it('tolerates a typo', async () => {
    // The reason fuzziness is configured at all — shoppers misspell.
    const { body } = await get<ProductJson[]>('/products?query=mascera');
    assert.ok(Number(body.meta.total) > 0, 'fuzzy matching did not recover a one-letter typo');
  });

  it('matches a category name, not just the title', async () => {
    const { body } = await get<ProductJson[]>('/products?query=groceries');
    assert.ok(Number(body.meta.total) > 0);
  });

  it('returns an empty result rather than an error for nonsense', async () => {
    const { status, body } = await get<ProductJson[]>('/products?query=zzzzzznotathing');
    assert.equal(status, 200);
    assert.equal(body.meta.total, 0);
    assert.deepEqual(body.data, []);
  });

  it('accepts ?q= as an alias', async () => {
    const [long, short] = await Promise.all([
      get<ProductJson[]>('/products?query=mascara'),
      get<ProductJson[]>('/products?q=mascara'),
    ]);
    assert.equal(long.body.meta.total, short.body.meta.total);
  });
});

describe('GET /products?category= — filtering', () => {
  it('returns only products in that category', async () => {
    const { status, body } = await get<ProductJson[]>('/products?category=beauty&limit=50');
    assert.equal(status, 200);
    assert.ok(body.data.length > 0);
    for (const p of body.data) assert.equal(p.category?.slug, 'beauty');
  });

  it('is case-insensitive', async () => {
    // category.slug is a keyword field; the lowercase normalizer is what makes 'BEAUTY' work.
    const [lower, upper] = await Promise.all([
      get<ProductJson[]>('/products?category=beauty'),
      get<ProductJson[]>('/products?category=BEAUTY'),
    ]);
    assert.equal(lower.body.meta.total, upper.body.meta.total);
  });

  it('combines with a full-text query', async () => {
    const { body } = await get<ProductJson[]>('/products?query=lipstick&category=beauty');
    for (const p of body.data) assert.equal(p.category?.slug, 'beauty');
  });

  it('returns an empty list for an unknown category', async () => {
    const { status, body } = await get<ProductJson[]>('/products?category=not-a-category');
    assert.equal(status, 200);
    assert.equal(body.meta.total, 0);
  });
});

describe('GET /products/:id', () => {
  it('returns one product with its relations, from MySQL', async () => {
    const { status, body } = await get<ProductJson>('/products/1');
    assert.equal(status, 200);
    const p = body.data;
    assert.equal(p.id, 1);
    assert.ok(p.title);
    assert.ok(Array.isArray(p.images));
    assert.ok(Array.isArray(p.tags));
    assert.ok(Array.isArray(p.reviews));
    assert.ok(p.dimensions);
    assert.ok(p.category?.slug);
  });

  it('404s for a missing product', async () => {
    const { status, body } = await get('/products/99999999');
    assert.equal(status, 404);
    assert.equal(body.error?.status, 404);
  });

  it('400s for a non-numeric id', async () => {
    const { status } = await get('/products/not-a-number');
    assert.equal(status, 400);
  });
});

describe('input validation', () => {
  it('rejects an unknown query parameter', async () => {
    // A typo'd filter that silently returns everything is worse than an error.
    const { status, body } = await get('/products?catagory=beauty');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /Unknown query parameter/);
  });

  it('names the offending parameter in details', async () => {
    // The schema reports every problem, not just the first, so a client can mark up its form.
    const { body } = await get('/products?limit=abc&minPrice=cheap');
    const fields = (body.error?.details ?? []).map((d) => d.field);
    assert.deepEqual(new Set(fields), new Set(['limit', 'minPrice']));
  });

  it('rejects a limit above the cap', async () => {
    const { status } = await get('/products?limit=99999');
    assert.equal(status, 400);
  });

  it('rejects a paging window deeper than Elasticsearch allows', async () => {
    const { status, body } = await get('/products?skip=10000&limit=20');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /window too deep/i);
  });

  it('rejects a repeated parameter rather than picking one', async () => {
    const { status, body } = await get('/products?source=es&source=db');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /exactly once/);
  });

  it('rejects full-text search against the MySQL source', async () => {
    const { status } = await get('/products?query=mascara&source=db');
    assert.equal(status, 400);
  });

  it('rejects sort=relevance without a query', async () => {
    const { status } = await get('/products?sort=relevance');
    assert.equal(status, 400);
  });

  it('404s an unknown route with JSON, not an HTML stack', async () => {
    const { status, body } = await get('/nope');
    assert.equal(status, 404);
    assert.ok(body.error);
  });
});
