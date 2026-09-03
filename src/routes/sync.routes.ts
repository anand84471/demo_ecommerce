import { Router } from 'express';

import * as syncController from '../controllers/sync.controller.js';
import { asyncHandler } from '../utils/errors.js';

export const syncRoutes = Router();

// The trigger first, then the history it writes. `/runs/:id` after `/runs` so the collection is
// not swallowed by the parameterised path.
syncRoutes.post('/', asyncHandler(syncController.triggerSync));
syncRoutes.get('/status', asyncHandler(syncController.getStatus));
syncRoutes.get('/runs', asyncHandler(syncController.listRuns));
syncRoutes.get('/runs/:id', asyncHandler(syncController.getRun));
