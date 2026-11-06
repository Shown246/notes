import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';
import { parseEnvironment } from '../src/config/env.js';
import { decodeCursor, encodeCursor, pageFromRows } from '../src/shared/cursor.js';
import { listQuerySchema, parseInput, parseObjectId } from '../src/shared/validation.js';
import { toUserDto } from '../src/shared/dto.js';

const valid = {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/notes_dev?replicaSet=rs0',
  JWT_SECRET: 'a-long-generated-secret-for-test-only'
};

describe('configuration boundary', () => {
  it('accepts dedicated local and hosted replica-set configuration with bounded defaults', () => {
    expect(parseEnvironment(valid)).toMatchObject({ PORT: 3000, JWT_TTL_SECONDS: 900 });
    expect(parseEnvironment({ ...valid, MONGODB_URI: 'mongodb+srv://user:password@example.test/notes_hosted' }).PORT).toBe(3000);
  });
  it.each([
    { JWT_SECRET: '' }, { PORT: '0' }, { PORT: '65536' }, { PORT: '' },
    { NODE_ENV: 'staging' }, { JWT_TTL_SECONDS: '3601' },
    { MONGODB_URI: 'mongodb://localhost' }, { MONGODB_URI: 'mongodb://localhost/admin' },
    { MONGODB_URI: 'https://localhost/notes_dev' }
  ])('rejects invalid configuration without exposing values: %j', (change) => {
    expect(() => parseEnvironment({ ...valid, ...change })).toThrow('Invalid configuration fields:');
  });
  it('reports field names without echoing sensitive configuration', () => {
    try { parseEnvironment({ MONGODB_URI: 'mongodb://user:private@localhost/', JWT_SECRET: 'private' }); }
    catch (error) {
      expect(String(error)).toContain('MONGODB_URI');
      expect(String(error)).toContain('JWT_SECRET');
      expect(String(error)).not.toContain('private');
      return;
    }
    throw new Error('Expected configuration rejection');
  });
});

describe('strict request parsing', () => {
  it('rejects operator objects and malformed ObjectIds before database access', () => {
    const id = new Types.ObjectId();
    expect(parseObjectId(id.toHexString()).equals(id)).toBe(true);
    for (const input of ['not-an-id', { $ne: null }, 123, 'a'.repeat(25)]) {
      expect(() => parseObjectId(input)).toThrow('Request validation failed');
    }
  });
  it('bounds limits and rejects duplicate/unknown query values', () => {
    expect(parseInput(listQuerySchema, {})).toEqual({ limit: 20 });
    expect(parseInput(listQuerySchema, { limit: '100' })).toEqual({ limit: 100 });
    for (const value of [{ limit: '101' }, { limit: '0' }, { limit: ['1', '2'] }, { sort: '_id' }, { limit: '1.5' }]) {
      expect(() => parseInput(listQuerySchema, value)).toThrow('Request validation failed');
    }
  });
});

describe('cursor contract', () => {
  const id = new Types.ObjectId().toHexString();
  it('roundtrips typed owner-scoped and interest cursors', () => {
    expect(decodeCursor(encodeCursor('notes:owner-a', 'objectId', id), 'notes:owner-a', 'objectId')).toBe(id);
    expect(decodeCursor(encodeCursor('interests', 'interest', 'দাবা'), 'interests', 'interest')).toBe('দাবা');
  });
  it('rejects scope changes, malformed encodings, oversized payloads and extra fields', () => {
    const validCursor = encodeCursor('notes:owner-a', 'objectId', id);
    const invalid = [validCursor, '!', 'a'.repeat(2049),
      Buffer.from(JSON.stringify({ v: 2, scope: 'notes:owner-b', kind: 'objectId', key: id })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, scope: 'notes:owner-b', kind: 'objectId', key: { $ne: null } })).toString('base64url'),
      Buffer.from(JSON.stringify({ v: 1, scope: 'notes:owner-b', kind: 'objectId', key: id, role: 'admin' })).toString('base64url')];
    for (const token of invalid) expect(() => decodeCursor(token, 'notes:owner-b', 'objectId')).toThrow('Invalid pagination cursor');
    expect(() => decodeCursor(validCursor, 'notes:owner-a', 'interest')).toThrow('Invalid pagination cursor');
  });
  it('uses the last returned row, not lookahead, for the next cursor', () => {
    const rows = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()].map(String);
    const page = pageFromRows(rows, 2, 'users', 'objectId', (row) => row);
    expect(page.data).toEqual(rows.slice(0, 2));
    expect(page.pagination.hasMore).toBe(true);
    expect(decodeCursor(page.pagination.nextCursor!, 'users', 'objectId')).toBe(rows[1]);
    expect(pageFromRows([], 20, 'users', 'objectId', String).pagination).toEqual({ limit: 20, hasMore: false, nextCursor: null });
    expect(pageFromRows(rows, 3, 'users', 'objectId', String).pagination.nextCursor).toBeNull();
  });
});

it('serializes only allowed user fields', () => {
  const user = {
    _id: new Types.ObjectId(), name: 'Test', email: 'test@example.test', role: 'user' as const,
    interests: ['chess'], createdAt: new Date(), updatedAt: new Date(),
    passwordHash: 'never-send', tokenVersion: 10, contentRevision: 50
  };
  expect(Object.keys(toUserDto(user)).sort()).toEqual(['id', 'name', 'email', 'role', 'interests', 'createdAt', 'updatedAt'].sort());
});
