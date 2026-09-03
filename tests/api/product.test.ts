import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { get, type ProductJson } from '../helpers.js';
import { anyProduct, catalogue, productQuery, reviewedProduct, stack } from '../conftest.js';

// `stack` is autouse for this file, the way a pytest autouse fixture would be: every
// test below needs a running API, and one clear failure beats forty connection errors.
before(stack);

describe('GET /products — listing', () => {
  it('paginates and reports a total', async () => {
    const { status, body } = await get<ProductJson[]>('/products?limit=5');
    assert.equal(status, 200);
    assert.equal(body.data.length, 5);
    assert.equal(body.meta.limit, 5);
    assert.ok(Number(body.meta.total) >= 5);
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

  it('serves fully precomputed documents — no join, no second trip', async () => {
    // The point of the products index: one document answers the listing outright. A missing
    // array here means a relation stopped being folded in at index time, which a consumer would
    // otherwise discover as a silently absent gallery.
    const { body } = await get<ProductJson[]>('/products?limit=3');
    for (const p of body.data) {
      assert.ok(Array.isArray(p.images), `product ${p.id} has no images array`);
      assert.ok(Array.isArray(p.tags), `product ${p.id} has no tags array`);
      assert.ok(Array.isArray(p.reviews), `product ${p.id} has no reviews array`);
      assert.equal(p.reviews.length, p.reviewCount, `reviewCount disagrees for ${p.id}`);
      assert.ok(p.dimensions, `product ${p.id} has no dimensions`);
      assert.ok(p.meta, `product ${p.id} has no meta`);
      assert.ok(p.category?.slug, `product ${p.id} has no category`);
    }
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

  it('matches a word the shopper has not finished typing', async () => {
    // 'monop' is not a token in any whole-word index; the title.autocomplete subfield is the
    // only thing that can match it.
    const { body } = await get<ProductJson[]>('/products?query=monop');
    assert.ok(Number(body.meta.total) > 0, 'a prefix of a product name found nothing');
    assert.match(body.data[0]!.title.toLowerCase(), /monopod/);
  });

  it('narrows monotonically as the word is typed', async () => {
    // The regression this guards: fuzziness used to stand in for prefix matching, and `AUTO`
    // budgets one edit for 3-5 characters and two beyond. So 'mono' matched *Moonphase* (one
    // transposition), 'monop' matched nothing, and 'monopo' matched Monopod — adding a letter
    // made the product disappear and come back.
    const totals: number[] = [];
    for (const query of ['mono', 'monop', 'monopo', 'monopod']) {
      const { body } = await get<ProductJson[]>(`/products?query=${query}`);
      assert.match(
        body.data[0]!.title.toLowerCase(),
        /monopod/,
        `'${query}' did not rank a monopod first`,
      );
      totals.push(Number(body.meta.total));
    }
    assert.deepEqual(
      totals,
      [...totals].sort((a, b) => b - a),
      `typing another letter widened the results: ${totals.join(' -> ')}`,
    );
  });

  it('does not expand the query into prefixes as well', async () => {
    // The half of the autocomplete pair that is easy to get wrong. If search_analyzer were the
    // edge-ngram analyzer, 'monop' would be analysed to mo/mon/mono/monop and match every
    // product starting with "mo" — recall would look fine and precision would be gone.
    const { body } = await get<ProductJson[]>('/products?query=monop&limit=50');
    for (const product of body.data) {
      assert.match(
        product.title.toLowerCase(),
        /monopod/,
        `'${product.title}' matched a prefix query it does not start with`,
      );
    }
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
  it('returns one product with its relations', async () => {
    const { status, body } = await get<ProductJson>('/products/1');
    assert.equal(status, 200);
    const p = body.data;
    assert.equal(p.id, 1);
    assert.ok(p.title);
    assert.ok(Array.isArray(p.images));
    assert.ok(Array.isArray(p.tags));
    assert.ok(Array.isArray(p.reviews));
    assert.ok(p.dimensions);
    assert.ok(p.meta);
    assert.ok(p.category?.slug);
  });

  it('is the same document the listing returns', async () => {
    // The detail endpoint is a lookup into the same index, not a second data path. If these ever
    // diverge, one of them has grown its own shaping — which is how a field ends up present on a
    // list page and missing on a detail page.
    const [list, detail] = await Promise.all([
      get<ProductJson[]>('/products?limit=1&sort=id&order=asc'),
      get<ProductJson>('/products/1'),
    ]);
    const { _score, ...listed } = list.body.data[0]! as ProductJson & { _score?: number };
    assert.deepEqual(detail.body.data, listed);
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
    const { status, body } = await get('/products?category=beauty&category=furniture');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /exactly once/);
  });

  it('rejects an inverted price range', async () => {
    // Elasticsearch would answer this with a cheerful empty list, which reads as "no such
    // products" rather than "you asked for something impossible".
    const { status, body } = await get('/products?minPrice=100&maxPrice=10');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /cannot exceed/);
  });

  it('no longer takes a store to read from', async () => {
    // MySQL is the write store; there is nothing to choose. The parameter is rejected rather
    // than ignored, so a caller relying on the old switch finds out.
    const { status, body } = await get('/products?source=db');
    assert.equal(status, 400);
    assert.match(body.error?.message ?? '', /Unknown query parameter/);
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

describe('GET /products — fixture-driven consistency', () => {
  it('serves the detail view from the same document as the listing', async () => {
    // The architecture's central claim: one precomputed document answers both, so a detail view
    // is a lookup rather than a second data path that can drift.
    const listed = await anyProduct();
    const { status, body } = await get<ProductJson>(`/products/${listed.id}`);

    assert.equal(status, 200);
    assert.deepEqual(body.data.category, listed.category);
    assert.deepEqual(body.data.tags, listed.tags);
    assert.deepEqual(body.data.images, listed.images);
    assert.equal(body.data.reviewCount, listed.reviewCount);
    assert.equal(body.data.price, listed.price);
  });

  it('carries whole reviews, not just a count', async () => {
    const product = await reviewedProduct();
    assert.equal(product.reviews.length, product.reviewCount);

    const review = product.reviews[0] as { rating?: unknown; comment?: unknown };
    assert.equal(typeof review.rating, 'number', 'a stored review lost its rating');
    assert.ok('comment' in review, 'a stored review lost its comment key');
  });

  it('files every product under a category the nav actually lists', async () => {
    // Cross-endpoint: the products index and the categories index are built in the same sync
    // from the same map. A product filed under a slug /categories does not know about is that
    // map having drifted.
    const [products, { body: nav }] = await Promise.all([
      catalogue(),
      get<Array<{ slug: string }>>('/categories'),
    ]);
    const known = new Set(nav.data.map((category) => category.slug));

    for (const product of products) {
      assert.ok(
        product.category && known.has(product.category.slug),
        `product ${product.id} is filed under '${product.category?.slug}', which /categories omits`,
      );
    }
  });

  it('applies every filter at once rather than the last one wins', async () => {
    const url = await productQuery();
    const products = await catalogue();
    const priced = products.filter((product) => product.price > 0);
    const ceiling = Math.max(...priced.map((product) => product.price));
    const category = priced[0]!.category!.slug;

    const { body } = await get<ProductJson[]>(url({ category, maxPrice: ceiling, limit: 50 }));
    for (const product of body.data) {
      assert.equal(product.category?.slug, category, 'category filter was dropped');
      assert.ok(product.price <= ceiling, `price ${product.price} exceeds maxPrice ${ceiling}`);
    }
  });
});
