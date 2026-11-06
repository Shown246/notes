import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createApp } from '../../src/app.js';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes } from '../../src/config/indexes.js';
import { createLogger } from '../../src/middleware/logging.js';
import { issueToken } from '../../src/modules/auth/token.js';
import { createPostService } from '../../src/modules/posts/post.service.js';
import { allAuthorPostsPipeline, createPostRepository } from '../../src/modules/posts/post.repository.js';
import { encodeCursor } from '../../src/shared/cursor.js';
import { cursorScopes, objectIdPage } from '../../src/shared/pagination.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
let app: ReturnType<typeof createApp>;
type Actor = { id: Types.ObjectId; token: string };
let a: Actor; let b: Actor; let admin: Actor;
async function actor(name: string, role: 'user' | 'admin' = 'user'): Promise<Actor> {
  const user = await models.User.create({ name, email: `${name}@example.test`, passwordHash: 'unused', role });
  return { id: user._id, token: await issueToken(user.id, 0, testEnvironment()) };
}
async function create(owner = a, fields = { title: ' A post ', body: '  body\n' }) {
  const response = await request(app).post('/api/posts').auth(owner.token, { type: 'bearer' }).send(fields);
  expect(response.status).toBe(201);
  return response.body.data as { id: string; authorId: string; title: string; body: string; createdAt: string; updatedAt: string };
}
function safePost(post: object) {
  expect(Object.keys(post).sort()).toEqual(['id', 'authorId', 'title', 'body', 'createdAt', 'updatedAt'].sort());
}
beforeAll(async () => {
  connection = await testConnection(); models = getModels(connection); await ensureIndexes(connection);
  app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true,
    auth: { connection, config: testEnvironment() } });
});
beforeEach(async () => {
  await models.Post.deleteMany({}); await models.User.deleteMany({});
  a = await actor('a'); b = await actor('b'); admin = await actor('admin', 'admin');
});
afterAll(async () => { await connection?.close(); });

