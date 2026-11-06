import express from 'express';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createRateLimiter } from '../src/middleware/rate-limit.js';
import { errorHandler } from '../src/middleware/errors.js';
import { createLogger } from '../src/middleware/logging.js';

it('expires attempt windows, bounds peer storage, and fails closed until capacity is available', async () => {
  let now = 0;
  const app = express();
  // Test-only peer identities; the production app uses the actual socket peer.
  app.use((req, _res, next) => { Object.defineProperty(req, 'ip', { value: req.headers['test-peer'] }); next(); });
  app.get('/', createRateLimiter({ max: 1, windowMs: 1000, maxKeys: 2 }, () => now), (_req, res) => { res.sendStatus(204); });
  app.use(errorHandler(createLogger('silent')));
  expect((await request(app).get('/').set('test-peer', 'a')).status).toBe(204);
  const blocked = await request(app).get('/').set('test-peer', 'a');
  expect(blocked.status).toBe(429);
  expect(blocked.headers['retry-after']).toBe('1');
  expect((await request(app).get('/').set('test-peer', 'b')).status).toBe(204);
  expect((await request(app).get('/').set('test-peer', 'c')).status).toBe(429);
  now = 1000;
  expect((await request(app).get('/').set('test-peer', 'c')).status).toBe(204);
  expect((await request(app).get('/').set('test-peer', 'a')).status).toBe(204);
});
