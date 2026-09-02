/**
 * Product controllers — the HTTP boundary.
 *
 * Validate, delegate, respond. Any logic that appears here has escaped from the service layer:
 * a controller should read as a description of the endpoint, not of the feature.
 */

import type { Request, Response } from 'express';

import * as productService from '../services/product.service.js';
import { collection, item } from '../utils/response.js';
import { validateListProducts, validateProductId } from '../validators/product.validator.js';

/**
 * GET /products
 *
 * One collection endpoint covering the three cases, because they are three shapes of the same
 * question — forcing a client to pick a different path before it knows what it wants would be
 * the wrong seam:
 *   /products                   list
 *   /products?query=mascara     full-text search (Elasticsearch)
 *   /products?category=beauty   filter, combinable with query
 */
export async function listProducts(req: Request, res: Response): Promise<Response> {
  const options = validateListProducts(req.query);
  const { products, total, source } = await productService.listProducts(options);

  return collection(res, products, {
    total,
    limit: options.limit,
    skip: options.skip,
    source,
    ...(options.text ? { query: options.text } : {}),
    ...(options.category ? { category: options.category } : {}),
  });
}

/** GET /products/:id */
export async function getProduct(req: Request, res: Response): Promise<Response> {
  const id = validateProductId(req.params.id);
  const product = await productService.getProduct(id);
  return item(res, product);
}
