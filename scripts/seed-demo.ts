import 'dotenv/config';
import { connectDatabase } from '../src/config/database.js';
import { databaseNameFromUri, parseEnvironment } from '../src/config/env.js';
import { seedDemo } from './seed-fixtures.js';

try {
  if (process.argv.length !== 2 || process.env.NODE_ENV !== 'development') throw new Error('Development only');
  const config = parseEnvironment(process.env);
  const database = databaseNameFromUri(config.MONGODB_URI);
  // Explicitly select a demo database; never default to the application's DB.
  if (!/^notes_demo(?:_[a-zA-Z0-9_-]+)?$/.test(database) || process.env.SEED_DATABASE !== database) {
    throw new Error('Select and acknowledge a demo database');
  }
  const password = process.env.SEED_PASSWORD;
  delete process.env.SEED_PASSWORD;
  const connection = await connectDatabase(config);
  try {
    await seedDemo(connection, password);
    console.log('Demo fixtures ready: demo01@example.test through demo12@example.test; 7 notes and 7 posts each. Existing fixture data and passwords retained.');
  } finally { await connection.close(); }
} catch {
  console.error('Demo seed failed. Use NODE_ENV=development, an acknowledged notes_demo database (SEED_DATABASE), a valid SEED_PASSWORD, no arguments, and compatible indexes/fixtures. No credentials were printed.');
  process.exitCode = 1;
}
