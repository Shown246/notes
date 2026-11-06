import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import { AppError } from '../shared/errors.js';

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) { next(error); return; }
    let safe: AppError;
    if (error instanceof AppError) safe = error;
    else if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000 &&
      'keyPattern' in error && typeof error.keyPattern === 'object' && error.keyPattern !== null && 'email' in error.keyPattern) {
      safe = new AppError(409, 'EMAIL_ALREADY_EXISTS', 'Email already exists');
    } else if (error instanceof Error && [
      'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoNetworkError',
      'MongoNetworkTimeoutError', 'MongoNotConnectedError', 'MongoTopologyClosedError'
    ].includes(error.name)) {
      safe = new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
    } else {
      const type = typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined;
      if (type === 'entity.too.large') safe = new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds size limit');
      else if (type === 'entity.parse.failed') safe = new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON');
      else if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
        safe = new AppError(415, 'UNSUPPORTED_ENCODING', 'Unsupported request encoding');
      } else {
        safe = new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
        // Error messages/stacks from dependencies may contain URIs or user data.
        logger.error({ requestId: response.locals.requestId, code: safe.code }, 'Request failed');
      }
    }
    response.status(safe.status).json({ error: {
      code: safe.code, message: safe.message,
      ...(safe.details ? { details: safe.details } : {}),
      requestId: response.locals.requestId
    } });
  };
}
