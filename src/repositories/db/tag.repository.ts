/**
 * Tag persistence against MySQL.
 *
 * Write-only, like the product repository: tags reach a reader folded into a search document, not
 * out of this table. The table exists so `product_tags` can join on a narrow key.
 */

import type { PoolConnection } from 'mysql2/promise';

import { queryOn } from '../../config/database.js';
import type { TagRow } from '../../models/db/tag.model.js';

/**
 * Insert any tag slug not already present and hand back the slug -> id map.
 *
 * INSERT IGNORE rather than a SELECT-then-INSERT: the unique key on `slug` already decides the
 * question, and letting MySQL answer it costs one round trip instead of two.
 */
export async function upsertTags(
  conn: PoolConnection,
  slugs: Iterable<string>,
): Promise<Map<string, number>> {
  for (const slug of new Set(slugs)) {
    if (!slug) continue;
    await conn.execute('INSERT IGNORE INTO tags (slug) VALUES (?)', [slug]);
  }
  const rows = await queryOn<TagRow>(conn, 'SELECT id, slug FROM tags');
  return new Map(rows.map((row) => [row.slug, row.id]));
}
