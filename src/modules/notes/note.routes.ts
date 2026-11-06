import { Router } from 'express';
import type { AuthOptions } from '../auth/auth.routes.js';
import { emptyQuerySchema } from '../auth/auth.validation.js';
import { currentUser } from '../../middleware/auth.js';
import { parseInput, parseObjectId } from '../../shared/validation.js';
import { createNoteService } from './note.service.js';
import { createNoteSchema, updateNoteSchema } from './note.validation.js';

// Authentication is mounted by the app; the admin router also requires its
// current-role guard. Only GET handlers exist on the admin surface.
export function createNoteRouters({ connection, config }: AuthOptions) {
  const own = Router();
  const admin = Router();
  const service = createNoteService(connection, config.QUERY_TIMEOUT_MS);
  own.get('/', async (req, res) => {
    res.json(await service.listOwn(currentUser(res)._id, req.query));
  });
  own.post('/', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.status(201).json({ data: await service.create(currentUser(res), parseInput(createNoteSchema, req.body)) });
  });
  own.get('/:noteId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.readOwn(currentUser(res)._id, parseObjectId(req.params.noteId)) });
  });
  own.patch('/:noteId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.update(currentUser(res)._id, parseObjectId(req.params.noteId), parseInput(updateNoteSchema, req.body)) });
  });
  own.delete('/:noteId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    await service.delete(currentUser(res)._id, parseObjectId(req.params.noteId));
    res.status(204).end();
  });
  admin.get('/', async (req, res) => {
    res.json(await service.listAll(req.query));
  });
  admin.get('/:noteId', async (req, res) => {
    parseInput(emptyQuerySchema, req.query);
    res.json({ data: await service.readAny(parseObjectId(req.params.noteId)) });
  });
  return { own, admin };
}
