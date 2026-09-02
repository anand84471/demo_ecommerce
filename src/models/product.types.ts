/**
 * The API's domain shapes, in one place.
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

export interface ProductMeta {
  barcode: string | null;
  qrCode: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface Review {
  rating: number;
  comment: string | null;
  date: Date | string | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
}

/** A product as the listing endpoints return it. */
export interface Product {
  id: number;
  title: string;
  description: string | null;
  brand: string | null;
  sku: string | null;
  price: number;
  discountPercentage: number | null;
  rating: number | null;
  stock: number;
  weight: number | null;
  dimensions: Dimensions;
  warrantyInformation: string | null;
  shippingInformation: string | null;
  availabilityStatus: string | null;
  returnPolicy: string | null;
  minimumOrderQuantity: number | null;
  thumbnail: string | null;
  category: CategoryRef | null;
  meta: ProductMeta;
}

/** One product with its relations — what `GET /products/:id` answers with. */
export interface ProductDetail extends Product {
  images: string[];
  tags: string[];
  reviews: Review[];
}

/**
 * A product as Elasticsearch stores it: denormalised, and without the relations that only the
 * detail view needs. `reviewCount` stands in for the reviews themselves.
 */
export interface SearchDocument {
  id: number;
  title: string;
  description: string | null;
  brand: string | null;
  sku: string | null;
  category: CategoryRef | null;
  tags: string[];
  price: number;
  discountPercentage: number | null;
  rating: number | null;
  stock: number;
  availabilityStatus: string | null;
  returnPolicy: string | null;
  shippingInformation: string | null;
  warrantyInformation: string | null;
  weight: number | null;
  minimumOrderQuantity: number | null;
  thumbnail: string | null;
  images: string[];
  reviewCount: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** A search hit: the stored document plus the score it matched with. */
export interface ScoredSearchDocument extends SearchDocument {
  _score: number | null;
}

/** What both stores return for a listing — the same shape, so the service can swap them. */
export interface ProductPage<T> {
  products: T[];
  total: number;
}
