import { Router } from 'express';

import * as productController from '../controllers/product.controller.js';
import { asyncHandler } from '../utils/errors.js';

// Routes are a table of contents: path -> controller, nothing else. asyncHandler is what routes
// a rejected promise to the error middleware — Express 4 does not await handlers, so without it
// a throw inside one hangs the request instead of returning 500.
export const productRoutes = Router();

productRoutes.get('/', asyncHandler(productController.listProducts));
productRoutes.get('/:id', asyncHandler(productController.getProduct));
