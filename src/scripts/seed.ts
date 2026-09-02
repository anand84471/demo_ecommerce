#!/usr/bin/env node
/**
 * Fetch the catalogue from dummyjson.com, populate MySQL, and index it into Elasticsearch.
 *
 * One script for both stores on purpose: they must not drift. Populating MySQL and indexing
 * Elasticsearch separately is how you end up with a search index describing a catalogue that no
 * longer exists.
 *
 * The feed is the one input here nobody controls, so it is the one place a schema pays for
 * itself: `sourceProductSchema` below is the contract, and a payload that breaks it fails the
 * seed with the offending field named instead of writing NULLs into twenty columns.
 *
 * Idempotent — safe to run repeatedly. Products upsert on their source id; each product's child
 * rows (images, tags, reviews) are replaced wholesale, because the source gives them no stable
 * ids of their own to match on.
 *
 *   npm run seed          # skips if data is already present
 *   npm run seed:force    # re-fetches and rewrites regardless
 */

import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { z } from 'zod';

import { config } from '../config/env.js';
import {
  applySchema, closePool, query, waitForMysql, withTransaction,
} from '../config/database.js';
import { closeEsClient, waitForElasticsearch } from '../config/elasticsearch.js';
import { ensureProductsIndex, toSearchDocument } from '../models/product.index.js';
import { bulkIndexProducts, countIndexedProducts } from '../models/productSearch.model.js';
import type { Category } from '../models/product.types.js';
import { errorMessage } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('seed');

/**
 * The feed's shape, as much of it as this app uses.
 *
 * Deliberately permissive about *values* and strict about *structure*: every field but the id is
 * allowed to be missing or null (the columns are nullable too), while an object that is not a
 * product at all fails loudly. Unknown fields are dropped rather than rejected, so the seed
 * survives the source adding one.
 */
const sourceReviewSchema = z.object({
  rating: z.coerce.number().nullish(),
  comment: z.string().nullish(),
  date: z.string().nullish(),
  reviewerName: z.string().nullish(),
  reviewerEmail: z.string().nullish(),
});

const sourceProductSchema = z.object({
  id: z.coerce.number().int(),
  title: z.string().nullish(),
  description: z.string().nullish(),
  category: z.string().nullish(),
  brand: z.string().nullish(),
  sku: z.string().nullish(),
  price: z.coerce.number().nullish(),
  discountPercentage: z.coerce.number().nullish(),
  rating: z.coerce.number().nullish(),
  stock: z.coerce.number().int().nullish(),
  weight: z.coerce.number().nullish(),
  dimensions: z.object({
    width: z.coerce.number().nullish(),
    height: z.coerce.number().nullish(),
    depth: z.coerce.number().nullish(),
  }).nullish(),
  warrantyInformation: z.string().nullish(),
  shippingInformation: z.string().nullish(),
  availabilityStatus: z.string().nullish(),
  returnPolicy: z.string().nullish(),
  minimumOrderQuantity: z.coerce.number().int().nullish(),
  thumbnail: z.string().nullish(),
  images: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish(),
  reviews: z.array(sourceReviewSchema).nullish(),
  meta: z.object({
    barcode: z.string().nullish(),
    qrCode: z.string().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
  }).nullish(),
});

const productsPayloadSchema = z.object({ products: z.array(sourceProductSchema) });

/** The categories endpoint returns objects; older versions of the feed returned bare slugs. */
const sourceCategorySchema = z.union([
  z.string().transform((slug) => ({ slug, name: undefined, url: undefined })),
  z.object({
    slug: z.string(),
    name: z.string().nullish(),
    url: z.string().nullish(),
  }),
]);

const categoriesPayloadSchema = z.array(sourceCategorySchema);

type SourceProduct = z.infer<typeof sourceProductSchema>;
type SourceCategory = z.infer<typeof sourceCategorySchema>;

/** Zod's own report, indented to sit under the log line that introduces it. */
const describeSchemaError = (err: unknown): string => (
  err instanceof z.ZodError ? `\n${z.prettifyError(err)}` : errorMessage(err)
);

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

/**
 * dummyjson returns the whole catalogue when limit=0 — ~200 items, so one request is everything
 * and paging would be ceremony. Retried because a cold `docker compose up` can race DNS.
 */
async function fetchProducts({ attempts = 5, delayMs = 2000 } = {}): Promise<SourceProduct[]> {
  const url = `${config.seed.sourceUrl}/products?limit=0`;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const { products } = productsPayloadSchema.parse(await fetchJson(url));
      return products;
    } catch (err) {
      log.warn(`fetch attempt ${i}/${attempts} failed: ${describeSchemaError(err)}`);
      if (i === attempts) throw err;
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
  return [];
}

async function fetchCategories(): Promise<SourceCategory[] | null> {
  const url = `${config.seed.sourceUrl}/products/categories`;
  try {
    return categoriesPayloadSchema.parse(await fetchJson(url));
  } catch (err) {
    // Not fatal: every product carries its category slug, so categories can be derived. The
    // dedicated endpoint is only nicer because it supplies display names and urls.
    log.warn(`category endpoint unusable (${describeSchemaError(err)}); deriving from products instead`);
    return null;
  }
}

const titleCase = (slug: string): string => slug
  .split('-')
  .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
  .join(' ');

