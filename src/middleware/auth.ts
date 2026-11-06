import type { RequestHandler, Response } from 'express';
import type { Types } from 'mongoose';
import type { getModels } from '../config/models.js';
import type { User } from '../modules/users/user.model.js';
import { unauthorized, verifyToken } from '../modules/auth/token.js';
import type { TokenConfig } from '../modules/auth/token.js';
import { AppError } from '../shared/errors.js';
import { parseObjectId } from '../shared/validation.js';

export type CurrentUser = Omit<User, 'passwordHash' | 'contentRevision'> & { _id: Types.ObjectId };
export function currentUser(response: Response): CurrentUser {
  const user = response.locals.currentUser as CurrentUser | undefined;
  if (!user) throw unauthorized();
  return user;
}

export function authenticate(models: ReturnType<typeof getModels>, config: TokenConfig): RequestHandler {
  return async (request, response, next) => {
    const header = request.headers.authorization;
    const matches = typeof header === 'string' && header.length <= 4096
      ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(header) : null;
    const headerCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]!.toLowerCase() === 'authorization').length;
    if (!matches || headerCount !== 1) throw unauthorized();
    const claims = await verifyToken(matches[1]!, config);
    const user = await models.User.findById(parseObjectId(claims.subject)).select('+tokenVersion').lean();
    if (!user || user.tokenVersion !== claims.version) throw unauthorized();
    response.locals.currentUser = user;
    next();
  };
}

export const requireAdmin: RequestHandler = (_request, response, next) => {
  if (currentUser(response).role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin access required');
  next();
};
