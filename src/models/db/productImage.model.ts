/**
 * The `product_images` table — a product's gallery, one row per image.
 *
 * A child table rather than a JSON column on `products`, because `position` is real data: image 1
 * is the hero shot, and row order in SQL guarantees nothing. The unique key on
 * (product_id, position) is what stops two images claiming the same slot.
 */

/** A row of `product_images`. */
export interface ProductImageRow {
  /** BIGINT UNSIGNED — still a JS number here; the catalogue is nowhere near 2^53 images. */
  id: number;
  product_id: number;
  url: string;
  position: number;
}

/**
 * What the seed writes.
 *
 * The caller supplies urls in gallery order and the repository derives `position` from the array
 * index, so there is no way to write a gallery whose positions disagree with its order.
 */
export type ProductImageWrite = string;
