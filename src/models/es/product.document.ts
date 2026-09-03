/**
 * The product search document: its Elasticsearch mapping, its TypeScript shape, and the mapper
 * that turns a source product into one. The counterpart to the DDL in db/migrations/.
 *
 * Denormalised on purpose: category and tags are folded into the document rather than referenced,
 * because a search index is a read model where one document should answer a query without a
 * join. MySQL keeps the normalised truth.
 *
 * Definition only — no client, no queries. Creating the index and searching it are the ES product
 * repository's job, which is what keeps this file readable as a schema.
 */

import type { estypes } from '@elastic/elasticsearch';

import { config } from '../../config/env.js';
import type { CategoryRef, Dimensions, Review } from '../common.types.js';

export const PRODUCTS_INDEX = config.elasticsearch.productsIndex;

export const productsIndexDefinition = {
  settings: {
    number_of_shards: 1,
    // Zero replicas: a single node can never allocate one, and asking would pin the index at
    // yellow forever for no benefit.
    number_of_replicas: 0,
    analysis: {
      filter: {
        english_stop: { type: 'stop', stopwords: '_english_' },
        english_stemmer: { type: 'stemmer', language: 'english' },
        // Every prefix of a word from two characters up. `Monopod` becomes mo, mon, mono, monop,
        // monopo, monopod — so a partial word is a real term instead of something the query has
        // to guess at.
        autocomplete_edge: { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
      },
      analyzer: {
        // Stemming + ASCII folding so "mascaras" finds "Mascara" and "creme" finds "crème".
        product_text: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'english_stop', 'english_stemmer'],
        },
        // Index side of the autocomplete pair: expand each word into its prefixes.
        product_autocomplete: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'autocomplete_edge'],
        },
        // Search side, and the reason the pair exists. The query must NOT be expanded: analysing
        // "monop" into mo/mon/mono/monop would make it match every word starting with "mo".
        // Same tokenizer and folding, minus the edge filter.
        product_autocomplete_search: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding'],
        },
      },
      normalizer: {
        // Exact matching that is still case-insensitive — for slugs arriving as "Beauty".
        lowercase_keyword: { type: 'custom', filter: ['lowercase'] },
      },
    },
  },
  mappings: {
    // Reject unexpected fields rather than mapping them silently: a typo'd field name that
    // dynamic mapping accepts becomes an un-searchable field nobody notices.
    dynamic: 'strict',
    properties: {
      id: { type: 'integer' },
      title: {
        type: 'text',
        analyzer: 'product_text',
        fields: {
          // Un-stemmed copy for exact phrase boosting: stemming makes "lash" and "lashes"
          // identical, which is right for recall and wrong for ranking.
          exact: { type: 'text', analyzer: 'standard' },
          // Prefix copy, for a search box being typed into. Without it nothing in this mapping
          // can match a partial word — every other field indexes whole tokens — and "monop"
          // finds nothing while "monopo" finds the product.
          autocomplete: {
            type: 'text',
            analyzer: 'product_autocomplete',
            search_analyzer: 'product_autocomplete_search',
          },
          keyword: { type: 'keyword', ignore_above: 256 },
        },
      },
      description: { type: 'text', analyzer: 'product_text' },
      brand: {
        type: 'text',
        analyzer: 'product_text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      sku: { type: 'keyword' },
      category: {
        properties: {
          slug: { type: 'keyword', normalizer: 'lowercase_keyword' },
          name: {
            type: 'text',
            analyzer: 'product_text',
            fields: { keyword: { type: 'keyword' } },
          },
        },
      },
      // Analysed for free-text recall, keyword for exact facet filtering.
      tags: {
        type: 'text',
        analyzer: 'product_text',
        fields: { keyword: { type: 'keyword', normalizer: 'lowercase_keyword' } },
      },
      price: { type: 'scaled_float', scaling_factor: 100 },
      discountPercentage: { type: 'scaled_float', scaling_factor: 100 },
      rating: { type: 'half_float' },
      stock: { type: 'integer' },
      availabilityStatus: { type: 'keyword' },
      returnPolicy: { type: 'keyword' },
      shippingInformation: { type: 'keyword' },
      warrantyInformation: { type: 'keyword' },
      weight: { type: 'half_float' },
      minimumOrderQuantity: { type: 'integer' },
      // Carried for display but never queried, so indexing them would only cost space.
      thumbnail: { type: 'keyword', index: false },
      images: { type: 'keyword', index: false },
      // `enabled: false` rather than a mapped object: dimensions are shown, never searched or
      // sorted on. Elasticsearch keeps them in _source untouched and builds nothing — which also
      // means 23.17 comes back as 23.17, where a half_float would have rounded it to 23.171875.
      dimensions: { type: 'object', enabled: false },
      // Same reasoning, and the reason `reviewCount` exists beside it: the count is the part
      // worth sorting and filtering on, so it is mapped while the array is only stored.
      reviews: { type: 'object', enabled: false },
      reviewCount: { type: 'integer' },
      meta: {
        properties: {
          barcode: { type: 'keyword', index: false },
          qrCode: { type: 'keyword', index: false },
          // The dates stay mapped: unlike the codes, "what changed recently" is a question a
          // catalogue actually gets asked, and a date field is what makes it answerable.
          createdAt: { type: 'date' },
          updatedAt: { type: 'date' },
        },
      },
    },
  },
} satisfies Omit<estypes.IndicesCreateRequest, 'index'>;

