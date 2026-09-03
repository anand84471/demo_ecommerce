/**
 * Category business logic.
 */

import * as categoryRepository from '../repositories/es/category.repository.js';
import type { CategoryWithCount } from '../models/common.types.js';

/**
 * All categories with product counts, from the `categories` index.
 *
 * Elasticsearch can be the only answer here because the index is built from the `categories`
 * table itself — every row, its `url`, and a count from the same `GROUP BY` MySQL would have run.
 * That was not true of the terms aggregation over product documents this replaced: an aggregation
 * has no bucket for a category holding zero products, so an unstocked category simply vanished
 * from the nav.
 */
export async function listCategories(): Promise<CategoryWithCount[]> {
  return categoryRepository.findCategories();
}
