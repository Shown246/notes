import { Router } from 'express';
import type { Connection } from 'mongoose';
import type { Environment } from '../../config/env.js';
import { getModels } from '../../config/models.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { createRateLimiter } from '../../middleware/rate-limit.js';
import { parseInput } from '../../shared/validation.js';
import { toUserDto } from '../../shared/dto.js';
import { createAuthService } from './auth.service.js';
import { emptyQuerySchema, loginSchema, profileUpdateSchema, registrationSchema } from './auth.validation.js';

export interface AuthOptions { connection: Connection; config: Environment }
export function createAuthRouter({ connection, config }: AuthOptions) {
  const router = Router();
  const models = getModels(connection);
  const service = createAuthService(models, config);
  const auth = authenticate(models, config);
  router.post('/register', createRateLimiter({ max: config.AUTH_REGISTER_LIMIT, windowMs: config.AUTH_RATE_WINDOW_MS }), async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.status(201).json({ data: await service.register(parseInput(registrationSchema, req.body)) });
  });
  router.post('/login', createRateLimiter({ max: config.AUTH_LOGIN_LIMIT, windowMs: config.AUTH_RATE_WINDOW_MS }), async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.login(parseInput(loginSchema, req.body)) });
  });
  router.get('/me', auth, (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: toUserDto(currentUser(res)) });
  });
  router.patch('/me', auth, async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.updateProfile(currentUser(res), parseInput(profileUpdateSchema, req.body)) });
  });
  return router;
}
