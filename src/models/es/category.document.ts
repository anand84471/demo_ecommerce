/**
 * The category search document: its Elasticsearch mapping, its shape, and the mapper that builds
 * one. The sibling of product.document.ts.
 *
 * A real index rather than a terms aggregation over `products`. An aggregation cannot produce a
 * bucket for a category that holds no documents, and it only knows the fields the product
 * carried — so a category with zero products disappeared from it, and `url` was always null. A
 * dedicated index built from the `categories` table has neither problem: it is the table's own
 * list, counted, with every field intact, which is what lets Elasticsearch serve /categories
 * without losing anything MySQL would have said.
 *
 * Definition only, as in product.document.ts — the client work lives in the ES category
 * repository.
 */

import type { estypes } from '@elastic/elasticsearch';

import { config } from '../../config/env.js';
import type { CategoryWithCount } from '../common.types.js';

export const CATEGORIES_INDEX = config.elasticsearch.categoriesIndex;

/** What the index stores — the same shape `GET /categories` answers with. */
export type CategoryDocument = CategoryWithCount;

export const categoriesIndexDefinition = {
  settings: {
    number_of_shards: 1,
    // Zero replicas, as in the products index: a single node can never allocate one.
    number_of_replicas: 0,
    analysis: {
      normalizer: {
        // So a slug arriving as 'Beauty' matches the stored 'beauty'.
        lowercase_keyword: { type: 'custom', filter: ['lowercase'] },
      },
    },
  },
  mappings: {
    dynamic: 'strict',
    properties: {
      slug: { type: 'keyword', normalizer: 'lowercase_keyword' },
      // The standard analyzer rather than the products index's stemming one: these are two-word
      // display names, and stemming 'Home Decoration' buys nothing. The keyword subfield is what
      // the listing sorts on — a `text` field cannot be sorted.
      name: {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      // Display only, like the products index's thumbnail.
      url: { type: 'keyword', index: false },
      productCount: { type: 'integer' },
    },
  },
} satisfies Omit<estypes.IndicesCreateRequest, 'index'>;

export interface CategoryDocumentSource {
  slug: string;
  name?: string | null;
  url?: string | null;
  productCount?: number | null;
}

/** Source category -> category document. */
export function toCategoryDocument(category: CategoryDocumentSource): CategoryDocument {
  return {
    slug: category.slug,
    // The slug is a usable last resort: it is the one field that is always present.
    name: category.name ?? category.slug,
    url: category.url ?? null,
    productCount: category.productCount ?? 0,
  };
}
