import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createConnection } from 'mongoose';
import { ensureIndexes, verifyIndexes } from '../src/config/indexes.js';
import { getModels } from '../src/config/models.js';
import { allInterestsPipeline, interestAggregateOptions, interestPipeline, createInterestRepository } from '../src/modules/reports/interest.repository.js';
import { encodeCursor } from '../src/shared/cursor.js';
import { cursorScopes, interestPage } from '../src/shared/pagination.js';
import { saveEvidence } from './query-evidence.js';

// Use disposable storage only; never read application credentials or database
// configuration. These extra measurements/explains do not run in API handlers.
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.34' }, replSet: { count: 1, storageEngine: 'wiredTiger' }
});
const databaseName = `notes_explain_${randomUUID().replaceAll('-', '')}`;
const connection = createConnection(replica.getUri(databaseName), { autoIndex: false, autoCreate: false });
try {
  await connection.asPromise();
  await ensureIndexes(connection);
  const { User } = getModels(connection);
  const fixtureUsers = 12_000;
  // Batches keep fixture construction bounded while still using the normal
  // model normalization/validation path, including duplicate interest inputs.
  for (let start = 0; start < fixtureUsers; start += 1000) {
    await User.insertMany(Array.from({ length: 1000 }, (_, offset) => {
      const i = start + offset;
      return {
        name: `Fixture ${i}`, email: `fixture${i}@example.test`, passwordHash: 'synthetic-unused-hash',
        interests: i % 10 === 0 ? [] : [' Common ', 'common',
          `topic-${String(i % 251).padStart(3, '0')}`, `category-${String(i % 24).padStart(2, '0')}`]
      };
    }));
  }
  const cases: Record<string, unknown> = {};
  const repository = createInterestRepository(connection, 5000);
  const allStarted = performance.now();
  const allRows = await repository.all();
  cases.all = {
    pipeline: allInterestsPipeline(), options: interestAggregateOptions(5000),
    measurement: {
      elapsedMs: Number((performance.now() - allStarted).toFixed(3)),
      groupsFetched: allRows.length, maxUsers: Math.max(0, ...allRows.map(row => row.users.length)),
      memberships: allRows.reduce((total, row) => total + row.userCount, 0)
    },
    explain: await User.collection.aggregate(allInterestsPipeline(), interestAggregateOptions(5000)).explain('executionStats')
  };
  for (const [name, after] of [['first', undefined], ['cursor', 'topic-124'], ['selectiveCursor', 'topic-249']] as const) {
    const page = interestPage({ limit: '20', ...(after === undefined ? {} : {
      cursor: encodeCursor(cursorScopes.interests, 'interest', after)
    }) });
    const pipeline = interestPipeline(page);
    const options = interestAggregateOptions(5000);
    const started = performance.now();
    const rows = await repository.list(page);
    const elapsedMs = Number((performance.now() - started).toFixed(3));
    const explain = await User.collection.aggregate(pipeline, options).explain('executionStats');
    cases[name] = {
      pipeline, options,
      measurement: {
        elapsedMs, groupsFetched: rows.length, maxPreviewUsers: Math.max(0, ...rows.map((row) => row.usersPreview.length)),
        firstInterest: rows[0]?.interest, lastInterest: rows.at(-1)?.interest
      }, explain
    };
  }
  await verifyIndexes(connection);
  const indexes = {} as Record<string, unknown>;
  for (const model of Object.values(getModels(connection))) {
    indexes[model.collection.collectionName] = await model.collection.listIndexes().toArray();
  }
  const build = await connection.db!.admin().command({ buildInfo: 1 });
  const evidence = {
    recordedAt: new Date().toISOString(), mongodbVersion: build.version,
    fixtures: {
      users: fixtureUsers, emptyInterestUsers: 1200, nonemptyInterestUsers: 10_800,
      normalizedMemberships: 32_400, distinctGroups: 276,
      distribution: 'Each nonempty user has common, one of 251 topics, and one of 24 categories. Duplicate raw common entries normalize before storage.',
      limit: 20, fetchLimit: 21, previewLimit: 5
    },
    notes: 'Unhinted production pipeline/options with an indexed interests range before unwind and the same membership filter after unwind. First-page plans may scan broadly; selective cursor pages can skip irrelevant users. Grouping/computed sort remain blocking. Local single-run measurements are not latency guarantees.',
    indexes, cases
  };
  await saveEvidence('interests', databaseName, evidence);
} finally {
  try { await connection.close(); } finally { await replica.stop(); }
}
