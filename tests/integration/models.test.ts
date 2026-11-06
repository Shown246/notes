import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes, verifyIndexes } from '../../src/config/indexes.js';
import { startServer } from '../../src/server.js';
import { testConnection, testEnvironment } from '../helpers/database.js';
import { cursorScopes, objectIdPage, ownNotesPage, authorPostsPage } from '../../src/shared/pagination.js';
import { pageFromRows } from '../../src/shared/cursor.js';
import { toUserDto, userProjection, noteSummaryProjection, noteDetailProjection,
  postProjection, toNoteDto, toNoteSummaryDto, toPostDto, toUserPreviewDto } from '../../src/shared/dto.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
const account = (email = 'member@example.test') => ({ name: ' Member ', email, passwordHash: 'test-only-encoded-hash' });

beforeAll(async () => {
  connection = await testConnection();
  models = getModels(connection);
  await ensureIndexes(connection);
});
beforeEach(async () => {
  await models.User.deleteMany({});
  await models.Note.deleteMany({});
  await models.Post.deleteMany({});
});
afterAll(async () => { await connection?.close(); });

describe('index lifecycle', () => {
  it('installs exactly seven indexes idempotently from the schema declarations', async () => {
    await ensureIndexes(connection);
    const inventory = [];
    for (const model of Object.values(models)) {
      const indexes = await model.collection.listIndexes().toArray();
      expect(indexes).toHaveLength(model.collection.name === 'users' ? 3 : 2);
      inventory.push(...indexes.map((index) => `${model.collection.name}.${index.name}`));
    }
    expect(inventory.sort()).toEqual([
      'notes._id_', 'notes.notes_owner_id_desc', 'posts._id_', 'posts.posts_author_id_desc',
      'users._id_', 'users.users_email_unique', 'users.users_interests_asc'
    ]);
    expect(models.User.schema.indexes()).toEqual([
      [{ email: 1 }, { unique: true, name: 'users_email_unique' }],
      [{ interests: 1 }, { name: 'users_interests_asc' }]
    ]);
    expect(models.Note.schema.indexes()).toEqual([[{ ownerId: 1, _id: -1 }, { name: 'notes_owner_id_desc' }]]);
    expect(models.Post.schema.indexes()).toEqual([[{ authorId: 1, _id: -1 }, { name: 'posts_author_id_desc' }]]);
  });
  it('refuses startup until uniqueness is installed and never removes unexpected indexes', async () => {
    await models.User.collection.dropIndex('users_email_unique');
    try {
      await expect(startServer({ ...testEnvironment(), PORT: 0 })).rejects.toThrow();
    } finally { await ensureIndexes(connection); }
    await models.User.collection.createIndex({ role: 1 }, { name: 'unexpected_role' });
    try {
      await expect(ensureIndexes(connection)).rejects.toThrow('Unexpected index inventory');
      expect((await models.User.collection.listIndexes().toArray()).some((index) => index.name === 'unexpected_role')).toBe(true);
    } finally { await models.User.collection.dropIndex('unexpected_role'); }
    await verifyIndexes(connection);
  });
  it('runs the actual explicit index command successfully', async () => {
    const env = testEnvironment();
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../scripts/ensure-indexes.ts', import.meta.url))], {
      env: { ...process.env, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)])), DOTENV_CONFIG_PATH: '.nonexistent-test-env' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const [code] = await once(child, 'exit');
    expect(code, output).toBe(0);
    expect(output).toContain('Verified three built-in and four custom indexes');
  });
});

