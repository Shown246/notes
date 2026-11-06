import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Response } from 'supertest';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { createApp } from '../../src/app.js';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes, verifyIndexes } from '../../src/config/indexes.js';
import { createLogger } from '../../src/middleware/logging.js';
import { issueToken } from '../../src/modules/auth/token.js';
import { createInterestRepository, interestPipeline, interestAggregateOptions } from '../../src/modules/reports/interest.repository.js';
import { createInterestService } from '../../src/modules/reports/interest.service.js';
import { encodeCursor, decodeCursor } from '../../src/shared/cursor.js';
import { cursorScopes, interestPage } from '../../src/shared/pagination.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

const path = '/api/admin/reports/users-by-interest';
let connection: Connection;
let models: ReturnType<typeof getModels>;
let app: ReturnType<typeof createApp>;
let admin: { id: Types.ObjectId; token: string };
async function member(name: string, interests: string[] = [], extra: object = {}) {
  return models.User.create({ name, email: `${name}@example.test`, passwordHash: 'private-test-hash', interests, ...extra });
}
function get(query: object = {}) {
  return request(app).get(path).query(query).auth(admin.token, { type: 'bearer' });
}
const empty = { data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } };

beforeAll(async () => {
  connection = await testConnection(); models = getModels(connection); await ensureIndexes(connection);
  app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true,
    auth: { connection, config: { ...testEnvironment(), REPORT_TIMEOUT_MS: 4321 } } });
});
beforeEach(async () => {
  await models.User.deleteMany({});
  const user = await member('admin', [], { role: 'admin' });
  admin = { id: user._id, token: await issueToken(user.id, 0, testEnvironment()) };
});
afterAll(async () => { await connection?.close(); });

