import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext { testMongoUri: string; testDatabaseName: string }
}

export default async function setup(project: TestProject) {
  // A real mongod process with disposable files; never read application/test URI environment variables.
  const databaseName = `notes_test_${randomUUID().replaceAll('-', '')}`;
  const replica = await MongoMemoryReplSet.create({
    binary: { version: '8.0.34' },
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  project.provide('testMongoUri', replica.getUri(databaseName));
  project.provide('testDatabaseName', databaseName);
  return async () => { await replica.stop(); };
}
