/**
 * Product business logic.
 *
 * This layer owns the one real decision in the app: **which store answers which question**. It
 * knows nothing about HTTP — it throws AppError and returns plain objects — so the same logic
 * would serve a GraphQL resolver or a CLI unchanged.
 */

import { badRequest, notFound } from '../utils/errors.js';
import * as productModel from '../models/product.model.js';
import type { DbSortField } from '../models/product.model.js';
import * as productSearchModel from '../models/productSearch.model.js';
import type {
  Product, ProductDetail, ScoredSearchDocument,
} from '../models/product.types.js';
import type { ListProductsOptions } from '../validators/product.validator.js';

export const SOURCE = { ES: 'es', DB: 'db' } as const;

/** Which store actually answered, as it appears in `meta.source`. */
export type AnsweringStore = 'mysql' | 'elasticsearch';

export interface ListProductsResult {
  products: Array<Product | ScoredSearchDocument>;
  total: number;
  source: AnsweringStore;
}

/**
 * List / search / filter products.
 *
 * Elasticsearch answers by default because listing, ranking and faceting are what it is for.
 * `source=db` runs the same listing against MySQL — not indecision, but a way to make divergence
 * between the two stores observable from outside the process, which is this architecture's real
 * failure mode.
 */
export async function listProducts({
  text, category, tag, minPrice, maxPrice, limit, skip, sort, order, source = SOURCE.ES,
}: ListProductsOptions): Promise<ListProductsResult> {
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw badRequest(`'minPrice' (${minPrice}) cannot exceed 'maxPrice' (${maxPrice})`);
  }

  if (source === SOURCE.DB) {
    // Rejected rather than quietly degraded to a LIKE: a silent fallback would return different
    // results from the same endpoint depending on a parameter the caller thinks is about
    // plumbing, and would scan the table doing it.
    if (text) {
      throw badRequest("Full-text search is served by Elasticsearch — drop 'source=db' to use 'query'.");
    }
    if (tag || minPrice != null || maxPrice != null) {
      throw badRequest("'tag', 'minPrice' and 'maxPrice' are only supported by the Elasticsearch source.");
    }
    const { products, total } = await productModel.findProducts({
      category,
      limit,
      skip,
      // `relevance` has no meaning without a scoring query; MySQL sorts by id instead.
      sort: sort === 'relevance' || sort === undefined ? 'id' : (sort satisfies DbSortField),
      order,
    });
    return { products, total, source: 'mysql' };
  }

  if (sort === 'relevance' && !text) {
    throw badRequest("'sort=relevance' needs a 'query' — there is nothing to score without one.");
  }

  const { products, total } = await productSearchModel.searchProducts({
    text, category, tag, minPrice, maxPrice, limit, skip, sort, order,
  });
  return { products, total, source: 'elasticsearch' };
}

/**
 * One product, always from MySQL.
 *
 * The record a client acts on should come from the system of record rather than a copy that may
 * be a moment behind — and the detail view wants the full relational picture (every review,
 * every image), which the search index deliberately does not carry.
 */
export async function getProduct(id: number): Promise<ProductDetail> {
  const product = await productModel.findProductById(id);
  if (!product) throw notFound(`Product ${id} not found`);
  return product;
}
