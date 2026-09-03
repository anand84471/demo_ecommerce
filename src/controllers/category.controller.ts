import type { Request, Response } from 'express';

import * as categoryService from '../services/category.service.js';
import { collection } from '../utils/response.js';
import { validateListCategories } from '../validators/category.validator.js';

/** GET /categories */
export async function listCategories(req: Request, res: Response): Promise<Response> {
  validateListCategories(req.query);
  const categories = await categoryService.listCategories();

  return collection(res, categories, { total: categories.length });
}
