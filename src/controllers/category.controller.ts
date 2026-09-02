import type { Request, Response } from 'express';

import * as categoryService from '../services/category.service.js';
import { collection } from '../utils/response.js';
import { validateListCategories } from '../validators/category.validator.js';

/** GET /categories */
export async function listCategories(req: Request, res: Response): Promise<Response> {
  const options = validateListCategories(req.query);
  const { categories, source } = await categoryService.listCategories(options);

  return collection(res, categories, { total: categories.length, source });
}
