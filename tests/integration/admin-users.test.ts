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
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { createNoteService } from '../../src/modules/notes/note.service.js';
import { createAdminUserService } from '../../src/modules/users/admin-user.service.js';
import { withParentContentWrite } from '../../src/shared/content-transaction.js';
import { encodeCursor } from '../../src/shared/cursor.js';
import { cursorScopes } from '../../src/shared/pagination.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
let app: ReturnType<typeof createApp>;
const password = ' original password ';
let passwordHash: string;
type Actor = { id: Types.ObjectId; token: string };
let admin: Actor;
let member: Actor;
async function actor(name: string, role: 'user' | 'admin' = 'user'): Promise<Actor> {
  const user = await models.User.create({ name, email: `${name}@example.test`, passwordHash, role });
  return { id: user._id, token: await issueToken(user.id, 0, testEnvironment()) };
}
function safe(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(['password', 'passwordHash', 'tokenVersion', 'contentRevision', '__v', '_id']).not.toContain(key);
    safe(child);
  }
}
async function fixtureContent(ownerId: Types.ObjectId) {
  const note = await models.Note.create({ ownerId, title: 'private note', content: 'private content' });
  const post = await models.Post.create({ authorId: ownerId, title: 'shared post', body: 'post content' });
  return { note, post };
}
const input = { name: ' New member ', email: ' NEW@Example.Test ', password: ' new password ', interests: [' Chess ', 'chess', 'READING'] };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Concurrent transaction did not reach the expected barrier')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

beforeAll(async () => {
  connection = await testConnection(); models = getModels(connection);
  await ensureIndexes(connection);
  passwordHash = await hashPassword(password);
  app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true,
    auth: { connection, config: testEnvironment() } });
});
beforeEach(async () => {
  await models.Note.deleteMany({}); await models.Post.deleteMany({}); await models.User.deleteMany({});
  admin = await actor('admin', 'admin'); member = await actor('member');
});
afterAll(async () => { await connection?.close(); });

