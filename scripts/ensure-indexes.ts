import 'dotenv/config';
import { connectDatabase } from '../src/config/database.js';
import { parseEnvironment } from '../src/config/env.js';
import { ensureIndexes } from '../src/config/indexes.js';

try {
  const connection = await connectDatabase(parseEnvironment(process.env));
  try {
    await ensureIndexes(connection);
    console.log('Verified three built-in and four custom indexes.');
  } finally { await connection.close(); }
} catch {
  // Driver errors can include credentials or duplicate email values.
  console.error('Index setup failed. Check configuration, connectivity, duplicate emails, and existing index definitions. No indexes were dropped.');
  process.exitCode = 1;
}
