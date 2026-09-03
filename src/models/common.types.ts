/**
 * The domain shapes both stores agree on.
 *
 * A category means the same thing whether it was read out of a MySQL row or out of an
 * Elasticsearch document, so its shape is declared once here and the two store-specific model
 * folders build on it rather than restating it. Anything that is true of only one store — a
 * column layout, an index mapping — belongs in `db/` or `es/` instead.
 *
 * These are plain interfaces rather than Zod schemas on purpose. Zod earns its runtime cost at a
 * trust boundary — an HTTP query string, the environment, a third-party payload — and everything
 * here has already crossed one: it is data this service read out of its own stores. Validating it
 * again on the way out would spend time re-checking our own SQL.
 */

/** A category as it appears nested inside a product: enough to filter and to display. */
export interface CategoryRef {
  slug: string;
  name: string;
}

export interface Category extends CategoryRef {
  url: string | null;
}

export interface CategoryWithCount extends Category {
  productCount: number;
}

export interface Dimensions {
  width: number | null;
  height: number | null;
  depth: number | null;
}

export interface Review {
  rating: number;
  comment: string | null;
  date: Date | string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
}

/** One page of a listing: the rows or documents, and how many matched in total. */
export interface ProductPage<T> {
  products: T[];
  total: number;
}
