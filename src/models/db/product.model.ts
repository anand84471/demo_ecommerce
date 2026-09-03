/**
 * The `products` table, as TypeScript sees it, plus the shape that goes into it.
 *
 * Two shapes, because reading and writing this table are not symmetric. `ProductRow` mirrors the
 * DDL column for column — the vocabulary a SELECT would speak. `ProductWrite` is the caller's
 * side: camelCase, every field but the id optional, and the child tables attached, because the
 * source feed's fields are optional and a product's images, tags and reviews are written with it.
 *
 * Nothing currently reads a product out of MySQL — Elasticsearch is the read model and answers
 * every request — so `ProductRow` is here as the table's definition rather than as a type in use.
 * Its columns being written down is what makes a schema change a compile-time question.
 */

import type { Dimensions } from '../common.types.js';
import type { ProductImageWrite } from './productImage.model.js';
import type { ProductReviewWrite } from './productReview.model.js';
import type { ProductTagWrite } from './productTag.model.js';

/**
 * A row of `products` — every column, in DDL order.
 *
 * The DECIMAL columns are `number` rather than `string` because the pool sets
 * `decimalNumbers: true`; without it mysql2 would return "9.99" in quotes to protect precision.
 * The inline `dim_*` columns are the dimensions triple, which is 1:1 with a product and so beats
 * a joined table that could only ever hold one row.
 */
export interface ProductRow {
  /** The source's own id, kept as the primary key so a re-seed updates in place. */
  id: number;
  title: string;
  description: string | null;
  category_id: number | null;
  brand: string | null;
  sku: string | null;
  price: number;
  discount_percentage: number | null;
  rating: number | null;
  stock: number;
  weight: number | null;
  dim_width: number | null;
  dim_height: number | null;
  dim_depth: number | null;
  warranty_information: string | null;
  shipping_information: string | null;
  availability_status: string | null;
  return_policy: string | null;
  minimum_order_quantity: number | null;
  thumbnail: string | null;
  meta_barcode: string | null;
  meta_qr_code: string | null;
  /** DATETIME, from the feed's own metadata — not this row's lifecycle. */
  meta_created_at: Date | null;
  meta_updated_at: Date | null;
  /** TIMESTAMP, maintained by MySQL: when this row was written here. */
  created_at: Date;
  updated_at: Date;
}

/**
 * A product to upsert, with its child rows attached.
 *
 * Every field but the id is optional and nullable because the source feed's are, and the columns
 * match. The repository is where those become the row's defaults; declaring the laxity here is
 * what stops it being rediscovered at each call site.
 *
 * `category` and `tags` are slugs, not ids: the caller knows the catalogue's own vocabulary, and
 * resolving a slug to the surrogate key the foreign keys use is the repository's job.
 */
export interface ProductWrite {
  id: number;
  title?: string | null;
  description?: string | null;
  /** The category's slug — resolved to `products.category_id` on write. */
  category?: string | null;
  brand?: string | null;
  sku?: string | null;
  price?: number | null;
  discountPercentage?: number | null;
  rating?: number | null;
  stock?: number | null;
  weight?: number | null;
  /** Flattened into the `dim_*` columns on write. */
  dimensions?: Partial<Dimensions> | null;
  warrantyInformation?: string | null;
  shippingInformation?: string | null;
  availabilityStatus?: string | null;
  returnPolicy?: string | null;
  minimumOrderQuantity?: number | null;
  thumbnail?: string | null;
  /** `product_images`, in gallery order — the position column is derived from the index. */
  images?: ProductImageWrite[] | null;
  /** `product_tags`, by tag slug. */
  tags?: ProductTagWrite[] | null;
  /** `product_reviews`. */
  reviews?: ProductReviewWrite[] | null;
  /** Flattened into the `meta_*` columns on write. */
  meta?: {
    barcode?: string | null;
    qrCode?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
  } | null;
}