describe('storage invariants', () => {
  it('normalizes every supported model write and enforces email uniqueness in MongoDB', async () => {
    const user = await models.User.create({ ...account(' Person+tag@Example.TEST '), interests: [' Chess ', 'chess', 'READING'] });
    expect(user).toMatchObject({ name: 'Member', email: 'person+tag@example.test', interests: ['chess', 'reading'], role: 'user', tokenVersion: 0, contentRevision: 0 });
    await expect(models.User.create(account('PERSON+tag@example.test'))).rejects.toMatchObject({ code: 11000 });
    await models.User.updateOne({ _id: user._id }, { $set: { email: ' Changed@Example.Test ', interests: [' Coding ', 'coding'] } });
    expect(await models.User.findById(user._id).lean()).toMatchObject({ email: 'changed@example.test', interests: ['coding'] });
    await models.User.findOneAndUpdate({ _id: user._id }, { interests: [' Music ', 'music'] });
    expect((await models.User.findById(user._id))!.interests).toEqual(['music']);
    await models.User.insertMany([{ ...account(' Seed@Example.Test '), interests: [' Art ', 'ART'] }]);
    expect((await models.User.findOne({ email: 'seed@example.test' }))!.interests).toEqual(['art']);
    const document = (await models.User.findById(user._id))!;
    document.interests.push(' MUSIC ', ' Chess ');
    await document.save();
    expect(document.interests).toEqual(['music', 'chess']);
    await expect(models.User.updateOne({ email: 'seed@example.test' }, { $set: { email: ' CHANGED@EXAMPLE.TEST ' } })).rejects.toMatchObject({ code: 11000 });
  });
  it('rejects invalid user bounds and update operations that bypass normalization', async () => {
    const invalid: Record<string, unknown>[] = [
      { name: ' ' }, { name: 'a'.repeat(101) }, { email: 'invalid' }, { passwordHash: '' },
      { role: 'root' }, { interests: [' '] }, { interests: ['a'.repeat(41)] },
      { interests: Array.from({ length: 11 }, (_, i) => String(i)) }, { interests: 'chess' },
      { tokenVersion: -1 }, { tokenVersion: 1.5 }, { contentRevision: 1.5 }, { interests: null }
    ];
    for (const fields of invalid) await expect(models.User.create({ ...account(), ...fields }), JSON.stringify(fields)).rejects.toThrow();
    const user = await models.User.create(account());
    for (const update of [
      { $set: { interests: [''] } }, { $set: { role: 'root' } }, { $push: { interests: ' Chess ' } },
      { $set: { 'interests.0': ' Chess ' } }, { $inc: { tokenVersion: 0.5 } }, { $unset: { name: 1 } }
    ]) await expect(models.User.updateOne({ _id: user._id }, update)).rejects.toThrow();
    await expect(models.User.updateOne({}, [{ $set: { interests: [' Chess '] } }], { updatePipeline: true })).rejects.toThrow('Update pipelines');
    await expect(models.User.bulkWrite([{ updateOne: { filter: {}, update: { $set: { interests: [' Chess '] } } } }])).rejects.toThrow('instead of bulkWrite');
  });
  it('enforces note/post bounds, timestamps, references, and immutable ownership', async () => {
    const ownerId = new Types.ObjectId();
    const note = await models.Note.create({ ownerId, title: ' Title ', content: '' });
    expect(note.title).toBe('Title');
    expect(note.createdAt).toBeInstanceOf(Date);
    await models.Note.updateOne({ _id: note._id }, { $set: { ownerId: new Types.ObjectId(), content: 'a'.repeat(20_000) } });
    expect((await models.Note.findById(note._id))!.ownerId.equals(ownerId)).toBe(true);
    const invalidNotes: Record<string, unknown>[] = [{ ownerId: null }, { title: ' ' }, { title: 'a'.repeat(201) }, { content: null }, { content: 'a'.repeat(20_001) }];
    for (const fields of invalidNotes) {
      await expect(models.Note.create({ ownerId, title: 'Title', ...fields })).rejects.toThrow();
    }
    await expect(models.Note.updateOne({ _id: note._id }, { $unset: { content: 1 } })).rejects.toThrow();
    await expect(models.Note.updateOne({ _id: note._id }, { $set: { content: 'a'.repeat(20_001) } })).rejects.toThrow();
    await models.Post.create({ authorId: ownerId, title: 'Title', body: 'a'.repeat(10_000) });
    const invalidPosts: Record<string, unknown>[] = [{ authorId: null }, { title: '' }, { title: 'a'.repeat(201) }, { body: '' }, { body: 'a'.repeat(10_001) }];
    for (const fields of invalidPosts) {
      await expect(models.Post.create({ authorId: ownerId, title: 'Title', body: 'Body', ...fields })).rejects.toThrow();
    }
  });
});

