/**
 * Category business logic.
 */

import * as productModel from '../models/product.model.js';
import * as productSearchModel from '../models/productSearch.model.js';
import type { CategoryWithCount } from '../models/product.types.js';
import type { ListCategoriesOptions } from '../validators/category.validator.js';
import { SOURCE, type AnsweringStore } from './product.service.js';

export interface ListCategoriesResult {
  categories: CategoryWithCount[];
  source: AnsweringStore;
}

/**
 * All categories with product counts.
 *
 * MySQL by default. The table is the authoritative list and can report a category holding **zero**
 * products; an Elasticsearch terms aggregation cannot, because a bucket with no documents does
 * not exist. For a storefront nav that difference is the whole point.
 *
 * `source=es` runs the aggregation instead, which is the better answer to a different question:
 * "what is actually searchable right now" rather than "what exists".
 */
export async function listCategories(
  { source = SOURCE.DB }: Partial<ListCategoriesOptions> = {},
): Promise<ListCategoriesResult> {
  const categories = source === SOURCE.ES
    ? await productSearchModel.aggregateCategories()
    : await productModel.findCategories();

  return { categories, source: source === SOURCE.ES ? 'elasticsearch' : 'mysql' };
}
