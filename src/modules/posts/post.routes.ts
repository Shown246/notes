import { Router } from 'express';
import type { AuthOptions } from '../auth/auth.routes.js';
import { emptyQuerySchema } from '../auth/auth.validation.js';
import { authenticate, currentUser } from '../../middleware/auth.js';
import { getModels } from '../../config/models.js';
import { parseInput, parseObjectId } from '../../shared/validation.js';
import { createPostService } from './post.service.js';
import { createPostSchema } from './post.validation.js';

// Reads are public. Only creation needs a current account.
export function createPostRouters({ connection, config }: AuthOptions) {
  const posts = Router();
  const authors = Router();
  const service = createPostService(connection, config.QUERY_TIMEOUT_MS);
  posts.post('/', authenticate(getModels(connection), config), async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.status(201).json({ data: await service.create(currentUser(res), parseInput(createPostSchema, req.body)) });
  });
  posts.get('/', async (req, res) => { res.json(await service.list(req.query)); });
  authors.get('/:userId/posts/all', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json(await service.allByAuthor(parseObjectId(req.params.userId)));
  });
  authors.get('/:userId/posts', async (req, res) => {
    res.json(await service.byAuthor(parseObjectId(req.params.userId), req.query));
  });
  return { posts, authors };
}
