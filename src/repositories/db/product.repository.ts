/**
 * Product persistence against MySQL — the system of record.
 *
 * Write-only by design. Elasticsearch is the read model and answers every request, so the only
 * product read here is a count, and the only caller of that is the seed deciding whether there is
 * anything to do.
 *
 * A product's child rows travel with it: images, tags and reviews are written in the same call
 * and the same transaction as the parent, because a product row whose images were rolled back is
 * not a product anyone wants indexed.
 */

import type { PoolConnection } from 'mysql2/promise';

import { query } from '../../config/database.js';
import type { ProductWrite } from '../../models/db/product.model.js';

/** How many products the table holds. */
export async function countProducts(): Promise<number> {
  const rows = await query<{ count: number | string }>('SELECT COUNT(*) AS count FROM products');
  return Number(rows[0]?.count ?? 0);
}

/** ISO-8601 -> a value MySQL DATETIME accepts. */
const toMysqlDateTime = (iso: string | Date | null | undefined): string | null => {
  if (!iso) return null;
  const date = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Upsert one product and replace its child rows.
 *
 * The id maps are passed in rather than looked up per product: they are the same two maps for the
 * whole run, and resolving a slug per row would be a query per product for an answer that has not
 * changed since the category and tag repositories returned it.
 */
export async function upsertProduct(
  conn: PoolConnection,
  product: ProductWrite,
  categoryIds: Map<string, number>,
  tagIds: Map<string, number>,
): Promise<void> {
  await conn.execute(
    `INSERT INTO products (
        id, title, description, category_id, brand, sku, price, discount_percentage, rating,
        stock, weight, dim_width, dim_height, dim_depth, warranty_information,
        shipping_information, availability_status, return_policy, minimum_order_quantity,
        thumbnail, meta_barcode, meta_qr_code, meta_created_at, meta_updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
        title = VALUES(title), description = VALUES(description), category_id = VALUES(category_id),
        brand = VALUES(brand), sku = VALUES(sku), price = VALUES(price),
        discount_percentage = VALUES(discount_percentage), rating = VALUES(rating),
        stock = VALUES(stock), weight = VALUES(weight), dim_width = VALUES(dim_width),
        dim_height = VALUES(dim_height), dim_depth = VALUES(dim_depth),
        warranty_information = VALUES(warranty_information),
        shipping_information = VALUES(shipping_information),
        availability_status = VALUES(availability_status), return_policy = VALUES(return_policy),
        minimum_order_quantity = VALUES(minimum_order_quantity), thumbnail = VALUES(thumbnail),
        meta_barcode = VALUES(meta_barcode), meta_qr_code = VALUES(meta_qr_code),
        meta_created_at = VALUES(meta_created_at), meta_updated_at = VALUES(meta_updated_at)`,
    [
      product.id,
      product.title ?? '',
      product.description ?? null,
      (product.category ? categoryIds.get(product.category) : null) ?? null,
      product.brand ?? null,
      product.sku ?? null,
      product.price ?? 0,
      product.discountPercentage ?? null,
      product.rating ?? null,
      product.stock ?? 0,
      product.weight ?? null,
      product.dimensions?.width ?? null,
      product.dimensions?.height ?? null,
      product.dimensions?.depth ?? null,
      product.warrantyInformation ?? null,
      product.shippingInformation ?? null,
      product.availabilityStatus ?? null,
      product.returnPolicy ?? null,
      product.minimumOrderQuantity ?? null,
      product.thumbnail ?? null,
      product.meta?.barcode ?? null,
      product.meta?.qrCode ?? null,
      toMysqlDateTime(product.meta?.createdAt),
      toMysqlDateTime(product.meta?.updatedAt),
    ],
  );

  // Replace-then-insert for child rows: without stable source ids there is no way to tell an
  // edited review from a new one, and appending would duplicate them on every re-seed.
  await conn.execute('DELETE FROM product_images WHERE product_id = ?', [product.id]);
  for (const [position, url] of (product.images ?? []).entries()) {
    await conn.execute(
      'INSERT INTO product_images (product_id, url, position) VALUES (?, ?, ?)',
      [product.id, url, position],
    );
  }

  await conn.execute('DELETE FROM product_tags WHERE product_id = ?', [product.id]);
  for (const slug of product.tags ?? []) {
    const tagId = tagIds.get(slug);
    if (tagId) {
      await conn.execute(
        'INSERT IGNORE INTO product_tags (product_id, tag_id) VALUES (?, ?)',
        [product.id, tagId],
      );
    }
  }

  await conn.execute('DELETE FROM product_reviews WHERE product_id = ?', [product.id]);
  for (const review of product.reviews ?? []) {
    await conn.execute(
      `INSERT INTO product_reviews
         (product_id, rating, comment, review_date, reviewer_name, reviewer_email)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        product.id,
        review.rating ?? 0,
        review.comment ?? null,
        toMysqlDateTime(review.date),
        review.reviewerName ?? null,
        review.reviewerEmail ?? null,
      ],
    );
  }
}
