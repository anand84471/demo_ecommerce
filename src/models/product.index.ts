/**
 * The Elasticsearch index definition for products — the search model's "schema", the counterpart
 * to models/schema.sql.
 *
 * Denormalised on purpose: category and tags are folded into the document rather than referenced,
 * because a search index is a read model where one document should answer a query without a
 * join. MySQL keeps the normalised truth.
 */

import type { estypes } from '@elastic/elasticsearch';

import { config } from '../config/env.js';
import { getEsClient } from '../config/elasticsearch.js';
import type { CategoryRef, SearchDocument } from './product.types.js';

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
      },
      analyzer: {
        // Stemming + ASCII folding so "mascaras" finds "Mascara" and "creme" finds "crème".
        product_text: {
          type: 'custom',
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding', 'english_stop', 'english_stemmer'],
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
      reviewCount: { type: 'integer' },
      createdAt: { type: 'date' },
      updatedAt: { type: 'date' },
    },
  },
} satisfies Omit<estypes.IndicesCreateRequest, 'index'>;

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
  minimumOrderQuantity?: number | null;
  thumbnail?: string | null;
  images?: string[] | null;
  reviews?: unknown[] | null;
  meta?: { createdAt?: string | Date | null; updatedAt?: string | Date | null } | null;
}

/** `date` fields want ISO-8601; MySQL hands back a Date, the feed hands back a string. */
const toIsoString = (value: string | Date | null | undefined): string | null => {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
};

/** Source product -> search document. */
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
    minimumOrderQuantity: product.minimumOrderQuantity ?? null,
    thumbnail: product.thumbnail ?? null,
    images: product.images ?? [],
    reviewCount: product.reviews?.length ?? 0,
    createdAt: toIsoString(product.meta?.createdAt),
    updatedAt: toIsoString(product.meta?.updatedAt),
  };
}

/**
 * Create the index if absent; drop and recreate when `recreate` is set.
 *
 * Mappings are effectively immutable in Elasticsearch — you cannot change a field's type in
 * place — so a change to this file only takes effect on a fresh index. Recreating on seed is
 * what keeps the running index honest to the definition above.
 */
export async function ensureProductsIndex({ recreate = false } = {}): Promise<void> {
  const es = getEsClient();
  const exists = await es.indices.exists({ index: PRODUCTS_INDEX });

  if (exists && recreate) {
    await es.indices.delete({ index: PRODUCTS_INDEX });
  }
  if (!exists || recreate) {
    await es.indices.create({ index: PRODUCTS_INDEX, ...productsIndexDefinition });
  }
}
