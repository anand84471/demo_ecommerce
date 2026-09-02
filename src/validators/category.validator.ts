import { enumParam, queryParser, withDefault } from './common.validator.js';
import { SOURCES, type Source } from './product.validator.js';

export interface ListCategoriesOptions {
  source: Source;
}

/** GET /categories */
export const validateListCategories: (reqQuery: unknown) => ListCategoriesOptions = queryParser({
  // MySQL by default here, unlike /products — the table is the authoritative list of categories.
  source: withDefault(enumParam('source', SOURCES), 'db'),
});
