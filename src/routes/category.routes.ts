import { Router } from 'express';

import * as categoryController from '../controllers/category.controller.js';
import { asyncHandler } from '../utils/errors.js';

export const categoryRoutes = Router();

categoryRoutes.get('/', asyncHandler(categoryController.listCategories));
