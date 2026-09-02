/**
 * Product data access against Elasticsearch — the search read model.
 *
 * The sibling of product.model.ts: same layer, different store. This one owns the query DSL and
 * nothing else.
 */

import type { estypes } from '@elastic/elasticsearch';

import { getEsClient } from '../config/elasticsearch.js';
import { PRODUCTS_INDEX } from './product.index.js';
import type {
  CategoryWithCount, ProductPage, ScoredSearchDocument, SearchDocument,
} from './product.types.js';

const SORTABLE = {
  // `_score` only means anything when there is a query; the service falls back to `id` otherwise.
  relevance: '_score',
  id: 'id',
  title: 'title.keyword',
  price: 'price',
  rating: 'rating',
  stock: 'stock',
} as const;

export type SearchSortField = keyof typeof SORTABLE;

export interface SearchProductsOptions {
  text?: string | undefined;
  category?: string | undefined;
  tag?: string | undefined;
  minPrice?: number | undefined;
  maxPrice?: number | undefined;
  limit: number;
  skip: number;
  sort?: SearchSortField | undefined;
  order?: string | undefined;
}

/**
 * The free-text query.
 *
 * `best_fields` rather than `cross_fields`: a product is normally identified by one field saying
 * it strongly ("Essence Mascara" in the title), not by terms scattered across several. Boosts put
 * a title hit well above a description mention, and the un-stemmed `title.exact` phrase clause
 * lifts a literal title match above a stemmed near-miss.
 *
 * Fuzziness is capped at one edit with `prefix_length: 1`, which recovers "mascera" -> "mascara"
 * without letting three-letter words match half the catalogue.
 */
function buildTextQuery(text: string): estypes.QueryDslQueryContainer {
  return {
    bool: {
      should: [
        {
          multi_match: {
            query: text,
            type: 'best_fields',
            fields: ['title^4', 'brand^3', 'tags^2', 'category.name^2', 'description'],
            fuzziness: 'AUTO',
            prefix_length: 1,
            minimum_should_match: '2<70%',
          },
        },
        { match_phrase: { 'title.exact': { query: text, boost: 6 } } },
      ],
      minimum_should_match: 1,
    },
  };
}

export async function searchProducts({
  text, category, tag, minPrice, maxPrice, limit, skip, sort, order,
}: SearchProductsOptions): Promise<ProductPage<ScoredSearchDocument>> {
  const filter: estypes.QueryDslQueryContainer[] = [];
  if (category) filter.push({ term: { 'category.slug': category.toLowerCase() } });
  if (tag) filter.push({ term: { 'tags.keyword': tag.toLowerCase() } });
  if (minPrice != null || maxPrice != null) {
    filter.push({
      range: {
        price: {
          ...(minPrice != null ? { gte: minPrice } : {}),
          ...(maxPrice != null ? { lte: maxPrice } : {}),
        },
      },
    });
  }

  // Filters go in `filter`, not `must`: they are yes/no conditions that should not skew
  // relevance, and Elasticsearch caches them.
  const query: estypes.QueryDslQueryContainer = {
    bool: {
      must: text ? [buildTextQuery(text)] : [{ match_all: {} }],
      filter,
    },
  };

  const effectiveSort = sort ?? (text ? 'relevance' : 'id');
  const sortField: string = SORTABLE[effectiveSort] ?? SORTABLE.id;
  const sortOrder = (order ?? (sortField === '_score' ? 'desc' : 'asc')).toLowerCase() === 'desc'
    ? 'desc'
    : 'asc';
  // The id tiebreaker keeps paging deterministic: without it, documents with equal scores can
  // reorder between requests, so the same product appears on two pages and another on none.
  const sortClause: estypes.Sort = [
    { [sortField]: { order: sortOrder } },
    { id: { order: 'asc' } },
  ];

  const response = await getEsClient().search<SearchDocument>({
    index: PRODUCTS_INDEX,
    from: skip,
    size: limit,
    query,
    sort: sortClause,
    // Exact totals rather than the default 10k cap — a paginator showing "10000+" for a
    // 194-product catalogue is simply wrong.
    track_total_hits: true,
  });

  return {
    // `_source` is only absent if the search asked for it to be, which this one does not.
    products: response.hits.hits.map((hit) => ({
      ...(hit._source as SearchDocument),
      _score: hit._score ?? null,
    })),
    total: totalHits(response.hits.total),
  };
}

/** ES reports the total either as a number or as `{ value, relation }`, depending on the version. */
function totalHits(total: estypes.SearchTotalHits | number | undefined): number {
  if (total === undefined) return 0;
  return typeof total === 'number' ? total : total.value;
}

interface CategoryAggregations {
  categories: estypes.AggregationsStringTermsAggregate & {
    buckets: Array<{
      key: string;
      doc_count: number;
      name?: { buckets?: Array<{ key: string }> };
    }>;
  };
}

/** Categories derived from the index rather than the table (a terms aggregation). */
export async function aggregateCategories(): Promise<CategoryWithCount[]> {
  const response = await getEsClient().search<SearchDocument, CategoryAggregations>({
    index: PRODUCTS_INDEX,
    size: 0,
    aggs: {
      categories: {
        terms: { field: 'category.slug', size: 500, order: { _key: 'asc' } },
        aggs: { name: { terms: { field: 'category.name.keyword', size: 1 } } },
      },
    },
  });

  const buckets = response.aggregations?.categories.buckets ?? [];
  return buckets.map((bucket) => ({
    slug: bucket.key,
    name: bucket.name?.buckets?.[0]?.key ?? bucket.key,
    url: null,
    productCount: bucket.doc_count,
  }));
}

/**
 * Bulk-index documents. Throws on the first real error — a partially-indexed catalogue that
 * reports success is worse than a failed seed.
 */
export async function bulkIndexProducts(documents: SearchDocument[]): Promise<number> {
  if (documents.length === 0) return 0;

  const operations = documents.flatMap((doc) => [
    { index: { _index: PRODUCTS_INDEX, _id: String(doc.id) } },
    doc,
  ]);

  const response = await getEsClient().bulk({ refresh: true, operations });
  if (response.errors) {
    const firstError = response.items.find((item) => item.index?.error)?.index?.error;
    throw new Error(`Bulk indexing failed: ${JSON.stringify(firstError)}`);
  }
  return documents.length;
}

export async function countIndexedProducts(): Promise<number> {
  try {
    const response = await getEsClient().count({ index: PRODUCTS_INDEX });
    return response.count;
  } catch {
    return 0; // index not created yet
  }
}