describe('posts and author lookup', () => {
  it('creates posts for both roles with server ownership, safe DTOs, and the parent fence', async () => {
    for (const owner of [a, admin]) {
      const post = await create(owner);
      safePost(post);
      expect(post).toMatchObject({ authorId: owner.id.toHexString(), title: 'A post', body: '  body\n' });
      expect(new Date(post.createdAt).toISOString()).toBe(post.createdAt);
      expect((await models.User.findById(owner.id).select('+contentRevision'))!.contentRevision).toBe(1);
      expect((await models.Post.findById(post.id))!.authorId).toEqual(owner.id);
    }
  });

  it('allows anonymous post reads and requires authentication for creation', async () => {
    await create();
    for (const path of ['/api/posts', `/api/users/${a.id}/posts`, `/api/users/${a.id}/posts/all`]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(1);
      safePost(response.body.data[0]);
      expect((await request(app).get(path).auth('forged', { type: 'bearer' })).status).toBe(200);
    }
    expect((await request(app).post('/api/posts').send({ title: 'post', body: 'body' })).status).toBe(401);
    expect((await request(app).post('/api/posts').auth('forged', { type: 'bearer' }).send({ title: 'post', body: 'body' })).status).toBe(401);
  });

  it('returns every author post in one lookup, including beyond the page maximum, with indexed foreign access', async () => {
    const own = await models.Post.insertMany(Array.from({ length: 121 }, (_, i) => ({
      authorId: a.id, title: `Post ${i}`, body: 'body'
    })));
    await create(b);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    const forbidden = [vi.spyOn(models.User, 'findById'), vi.spyOn(models.User, 'findOne'),
      vi.spyOn(models.Post, 'find'), vi.spyOn(models.Post, 'countDocuments')];
    try {
      const response = await request(app).get(`/api/users/${a.id}/posts/all`);
      expect(response.status).toBe(200);
      expect(response.body.author).toEqual({ id: a.id.toHexString(), name: 'a' });
      expect(response.body.data.map((post: { id: string }) => post.id)).toEqual(own.map(post => post.id).sort().reverse());
      response.body.data.forEach(safePost);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]![0]).toEqual(allAuthorPostsPipeline(a.id));
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); forbidden.forEach(spy => spy.mockRestore()); }
    const explain = await models.User.collection.aggregate(allAuthorPostsPipeline(a.id)).explain('executionStats');
    const lookup = explain.stages.find((stage: Record<string, unknown>) => stage.$lookup);
    expect(lookup.indexesUsed).toContain('posts_author_id_desc');
    expect(lookup.collectionScans).toBe(0);
  });

  it('handles empty and missing authors and rejects queries on the complete endpoint', async () => {
    expect((await request(app).get(`/api/users/${a.id}/posts/all`)).body)
      .toEqual({ data: [], author: { id: a.id.toHexString(), name: 'a' } });
    expect((await request(app).get(`/api/users/${new Types.ObjectId()}/posts/all`)).status).toBe(404);
    expect((await request(app).get('/api/users/bad/posts/all')).status).toBe(400);
    for (const query of ['limit=1', 'cursor=bad', 'extra=1']) {
      expect((await request(app).get(`/api/users/${a.id}/posts/all?${query}`)).status).toBe(400);
    }
  });

  it('retrieves author posts whose combined bodies exceed one BSON document', async () => {
    // A joined array of these bodies alone exceeds 16 MiB. Immediate unwind
    // must prevent the complete lookup from materializing one result document.
    const count = 1700;
    await models.Post.insertMany(Array.from({ length: count }, (_, i) => ({
      authorId: a.id, title: `Large fixture ${i}`, body: 'x'.repeat(10_000)
    })));
    const response = await request(app).get(`/api/users/${a.id}/posts/all`);
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(count);
    expect(new Set(response.body.data.map((post: { id: string }) => post.id)).size).toBe(count);
    expect(response.body.data.every((post: { body: string }) => post.body.length === 10_000)).toBe(true);
  }, 60000);

  it('returns a sanitized timeout when complete author cursor consumption exceeds its budget', async () => {
    const original = models.User.collection.aggregate.bind(models.User.collection);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate').mockImplementationOnce((...args) => {
      const cursor = original(...args);
      vi.spyOn(cursor, 'toArray').mockImplementationOnce(async () => {
        await cursor.close(); throw Object.assign(new Error('private query details'), { code: 50 });
      });
      return cursor;
    });
    try {
      const response = await request(app).get(`/api/users/${a.id}/posts/all`);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('QUERY_TIMEOUT');
      expect(JSON.stringify(response.body)).not.toContain('private');
    } finally { aggregate.mockRestore(); }
  });

  it('paginates global and author posts for either reader role without omissions or duplicates', async () => {
    const all: string[] = []; const own: string[] = [];
    for (let i = 0; i < 11; i++) {
      const post = await create(i % 2 === 0 ? a : b);
      all.push(post.id); if (i % 2 === 0) own.push(post.id);
    }
    for (const reader of [b, admin]) {
      for (const [path, expected] of [['/api/posts', all], [`/api/users/${a.id}/posts`, own]] as const) {
        const seen: string[] = []; let cursor: string | null = null;
        do {
          const response: Response = await request(app).get(path).query({ limit: 2, ...(cursor ? { cursor } : {}) })
            .auth(reader.token, { type: 'bearer' });
          expect(response.status).toBe(200);
          expect(response.body.pagination.limit).toBe(2);
          expect(response.body.data.length).toBeLessThanOrEqual(2);
          for (const row of response.body.data) { safePost(row); seen.push(row.id); }
          if (path !== '/api/posts') expect(response.body.author).toEqual({ id: a.id.toHexString(), name: 'a' });
          expect(response.body.pagination.hasMore).toBe(response.body.pagination.nextCursor !== null);
          cursor = response.body.pagination.nextCursor;
        } while (cursor);
        expect(seen).toEqual([...expected].sort().reverse());
        expect(new Set(seen).size).toBe(expected.length);
      }
    }
  });

  it('distinguishes missing authors, empty authors, and exhausted pages', async () => {
    const empty = { data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } };
    expect((await request(app).get('/api/posts').auth(a.token, { type: 'bearer' })).body).toEqual(empty);
    expect((await request(app).get(`/api/users/${b.id}/posts`).auth(a.token, { type: 'bearer' })).body)
      .toEqual({ ...empty, author: { id: b.id.toHexString(), name: 'b' } });
    const missing = await request(app).get(`/api/users/${new Types.ObjectId()}/posts`).auth(a.token, { type: 'bearer' });
    expect(missing.status).toBe(404); expect(missing.body.error.code).toBe('USER_NOT_FOUND');
    await create();
    for (const [path, scope] of [
      ['/api/posts', cursorScopes.posts], [`/api/users/${a.id}/posts`, cursorScopes.authorPosts(a.id)]
    ] as const) {
      const cursor = encodeCursor(scope, 'objectId', '000000000000000000000000');
      const response = await request(app).get(path).query({ cursor }).auth(b.token, { type: 'bearer' });
      expect(response.status).toBe(200); expect(response.body).toMatchObject(empty);
    }
  });

  it('rejects malformed IDs, unsupported queries, limits, and cross-scope cursors', async () => {
    for (const id of ['bad', 'a'.repeat(23), 'z'.repeat(24)]) {
      expect((await request(app).get(`/api/users/${id}/posts`).auth(a.token, { type: 'bearer' })).status).toBe(400);
    }
    for (const path of ['/api/posts', `/api/users/${a.id}/posts`]) {
      for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=2&limit=3', 'sort=title', 'authorId=x', 'cursor=bad']) {
        expect((await request(app).get(`${path}?${query}`).auth(a.token, { type: 'bearer' })).status).toBe(400);
      }
      for (const scope of [cursorScopes.adminNotes, cursorScopes.authorPosts(b.id),
        path === '/api/posts' ? cursorScopes.authorPosts(a.id) : cursorScopes.posts]) {
        const response = await request(app).get(path).query({ cursor: encodeCursor(scope, 'objectId', a.id.toHexString()) })
          .auth(a.token, { type: 'bearer' });
        expect(response.status).toBe(400); expect(response.body.error.code).toBe('INVALID_CURSOR');
      }
    }
  });

  it('validates required fields, size bounds, operators, and ownership/internal injection before writing', async () => {
    for (const fields of [
      {}, { title: 'ok' }, { title: ' ', body: 'ok' }, { title: 'x'.repeat(201), body: 'ok' },
      { title: 'ok', body: '' }, { title: 'ok', body: 'x'.repeat(10_001) }, { title: { $gt: '' }, body: 'ok' },
      { title: 'ok', body: { $ne: '' } }, ...['authorId', '_id', 'ownerId', 'tokenVersion', 'contentRevision', 'role', '$set']
        .map((key) => ({ title: 'ok', body: 'ok', [key]: b.id.toHexString() }))
    ]) {
      expect((await request(app).post('/api/posts').auth(a.token, { type: 'bearer' }).send(fields)).status).toBe(400);
    }
    expect((await request(app).post('/api/posts?extra=1').auth(a.token, { type: 'bearer' }).send({ title: 'ok', body: 'ok' })).status).toBe(400);
    expect(await models.Post.countDocuments()).toBe(0);
    expect((await models.User.findById(a.id).select('+contentRevision'))!.contentRevision).toBe(0);
    await create(a, { title: 'x'.repeat(200), body: 'x'.repeat(10_000) });
  });

  it('uses exactly one native aggregate with bounded foreign pagination and no fallback reads', async () => {
    for (let i = 0; i < 4; i++) await create();
    await create(b);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    const forbidden = [vi.spyOn(models.User, 'findById'), vi.spyOn(models.User, 'findOne'), vi.spyOn(models.User, 'find'),
      vi.spyOn(models.Post, 'find'), vi.spyOn(models.Post, 'countDocuments'), vi.spyOn(models.User, 'aggregate')];
    try {
      const page = objectIdPage({ limit: '1', cursor: encodeCursor(cursorScopes.authorPosts(a.id), 'objectId', 'ffffffffffffffffffffffff') }, cursorScopes.authorPosts(a.id));
      const result = await createPostRepository(connection, 5000).byAuthor(a.id, page);
      expect(result!.posts).toHaveLength(2);
      expect(Object.keys(result!).sort()).toEqual(['_id', 'name', 'posts']);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]).toEqual([[
        { $match: { _id: a.id } },
        { $lookup: { from: 'posts', localField: '_id', foreignField: 'authorId', as: 'posts', pipeline: [
          { $match: { _id: { $lt: new Types.ObjectId('ffffffffffffffffffffffff') } } },
          { $sort: { _id: -1 } }, { $limit: 2 },
          { $project: { _id: 1, authorId: 1, title: 1, body: 1, createdAt: 1, updatedAt: 1 } }
        ] } }, { $project: { _id: 1, name: 1, posts: 1 } }
      ], { maxTimeMS: 5000 }]);
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); forbidden.forEach((spy) => spy.mockRestore()); }
  });

  it('rolls back the fence and inserted post after an injected post-insert failure', async () => {
    const original = models.Post.create.bind(models.Post);
    const spy = vi.spyOn(models.Post, 'create').mockImplementationOnce(async (...args: Parameters<typeof original>) => {
      await original(...args); throw new Error('private post failure');
    });
    try {
      const response = await request(app).post('/api/posts').auth(a.token, { type: 'bearer' }).send({ title: 'post', body: 'body' });
      expect(response.status).toBe(500); expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('private');
    } finally { spy.mockRestore(); }
    expect(await models.Post.countDocuments()).toBe(0);
    expect((await models.User.findById(a.id).select('+contentRevision'))!.contentRevision).toBe(0);
  });

  it('rechecks revoked/deleted parents in the creation transaction', async () => {
    const user = await models.User.findById(a.id).select('+tokenVersion').lean();
    const service = createPostService(connection, 5000);
    await models.User.updateOne({ _id: a.id }, { $inc: { tokenVersion: 1 } });
    await expect(service.create(user!, { title: 'post', body: 'body' })).rejects.toMatchObject({ status: 401 });
    await models.User.deleteOne({ _id: a.id });
    await expect(service.create(user!, { title: 'post', body: 'body' })).rejects.toMatchObject({ status: 401 });
    expect(await models.Post.countDocuments()).toBe(0);
  });

  it('leaves no orphan posts when HTTP creation races with HTTP account deletion', async () => {
    for (let i = 0; i < 6; i++) {
      const target = await actor(`race${i}`);
      const [created, deleted] = await Promise.all([
        request(app).post('/api/posts').auth(target.token, { type: 'bearer' }).send({ title: 'race', body: 'body' }),
        request(app).delete(`/api/admin/users/${target.id}`).auth(admin.token, { type: 'bearer' })
      ]);
      expect([201, 401]).toContain(created.status); expect(deleted.status).toBe(204);
      expect(await models.User.findById(target.id)).toBeNull();
      expect(await models.Post.countDocuments({ authorId: target.id })).toBe(0);
      expect((await request(app).get(`/api/users/${target.id}/posts`).auth(b.token, { type: 'bearer' })).status).toBe(404);
    }
  });
});
