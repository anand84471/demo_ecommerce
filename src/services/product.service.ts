/**
 * Product business logic.
 *
 * There is no store to choose any more, and that is the design rather than a simplification of
 * it: **Elasticsearch answers every read; MySQL exists to be written to.** The index is not a
 * cache in front of the tables, it is the read model — a request never touches MySQL, so a slow
 * join or a lock on the write side cannot show up as a slow catalogue.
 *
 * This layer knows nothing about HTTP — it throws AppError and returns plain objects — so the
 * same logic would serve a GraphQL resolver or a CLI unchanged, and nothing about a store either:
 * it asks a repository, which is the only layer that knows Elasticsearch exists.
 */

import { badRequest, notFound } from '../utils/errors.js';
import * as productRepository from '../repositories/es/product.repository.js';
import type { ScoredSearchDocument, SearchDocument } from '../models/es/product.document.js';
import type { ListProductsOptions } from '../validators/product.validator.js';

export interface ListProductsResult {
  products: ScoredSearchDocument[];
  total: number;
}

/** List / search / filter products. */
export async function listProducts({
  text, category, tag, minPrice, maxPrice, limit, skip, sort, order,
}: ListProductsOptions): Promise<ListProductsResult> {
  // Checked here rather than in the validator because it is a rule about two parameters
  // together, and ES would otherwise answer an inverted range with a cheerful empty list.
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw badRequest(`'minPrice' (${minPrice}) cannot exceed 'maxPrice' (${maxPrice})`);
  }
  if (sort === 'relevance' && !text) {
    throw badRequest("'sort=relevance' needs a 'query' — there is nothing to score without one.");
  }

  return productRepository.searchProducts({
    text, category, tag, minPrice, maxPrice, limit, skip, sort, order,
  });
}

/**
 * One product.
 *
 * The same document the listing returns, which is what makes this endpoint a lookup rather than
 * a second data path: images, tags, reviews, dimensions and meta were folded in at index time, so
 * there is nothing left for a detail view to go and join. The cost of that is staleness — a
 * product edited in MySQL is wrong here until the next index — and it is the trade this
 * architecture makes on purpose.
 */
export async function getProduct(id: number): Promise<SearchDocument> {
  const product = await productRepository.findProductById(id);
  if (!product) throw notFound(`Product ${id} not found`);
  return product;
}
