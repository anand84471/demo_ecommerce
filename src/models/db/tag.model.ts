/**
 * The `tags` table.
 *
 * A tag is a slug and an id and nothing else — the table exists so that `product_tags` can point
 * at a narrow key rather than repeating the string on every row.
 */

/** A row of `tags`. */
export interface TagRow {
  id: number;
  slug: string;
}

/** What the seed writes: the slug alone; the id is the table's own. */
export type TagWrite = Pick<TagRow, 'slug'>;
