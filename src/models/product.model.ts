/**
 * Product data access against MySQL — the system of record.
 *
 * This layer knows SQL and nothing else: no HTTP, no decisions about which store to use. It
 * returns the API's product shape so callers never see snake_case column names leak upward — the
 * `Row` interfaces below are the only place those names appear.
 */

import { query, type SqlParam } from '../config/database.js';
import type {
  CategoryWithCount, Product, ProductDetail, ProductPage, Review,
} from './product.types.js';

const PRODUCT_COLUMNS = `
  p.id, p.title, p.description, p.brand, p.sku, p.price, p.discount_percentage, p.rating,
  p.stock, p.weight, p.dim_width, p.dim_height, p.dim_depth, p.warranty_information,
  p.shipping_information, p.availability_status, p.return_policy, p.minimum_order_quantity,
  p.thumbnail, p.meta_barcode, p.meta_qr_code, p.meta_created_at, p.meta_updated_at,
  c.slug AS category_slug, c.name AS category_name
`;

/** The columns PRODUCT_COLUMNS selects, exactly as MySQL names them. */
interface ProductRow {
  id: number;
  title: string;
  description: string | null;
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
  meta_created_at: Date | null;
  meta_updated_at: Date | null;
  category_slug: string | null;
  category_name: string | null;
}

interface CategoryRow {
  id: number;
  slug: string;
  name: string;
  url: string | null;
  product_count: number | string;
}

interface CountRow {
  total: number | string;
}

interface ImageRow {
  url: string;
}

interface TagRow {
  slug: string;
}

interface ReviewRow {
  rating: number;
  comment: string | null;
  review_date: Date | null;
  reviewer_name: string | null;
  reviewer_email: string | null;
}

/** DB row -> the API's product shape (camelCase, nested objects). */
function mapProduct(row: ProductRow): Product {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    brand: row.brand,
    sku: row.sku,
    price: row.price,
    discountPercentage: row.discount_percentage,
    rating: row.rating,
    stock: row.stock,
    weight: row.weight,
    dimensions: { width: row.dim_width, height: row.dim_height, depth: row.dim_depth },
    warrantyInformation: row.warranty_information,
    shippingInformation: row.shipping_information,
    availabilityStatus: row.availability_status,
    returnPolicy: row.return_policy,
    minimumOrderQuantity: row.minimum_order_quantity,
    thumbnail: row.thumbnail,
    category: row.category_slug
      ? { slug: row.category_slug, name: row.category_name ?? row.category_slug }
      : null,
    meta: {
      barcode: row.meta_barcode,
      qrCode: row.meta_qr_code,
      createdAt: row.meta_created_at,
      updatedAt: row.meta_updated_at,
    },
  };
}

function mapReview(row: ReviewRow): Review {
  return {
    rating: row.rating,
    comment: row.comment,
    date: row.review_date,
    reviewerName: row.reviewer_name,
    reviewerEmail: row.reviewer_email,
  };
}

/** All categories with how many products each holds. */
export async function findCategories(): Promise<CategoryWithCount[]> {
  // The count is what makes this useful rather than 24 bare strings — it is the number a nav
  // needs, and computing it here avoids a request per category.
  const rows = await query<CategoryRow>(`
    SELECT c.id, c.slug, c.name, c.url, COUNT(p.id) AS product_count
    FROM categories c
    LEFT JOIN products p ON p.category_id = c.id
    GROUP BY c.id, c.slug, c.name, c.url
    ORDER BY c.name ASC
  `);
  return rows.map((row) => ({
    slug: row.slug,
    name: row.name,
    url: row.url,
    productCount: Number(row.product_count),
  }));
}

/** One product with images, tags and reviews. Null when absent. */
export async function findProductById(id: number): Promise<ProductDetail | null> {
  const rows = await query<ProductRow>(
    `SELECT ${PRODUCT_COLUMNS}
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;

  // Three indexed lookups rather than one join: joining images, tags and reviews together
  // multiplies rows (4 images x 3 tags x 3 reviews = 36 for one product) and would need
  // de-duplicating in JS. At one product per call this is both cheaper and clearer.
  const [images, tags, reviews] = await Promise.all([
    query<ImageRow>('SELECT url FROM product_images WHERE product_id = ? ORDER BY position ASC', [id]),
    query<TagRow>(
      `SELECT t.slug FROM tags t
       JOIN product_tags pt ON pt.tag_id = t.id
       WHERE pt.product_id = ? ORDER BY t.slug ASC`,
      [id],
    ),
    query<ReviewRow>(
      `SELECT rating, comment, review_date, reviewer_name, reviewer_email
       FROM product_reviews WHERE product_id = ? ORDER BY review_date DESC, id ASC`,
      [id],
    ),
  ]);

  return {
    ...mapProduct(row),
    images: images.map((image) => image.url),
    tags: tags.map((tag) => tag.slug),
    reviews: reviews.map(mapReview),
  };
}

// Whitelist for ORDER BY. A placeholder is not allowed there, so the value is interpolated —
// and this map is what makes that safe rather than an injection.
const SORTABLE = {
  id: 'p.id',
  title: 'p.title',
  price: 'p.price',
  rating: 'p.rating',
  stock: 'p.stock',
} as const;

/** The sorts MySQL can serve. `relevance` is Elasticsearch-only — the service maps it away. */
export type DbSortField = keyof typeof SORTABLE;

export interface FindProductsOptions {
  category?: string | undefined;
  limit: number;
  skip: number;
  sort?: DbSortField | undefined;
  order?: string | undefined;
}

/**
 * Paginated listing with optional category filter.
 *
 * No free-text search here on purpose: that is Elasticsearch's job, and `LIKE '%term%'` in MySQL
 * is a table scan that cannot rank results.
 */
export async function findProducts({
  category, limit, skip, sort = 'id', order = 'asc',
}: FindProductsOptions): Promise<ProductPage<Product>> {
  const where: string[] = [];
  const params: SqlParam[] = [];
  if (category) {
    where.push('c.slug = ?');
    params.push(category.toLowerCase());
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortColumn = SORTABLE[sort] ?? SORTABLE.id;
  const sortOrder = order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const [rows, countRows] = await Promise.all([
    query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS}
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}
       ORDER BY ${sortColumn} ${sortOrder}, p.id ASC
       LIMIT ? OFFSET ?`,
      // LIMIT/OFFSET as strings: mysql2's prepared-statement protocol rejects numbers here.
      [...params, String(limit), String(skip)],
    ),
    query<CountRow>(
      `SELECT COUNT(*) AS total
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       ${whereSql}`,
      params,
    ),
  ]);

  return { products: rows.map(mapProduct), total: Number(countRows[0]?.total ?? 0) };
}

export async function countProducts(): Promise<number> {
  const rows = await query<CountRow>('SELECT COUNT(*) AS total FROM products');
  return Number(rows[0]?.total ?? 0);
}
