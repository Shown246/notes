import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import { createApp } from './app.js';
import { connectDatabase, databaseReady } from './config/database.js';
import { parseEnvironment } from './config/env.js';
import type { Environment } from './config/env.js';
import { createLogger } from './middleware/logging.js';
import { verifyIndexes } from './config/indexes.js';

export async function startServer(config: Environment, logger: Logger = createLogger(config.LOG_LEVEL)) {
  const connection = await connectDatabase(config);
  let server: Server;
  let app: ReturnType<typeof createApp>;
  try {
    await verifyIndexes(connection);
    app = createApp({ logger, isDatabaseReady: () => databaseReady(connection, config.QUERY_TIMEOUT_MS), auth: { connection, config } });
    server = await new Promise<Server>((resolve, reject) => {
      const listener = createServer(app);
      listener.once('error', reject);
      listener.listen(config.PORT, () => {
        listener.off('error', reject);
        resolve(listener);
      });
    });
  } catch (error) { await connection.close(); throw error; }
  logger.info({ port: (server.address() as { port: number }).port }, 'Server listening');
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    closing ??= new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
        void connection.destroy().then(() => reject(new Error('Shutdown deadline exceeded')), reject);
      }, config.SHUTDOWN_TIMEOUT_MS);
      timer.unref();
      server.close((error) => {
        void connection.close().then(() => {
          clearTimeout(timer);
          if (error) reject(error); else resolve();
        }, (databaseError: unknown) => { clearTimeout(timer); reject(databaseError); });
      });
    });
    return closing;
  }
  return { app, server, connection, close };
}

async function main() {
  let config: Environment;
  try { config = parseEnvironment(process.env); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid configuration');
    process.exitCode = 1;
    return;
  }
  const logger = createLogger(config.LOG_LEVEL);
  try {
    const running = await startServer(config, logger);
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void running.close().catch(() => {
        logger.error('Shutdown failed'); process.exitCode = 1;
      });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    logger.error('Startup failed: check database availability, replica set, index setup (npm run db:indexes), and port configuration');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
