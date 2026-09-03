/**
 * Category persistence against MySQL — the system of record.
 *
 * MySQL is the store that accepts writes; Elasticsearch answers every read the API serves. That
 * leaves exactly one MySQL read in the codebase, and it is not on a request path: the indexer
 * needs the authoritative category list to build the `categories` index from, counts included.
 *
 * It has to come from here rather than from the products already indexed. The table knows about a
 * category that holds **zero** products; a count derived from product documents cannot, because
 * there are no documents to count. That is the difference between a nav that lists the catalogue's
 * taxonomy and one that lists only the parts of it currently stocked.
 */

import type { PoolConnection } from 'mysql2/promise';

import { query, queryOn } from '../../config/database.js';
import type { CategoryWithCount } from '../../models/common.types.js';
import {
  toCategoryWithCount,
  type CategoryRow, type CategoryWithCountRow, type CategoryWrite,
} from '../../models/db/category.model.js';

/** All categories with how many products each holds. */
export async function findCategories(): Promise<CategoryWithCount[]> {
  // LEFT JOIN, not INNER: an inner join would drop the empty categories this function exists to
  // keep. COUNT(p.id) rather than COUNT(*) for the same reason — it counts matched products, so
  // an empty category scores 0 instead of 1.
  const rows = await query<CategoryWithCountRow>(`
    SELECT c.id, c.slug, c.name, c.url, COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.slug, c.name, c.url
    ORDER BY c.name ASC
  `);
  return rows.map(toCategoryWithCount);
}

/**
 * Upsert every category and hand back the slug -> id map the product writes need.
 *
 * Returned rather than recomputed by the caller because the surrogate ids are this table's own
 * business: a product knows its category as a slug, and this is the only place that knows what
 * `products.category_id` should hold.
 */
export async function upsertCategories(
  conn: PoolConnection,
  categories: Iterable<CategoryWrite>,
): Promise<Map<string, number>> {
  for (const category of categories) {
    // COALESCE, not a plain overwrite: when the feed's category endpoint is unreachable the sync
    // derives categories from the products instead, and a product carries no `url`. Writing that
    // null straight in would let one transient upstream failure erase a column that a previous
    // healthy run had filled. A degraded run may add rows; it may not destroy what a good one
    // learned.
    await conn.execute(
      `INSERT INTO categories (slug, name, url) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), url = COALESCE(VALUES(url), url)`,
      [category.slug, category.name, category.url],
    );
  }
  const rows = await queryOn<Pick<CategoryRow, 'id' | 'slug'>>(
    conn,
    'SELECT id, slug FROM categories',
  );
  return new Map(rows.map((row) => [row.slug, row.id]));
}
