/**
 * Category persistence against Elasticsearch.
 *
 * The sibling of the ES product repository, and of the MySQL category repository: `findCategories`
 * appears in both stores deliberately, since the namespace an import gives it is what says which
 * one a caller reached for.
 */

import { getEsClient } from '../../config/elasticsearch.js';
import {
  CATEGORIES_INDEX, categoriesIndexDefinition, type CategoryDocument,
} from '../../models/es/category.document.js';

/**
 * A ceiling on how many categories one request will return.
 *
 * The catalogue has ~24 and a storefront nav that needed paging would be a different feature, so
 * a single request is the right shape here. The cap is what stops that assumption becoming an
 * accidental unbounded query if the taxonomy ever grows.
 */
const MAX_CATEGORIES = 1000;

/**
 * Create the index if absent; drop and recreate when `recreate` is set.
 *
 * Same reasoning as ensureProductsIndex: mappings are effectively immutable, so a change to the
 * definition in models/es/category.document.ts only takes effect on a fresh index.
 */
export async function ensureCategoriesIndex({ recreate = false } = {}): Promise<void> {
  const es = getEsClient();
  const exists = await es.indices.exists({ index: CATEGORIES_INDEX });

  if (exists && recreate) {
    await es.indices.delete({ index: CATEGORIES_INDEX });
  }
  if (!exists || recreate) {
    await es.indices.create({ index: CATEGORIES_INDEX, ...categoriesIndexDefinition });
  }
}

/**
 * Every category, ordered by name.
 *
 * `name.keyword` rather than `name`, because an analysed field cannot be sorted — and the order
 * matches MySQL's `ORDER BY c.name ASC` deliberately, so the two sources are comparable
 * position by position rather than only as sets.
 */
export async function findCategories(): Promise<CategoryDocument[]> {
  const response = await getEsClient().search<CategoryDocument>({
    index: CATEGORIES_INDEX,
    size: MAX_CATEGORIES,
    query: { match_all: {} },
    sort: [{ 'name.keyword': { order: 'asc' } }],
  });

  return response.hits.hits.map((hit) => hit._source as CategoryDocument);
}

/**
 * Bulk-index category documents. Throws on the first real error, for the same reason the product
 * bulk helper does: a partially-indexed taxonomy that reports success is worse than a failed seed.
 */
export async function bulkIndexCategories(documents: CategoryDocument[]): Promise<number> {
  if (documents.length === 0) return 0;

  // The slug as _id, not a generated one: re-indexing the same category has to overwrite it
  // rather than add a second copy that would then show up twice in the nav.
  const operations = documents.flatMap((doc) => [
    { index: { _index: CATEGORIES_INDEX, _id: doc.slug } },
    doc,
  ]);

  const response = await getEsClient().bulk({ refresh: true, operations });
  if (response.errors) {
    const firstError = response.items.find((item) => item.index?.error)?.index?.error;
    throw new Error(`Bulk indexing categories failed: ${JSON.stringify(firstError)}`);
  }
  return documents.length;
}

export async function countIndexedCategories(): Promise<number> {
  try {
    const response = await getEsClient().count({ index: CATEGORIES_INDEX });
    return response.count;
  } catch {
    return 0; // index not created yet
  }
}
