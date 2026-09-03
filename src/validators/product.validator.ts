/**
 * Product request validation.
 *
 * Validators turn an untrusted request into a typed, bounded options object. Controllers stay
 * thin because of it, and services can assume their inputs are already sane — and now say so in
 * their signatures.
 */

import {
  checkPagingWindow, enumParam, intParam, numberParam, pagingShape, parsePathParam, queryParser,
  stringParam,
} from './common.validator.js';

export const SORT_FIELDS = ['relevance', 'id', 'title', 'price', 'rating', 'stock'] as const;
export const SORT_ORDERS = ['asc', 'desc'] as const;

export type SortField = typeof SORT_FIELDS[number];
export type SortOrder = typeof SORT_ORDERS[number];

/** The typed result of validating `GET /products` — the service layer's input contract. */
export interface ListProductsOptions {
  text: string | undefined;
  category: string | undefined;
  tag: string | undefined;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  sort: SortField | undefined;
  order: SortOrder | undefined;
  limit: number;
  skip: number;
}

const parseListQuery = queryParser({
  query: stringParam('query'),
  // `q` is accepted as an alias because it is the parameter people try first.
  q: stringParam('q'),
  category: stringParam('category'),
  tag: stringParam('tag'),
  minPrice: numberParam('minPrice', { min: 0 }),
  maxPrice: numberParam('maxPrice', { min: 0 }),
  sort: enumParam('sort', SORT_FIELDS),
  order: enumParam('order', SORT_ORDERS),
  ...pagingShape,
}, checkPagingWindow);

/** GET /products */
export function validateListProducts(reqQuery: unknown): ListProductsOptions {
  const { query, q, ...rest } = parseListQuery(reqQuery);
  return { text: query ?? q, ...rest };
}

const productId = intParam('id', { min: 1 });

/** GET /products/:id */
export function validateProductId(rawId: unknown): number {
  return parsePathParam(productId, 'id', rawId);
}
