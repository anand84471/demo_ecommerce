import { queryParser } from './common.validator.js';

/**
 * GET /categories
 *
 * The endpoint takes no parameters — the catalogue's taxonomy is ~24 rows, so there is nothing
 * to page, filter or sort from outside. It is still parsed rather than ignored: an empty shape
 * makes `?soruce=es` a 400 that names the parameter, where skipping validation would answer 200
 * and quietly do something other than what the caller asked.
 */
export const validateListCategories: (reqQuery: unknown) => void = queryParser({});
