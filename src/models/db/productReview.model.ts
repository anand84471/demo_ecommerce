/**
 * The `product_reviews` table.
 *
 * Reviews are stored relationally here and folded into the search document at index time — the
 * same data in two shapes, for two different questions. `SearchReview` in models/es/ is the other
 * one.
 */

/** A row of `product_reviews`. */
export interface ProductReviewRow {
  /** BIGINT UNSIGNED, as in `product_images`. */
  id: number;
  product_id: number;
  /** TINYINT — the source's 1-5 star rating. */
  rating: number;
  comment: string | null;
  /** DATETIME; mysql2 hands it back as a Date. */
  review_date: Date | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
}

/**
 * What the seed writes.
 *
 * No id and no product_id: the source gives reviews no identity of their own, which is why a
 * re-seed replaces a product's reviews wholesale rather than matching them up, and the parent id
 * comes from the product being written. `date` accepts both because the two sources disagree —
 * MySQL hands back a Date, the feed hands back a string.
 */
export interface ProductReviewWrite {
  rating?: number | null;
  comment?: string | null;
  date?: string | Date | null;
  reviewerName?: string | null;
  reviewerEmail?: string | null;
}
