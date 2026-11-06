import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { createApp } from '../../src/app.js';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes } from '../../src/config/indexes.js';
import { createLogger } from '../../src/middleware/logging.js';
import { issueToken } from '../../src/modules/auth/token.js';
import { createNoteService } from '../../src/modules/notes/note.service.js';
import { withParentContentWrite } from '../../src/shared/content-transaction.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
let app: ReturnType<typeof createApp>;
type Actor = { id: Types.ObjectId; token: string };
let a: Actor;
let b: Actor;
let admin: Actor;
async function actor(name: string, role: 'user' | 'admin' = 'user'): Promise<Actor> {
  const user = await models.User.create({ name, email: `${name}@example.test`, passwordHash: 'unused-test-hash', role });
  return { id: user._id, token: await issueToken(user.id, 0, testEnvironment()) };
}
async function create(owner: Actor = a, fields = { title: ' A note ', content: '  content\n' }) {
  const response = await request(app).post('/api/notes').auth(owner.token, { type: 'bearer' }).send(fields);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; ownerId: string; title: string; content: string; createdAt: string; updatedAt: string };
}
function safeNote(note: object, detail: boolean) {
  expect(Object.keys(note).sort()).toEqual([
    'id', 'ownerId', 'title', 'createdAt', 'updatedAt', ...(detail ? ['content'] : [])
  ].sort());
}

beforeAll(async () => {
  connection = await testConnection();
  models = getModels(connection);
  await ensureIndexes(connection);
  app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true,
    auth: { connection, config: testEnvironment() } });
});
beforeEach(async () => {
  await models.Note.deleteMany({});
  await models.User.deleteMany({});
  a = await actor('a'); b = await actor('b'); admin = await actor('admin', 'admin');
});
afterAll(async () => { await connection?.close(); });

