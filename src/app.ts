import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { errorHandler } from './middleware/errors.js';
import { requestLogging } from './middleware/logging.js';
import { AppError } from './shared/errors.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import type { AuthOptions } from './modules/auth/auth.routes.js';
import { getModels } from './config/models.js';
import { authenticate, requireAdmin } from './middleware/auth.js';
import { createNoteRouters } from './modules/notes/note.routes.js';
import { createAdminUserRouter } from './modules/users/admin-user.routes.js';
import { createPostRouters } from './modules/posts/post.routes.js';
import { createReportRouter } from './modules/reports/report.routes.js';

interface AppOptions {
  logger: Logger;
  isDatabaseReady: () => Promise<boolean>;
  publicDirectory?: string;
  auth?: AuthOptions;
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(requestLogging(options.logger));
  app.use(helmet());
  app.use(express.json({ limit: '100kb', strict: true }));
  app.use('/api', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', async (_request, response) => {
    if (!await options.isDatabaseReady()) {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
    }
    response.json({ data: { status: 'ok' } });
  });
  if (options.auth) {
    app.use('/api/auth', createAuthRouter(options.auth));
    app.use('/api/admin', authenticate(getModels(options.auth.connection), options.auth.config), requireAdmin);
    const notes = createNoteRouters(options.auth);
    app.use('/api/notes', authenticate(getModels(options.auth.connection), options.auth.config), notes.own);
    app.use('/api/admin/notes', notes.admin);
    app.use('/api/admin/users', createAdminUserRouter(options.auth));
    app.use('/api/admin/reports', createReportRouter(options.auth));
    const posts = createPostRouters(options.auth);
    app.use('/api/posts', posts.posts);
    app.use('/api/users', posts.authors);
  }
  // Reserve /api before static serving so unknown API routes always return JSON errors.
  app.use('/api', (_request, _response, next) => next(new AppError(404, 'NOT_FOUND', 'Resource not found')));
  app.use(express.static(options.publicDirectory ?? fileURLToPath(new URL('../public/', import.meta.url)), {
    dotfiles: 'deny', index: 'index.html'
  }));
  app.use((_request, _response, next) => next(new AppError(404, 'NOT_FOUND', 'Resource not found')));
  app.use(errorHandler(options.logger));
  return app;
}
