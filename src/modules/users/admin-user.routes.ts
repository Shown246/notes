import { Router } from 'express';
import type { AuthOptions } from '../auth/auth.routes.js';
import { emptyQuerySchema } from '../auth/auth.validation.js';
import { currentUser } from '../../middleware/auth.js';
import { parseInput, parseObjectId } from '../../shared/validation.js';
import { createAdminUserService } from './admin-user.service.js';
import { createUserSchema, updateUserSchema } from './admin-user.validation.js';

// Mounted behind the app's shared current-account and Admin guards.
export function createAdminUserRouter({ connection, config }: AuthOptions) {
  const router = Router();
  const service = createAdminUserService(connection, config.QUERY_TIMEOUT_MS);
  router.get('/', async (req, res) => {
    res.json(await service.list(req.query));
  });
  router.post('/', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.status(201).json({ data: await service.create(parseInput(createUserSchema, req.body)) });
  });
  router.get('/:userId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.read(parseObjectId(req.params.userId)) });
  });
  router.patch('/:userId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.update(currentUser(res)._id, parseObjectId(req.params.userId), parseInput(updateUserSchema, req.body)) });
  });
  router.delete('/:userId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    await service.delete(currentUser(res)._id, parseObjectId(req.params.userId));
    res.status(204).end();
  });
  return router;
}
