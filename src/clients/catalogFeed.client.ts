/**
 * The upstream catalogue feed (dummyjson.com) — the one input to this service that nobody here
 * controls.
 *
 * Its own layer rather than part of the sync, because it is the same kind of thing a repository
 * is: a store the app reads from, with the wire format contained. The difference is that this
 * one is a stranger, which is why it is also the one place a runtime schema pays for itself —
 * `sourceProductSchema` is the contract, and a payload that breaks it fails with the offending
 * field named instead of writing NULLs into twenty columns.
 */

import { z } from 'zod';

import { config } from '../config/env.js';
import { errorMessage } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('feed');

/**
 * The feed's shape, as much of it as this app uses.
 *
 * Deliberately permissive about *values* and strict about *structure*: every field but the id is
 * allowed to be missing or null (the columns are nullable too), while an object that is not a
 * product at all fails loudly. Unknown fields are dropped rather than rejected, so the sync
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

export type SourceProduct = z.infer<typeof sourceProductSchema>;
export type SourceCategory = z.infer<typeof sourceCategorySchema>;

/** Zod's own report, indented to sit under the log line that introduces it. */
export const describeSchemaError = (err: unknown): string => (
  err instanceof z.ZodError ? `\n${z.prettifyError(err)}` : errorMessage(err)
);

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

export interface RetryOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * Retry a fetch. A cold `docker compose up` can race DNS, and the public feed rate-limits a
 * burst of container restarts with a 429 — neither is a reason to give up on the first try.
 */
async function withRetries<T>(
  label: string,
  { attempts = 5, delayMs = 2000 }: RetryOptions,
  fetchOnce: () => Promise<T>,
): Promise<T> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fetchOnce();
    } catch (err) {
      log.warn(`${label} attempt ${i}/${attempts} failed: ${describeSchemaError(err)}`);
      if (i === attempts) throw err;
      await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    }
  }
  // Unreachable: the loop either returns or rethrows on the last attempt.
  throw new Error(`${label}: exhausted ${attempts} attempts`);
}

/**
 * dummyjson returns the whole catalogue when limit=0 — ~200 items, so one request is everything
 * and paging would be ceremony.
 */
export async function fetchProducts(retry: RetryOptions = {}): Promise<SourceProduct[]> {
  const url = `${config.sync.sourceUrl}/products?limit=0`;
  return withRetries('product fetch', retry, async () => {
    const { products } = productsPayloadSchema.parse(await fetchJson(url));
    return products;
  });
}

/**
 * The categories endpoint, or null if it cannot be reached.
 *
 * Retried like the products fetch, and that is not symmetry for its own sake. Falling back to
 * deriving categories from the products means losing `url` and the feed's display names, and
 * `upsertCategories` would then write those nulls over rows that already had good values — a
 * single transient 429 permanently degrading stored data. Retrying first makes the lossy path
 * the last resort it was always meant to be.
 */
export async function fetchCategories(retry: RetryOptions = {}): Promise<SourceCategory[] | null> {
  const url = `${config.sync.sourceUrl}/products/categories`;
  try {
    return await withRetries('category fetch', retry, async () => (
      categoriesPayloadSchema.parse(await fetchJson(url))
    ));
  } catch (err) {
    // Not fatal: every product carries its category slug, so categories can be derived. The
    // dedicated endpoint is only nicer because it supplies display names and urls.
    log.warn(`category endpoint unusable (${describeSchemaError(err)}); deriving from products instead`);
    return null;
  }
}
