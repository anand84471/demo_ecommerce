/**
 * The `product_tags` join table — many products to many tags.
 *
 * The composite primary key (product_id, tag_id) is the join's natural key, so there is no
 * surrogate id here and no row shape beyond the pair itself: a duplicate pairing is not a row the
 * table can hold.
 */

/** A row of `product_tags`. */
export interface ProductTagRow {
  product_id: number;
  tag_id: number;
}

/**
 * What the seed writes: a tag slug.
 *
 * A product knows its tags by the catalogue's own vocabulary; resolving a slug to the `tags.id`
 * this table points at is the repository's job.
 */
export type ProductTagWrite = string;
