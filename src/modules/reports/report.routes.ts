import { Router } from 'express';
import type { AuthOptions } from '../auth/auth.routes.js';
import { createInterestService } from './interest.service.js';
import { emptyQuerySchema } from '../auth/auth.validation.js';
import { parseInput } from '../../shared/validation.js';

// Mounted behind the app's current-account authentication and Admin guard.
export function createReportRouter({ connection, config }: AuthOptions) {
  const router = Router();
  const interests = createInterestService(connection, config.REPORT_TIMEOUT_MS);
  router.get('/users-by-interest/all', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json(await interests.all());
  });
  router.get('/users-by-interest', async (req, res) => {
    res.json(await interests.list(req.query));
  });
  return router;
}