describe('Scenario 1 grouped-interest report', () => {
  it('returns all groups and all memberships in exactly one aggregate without fallback reads', async () => {
    const users = [];
    for (let i = 0; i < 25; i++) users.push(await member(`all${i}`, [' Chess ', 'chess', `topic-${String(i).padStart(2, '0')}`]));
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    const forbidden = [vi.spyOn(models.User, 'find'), vi.spyOn(models.User, 'findById'),
      vi.spyOn(models.User, 'findOne'), vi.spyOn(models.User, 'countDocuments'),
      vi.spyOn(models.User.collection, 'find'), vi.spyOn(models.User.collection, 'findOne'),
      vi.spyOn(models.User, 'distinct'), vi.spyOn(models.User, 'aggregate'), vi.spyOn(models.User, 'populate')];
    try {
      const response = await createInterestService(connection, 5000).all();
      expect(response.data).toHaveLength(26);
      expect(response.data[0]).toEqual({ interest: 'chess', userCount: 25,
        users: users.map(user => ({ id: user.id, name: user.name })).sort((a, b) => b.id.localeCompare(a.id)) });
      for (const group of response.data) {
        expect(group.users).toHaveLength(group.userCount);
        expect(Object.keys(group).sort()).toEqual(['interest', 'userCount', 'users']);
        group.users.forEach(user => expect(Object.keys(user).sort()).toEqual(['id', 'name']));
      }
      expect(aggregate).toHaveBeenCalledTimes(1);
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); forbidden.forEach(spy => spy.mockRestore()); }
  });

  it('protects the complete report, returns empty data, and rejects pagination parameters', async () => {
    expect((await request(app).get(`${path}/all`)).status).toBe(401);
    const user = await member('ordinary-all');
    const token = await issueToken(user.id, 0, testEnvironment());
    expect((await request(app).get(`${path}/all`).auth(token, { type: 'bearer' })).status).toBe(403);
    expect((await request(app).get(`${path}/all`).auth(admin.token, { type: 'bearer' })).body).toEqual({ data: [] });
    for (const query of ['limit=1', 'cursor=bad', 'extra=1']) {
      expect((await request(app).get(`${path}/all?${query}`).auth(admin.token, { type: 'bearer' })).status).toBe(400);
    }
  });

  it('reports complete-result size and time failures without leaking database details or truncating data', async () => {
    for (const [mongoCode, status, code] of [
      [10334, 413, 'REPORT_TOO_LARGE'], [146, 413, 'REPORT_TOO_LARGE'],
      [292, 413, 'REPORT_TOO_LARGE'], [50, 503, 'REPORT_TIMEOUT']
    ] as const) {
      const aggregate = vi.spyOn(models.User.collection, 'aggregate').mockImplementationOnce(() => {
        throw Object.assign(new Error('private database details'), { code: mongoCode });
      });
      try {
        const response = await request(app).get(`${path}/all`).auth(admin.token, { type: 'bearer' });
        expect(response.status).toBe(status); expect(response.body.error.code).toBe(code);
        expect(response.body).not.toHaveProperty('data');
        expect(JSON.stringify(response.body)).not.toContain('private');
      } finally { aggregate.mockRestore(); }
    }
  });
  it('requires authentication and the current Admin role', async () => {
    expect((await request(app).get(path)).status).toBe(401);
    expect((await request(app).get(path).auth('forged', { type: 'bearer' })).status).toBe(401);
    const user = await member('ordinary', ['chess']);
    const token = await issueToken(user.id, 0, testEnvironment());
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    try {
      expect((await request(app).get(path).auth(token, { type: 'bearer' })).status).toBe(403);
      expect(aggregate).not.toHaveBeenCalled();
      expect((await get()).status).toBe(200);
      await models.User.updateOne({ _id: admin.id }, { $set: { role: 'user' } });
      expect((await get()).status).toBe(403);
      expect(aggregate).toHaveBeenCalledTimes(1);
      await models.User.updateOne({ _id: user._id }, { $set: { role: 'admin' } });
      expect((await request(app).get(path).auth(token, { type: 'bearer' })).status).toBe(200);
    } finally { aggregate.mockRestore(); }
  });

  it('returns an empty page for users with no interests and for a completely empty database', async () => {
    await member('empty');
    expect((await get()).body).toEqual(empty);
    await models.User.deleteMany({});
    expect(await createInterestService(connection, 5000).list({})).toEqual(empty);
  });

  it('counts each normalized membership once and includes every interest of a user', async () => {
    const a = await member('a', [' Chess ', 'chess', ' Reading ']);
    const b = await member('b', ['CHESS', 'music']);
    await member('none');
    expect((await models.User.findById(a._id))!.interests).toEqual(['chess', 'reading']);
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [
        { interest: 'chess', userCount: 2, usersPreview: [{ id: b.id, name: 'b' }, { id: a.id, name: 'a' }], hasMoreUsers: false },
        { interest: 'music', userCount: 1, usersPreview: [{ id: b.id, name: 'b' }], hasMoreUsers: false },
        { interest: 'reading', userCount: 1, usersPreview: [{ id: a.id, name: 'a' }], hasMoreUsers: false }
      ], pagination: empty.pagination
    });
  });

  it('excludes earlier memberships on cursor pages while preserving complete counts and previews', async () => {
    const mixed = await member('mixed', ['art', 'chess', 'reading']);
    const later = await member('later', ['reading']);
    await member('earlier', ['art', 'chess']);
    const response = await get({ cursor: encodeCursor(cursorScopes.interests, 'interest', 'chess') });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([{
      interest: 'reading', userCount: 2,
      usersPreview: [later, mixed].sort((a, b) => b.id.localeCompare(a.id))
        .map((user) => ({ id: user.id, name: user.name })),
      hasMoreUsers: false
    }]);
    expect(response.body.pagination.hasMore).toBe(false);
    expect((await get({ cursor: encodeCursor(cursorScopes.interests, 'interest', 'zebra') })).body).toEqual(empty);
  });

  it('uses the interests index to avoid reading irrelevant users on a selective cursor page', async () => {
    await models.User.insertMany(Array.from({ length: 1000 }, (_, i) => ({
      name: `Fixture ${i}`, email: `fixture${i}@example.test`, passwordHash: 'private-test-hash',
      interests: i < 990 ? ['art', 'chess'] : ['art', 'zebra']
    })));
    const page = interestPage({ cursor: encodeCursor(cursorScopes.interests, 'interest', 'y') });
    // Unhinted production query, with enough irrelevant users to make the range selective.
    const explain = await models.User.collection.aggregate(interestPipeline(page), interestAggregateOptions(5000))
      .explain('executionStats');
    const cursor = explain.stages?.find((stage: Record<string, unknown>) => stage.$cursor)?.$cursor;
    const execution = cursor ?? explain;
    expect(JSON.stringify(execution.queryPlanner.winningPlan)).toContain('users_interests_asc');
    expect(execution.executionStats.totalDocsExamined).toBeLessThanOrEqual(10);
    const result = await get({ cursor: encodeCursor(cursorScopes.interests, 'interest', 'y') });
    expect(result.body.data).toMatchObject([{ interest: 'zebra', userCount: 10, hasMoreUsers: true }]);
    expect(result.body.data).toHaveLength(1);
  });

  it('reflects normalized profile updates in the report without duplicate membership', async () => {
    const user = await member('profile', ['old']);
    const token = await issueToken(user.id, 0, testEnvironment());
    const updated = await request(app).patch('/api/auth/me').auth(token, { type: 'bearer' })
      .send({ interests: [' Chess ', 'chess', ' READING '] });
    expect(updated.status).toBe(200);
    expect(updated.body.data.interests).toEqual(['chess', 'reading']);
    const response = await get();
    expect(response.body.data.map((row: { interest: string; userCount: number }) => [row.interest, row.userCount]))
      .toEqual([['chess', 1], ['reading', 1]]);
  });

  it('bounds large previews, orders them by descending ID, and handles exactly five members', async () => {
    const users = [];
    // Insert deliberately out of ID order so top-five selection cannot use insertion order.
    for (const i of [7, 2, 9, 1, 4, 8, 3, 6, 5]) {
      users.push(await member(`member${i}`, ['chess', ...(i <= 5 ? ['five'] : [])], {
        _id: new Types.ObjectId(i.toString(16).padStart(24, '0')), tokenVersion: 12, contentRevision: 34
      }));
    }
    const response = await get();
    expect(response.status).toBe(200);
    const expected = [...users].sort((a, b) => b.id.localeCompare(a.id));
    expect(response.body.data[0]).toEqual({
      interest: 'chess', userCount: 9, usersPreview: expected.slice(0, 5).map((u) => ({ id: u.id, name: u.name })), hasMoreUsers: true
    });
    expect(response.body.data[1]).toEqual({
      interest: 'five', userCount: 5,
      usersPreview: expected.filter((u) => u.interests.includes('five')).map((u) => ({ id: u.id, name: u.name })), hasMoreUsers: false
    });
    for (const group of response.body.data) {
      expect(Object.keys(group).sort()).toEqual(['interest', 'userCount', 'usersPreview', 'hasMoreUsers'].sort());
      for (const user of group.usersPreview) expect(Object.keys(user).sort()).toEqual(['id', 'name']);
    }
    for (const secret of ['passwordHash', 'private-test-hash', 'email', 'role', 'tokenVersion', 'contentRevision']) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
  });

  it('traverses complete groups in binary order with exact counts and last-returned cursors', async () => {
    const interests = ['zebra', 'chess', 'reading', 'échecs', 'বাংলা', '😀', '\uffff'];
    await member('multi', interests);
    await member('also', ['chess', '😀']);
    const expected = [...interests].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const limit of [1, 2, 3, 100]) {
      const seen: string[] = []; let cursor: string | null = null;
      do {
        const response: Response = await get({ limit, ...(cursor ? { cursor } : {}) });
        expect(response.status).toBe(200);
        expect(response.body.data.length).toBeLessThanOrEqual(limit);
        for (const group of response.body.data) {
          seen.push(group.interest);
          expect(group.userCount).toBe(['chess', '😀'].includes(group.interest) ? 2 : 1);
          expect(group.usersPreview).toHaveLength(group.userCount);
        }
        expect(response.body.pagination.hasMore).toBe(response.body.pagination.nextCursor !== null);
        cursor = response.body.pagination.nextCursor;
        if (cursor) expect(decodeCursor(cursor, cursorScopes.interests, 'interest')).toBe(response.body.data.at(-1).interest);
      } while (cursor);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(interests.length);
    }
    const exhausted = await get({ cursor: encodeCursor(cursorScopes.interests, 'interest', expected.at(-1)!) });
    expect(exhausted.body).toEqual(empty);
  });

  it('rejects invalid limits, unsupported fields, malformed and cross-scope cursors before aggregation', async () => {
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    try {
      for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=1&limit=2', 'cursor=', 'cursor=garbage', 'sort=name', 'interest=chess', 'cursor[x]=chess']) {
        expect((await request(app).get(`${path}?${query}`).auth(admin.token, { type: 'bearer' })).status).toBe(400);
      }
      const cursors = [
        encodeCursor(cursorScopes.posts, 'objectId', admin.id.toHexString()),
        encodeCursor(cursorScopes.users, 'objectId', admin.id.toHexString()),
        encodeCursor(cursorScopes.interests, 'objectId', admin.id.toHexString()),
        ...[' Chess ', '', 'x'.repeat(41)].map((key) => Buffer.from(JSON.stringify({ v: 1, scope: cursorScopes.interests, kind: 'interest', key })).toString('base64url'))
      ];
      for (const cursor of cursors) {
        const response = await get({ cursor });
        expect(response.status).toBe(400); expect(response.body.error.code).toBe('INVALID_CURSOR');
      }
      expect(aggregate).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); }
    const cursor = encodeCursor(cursorScopes.interests, 'interest', 'chess');
    const response = await request(app).get('/api/admin/users').query({ cursor }).auth(admin.token, { type: 'bearer' });
    expect(response.status).toBe(400); expect(response.body.error.code).toBe('INVALID_CURSOR');
  });

  it('makes exactly one native aggregate per report page with bounded topN and no fallback reads', async () => {
    await member('one', ['chess', 'music', 'reading']);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    const forbidden = [vi.spyOn(models.User, 'find'), vi.spyOn(models.User, 'findOne'), vi.spyOn(models.User, 'findById'),
      vi.spyOn(models.User, 'distinct'), vi.spyOn(models.User, 'countDocuments'), vi.spyOn(models.User, 'aggregate'),
      vi.spyOn(models.User, 'populate'), vi.spyOn(models.User.collection, 'find'), vi.spyOn(models.User.collection, 'findOne'),
      vi.spyOn(models.User.collection, 'distinct'), vi.spyOn(models.User.collection, 'countDocuments')];
    try {
      const repository = createInterestRepository(connection, 4321);
      const page = interestPage({ limit: '1', cursor: encodeCursor(cursorScopes.interests, 'interest', 'chess') });
      const rows = await repository.list(page);
      expect(rows.map((row) => row.interest)).toEqual(['music', 'reading']);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]).toEqual([[
        { $match: { interests: { $gt: 'chess' } } }, { $unwind: '$interests' },
        { $match: { interests: { $gt: 'chess' } } },
        { $group: { _id: '$interests', userCount: { $sum: 1 }, usersPreview: {
          $topN: { n: 5, sortBy: { _id: -1 }, output: { id: '$_id', name: '$name' } }
        } } },
        { $sort: { _id: 1 } }, { $limit: 2 },
        { $project: { _id: 0, interest: '$_id', userCount: 1, usersPreview: 1, hasMoreUsers: { $gt: ['$userCount', 5] } } }
      ], { allowDiskUse: true, maxTimeMS: 4321, collation: { locale: 'simple' } }]);
      expect(Object.keys(rows[0]!).sort()).toEqual(['interest', 'userCount', 'usersPreview', 'hasMoreUsers'].sort());
      expect(Object.keys(rows[0]!.usersPreview[0]!).sort()).toEqual(['id', 'name']);
      for (const spy of forbidden) expect(spy).not.toHaveBeenCalled();
      aggregate.mockClear();
      expect(await repository.list(interestPage({ limit: '1' }))).toHaveLength(2);
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]![0]).not.toContainEqual({ $match: { _id: { $gt: 'chess' } } });
    } finally { aggregate.mockRestore(); forbidden.forEach((spy) => spy.mockRestore()); }
  });

  it('keeps authentication separate: one current-user read plus one report aggregate per HTTP request', async () => {
    await member('one', ['chess']);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate');
    const accountRead = vi.spyOn(models.User, 'findById');
    try {
      const response = await get(); expect(response.status).toBe(200);
      expect(aggregate).toHaveBeenCalledTimes(1); expect(accountRead).toHaveBeenCalledTimes(1);
      expect(aggregate.mock.calls[0]![1]).toEqual({ allowDiskUse: true, maxTimeMS: 4321, collation: { locale: 'simple' } });
    } finally { aggregate.mockRestore(); accountRead.mockRestore(); }
  });

  it('returns sanitized 503 for report budget exhaustion while consuming its cursor', async () => {
    const original = models.User.collection.aggregate.bind(models.User.collection);
    const aggregate = vi.spyOn(models.User.collection, 'aggregate').mockImplementationOnce((...args) => {
      const cursor = original(...args);
      vi.spyOn(cursor, 'toArray').mockImplementationOnce(async () => {
        await cursor.close(); throw Object.assign(new Error('private database budget details'), { code: 50 });
      });
      return cursor;
    });
    try {
      const response = await get();
      expect(response.status).toBe(503); expect(response.body.error.code).toBe('REPORT_TIMEOUT');
      expect(response.body.error.requestId).toBe(response.headers['x-request-id']);
      expect(JSON.stringify(response.body)).not.toContain('private');
      expect(response.body).not.toHaveProperty('data');
    } finally { aggregate.mockRestore(); }
  });

  it('uses central sanitized database/unexpected errors and preserves the index inventory', async () => {
    for (const [name, status, code] of [['MongoNetworkError', 503, 'DATABASE_UNAVAILABLE'], ['Error', 500, 'INTERNAL_ERROR']] as const) {
      const error = new Error('private server connection'); error.name = name;
      const aggregate = vi.spyOn(models.User.collection, 'aggregate').mockImplementationOnce(() => { throw error; });
      try {
        const response = await get();
        expect(response.status).toBe(status); expect(response.body.error.code).toBe(code);
        expect(JSON.stringify(response.body)).not.toContain('private');
      } finally { aggregate.mockRestore(); }
    }
    await verifyIndexes(connection);
  });
});
