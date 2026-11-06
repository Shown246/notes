import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import request from 'supertest';
import { connectDatabase, databaseReady } from '../../src/config/database.js';
import { startServer } from '../../src/server.js';
import { testConnection, testEnvironment } from '../helpers/database.js';
import { ensureIndexes } from '../../src/config/indexes.js';

beforeAll(async () => {
  const connection = await testConnection();
  try { await ensureIndexes(connection); } finally { await connection.close(); }
});

describe('real replica-set foundation', () => {
  it('connects only to its disposable database and executes a rollback-capable transaction', async () => {
    const connection = await testConnection();
    try {
      expect(connection.name).toMatch(/^notes_test_[a-f0-9]{32}$/);
      expect(await databaseReady(connection, 1000)).toBe(true);
      // Create the collection outside the transaction to support all compatible server settings.
      const collection = await connection.db!.createCollection('foundation_probe');
      const session = await connection.startSession();
      try {
        await expect(session.withTransaction(async () => {
          await collection.insertOne({ probe: true }, { session });
          throw new Error('intentional rollback');
        })).rejects.toThrow('intentional rollback');
        expect(await collection.countDocuments()).toBe(0);
      } finally { await session.endSession(); await collection.drop(); }
    } finally { await connection.close(); }
    expect(await databaseReady(connection, 1000)).toBe(false);
  });
  it('starts HTTP only after connection and closes the listener and database idempotently', async () => {
    const running = await startServer({ ...testEnvironment(), PORT: 0 });
    const port = (running.server.address() as { port: number }).port;
    try {
      expect((await request(running.server).get('/api/health')).status).toBe(200);
      expect((await request(running.server).get('/api/auth/me')).status).toBe(401);
      await Promise.all([running.close(), running.close()]);
      expect(running.connection.readyState).toBe(0);
      expect(running.server.listening).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    } finally { await running.close(); }
  });
  it('fails startup when the configured database is unavailable', async () => {
    await expect(startServer({
      ...testEnvironment(), PORT: 0, MONGODB_URI: 'mongodb://127.0.0.1:1/notes_unreachable',
      DB_SERVER_SELECTION_TIMEOUT_MS: 200
    })).rejects.toThrow();
  });
  it('fails cleanly if another listener already owns the configured HTTP port', async () => {
    const running = await startServer({ ...testEnvironment(), PORT: 0 });
    const port = (running.server.address() as { port: number }).port;
    try {
      await expect(startServer({ ...testEnvironment(), PORT: port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect((await request(running.server).get('/api/health')).status).toBe(200);
    } finally { await running.close(); }
  });
  it('rejects a standalone MongoDB instance instead of pretending transactions are supported', async () => {
    const standalone = await MongoMemoryServer.create({ binary: { version: '8.0.34' } });
    try {
      await expect(connectDatabase({ ...testEnvironment(), MONGODB_URI: standalone.getUri('notes_test_standalone') }))
        .rejects.toThrow('A writable MongoDB replica set is required');
    } finally { await standalone.stop(); }
  });
  it('fails the actual entry point on bad configuration without printing secret values', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../src/server.ts', import.meta.url))], {
      env: { ...process.env, MONGODB_URI: 'mongodb://private:credential@localhost/', JWT_SECRET: 'secret-value', PORT: '0', DOTENV_CONFIG_PATH: '.nonexistent-test-env' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const [exitCode] = await once(child, 'exit');
    expect(exitCode).toBe(1);
    expect(output).toContain('Invalid configuration fields');
    expect(output).not.toMatch(/private|credential|secret-value/);
  });
});