it('traverses each ordinary list with descending ids, lookahead and owner/author isolation', async () => {
  const users = await models.User.insertMany(Array.from({ length: 7 }, (_, i) => account(`user${i}@example.test`)));
  const owner = users[0]!._id;
  const other = users[1]!._id;
  await models.Note.insertMany(Array.from({ length: 13 }, (_, i) => ({ ownerId: i % 2 ? owner : other, title: `Note ${i}` })));
  await models.Post.insertMany(Array.from({ length: 13 }, (_, i) => ({ authorId: i % 2 ? owner : other, title: `Post ${i}`, body: 'Body' })));
  const cases = [
    { model: models.User, page: (query: unknown) => objectIdPage(query, cursorScopes.users) },
    { model: models.Note, page: (query: unknown) => objectIdPage(query, cursorScopes.adminNotes) },
    { model: models.Post, page: (query: unknown) => objectIdPage(query, cursorScopes.posts) },
    { model: models.Note, page: (query: unknown) => ownNotesPage(query, owner) },
    { model: models.Post, page: (query: unknown) => authorPostsPage(query, owner) }
  ];
  for (const { model, page: build } of cases) {
    // Native reads share exactly the same ObjectId predicates as Mongoose and lookup builders.
    const expected = await model.collection.find(build({}).predicate).sort({ _id: -1 }).toArray();
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ReturnType<typeof objectIdPage> = build({ limit: '2', ...(cursor ? { cursor } : {}) });
      const rows = await model.collection.find(page.predicate).sort(page.sort).limit(page.fetchLimit).toArray();
      const result = pageFromRows(rows, page.limit, page.scope, 'objectId', (row) => row._id.toString());
      seen.push(...result.data.map((row) => row._id.toString()));
      cursor = result.pagination.nextCursor;
      if (cursor) {
        expect(() => ownNotesPage({ cursor }, other)).toThrow('Invalid pagination cursor');
        expect(() => authorPostsPage({ cursor }, other)).toThrow('Invalid pagination cursor');
      }
    } while (cursor);
    expect(seen).toEqual(expected.map((row) => row._id.toString()));
    expect(new Set(seen).size).toBe(seen.length);
  }
});

it('projects and serializes only safe fields, including native aggregation reads', async () => {
  const user = await models.User.create(account());
  const ordinary = (await models.User.findById(user._id).lean())!;
  for (const key of ['passwordHash', 'tokenVersion', 'contentRevision']) expect(ordinary).not.toHaveProperty(key);
  const [row] = await models.User.collection.aggregate([{ $match: { _id: user._id } }, { $project: userProjection }]).toArray();
  expect(Object.keys(row!).sort()).toEqual(Object.keys(userProjection).sort());
  expect(toUserDto(user)).toEqual(toUserDto(row as typeof user));
  expect(toUserPreviewDto(user)).toEqual({ id: user.id, name: 'Member' });
  const note = await models.Note.create({ ownerId: user._id, title: 'Title', content: 'Private' });
  const summary = (await models.Note.findById(note._id, noteSummaryProjection).lean())!;
  expect(summary).not.toHaveProperty('content');
  expect(toNoteSummaryDto(note)).not.toHaveProperty('content');
  expect(toNoteDto((await models.Note.findById(note._id, noteDetailProjection).lean())!).content).toBe('Private');
  const post = await models.Post.create({ authorId: user._id, title: 'Title', body: 'Body' });
  expect(toPostDto((await models.Post.findById(post._id, postProjection).lean())!)).toMatchObject({ id: post.id, authorId: user.id, body: 'Body' });
});
