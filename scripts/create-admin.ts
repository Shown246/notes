import 'dotenv/config';
import { connectDatabase } from '../src/config/database.js';
import { parseEnvironment } from '../src/config/env.js';
import { bootstrapAdmin } from '../src/modules/users/admin-bootstrap.js';

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--recover')) throw new Error('Unsupported arguments');
  // Environment input avoids echoing a password or putting it in command-line arguments.
  const credentials = { name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD };
  delete process.env.ADMIN_PASSWORD;
  const connection = await connectDatabase(parseEnvironment(process.env));
  try {
    await bootstrapAdmin(connection, credentials, args[0] === '--recover');
    console.log(args[0] === '--recover' ? 'Admin access recovered; prior tokens revoked.' : 'Admin created.');
  } finally { await connection.close(); }
} catch (error) {
  const duplicate = typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
  console.error(duplicate
    ? 'Admin creation refused: email already exists. Use --recover explicitly to reset credentials and promote an existing account.'
    : 'Admin setup failed. Check ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, arguments, configuration, database access, and index definitions.');
  process.exitCode = 1;
}
