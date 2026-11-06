import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import pino from 'pino';
import type { Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['password', 'passwordHash', 'accessToken', 'JWT_SECRET', 'MONGODB_URI',
        'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie'],
      censor: '[REDACTED]'
    }
  });
}

export function requestLogging(logger: Logger): RequestHandler {
  return (request, response, next) => {
    const started = performance.now();
    // Generate locally: untrusted incoming request IDs are never copied to logs/headers.
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    response.once('finish', () => {
      logger.info({
        requestId, method: request.method,
        // Use route patterns only: URLs, queries, headers and bodies may contain secrets.
        route: request.route?.path ?? 'unmatched', status: response.statusCode,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100
      }, 'Request completed');
    });
    next();
  };
}
