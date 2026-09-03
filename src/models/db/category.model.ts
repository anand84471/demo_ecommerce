/**
 * The `categories` table, as TypeScript sees it.
 *
 * Row interfaces are snake_case because the columns are: the point of naming them after the DDL
 * is that a reader can hold this file and db/migrations/ side by side and check them against
 * each other. The camelCase domain shape is what leaves the repository, and the mapper below is the
 * one place the two vocabularies meet.
 */

import type { Category, CategoryWithCount } from '../common.types.js';

/** A row of `categories` — every column, in DDL order. */
export interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  url: string | null;
  /** MySQL TIMESTAMP; mysql2 hands it back as a Date. */
  created_at: Date;
  updated_at: Date;
}

/**
 * A `categories` row carrying the aggregate the listing needs.
 *
 * A `Pick` of the columns that SELECT actually asks for rather than the whole row: extending
 * `CategoryRow` would promise timestamps the query never fetched. `product_count` is
 * `number | string` because MySQL's COUNT() comes back as either depending on driver settings —
 * declaring only `number` would be a lie the mapper below quietly corrects.
 */
export interface CategoryWithCountRow extends Pick<CategoryRow, 'id' | 'slug' | 'name' | 'url'> {
  product_count: number | string;
}

/**
 * What the seed writes: the natural key plus the two display fields.
 *
 * The id and the timestamps are absent because the table supplies all three — an AUTO_INCREMENT
 * and two DEFAULT CURRENT_TIMESTAMP columns are the database's business, not the caller's.
 */
export type CategoryWrite = Category;

/** Row -> domain. */
export function toCategoryWithCount(row: CategoryWithCountRow): CategoryWithCount {
  return {
    slug: row.slug,
    name: row.name,
    url: row.url,
    productCount: Number(row.product_count),
  };
}
