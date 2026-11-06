import mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import type { Environment } from './env.js';

export async function connectDatabase(config: Environment): Promise<Connection> {
  const connection = mongoose.createConnection(config.MONGODB_URI, {
    autoIndex: false,
    autoCreate: false,
    bufferCommands: false,
    serverSelectionTimeoutMS: config.DB_SERVER_SELECTION_TIMEOUT_MS,
    connectTimeoutMS: config.DB_SERVER_SELECTION_TIMEOUT_MS
  });
  connection.set('maxTimeMS', config.QUERY_TIMEOUT_MS);
  // Errors are handled by startup, readiness, and request boundaries; never log driver URIs.
  connection.on('error', () => undefined);
  try {
    await connection.asPromise();
    const hello = await connection.db!.admin().command({ hello: 1 }, {
      timeoutMS: config.DB_SERVER_SELECTION_TIMEOUT_MS
    });
    if (!hello.setName || !hello.isWritablePrimary) {
      throw new Error('A writable MongoDB replica set is required');
    }
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export async function databaseReady(connection: Connection, timeoutMs: number): Promise<boolean> {
  if (connection.readyState !== 1 || !connection.db) return false;
  try {
    await connection.db.admin().command({ ping: 1 }, { timeoutMS: timeoutMs });
    return true;
  } catch { return false; }
}