/** ISO-8601 -> a value MySQL DATETIME accepts. */
const toMysqlDateTime = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * The canonical slug -> {slug, name, url} map, built once and used for BOTH stores, so the
 * category name in Elasticsearch is the same string as the one in MySQL. Deriving it separately
 * on each side is how a filter starts matching in one store and not the other.
 */
function buildCategoryMap(
  products: SourceProduct[],
  sourceCategories: SourceCategory[] | null,
): Map<string, Category> {
  const bySlug = new Map<string, Category>();
  for (const category of sourceCategories ?? []) {
    bySlug.set(category.slug, {
      slug: category.slug,
      name: category.name ?? titleCase(category.slug),
      url: category.url ?? null,
    });
  }
  // A category a product references but the endpoint didn't list still needs a row, or the
  // product's foreign key drops to NULL and it vanishes from category filters.
  for (const product of products) {
    if (product.category && !bySlug.has(product.category)) {
      bySlug.set(product.category, {
        slug: product.category,
        name: titleCase(product.category),
        url: null,
      });
    }
  }
  return bySlug;
}

/** `conn.execute` can only promise rows; each caller states the shape its SELECT asked for. */
async function selectRows<Row>(conn: PoolConnection, sql: string): Promise<Row[]> {
  const [rows] = await conn.execute<RowDataPacket[]>(sql);
  return rows as Row[];
}

async function upsertCategories(
  conn: PoolConnection,
  bySlug: Map<string, Category>,
): Promise<Map<string, number>> {
  for (const category of bySlug.values()) {
    await conn.execute(
      `INSERT INTO categories (slug, name, url) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), url = VALUES(url)`,
      [category.slug, category.name, category.url],
    );
  }
  const rows = await selectRows<{ id: number; slug: string }>(conn, 'SELECT id, slug FROM categories');
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function upsertTags(
  conn: PoolConnection,
  products: SourceProduct[],
): Promise<Map<string, number>> {
  const slugs = [...new Set(products.flatMap((product) => product.tags ?? []).filter(Boolean))];
  for (const slug of slugs) {
    await conn.execute('INSERT IGNORE INTO tags (slug) VALUES (?)', [slug]);
  }
  const rows = await selectRows<{ id: number; slug: string }>(conn, 'SELECT id, slug FROM tags');
  return new Map(rows.map((row) => [row.slug, row.id]));
}

async function upsertProduct(
  conn: PoolConnection,
  product: SourceProduct,
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

async function currentState(): Promise<{ productCount: number; indexedCount: number }> {
  const rows = await query<{ count: number | string }>('SELECT COUNT(*) AS count FROM products');
  return {
    productCount: Number(rows[0]?.count ?? 0),
    indexedCount: await countIndexedProducts(),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();

  log.info('waiting for MySQL and Elasticsearch…');
  await Promise.all([waitForMysql(), waitForElasticsearch()]);

  await applySchema();

  if (!config.seed.force) {
    const { productCount, indexedCount } = await currentState();
    // Both stores must be populated to count as seeded — otherwise a half-seeded stack (MySQL
    // full, index empty) would skip and serve an empty catalogue.
    if (productCount > 0 && indexedCount > 0) {
      log.info(`already seeded (${productCount} in MySQL, ${indexedCount} in Elasticsearch) — skipping`);
      log.info('re-run with SEED_FORCE=true to refresh');
      return;
    }
    log.info(`incomplete state (mysql=${productCount}, es=${indexedCount}) — seeding`);
  }

  log.info(`fetching from ${config.seed.sourceUrl}`);
  const [products, sourceCategories] = await Promise.all([fetchProducts(), fetchCategories()]);
  log.info(`fetched ${products.length} products`);

  const categoryBySlug = buildCategoryMap(products, sourceCategories);

  // All MySQL writes in one transaction: a half-applied seed would leave products referencing
  // categories that were rolled back.
  await withTransaction(async (conn) => {
    const categoryIds = await upsertCategories(conn, categoryBySlug);
    const tagIds = await upsertTags(conn, products);
    log.info(`upserted ${categoryIds.size} categories, ${tagIds.size} tags`);

    for (const product of products) {
      await upsertProduct(conn, product, categoryIds, tagIds);
    }
    log.info(`upserted ${products.length} products (+ images, tags, reviews)`);
  });

  // The index is rebuilt rather than updated in place: mappings are effectively immutable, so a
  // change to product.index.ts only takes effect on a fresh index. Cheap at this size, and it
  // guarantees the running index matches the definition in the code.
  log.info('rebuilding Elasticsearch index');
  await ensureProductsIndex({ recreate: true });

  let indexed = 0;
  for (let i = 0; i < products.length; i += config.seed.batchSize) {
    const batch = products.slice(i, i + config.seed.batchSize).map((product) => toSearchDocument({
      ...product,
      // The same map MySQL was populated from — see buildCategoryMap.
      category: (product.category ? categoryBySlug.get(product.category) : null) ?? null,
    }));
    indexed += await bulkIndexProducts(batch);
  }
  log.info(`indexed ${indexed} documents into '${config.elasticsearch.productsIndex}'`);
  log.info(`done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main()
  .catch((err: unknown) => {
    log.error(`FAILED: ${describeSchemaError(err)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closePool(), closeEsClient()]);
  });
