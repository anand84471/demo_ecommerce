/**
 * Product persistence against Elasticsearch — the read model the API is served from.
 *
 * The repository layer is where store access lives: query DSL, bulk writes, index lifecycle. It
 * owns *how* a question is asked, never *whether* it should be — a repository has no opinion
 * about which store answers a request, and no knowledge of HTTP. Its models are in models/es/.
 */

import type { estypes } from '@elastic/elasticsearch';

import { getEsClient } from '../../config/elasticsearch.js';
import type { ProductPage } from '../../models/common.types.js';
import {
  PRODUCTS_INDEX, productsIndexDefinition,
  type ScoredSearchDocument, type SearchDocument,
} from '../../models/es/product.document.js';

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
 * Create the index if absent; drop and recreate when `recreate` is set.
 *
 * Mappings are effectively immutable in Elasticsearch — you cannot change a field's type in
 * place — so a change to models/es/product.document.ts only takes effect on a fresh index.
 * Recreating on seed is what keeps the running index honest to the definition.
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

/**
 * The free-text query.
 *
 * `best_fields` rather than `cross_fields`: a product is normally identified by one field saying
 * it strongly ("Essence Mascara" in the title), not by terms scattered across several. Boosts put
 * a title hit well above a description mention, and the un-stemmed `title.exact` phrase clause
 * lifts a literal title match above a stemmed near-miss.
 *
 * Three clauses, because typo tolerance and prefix matching are different problems:
 *
 *   - the fuzzy `multi_match` handles misspellings — "mascera" -> "mascara". `AUTO` spends one
 *     edit on terms of 3-5 characters and two on longer ones, and `prefix_length: 1` pins the
 *     first character so short words cannot drift into half the catalogue.
 *   - the `title.exact` phrase lifts a literal title match above a stemmed near-miss.
 *   - `title.autocomplete` matches a word the user has not finished typing.
 *
 * The last one is not decoration. Without it, fuzziness was standing in for prefix matching and
 * doing it non-monotonically: "mono" matched *Moonphase* (one transposition), "monop" matched
 * nothing (two edits away, and only one was budgeted), and "monopo" matched Monopod. Adding a
 * letter made results disappear and then reappear as a different product.
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
        // Below the exact phrase: someone who typed the whole title wants that product first,
        // not whatever else happens to start with the same letters.
        { match: { 'title.autocomplete': { query: text, boost: 3 } } },
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

/**
 * One document by id, or null when the index has no such product.
 *
 * A `get` rather than a search: fetching by document id is a direct lookup that skips scoring and
 * the query phase entirely, and it is realtime — it will return a document that has been indexed
 * but not yet refreshed into the searchable segments, which a search would miss.
 */
export async function findProductById(id: number): Promise<SearchDocument | null> {
  try {
    const response = await getEsClient().get<SearchDocument>({
      index: PRODUCTS_INDEX,
      id: String(id),
    });
    return response._source ?? null;
  } catch (err) {
    // A missing document is a 404 from Elasticsearch, which the client raises rather than
    // returns. That is this function's null, not an error — anything else genuinely is one and
    // must keep propagating, or an unreachable cluster would masquerade as an empty catalogue.
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** True for Elasticsearch's own 404, and nothing else. */
function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { statusCode?: number }).statusCode === 404;
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
