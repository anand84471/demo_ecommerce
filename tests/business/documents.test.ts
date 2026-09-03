/**
 * The mappers that turn a source record into a stored document.
 *
 * Pure functions, so these are the only tests in the suite that assert on *behaviour* rather than
 * on a round trip — and the only ones that can pin down what happens to a field the feed omits.
 * An integration test cannot: it can only show you what the live feed happened to send today.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toCategoryDocument } from '../../src/models/es/category.document.js';
import { toSearchDocument } from '../../src/models/es/product.document.js';

describe('toSearchDocument', () => {
  it('turns a feed product into a fully populated document', () => {
    const doc = toSearchDocument({
      id: 7,
      title: 'Selfie Stick Monopod',
      price: 12.99,
      category: { slug: 'mobile-accessories', name: 'Mobile Accessories' },
      tags: ['selfie', 'tripod'],
      images: ['a.jpg', 'b.jpg'],
      reviews: [{ rating: 5, comment: 'great', date: '2026-01-01T00:00:00.000Z' }],
      meta: { barcode: '123', createdAt: '2026-01-01T00:00:00.000Z' },
    });

    assert.equal(doc.id, 7);
    assert.equal(doc.title, 'Selfie Stick Monopod');
    assert.deepEqual(doc.category, { slug: 'mobile-accessories', name: 'Mobile Accessories' });
    assert.deepEqual(doc.tags, ['selfie', 'tripod']);
    assert.equal(doc.reviewCount, 1, 'reviewCount is derived, not carried');
  });

  it('gives every optional field a concrete value', () => {
    // The document's contract: a consumer never has to tell "absent" from "null". Only `id` is
    // required of the source, so this is the worst case the feed can hand over.
    const doc = toSearchDocument({ id: 1 });

    assert.equal(doc.title, '', 'title falls back to empty string, not undefined');
    assert.equal(doc.price, 0);
    assert.equal(doc.stock, 0);
    assert.deepEqual(doc.tags, []);
    assert.deepEqual(doc.images, []);
    assert.deepEqual(doc.reviews, []);
    assert.equal(doc.reviewCount, 0);
    assert.equal(doc.description, null);
    assert.equal(doc.category, null);
    for (const key of Object.keys(doc.meta) as Array<keyof typeof doc.meta>) {
      assert.equal(doc.meta[key], null, `meta.${key} should be null, not missing`);
    }
  });

  it('always emits the full dimensions triple', () => {
    // `dimensions` is mapped `enabled: false`, so a missing key would reach a client verbatim.
    const partial = toSearchDocument({ id: 1, dimensions: { width: 3 } });
    assert.deepEqual(partial.dimensions, { width: 3, height: null, depth: null });

    const absent = toSearchDocument({ id: 1 });
    assert.deepEqual(Object.keys(absent.dimensions).sort(), ['depth', 'height', 'width']);
  });

  it('normalises dates to ISO strings whichever source they came from', () => {
    // MySQL hands back a Date, the feed hands back a string, and the document promises a string.
    const fromDate = toSearchDocument({
      id: 1,
      meta: { createdAt: new Date('2026-09-03T06:00:00.000Z') },
      reviews: [{ rating: 4, date: new Date('2026-09-02T05:00:00.000Z') }],
    });
    assert.equal(fromDate.meta.createdAt, '2026-09-03T06:00:00.000Z');
    assert.equal(fromDate.reviews[0]!.date, '2026-09-02T05:00:00.000Z');

    const fromString = toSearchDocument({ id: 1, meta: { createdAt: '2026-09-03T06:00:00.000Z' } });
    assert.equal(fromString.meta.createdAt, '2026-09-03T06:00:00.000Z');
  });

  it('fills a review’s missing fields rather than dropping the review', () => {
    const doc = toSearchDocument({ id: 1, reviews: [{}] });
    assert.equal(doc.reviewCount, 1);
    assert.deepEqual(doc.reviews[0], {
      rating: 0, comment: null, date: null, reviewerName: null, reviewerEmail: null,
    });
  });
});

describe('toCategoryDocument', () => {
  it('keeps every field the feed supplied', () => {
    const doc = toCategoryDocument({
      slug: 'beauty', name: 'Beauty', url: 'https://example.test/beauty', productCount: 5,
    });
    assert.deepEqual(doc, {
      slug: 'beauty', name: 'Beauty', url: 'https://example.test/beauty', productCount: 5,
    });
  });

  it('falls back to the slug when there is no display name', () => {
    // The slug is the one field always present, which is what makes it a usable last resort.
    const doc = toCategoryDocument({ slug: 'home-decoration' });
    assert.equal(doc.name, 'home-decoration');
    assert.equal(doc.url, null);
    assert.equal(doc.productCount, 0, 'an uncounted category is 0, never undefined');
  });
});
