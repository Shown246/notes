import { inject } from 'vitest';
import { connectDatabase } from '../../src/config/database.js';
import { databaseNameFromUri, parseEnvironment } from '../../src/config/env.js';

export function testEnvironment() {
  const uri = inject('testMongoUri');
  const name = inject('testDatabaseName');
  if (!/^notes_test_[a-f0-9]{32}$/.test(name) || databaseNameFromUri(uri) !== name) {
    throw new Error('Refusing an unsafe test database');
  }
  return parseEnvironment({
    NODE_ENV: 'test', MONGODB_URI: uri,
    JWT_SECRET: 'test-only-secret-never-used-outside-tests', LOG_LEVEL: 'silent'
  });
}

export async function testConnection() {
  return connectDatabase(testEnvironment());
}