/**
 * `meta` as Elasticsearch stores it, with the dates already ISO-8601.
 *
 * The narrowing is the point: the sources this is built from disagree about dates — MySQL hands
 * back a `Date`, the feed hands back a string — while a document that has been through
 * `toSearchDocument` is known to hold strings. Saying so here is what lets a reader trust the
 * JSON without going and checking the mapper.
 */
export interface SearchDocumentMeta {
  barcode: string | null;
  qrCode: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A review inside a search document — `Review` with its date narrowed the same way. */
export interface SearchReview extends Omit<Review, 'date'> {
  date: string | null;
}

/**
 * A product, as Elasticsearch stores it and as the API returns it.
 *
 * There is no second product shape any more: this one is what every read endpoint answers with,
 * the detail view included, because it is fully denormalised and fully precomputed. Category,
 * tags, images, dimensions, meta and the reviews themselves are folded in at index time, so one
 * document answers a request outright — no join, and no trip to MySQL. `reviewCount` is the one
 * field with no counterpart in the tables: a summary the index can sort and filter on, which an
 * array of stored objects cannot do cheaply.
 */
export interface SearchDocument {
  id: number;
  title: string;
  description: string | null;
  brand: string | null;
  sku: string | null;
  category: CategoryRef | null;
  tags: string[];
  price: number;
  discountPercentage: number | null;
  rating: number | null;
  stock: number;
  availabilityStatus: string | null;
  returnPolicy: string | null;
  shippingInformation: string | null;
  warrantyInformation: string | null;
  weight: number | null;
  dimensions: Dimensions;
  minimumOrderQuantity: number | null;
  thumbnail: string | null;
  images: string[];
  reviews: SearchReview[];
  reviewCount: number;
  meta: SearchDocumentMeta;
}

/** A search hit: the stored document plus the score it matched with. */
export interface ScoredSearchDocument extends SearchDocument {
  _score: number | null;
}

/**
 * What `toSearchDocument` accepts: either a product read out of MySQL or one straight off the
 * source feed. Every field is optional because the feed's are — the mapping below is where the
 * document's guarantees are established.
 */
export interface SearchDocumentSource {
  id: number;
  title?: string | null;
  description?: string | null;
  brand?: string | null;
  sku?: string | null;
  category?: CategoryRef | null;
  tags?: string[] | null;
  price?: number | null;
  discountPercentage?: number | null;
  rating?: number | null;
  stock?: number | null;
  availabilityStatus?: string | null;
  returnPolicy?: string | null;
  shippingInformation?: string | null;
  warrantyInformation?: string | null;
  weight?: number | null;
  dimensions?: Partial<Dimensions> | null;
  minimumOrderQuantity?: number | null;
  thumbnail?: string | null;
  images?: string[] | null;
  reviews?: SourceReview[] | null;
  meta?: {
    barcode?: string | null;
    qrCode?: string | null;
    createdAt?: string | Date | null;
    updatedAt?: string | Date | null;
  } | null;
}

/** A review as either source hands it over: MySQL with a Date, the feed with a string. */
export interface SourceReview {
  rating?: number | null;
  comment?: string | null;
  date?: string | Date | null;
  reviewerName?: string | null;
  reviewerEmail?: string | null;
}

/** `date` fields want ISO-8601; MySQL hands back a Date, the feed hands back a string. */
const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
};

/** Source review -> the document's review. */
const toSearchReview = (review: SourceReview): SearchReview => ({
  rating: review.rating ?? 0,
  comment: review.comment ?? null,
  date: toIsoString(review.date),
  reviewerName: review.reviewerName ?? null,
  reviewerEmail: review.reviewerEmail ?? null,
});

/**
 * Source product -> search document.
 *
 * This is where "precomputed" is actually done: every relation the listing endpoints hand back
 * is flattened into the document once, at index time, instead of being joined on every read. The
 * nullish defaults are the other half of the job — the source's optional fields become the
 * document's guaranteed ones, so a consumer never has to distinguish "absent" from "null".
 */
export function toSearchDocument(product: SearchDocumentSource): SearchDocument {
  return {
    id: product.id,
    title: product.title ?? '',
    description: product.description ?? null,
    brand: product.brand ?? null,
    sku: product.sku ?? null,
    category: product.category
      ? { slug: product.category.slug, name: product.category.name }
      : null,
    tags: product.tags ?? [],
    price: product.price ?? 0,
    discountPercentage: product.discountPercentage ?? null,
    rating: product.rating ?? null,
    stock: product.stock ?? 0,
    availabilityStatus: product.availabilityStatus ?? null,
    returnPolicy: product.returnPolicy ?? null,
    shippingInformation: product.shippingInformation ?? null,
    warrantyInformation: product.warrantyInformation ?? null,
    weight: product.weight ?? null,
    // Always the full triple, even when the source omits one: a consumer reading
    // `dimensions.width` should find a null rather than a missing key.
    dimensions: {
      width: product.dimensions?.width ?? null,
      height: product.dimensions?.height ?? null,
      depth: product.dimensions?.depth ?? null,
    },
    minimumOrderQuantity: product.minimumOrderQuantity ?? null,
    thumbnail: product.thumbnail ?? null,
    images: product.images ?? [],
    reviews: (product.reviews ?? []).map(toSearchReview),
    reviewCount: product.reviews?.length ?? 0,
    meta: {
      barcode: product.meta?.barcode ?? null,
      qrCode: product.meta?.qrCode ?? null,
      createdAt: toIsoString(product.meta?.createdAt),
      updatedAt: toIsoString(product.meta?.updatedAt),
    },
  };
}
