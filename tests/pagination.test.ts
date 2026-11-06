import express from 'express';
import request from 'supertest';
import { pino } from 'pino';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, pageFromRows } from '../src/shared/cursor.js';
import { cursorScopes, interestPage, objectIdPage, ownNotesPage, authorPostsPage } from '../src/shared/pagination.js';
import { errorHandler } from '../src/middleware/errors.js';
import { toInterestGroupDto } from '../src/shared/dto.js';
import { emailSchema, interestsSchema } from '../src/shared/normalization.js';

describe('normalization policy', () => {
  it('preserves email plus suffixes/dots and validates normalized interest limits', () => {
    expect(emailSchema.parse(' A.B+tag@Example.TEST ')).toBe('a.b+tag@example.test');
    expect(interestsSchema.parse(Array.from({ length: 11 }, () => ' Chess '))).toEqual(['chess']);
    expect(interestsSchema.parse(['a'.repeat(40)])).toEqual(['a'.repeat(40)]);
    for (const value of [[''], [' '], ['a'.repeat(41)], ['valid', 5], null]) {
      expect(interestsSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('page contracts', () => {
  it('uses strict descending ObjectId predicates and distinct route/owner/author scopes', () => {
    const id = new Types.ObjectId();
    const owner = new Types.ObjectId();
    const token = encodeCursor(cursorScopes.ownNotes(owner), 'objectId', id.toHexString());
    const page = ownNotesPage({ limit: '1', cursor: token }, owner);
    expect(page).toMatchObject({ limit: 1, fetchLimit: 2, sort: { _id: -1 }, predicate: { ownerId: owner, _id: { $lt: id } } });
    expect(() => authorPostsPage({ cursor: token }, owner)).toThrow('Invalid pagination cursor');
    expect(() => objectIdPage({ cursor: token }, cursorScopes.adminNotes)).toThrow('Invalid pagination cursor');
    expect(objectIdPage({}, cursorScopes.posts)).toMatchObject({ predicate: {}, limit: 20, fetchLimit: 21 });
  });
  it('validates binary interest keys and bounded report lookahead', () => {
    const token = encodeCursor(cursorScopes.interests, 'interest', 'chess');
    expect(interestPage({ cursor: token, limit: '100' })).toMatchObject({ afterInterest: 'chess', fetchLimit: 101 });
    expect(interestPage({}).afterInterest).toBeUndefined();
    const page = pageFromRows(['art', 'chess', 'reading'], 2, cursorScopes.interests, 'interest', String);
    expect(interestPage({ cursor: page.pagination.nextCursor }).afterInterest).toBe('chess');
    for (const key of ['', ' Chess', 'CHESS', 'a'.repeat(41)]) {
      const bad = Buffer.from(JSON.stringify({ v: 1, scope: cursorScopes.interests, kind: 'interest', key })).toString('base64url');
      expect(() => interestPage({ cursor: bad })).toThrow('Invalid pagination cursor');
    }
  });
  it('rejects malformed UTF-8, excessive decoded bytes and invalid ObjectId keys', () => {
    const oversized = Buffer.from(JSON.stringify({ v: 1, scope: cursorScopes.posts, kind: 'objectId', key: 'a'.repeat(1100) })).toString('base64url');
    const invalidUtf8 = Buffer.concat([Buffer.from('{"v":1,"scope":"admin:reports:users-by-interest","kind":"interest","key":"'), Buffer.from([0xff]), Buffer.from('"}')]).toString('base64url');
    for (const token of [oversized, invalidUtf8, Buffer.from('{"v":1}').toString('base64url')]) {
      expect(() => decodeCursor(token, cursorScopes.interests, 'interest')).toThrow('Invalid pagination cursor');
    }
    expect(() => encodeCursor(cursorScopes.posts, 'objectId', 'not-an-id')).toThrow('Invalid internal cursor value');
    expect(() => pageFromRows([1, 2, 3], 1, cursorScopes.posts, 'objectId', String)).toThrow('Invalid internal page bounds');
  });
  it('returns 400 through the shared HTTP error boundary for invalid and cross-scope cursors', async () => {
    // Test-only route: feature endpoints are introduced in their owning phases.
    const app = express();
    app.set('query parser', 'simple');
    app.get('/page', (req, res) => { res.json(objectIdPage(req.query, cursorScopes.posts)); });
    app.use(errorHandler(pino({ level: 'silent' })));
    const foreign = encodeCursor(cursorScopes.users, 'objectId', new Types.ObjectId().toHexString());
    for (const query of [{ cursor: '!' }, { cursor: foreign }, { limit: '101' }, { sort: 'date' }, { limit: ['1', '2'] }]) {
      const response = await request(app).get('/page').query(query);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('cursor' in query ? 'INVALID_CURSOR' : 'VALIDATION_ERROR');
    }
  });
});

it('allowlists and bounds native report preview DTOs', () => {
  const id = new Types.ObjectId();
  const result = toInterestGroupDto({ interest: 'chess', userCount: 8,
    usersPreview: Array.from({ length: 8 }, () => ({ id, name: 'Member', passwordHash: 'never-send' })) });
  expect(result.usersPreview).toHaveLength(5);
  expect(result.usersPreview[0]).toEqual({ id: id.toHexString(), name: 'Member' });
  expect(result.hasMoreUsers).toBe(true);
});