describe('admin user management', () => {
  it('creates either role, normalizes fields, hashes exact passwords and returns safe details', async () => {
    for (const role of ['user', 'admin'] as const) {
      const response = await request(app).post('/api/admin/users').auth(admin.token, { type: 'bearer' })
        .send({ ...input, email: ` created-${role}@Example.Test `, role });
      expect(response.status).toBe(201); safe(response.body);
      expect(response.body.data).toMatchObject({ name: 'New member', email: `created-${role}@example.test`, role, interests: ['chess', 'reading'] });
      const stored = await models.User.findById(response.body.data.id).select('+passwordHash +tokenVersion +contentRevision');
      expect(stored!.passwordHash).toMatch(/^\$argon2id\$/);
      expect(await verifyPassword(stored!.passwordHash, input.password)).toBe(true);
      expect(await verifyPassword(stored!.passwordHash, input.password.trim())).toBe(false);
      expect(stored!.tokenVersion).toBe(0); expect(stored!.contentRevision).toBe(0);
      const read = await request(app).get(`/api/admin/users/${stored!.id}`).auth(admin.token, { type: 'bearer' });
      expect(read.status).toBe(200); expect(read.body).toEqual(response.body); safe(read.body);
      expect((await request(app).post('/api/auth/login').send({ email: stored!.email, password: input.password })).status).toBe(200);
    }
    const defaults = await request(app).post('/api/admin/users').auth(admin.token, { type: 'bearer' }).send({ name: 'Defaults', email: 'default@example.test', password });
    expect(defaults.status).toBe(201);
    expect(defaults.body.data).toMatchObject({ role: 'user', interests: [] });
  });

  it('paginates all users in descending ObjectId order with no omissions or duplicates', async () => {
    for (let i = 0; i < 5; i++) await actor(`page${i}`);
    const expected = (await models.User.find().sort({ _id: -1 })).map((user) => user.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: Response = await request(app).get('/api/admin/users').query({ limit: 2, ...(cursor ? { cursor } : {}) }).auth(admin.token, { type: 'bearer' });
      expect(response.status).toBe(200); safe(response.body);
      seen.push(...response.body.data.map((user: { id: string }) => user.id));
      expect(response.body.pagination.limit).toBe(2);
      expect(response.body.pagination.hasMore).toBe(response.body.pagination.nextCursor !== null);
      cursor = response.body.pagination.nextCursor;
    } while (cursor);
    expect(seen).toEqual(expected); expect(new Set(seen).size).toBe(expected.length);
    const pastEnd = encodeCursor(cursorScopes.users, 'objectId', '000000000000000000000000');
    const empty = await request(app).get('/api/admin/users').query({ cursor: pastEnd }).auth(admin.token, { type: 'bearer' });
    expect(empty.body).toEqual({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } });
  });

  it('updates allowed fields and current roles without revoking tokens for ordinary edits', async () => {
    const response = await request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })
      .send({ name: ' Changed ', email: ' CHANGED@Example.Test ', interests: [' Music ', 'music'], role: 'admin' });
    expect(response.status).toBe(200); safe(response.body);
    expect(response.body.data).toMatchObject({ name: 'Changed', email: 'changed@example.test', interests: ['music'], role: 'admin' });
    expect((await request(app).get('/api/admin/users').auth(member.token, { type: 'bearer' })).status).toBe(200);
    expect((await models.User.findById(member.id).select('+tokenVersion'))!.tokenVersion).toBe(0);
    const demoted = await request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).send({ role: 'user', interests: [] });
    expect(demoted.status).toBe(200); expect(demoted.body.data.interests).toEqual([]);
    expect((await request(app).get('/api/admin/users').auth(member.token, { type: 'bearer' })).status).toBe(403);
  });

  it('atomically resets passwords and increments versions, revoking old JWTs immediately', async () => {
    for (const newPassword of ['x'.repeat(12), ' '.repeat(2) + 'x'.repeat(124) + ' '.repeat(2)]) {
      const before = await models.User.findById(member.id).select('+tokenVersion');
      const oldToken = await issueToken(member.id.toHexString(), before!.tokenVersion, testEnvironment());
      const response = await request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).send({ password: newPassword });
      expect(response.status).toBe(200); safe(response.body);
      const stored = await models.User.findById(member.id).select('+passwordHash +tokenVersion');
      expect(stored!.tokenVersion).toBe(before!.tokenVersion + 1);
      expect(await verifyPassword(stored!.passwordHash, newPassword)).toBe(true);
      expect((await request(app).get('/api/auth/me').auth(oldToken, { type: 'bearer' })).status).toBe(401);
      expect((await request(app).post('/api/auth/login').send({ email: 'member@example.test', password })).status).toBe(401);
      const login = await request(app).post('/api/auth/login').send({ email: 'member@example.test', password: newPassword });
      expect(login.status).toBe(200);
      expect((await request(app).get('/api/auth/me').auth(login.body.data.accessToken, { type: 'bearer' })).status).toBe(200);
    }
  });

  it('uses atomic increments for concurrent password resets', async () => {
    const results = await Promise.all(['first replacement', 'second replacement'].map((replacement) =>
      request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).send({ password: replacement })));
    for (const response of results) { expect(response.status).toBe(200); safe(response.body); }
    expect((await models.User.findById(member.id).select('+tokenVersion'))!.tokenVersion).toBe(2);
    expect((await request(app).get('/api/auth/me').auth(member.token, { type: 'bearer' })).status).toBe(401);
  });

  it('rejects self-deletion and any self-role assignment while allowing other self edits', async () => {
    const content = await fixtureContent(admin.id);
    for (const role of ['user', 'admin']) {
      const response = await request(app).patch(`/api/admin/users/${admin.id}`).auth(admin.token, { type: 'bearer' }).send({ role, name: 'must not change' });
      expect(response.status).toBe(409); expect(response.body.error.code).toBe('SELF_ACCOUNT_OPERATION');
    }
    const deleted = await request(app).delete(`/api/admin/users/${admin.id}`).auth(admin.token, { type: 'bearer' });
    expect(deleted.status).toBe(409); expect(deleted.body.error.code).toBe('SELF_ACCOUNT_OPERATION');
    expect((await models.User.findById(admin.id))!.name).toBe('admin');
    expect(await models.Note.findById(content.note._id)).not.toBeNull(); expect(await models.Post.findById(content.post._id)).not.toBeNull();
    const updated = await request(app).patch(`/api/admin/users/${admin.id}`).auth(admin.token, { type: 'bearer' }).send({ name: ' Allowed ' });
    expect(updated.status).toBe(200); expect(updated.body.data.name).toBe('Allowed');
  });

  it('denies every admin user operation to anonymous and ordinary accounts', async () => {
    for (const [method, path] of [['get', '/api/admin/users'], ['post', '/api/admin/users'],
      ['get', `/api/admin/users/${member.id}`], ['patch', `/api/admin/users/${member.id}`], ['delete', `/api/admin/users/${member.id}`]] as const) {
      expect((await request(app)[method](path).send(input)).status).toBe(401);
      expect((await request(app)[method](path).auth(member.token, { type: 'bearer' }).send(input)).status).toBe(403);
    }
    expect(await models.User.countDocuments()).toBe(2);
  });

  it('rejects invalid fields, internal/operator injection, empty patches, and invalid required inputs', async () => {
    const invalid = [
      { name: ' ' }, { name: 'x'.repeat(101) }, { email: 'bad' }, { email: { $ne: null } },
      { password: 'short' }, { password: 'x'.repeat(129) }, { password: 123456789012 }, { role: 'owner' },
      { interests: [''] }, { interests: ['x'.repeat(41)] }, { interests: Array.from({ length: 11 }, (_, i) => `${i}`) },
      { interests: 'chess' }, { _id: admin.id.toHexString() }, { id: admin.id.toHexString() },
      { passwordHash: 'injected' }, { tokenVersion: 99 }, { contentRevision: 99 },
      { createdAt: new Date().toISOString() }, { updatedAt: new Date().toISOString() },
      { $set: { role: 'admin' } }, { extra: true }, { name: null }, { role: null }
    ];
    for (const fields of invalid) {
      for (const method of ['post', 'patch'] as const) {
        const response = await request(app)[method](method === 'post' ? '/api/admin/users' : `/api/admin/users/${member.id}`)
          .auth(admin.token, { type: 'bearer' }).send(method === 'post' ? { ...input, ...fields } : fields);
        expect(response.status, JSON.stringify(fields)).toBe(400); expect(response.body.error.code).toBe('VALIDATION_ERROR');
      }
    }
    for (const body of [{}, [], { name: 'Only' }, { email: 'only@example.test' }]) {
      expect((await request(app).post('/api/admin/users').auth(admin.token, { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect((await request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).send({})).status).toBe(400);
    expect(await models.User.countDocuments()).toBe(2);
    expect((await models.User.findById(member.id))!.name).toBe('member');
  });

  it('rejects malformed IDs, unknown queries and invalid or cross-route cursors', async () => {
    for (const method of ['get', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/admin/users/invalid').auth(admin.token, { type: 'bearer' }).send({ name: 'x' })).status).toBe(400);
      expect((await request(app)[method](`/api/admin/users/${member.id}?extra=1`).auth(admin.token, { type: 'bearer' }).send({ name: 'x' })).status).toBe(400);
      const missing = await request(app)[method](`/api/admin/users/${new Types.ObjectId()}`).auth(admin.token, { type: 'bearer' }).send({ name: 'x' });
      expect(missing.status).toBe(404); expect(missing.body.error.code).toBe('USER_NOT_FOUND');
    }
    expect((await request(app).post('/api/admin/users?role=admin').auth(admin.token, { type: 'bearer' }).send(input)).status).toBe(400);
    for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'limit=1&limit=2', 'cursor=garbage', 'role=user', 'sort=name']) {
      expect((await request(app).get(`/api/admin/users?${query}`).auth(admin.token, { type: 'bearer' })).status).toBe(400);
    }
    const wrong = encodeCursor(cursorScopes.adminNotes, 'objectId', member.id.toHexString());
    const response = await request(app).get('/api/admin/users').query({ cursor: wrong }).auth(admin.token, { type: 'bearer' });
    expect(response.status).toBe(400); expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('handles duplicate email races and leaves resets unchanged on duplicate-email update failure', async () => {
    const responses = await Promise.all(['NEW@example.test', ' new@EXAMPLE.test '].map((email) =>
      request(app).post('/api/admin/users').auth(admin.token, { type: 'bearer' }).send({ ...input, email })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(conflict.body.error.code).toBe('EMAIL_ALREADY_EXISTS'); safe(conflict.body);
    const failed = await request(app).patch(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })
      .send({ email: ' ADMIN@Example.Test ', password: 'must not be applied', name: 'must not change' });
    expect(failed.status).toBe(409); expect(failed.body.error.code).toBe('EMAIL_ALREADY_EXISTS'); safe(failed.body);
    const stored = await models.User.findById(member.id).select('+passwordHash +tokenVersion');
    expect(stored!.name).toBe('member'); expect(stored!.email).toBe('member@example.test');
    expect(stored!.tokenVersion).toBe(0); expect(await verifyPassword(stored!.passwordHash, password)).toBe(true);
    expect((await request(app).get('/api/auth/me').auth(member.token, { type: 'bearer' })).status).toBe(200);
    const other = await actor('other');
    const updates = await Promise.all([member, other].map((owner) => request(app).patch(`/api/admin/users/${owner.id}`)
      .auth(admin.token, { type: 'bearer' }).send({ email: 'same@example.test' })));
    expect(updates.map((response) => response.status).sort()).toEqual([200, 409]);
  });
});

describe('account cascade consistency', () => {
  it('deletes the account, every owned note and authored post, retaining all other accounts and content', async () => {
    await fixtureContent(member.id); await fixtureContent(member.id);
    const retained = await fixtureContent(admin.id);
    const response = await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' });
    expect(response.status).toBe(204); expect(response.text).toBe('');
    expect(await models.User.findById(member.id)).toBeNull();
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(0);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(0);
    expect(await models.User.findById(admin.id)).not.toBeNull();
    expect(await models.Note.findById(retained.note._id)).not.toBeNull(); expect(await models.Post.findById(retained.post._id)).not.toBeNull();
    expect((await request(app).get('/api/auth/me').auth(member.token, { type: 'bearer' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'member@example.test', password })).status).toBe(401);
    expect((await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })).status).toBe(404);
  });

  it('rolls back all three collections on a failure after deleting posts, returning a sanitized error', async () => {
    const content = await fixtureContent(member.id);
    const deletePosts = models.Post.deleteMany.bind(models.Post);
    const spy = vi.spyOn(models.Post, 'deleteMany').mockImplementationOnce((...args) => {
      const query = deletePosts(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => { await execute(); throw new Error('private database details'); };
      return query;
    });
    try {
      const response = await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' });
      expect(response.status).toBe(500); expect(response.body.error.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('private database details');
    } finally { spy.mockRestore(); }
    expect(await models.User.findById(member.id)).not.toBeNull();
    expect(await models.Note.findById(content.note._id)).not.toBeNull(); expect(await models.Post.findById(content.post._id)).not.toBeNull();
    expect((await request(app).get('/api/auth/me').auth(member.token, { type: 'bearer' })).status).toBe(200);
    expect((await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })).status).toBe(204);
  });

  it('maps unavailable-database transaction failures to 503 without leaking details or deleting data', async () => {
    const error = new Error('secret server URI'); error.name = 'MongoNetworkError';
    const spy = vi.spyOn(connection, 'transaction').mockRejectedValueOnce(error);
    try {
      const response = await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' });
      expect(response.status).toBe(503); expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE');
      expect(JSON.stringify(response.body)).not.toContain('secret');
    } finally { spy.mockRestore(); }
    expect(await models.User.findById(member.id)).not.toBeNull();
  });

  it('handles simultaneous deletion of the same account with one success and one not found', async () => {
    await fixtureContent(member.id);
    const results = await Promise.all([0, 1].map(() => request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })));
    expect(results.map((result) => result.status).sort()).toEqual([204, 404]);
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(0);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(0);
  });

  it('preserves content when deletion aborts and rejects child creation after committed deletion', async () => {
    const user = await models.User.findById(member.id).select('+tokenVersion').lean();
    const notes = createNoteService(connection, 5000);
    await notes.create(user!, { title: 'committed first', content: '' });
    // Future post creation uses this same fence; no Phase 6 endpoint is needed.
    const createPost = () => withParentContentWrite(connection, user!, async (session) => {
      const [post] = await models.Post.create([{ authorId: member.id, title: 'post', body: 'body' }], { session });
      return post!;
    });
    await createPost();
    const spy = vi.spyOn(models.Post, 'deleteMany').mockImplementationOnce(() => { throw new Error('abort deletion'); });
    try {
      expect((await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect(await models.User.findById(member.id)).not.toBeNull();
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(1);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(1);
    expect((await request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' })).status).toBe(204);
    await expect(notes.create(user!, { title: 'too late', content: '' })).rejects.toMatchObject({ status: 401 });
    await expect(createPost()).rejects.toMatchObject({ status: 401 });
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(0);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(0);
  });

  it('leaves no orphan notes or posts when fenced creation races with the actual deletion endpoint', async () => {
    const notes = createNoteService(connection, 5000);
    for (let i = 0; i < 8; i++) {
      const target = await actor(`race${i}`);
      const user = await models.User.findById(target.id).select('+tokenVersion').lean();
      const operations = [
        () => notes.create(user!, { title: 'racing note', content: '' }),
        () => withParentContentWrite(connection, user!, async (session) => {
          await models.Post.create([{ authorId: target.id, title: 'racing post', body: 'body' }], { session });
        }),
        async () => {
          const response = await request(app).delete(`/api/admin/users/${target.id}`).auth(admin.token, { type: 'bearer' });
          expect(response.status).toBe(204);
        }
      ];
      const results = await Promise.allSettled((i % 2 ? operations.reverse() : operations).map((run) => run()));
      for (const result of results) if (result.status === 'rejected') expect(result.reason).toMatchObject({ status: 401 });
      expect(await models.User.findById(target.id)).toBeNull();
      expect(await models.Note.countDocuments({ ownerId: target.id })).toBe(0);
      expect(await models.Post.countDocuments({ authorId: target.id })).toBe(0);
    }
  });

  it('retries deletion after an overlapping creation commits, then removes both committed children', async () => {
    const inserted = barrier(); const release = barrier(); const retried = barrier();
    const user = await models.User.findById(member.id).select('+tokenVersion').lean();
    const original = models.User.findOneAndDelete.bind(models.User);
    let attempts = 0;
    const spy = vi.spyOn(models.User, 'findOneAndDelete').mockImplementation((...args) => {
      if (++attempts === 2) retried.resolve();
      return original(...args);
    });
    const creation = withParentContentWrite(connection, user!, async (session) => {
      await models.Note.create([{ ownerId: member.id, title: 'concurrent note', content: '' }], { session });
      await models.Post.create([{ authorId: member.id, title: 'concurrent post', body: 'body' }], { session });
      inserted.resolve(); await release.promise;
    });
    let deletion: Promise<Response> | undefined;
    try {
      await bounded(inserted.promise);
      deletion = request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).then((response) => response);
      await bounded(retried.promise);
      release.resolve();
      await creation;
      expect((await deletion).status).toBe(204);
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      release.resolve(); await Promise.allSettled([creation, deletion]); spy.mockRestore();
    }
    expect(await models.User.findById(member.id)).toBeNull();
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(0);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(0);
  });

  it('retries overlapping child creation after deletion commits, then rejects the missing parent', async () => {
    const deleting = barrier(); const release = barrier(); const retried = barrier();
    const user = await models.User.findById(member.id).select('+tokenVersion').lean();
    const deletePosts = models.Post.deleteMany.bind(models.Post);
    const deleteSpy = vi.spyOn(models.Post, 'deleteMany').mockImplementationOnce((...args) => {
      const query = deletePosts(...args); const execute = query.exec.bind(query);
      query.exec = async () => { const result = await execute(); deleting.resolve(); await release.promise; return result; };
      return query;
    });
    const updateParent = models.User.updateOne.bind(models.User);
    let attempts = 0;
    const parentSpy = vi.spyOn(models.User, 'updateOne').mockImplementation((...args) => {
      if (++attempts === 2) retried.resolve();
      return updateParent(...args);
    });
    const deletion = request(app).delete(`/api/admin/users/${member.id}`).auth(admin.token, { type: 'bearer' }).then((response) => response);
    let creation: Promise<unknown> | undefined;
    try {
      await bounded(deleting.promise);
      creation = withParentContentWrite(connection, user!, async (session) => {
        await models.Note.create([{ ownerId: member.id, title: 'too late', content: '' }], { session });
        await models.Post.create([{ authorId: member.id, title: 'too late', body: 'body' }], { session });
      });
      // Attach the rejection assertion before releasing the deleting transaction.
      const rejected = expect(creation).rejects.toMatchObject({ status: 401 });
      await bounded(retried.promise);
      release.resolve();
      expect((await deletion).status).toBe(204);
      await rejected;
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      release.resolve(); await Promise.allSettled([creation, deletion]); parentSpy.mockRestore(); deleteSpy.mockRestore();
    }
    expect(await models.User.findById(member.id)).toBeNull();
    expect(await models.Note.countDocuments({ ownerId: member.id })).toBe(0);
    expect(await models.Post.countDocuments({ authorId: member.id })).toBe(0);
  });

  it('enforces self safeguards within the service used by transactions', async () => {
    const service = createAdminUserService(connection, 5000);
    await expect(service.delete(admin.id, admin.id)).rejects.toMatchObject({ status: 409 });
    await expect(service.update(admin.id, admin.id, { role: 'user' })).rejects.toMatchObject({ status: 409 });
  });
});
