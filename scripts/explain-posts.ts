import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createConnection, Types } from 'mongoose';
import { ensureIndexes } from '../src/config/indexes.js';
import { getModels } from '../src/config/models.js';
import { allAuthorPostsPipeline, authorPostsPipeline } from '../src/modules/posts/post.repository.js';
import { encodeCursor } from '../src/shared/cursor.js';
import { postProjection } from '../src/shared/dto.js';
import { cursorScopes, objectIdPage } from '../src/shared/pagination.js';
import { saveEvidence } from './query-evidence.js';

// Reproducible evidence from disposable storage only. Never read MONGODB_URI,
// seed an application database, or print connection strings/credentials.
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.34' }, replSet: { count: 1, storageEngine: 'wiredTiger' }
});
const databaseName = `notes_explain_${randomUUID().replaceAll('-', '')}`;
const connection = createConnection(replica.getUri(databaseName), { autoIndex: false, autoCreate: false });
try {
  await connection.asPromise();
  await ensureIndexes(connection);
  const { User, Post } = getModels(connection);
  const users = await User.insertMany(Array.from({ length: 80 }, (_, i) => ({
    name: `Fixture ${i}`, email: `fixture${i}@example.test`, passwordHash: 'synthetic-unused-hash'
  })));
  const target = users[0]!;
  await Post.insertMany(users.flatMap((user, author) => Array.from({ length: 120 }, (_, i) => ({
    _id: new Types.ObjectId((i * users.length + author + 1).toString(16).padStart(24, '0')),
    authorId: user._id, title: `Fixture post ${i}`, body: 'Synthetic bounded post body'
  }))));
  const after = new Types.ObjectId((60 * users.length + 1).toString(16).padStart(24, '0'));
  const cases: Record<string, unknown> = {};
  const allPipeline = allAuthorPostsPipeline(target._id);
  cases.all = {
    pipeline: allPipeline,
    lookup: await User.collection.aggregate(allPipeline, { maxTimeMS: 5000, allowDiskUse: true }).explain('executionStats'),
    foreign: await Post.collection.find({ authorId: target._id }, { projection: postProjection })
      .sort({ _id: -1 }).maxTimeMS(5000).explain('executionStats')
  };
  for (const [name, cursor] of [['first', undefined], ['cursor', after]] as const) {
    const page = objectIdPage({ limit: '20', ...(cursor ? {
      cursor: encodeCursor(cursorScopes.authorPosts(target._id), 'objectId', cursor.toHexString())
    } : {}) }, cursorScopes.authorPosts(target._id));
    const pipeline = authorPostsPipeline(target._id, page);
    const lookup = await User.collection.aggregate(pipeline, { maxTimeMS: 5000 }).explain('executionStats');
    // Explain the identical foreign predicate/order separately to expose the
    // winning sort/access stages that $lookup's summary does not include.
    const foreign = await Post.collection.find({ authorId: target._id, ...page.predicate }, { projection: postProjection })
      .sort(page.sort).limit(page.fetchLimit).maxTimeMS(5000).explain('executionStats');
    const global = await Post.collection.find(page.predicate, { projection: postProjection })
      .sort(page.sort).limit(page.fetchLimit).maxTimeMS(5000).explain('executionStats');
    cases[name] = { pipeline, lookup, foreign, global };
  }
  const build = await connection.db!.admin().command({ buildInfo: 1 });
  const indexes = {} as Record<string, unknown>;
  for (const model of [User, getModels(connection).Note, Post]) {
    indexes[model.collection.collectionName] = await model.collection.listIndexes().toArray();
  }
  const evidence = {
    recordedAt: new Date().toISOString(), mongodbVersion: build.version,
    fixtures: { users: 80, posts: 9600, postsPerAuthor: 120, limit: 20, fetchLimit: 21 },
    notes: 'Unhinted production pipeline and query shapes. Synthetic disposable replica set; no latency guarantee. Foreign standalone explain supplements actual lookup index/scan statistics.',
    indexes, cases
  };
  await saveEvidence('posts', databaseName, evidence);
} finally {
  try { await connection.close(); } finally { await replica.stop(); }
}
