import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createConnection, Types } from 'mongoose';
import { ensureIndexes } from '../src/config/indexes.js';
import { getModels } from '../src/config/models.js';
import { encodeCursor } from '../src/shared/cursor.js';
import { noteDetailProjection, noteSummaryProjection, postProjection, userProjection } from '../src/shared/dto.js';
import { cursorScopes, objectIdPage, ownNotesPage } from '../src/shared/pagination.js';
import { saveEvidence } from './query-evidence.js';

// This command never reads MONGODB_URI. Production read builders/projections
// are measured unhinted on a clean, synthetic, disposable replica set.
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.34' }, replSet: { count: 1, storageEngine: 'wiredTiger' }
});
const databaseName = `notes_explain_${randomUUID().replaceAll('-', '')}`;
const connection = createConnection(replica.getUri(databaseName), { autoIndex: false, autoCreate: false });
// Match connectDatabase's configured query deadline, including authentication.
connection.set('maxTimeMS', 5000);
try {
  await connection.asPromise();
  await ensureIndexes(connection);
  const { User, Note, Post } = getModels(connection);
  const users = await User.insertMany(Array.from({ length: 200 }, (_, i) => ({
    name: `Fixture ${i}`, email: `fixture${i}@example.test`, passwordHash: 'synthetic-unused-hash'
  })));
  for (let i = 0; i < 200; i++) {
    const user = users[i]!;
    const content = Array.from({ length: 80 }, (_, j) => ({
      _id: new Types.ObjectId((j * 200 + i + 1).toString(16).padStart(24, '0')),
      title: `Fixture ${j}`
    }));
    await Note.insertMany(content.map(row => ({ ...row, ownerId: user._id, content: 'Synthetic private content' })));
    await Post.insertMany(content.map(row => ({ ...row, authorId: user._id, body: 'Synthetic shared body' })));
  }
  const target = users[0]!;
  const noteId = new Types.ObjectId((40 * 200 + 1).toString(16).padStart(24, '0'));
  const cases: Record<string, unknown> = {
    login: await User.findOne({ email: target.email }).select('+passwordHash +tokenVersion').explain('executionStats'),
    currentUser: await User.findById(target._id).select('+tokenVersion').lean().explain('executionStats'),
    adminUserDetail: await User.findById(target._id).select(userProjection).maxTimeMS(5000).lean().explain('executionStats'),
    ownNoteDetail: await Note.findOne({ _id: noteId, ownerId: target._id }).select(noteDetailProjection)
      .maxTimeMS(5000).lean().explain('executionStats'),
    inaccessibleNote: await Note.findOne({ _id: noteId, ownerId: users[1]!._id }).select(noteDetailProjection)
      .maxTimeMS(5000).lean().explain('executionStats'),
    adminNoteDetail: await Note.findOne({ _id: noteId }).select(noteDetailProjection)
      .maxTimeMS(5000).lean().explain('executionStats'),
    // Read-only explains of cascade equality prefixes; never perform deletes.
    cascadeNotesPredicate: await Note.find({ ownerId: target._id }).lean().explain('executionStats'),
    cascadePostsPredicate: await Post.find({ authorId: target._id }).lean().explain('executionStats')
  };
  for (const [name, after] of [['first', undefined], ['cursor', noteId]] as const) {
    const query = { limit: '20', ...(after ? {
      cursor: encodeCursor(cursorScopes.ownNotes(target._id), 'objectId', after.toHexString())
    } : {}) };
    const own = ownNotesPage(query, target._id);
    const global = objectIdPage({ limit: '20', ...(after ? {
      cursor: encodeCursor(cursorScopes.adminNotes, 'objectId', after.toHexString())
    } : {}) }, cursorScopes.adminNotes);
    const adminUsers = objectIdPage({ limit: '20', ...(after ? {
      cursor: encodeCursor(cursorScopes.users, 'objectId', users[100]!._id.toHexString())
    } : {}) }, cursorScopes.users);
    cases[`ownNotes.${name}`] = await Note.find(own.predicate).select(noteSummaryProjection)
      .sort(own.sort).limit(own.fetchLimit).maxTimeMS(5000).lean().explain('executionStats');
    cases[`adminUsers.${name}`] = await User.find(adminUsers.predicate).select(userProjection)
      .sort(adminUsers.sort).limit(adminUsers.fetchLimit).maxTimeMS(5000).lean().explain('executionStats');
    cases[`adminNotes.${name}`] = await Note.find(global.predicate).select(noteSummaryProjection)
      .sort(global.sort).limit(global.fetchLimit).maxTimeMS(5000).lean().explain('executionStats');
    cases[`globalPosts.${name}`] = await Post.find(global.predicate).select(postProjection)
      .sort(global.sort).limit(global.fetchLimit).maxTimeMS(5000).lean().explain('executionStats');
  }
  const indexes: Record<string, unknown> = {};
  for (const model of [User, Note, Post]) indexes[model.collection.collectionName] = await model.collection.listIndexes().toArray();
  const build = await connection.db!.admin().command({ buildInfo: 1 });
  await saveEvidence('reads', databaseName, {
    recordedAt: new Date().toISOString(), mongodbVersion: build.version,
    fixtures: { users: 200, notes: 16000, posts: 16000, notesPerOwner: 80, postsPerAuthor: 80,
      distribution: 'Content IDs interleave all 200 owners/authors. Cursor selects midway through the target account and global content; admin-user cursor selects midway through users.',
      limit: 20, fetchLimit: 21 },
    notes: 'Unhinted Mongoose read shapes matching services and authentication, including actual selected/excluded fields. Explain commands record filters, projection, sort, limit and options. Prefix cascade cases are read-only find equivalents, not delete execution plans. No latency thresholds.',
    indexes, cases
  });
} finally {
  try { await connection.close(); } finally { await replica.stop(); }
}