describe('note CRUD and read boundaries', () => {
  it('supports complete own-note CRUD for both roles, safe DTOs, and partial updates', async () => {
    for (const owner of [a, admin]) {
      const note = await create(owner);
      expect(note).toMatchObject({ ownerId: owner.id.toHexString(), title: 'A note', content: '  content\n' });
      safeNote(note, true);
      expect(new Date(note.createdAt).toISOString()).toBe(note.createdAt);
      const read = await request(app).get(`/api/notes/${note.id}`).auth(owner.token, { type: 'bearer' });
      expect(read.status).toBe(200);
      expect(read.body.data).toEqual(note);
      const updated = await request(app).patch(`/api/notes/${note.id}`).auth(owner.token, { type: 'bearer' }).send({ title: ' Updated ' });
      expect(updated.status).toBe(200);
      expect(updated.body.data).toMatchObject({ id: note.id, title: 'Updated', content: note.content, createdAt: note.createdAt });
      safeNote(updated.body.data, true);
      const cleared = await request(app).patch(`/api/notes/${note.id}`).auth(owner.token, { type: 'bearer' }).send({ content: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.body.data.content).toBe('');
      const deleted = await request(app).delete(`/api/notes/${note.id}`).auth(owner.token, { type: 'bearer' });
      expect(deleted.status).toBe(204);
      expect(deleted.text).toBe('');
      expect((await request(app).get(`/api/notes/${note.id}`).auth(owner.token, { type: 'bearer' })).status).toBe(404);
    }
    expect(await models.Note.countDocuments()).toBe(0);
  });

  it('hides inaccessible and missing targets identically, including admin ordinary mutations', async () => {
    const note = await create();
    for (const other of [b, admin]) {
      for (const id of [note.id, new Types.ObjectId().toHexString()]) {
        for (const method of ['get', 'patch', 'delete'] as const) {
          const response = await request(app)[method](`/api/notes/${id}`).auth(other.token, { type: 'bearer' })
            .send(method === 'patch' ? { title: 'stolen' } : undefined);
          expect(response.status).toBe(404);
          expect(response.body.error).toMatchObject({ code: 'NOTE_NOT_FOUND', message: 'Note not found' });
        }
      }
    }
    expect((await models.Note.findById(note.id))!.title).toBe('A note');
    expect((await request(app).get('/api/notes').auth(b.token, { type: 'bearer' })).body.data).toEqual([]);
  });

  it('paginates isolated own lists and admin all-note summaries without duplicates or omissions', async () => {
    const empty = await request(app).get('/api/notes').auth(a.token, { type: 'bearer' });
    expect(empty.body).toEqual({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
    const all: string[] = []; const own: string[] = [];
    for (let i = 0; i < 7; i++) {
      const note = await create(i % 2 === 0 ? a : b);
      all.push(note.id); if (i % 2 === 0) own.push(note.id);
    }
    for (const [path, owner, expected] of [
      ['/api/notes', a, own], ['/api/admin/notes', admin, all]
    ] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const response: Response = await request(app).get(path).query({ limit: 2, ...(cursor ? { cursor } : {}) }).auth(owner.token, { type: 'bearer' });
        expect(response.status).toBe(200);
        for (const row of response.body.data) { safeNote(row, false); seen.push(row.id); }
        expect(response.body.pagination.limit).toBe(2);
        expect(response.body.pagination.hasMore).toBe(response.body.pagination.nextCursor !== null);
        cursor = response.body.pagination.nextCursor;
      } while (cursor);
      expect(seen).toEqual([...expected].sort().reverse());
      expect(new Set(seen).size).toBe(expected.length);
    }
    const first = await request(app).get('/api/notes?limit=1').auth(a.token, { type: 'bearer' });
    for (const [path, owner] of [['/api/notes', b], ['/api/admin/notes', admin]] as const) {
      const response = await request(app).get(path).query({ cursor: first.body.pagination.nextCursor }).auth(owner.token, { type: 'bearer' });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_CURSOR');
    }
    const adminPage = await request(app).get('/api/admin/notes?limit=1').auth(admin.token, { type: 'bearer' });
    expect((await request(app).get('/api/notes').query({ cursor: adminPage.body.pagination.nextCursor }).auth(admin.token, { type: 'bearer' })).status).toBe(400);
  });

  it('allows only current admins to read all-note routes and exposes no admin write handlers', async () => {
    const note = await create();
    for (const path of ['/api/admin/notes', `/api/admin/notes/${note.id}`]) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).auth(b.token, { type: 'bearer' })).status).toBe(403);
      const response = await request(app).get(path).auth(admin.token, { type: 'bearer' });
      expect(response.status).toBe(200);
      if (path.endsWith(note.id)) { expect(response.body.data).toEqual(note); safeNote(response.body.data, true); }
    }
    for (const method of ['post', 'patch', 'delete'] as const) {
      const path = method === 'post' ? '/api/admin/notes' : `/api/admin/notes/${note.id}`;
      expect((await request(app)[method](path).auth(admin.token, { type: 'bearer' }).send({ title: 'changed' })).status).toBe(404);
    }
    await models.User.updateOne({ _id: admin.id }, { $set: { role: 'user' } });
    expect((await request(app).get(`/api/admin/notes/${note.id}`).auth(admin.token, { type: 'bearer' })).status).toBe(403);
    expect((await models.Note.findById(note.id))!.title).toBe(note.title);
  });

  it('requires authentication on every own-note operation', async () => {
    const note = await create();
    for (const [method, path] of [
      ['get', '/api/notes'], ['post', '/api/notes'], ['get', `/api/notes/${note.id}`],
      ['patch', `/api/notes/${note.id}`], ['delete', `/api/notes/${note.id}`]
    ] as const) {
      expect((await request(app)[method](path).send({ title: 'x', content: '' })).status).toBe(401);
    }
  });

  it('rejects invalid bodies, ownership/internal injection and operator objects without writes', async () => {
    const note = await create();
    const invalid = [
      { title: '' }, { title: '  ' }, { title: 'x'.repeat(201) }, { title: 1 }, { title: { $ne: null } },
      { content: 'x'.repeat(20_001) }, { content: null }, { content: 1 }, { content: { $set: '' } },
      { ownerId: b.id.toHexString() }, { _id: b.id.toHexString() }, { id: b.id.toHexString() },
      { createdAt: new Date().toISOString() }, { updatedAt: new Date().toISOString() },
      { contentRevision: 5 }, { $set: { ownerId: b.id.toHexString() } }, { extra: true }
    ];
    for (const fields of invalid) {
      for (const method of ['post', 'patch'] as const) {
        const response = await request(app)[method](method === 'post' ? '/api/notes' : `/api/notes/${note.id}`)
          .auth(a.token, { type: 'bearer' }).send({ title: 'valid', content: '', ...fields });
        expect(response.status, JSON.stringify(fields)).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    }
    for (const body of [{}, [], { title: 'only' }, { content: '' }]) {
      expect((await request(app).post('/api/notes').auth(a.token, { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect((await request(app).patch(`/api/notes/${note.id}`).auth(a.token, { type: 'bearer' }).send({})).status).toBe(400);
    expect(await models.Note.countDocuments()).toBe(1);
    expect((await models.Note.findById(note.id))!.content).toBe(note.content);
    const bounded = await create(a, { title: 'x'.repeat(200), content: 'x'.repeat(20_000) });
    expect(bounded.content.length).toBe(20_000);
    const cleared = await request(app).patch(`/api/notes/${bounded.id}`).auth(a.token, { type: 'bearer' }).send({ title: 'x'.repeat(200), content: '' });
    expect(cleared.status).toBe(200);
  });

  it('rejects invalid IDs, unknown queries and invalid pagination at the actual HTTP boundaries', async () => {
    const note = await create();
    for (const method of ['get', 'patch', 'delete'] as const) {
      const response = await request(app)[method]('/api/notes/not-an-id').auth(a.token, { type: 'bearer' }).send({ title: 'x' });
      expect(response.status).toBe(400);
      expect((await request(app)[method](`/api/notes/${note.id}?ownerId=other`).auth(a.token, { type: 'bearer' }).send({ title: 'x' })).status).toBe(400);
    }
    expect((await request(app).get('/api/admin/notes/not-an-id').auth(admin.token, { type: 'bearer' })).status).toBe(400);
    expect((await request(app).get(`/api/admin/notes/${note.id}?content=true`).auth(admin.token, { type: 'bearer' })).status).toBe(400);
    expect((await request(app).post('/api/notes?ownerId=other').auth(a.token, { type: 'bearer' }).send({ title: 'x', content: '' })).status).toBe(400);
    for (const [path, owner] of [['/api/notes', a], ['/api/admin/notes', admin]] as const) {
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'cursor=garbage', 'ownerId=other', 'sort=title']) {
        expect((await request(app).get(`${path}?${query}`).auth(owner.token, { type: 'bearer' })).status).toBe(400);
      }
    }
  });
});

describe('note parent write fence', () => {
  it('increments only the authenticated parent and never returns internal fields', async () => {
    await create(); await create();
    const parent = await models.User.findById(a.id).select('+contentRevision +tokenVersion');
    expect(parent!.contentRevision).toBe(2);
    expect(parent!.tokenVersion).toBe(0);
    expect((await models.User.findById(b.id).select('+contentRevision'))!.contentRevision).toBe(0);
  });

  it('rolls back the parent revision on insertion failure and both writes on a later failure', async () => {
    const spy = vi.spyOn(models.Note, 'create').mockRejectedValueOnce(new Error('injected insert failure'));
    try {
      const response = await request(app).post('/api/notes').auth(a.token, { type: 'bearer' }).send({ title: 'x', content: '' });
      expect(response.status).toBe(500);
      expect(response.body.error.code).toBe('INTERNAL_ERROR');
    } finally { spy.mockRestore(); }
    await expect(withParentContentWrite(connection, { _id: a.id, tokenVersion: 0 }, async (session) => {
      await models.Note.create([{ ownerId: a.id, title: 'rollback', content: '' }], { session });
      throw new Error('injected post-insert failure');
    })).rejects.toThrow('injected post-insert failure');
    expect(await models.Note.countDocuments()).toBe(0);
    expect((await models.User.findById(a.id).select('+contentRevision'))!.contentRevision).toBe(0);
  });

  it('rechecks deleted and revoked parents inside creation even after authentication', async () => {
    const service = createNoteService(connection, 5000);
    const staleUser = await models.User.findById(a.id).select('+tokenVersion').lean();
    await models.User.updateOne({ _id: a.id }, { $inc: { tokenVersion: 1 } });
    await expect(service.create(staleUser!, { title: 'revoked', content: '' })).rejects.toMatchObject({ status: 401 });
    await models.User.deleteOne({ _id: a.id });
    await expect(service.create(staleUser!, { title: 'deleted', content: '' })).rejects.toMatchObject({ status: 401 });
    expect(await models.Note.countDocuments()).toBe(0);
  });

  it('conflicts with parent-first deletion transactions and leaves no orphan under concurrent creation', async () => {
    const service = createNoteService(connection, 5000);
    // Test-only cascade follows the architecture; the admin deletion API belongs
    // to Phase 5. No operations run in parallel on an individual session.
    async function cascade(id: Types.ObjectId) {
      await connection.transaction(async (session) => {
        await models.User.deleteOne({ _id: id }, { session });
        await models.Note.deleteMany({ ownerId: id }, { session });
      });
    }
    for (let i = 0; i < 8; i++) {
      const owner = await actor(`race${i}`);
      const user = await models.User.findById(owner.id).select('+tokenVersion').lean();
      const operations = [() => service.create(user!, { title: 'racing', content: '' }), () => cascade(owner.id)];
      const results = await Promise.allSettled((i % 2 ? operations.reverse() : operations).map((run) => run()));
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 401 });
      }
      expect(await models.User.countDocuments({ _id: owner.id })).toBe(0);
      expect(await models.Note.countDocuments({ ownerId: owner.id })).toBe(0);
    }
  });
});
