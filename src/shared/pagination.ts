import { decodeCursor } from './cursor.js';
import { listQuerySchema, parseInput, parseObjectId } from './validation.js';
import type { Types } from 'mongoose';

export const cursorScopes = {
  users: 'admin:users',
  adminNotes: 'admin:notes',
  posts: 'posts',
  interests: 'admin:reports:users-by-interest',
  ownNotes: (ownerId: Types.ObjectId): string => `notes:owner:${ownerId.toHexString()}`,
  authorPosts: (authorId: Types.ObjectId): string => `posts:author:${authorId.toHexString()}`
} as const;

export function objectIdPage(query: unknown, scope: string) {
  const { limit, cursor } = parseInput(listQuerySchema, query);
  const after = cursor === undefined ? undefined : parseObjectId(decodeCursor(cursor, scope, 'objectId'));
  return {
    limit, scope, fetchLimit: limit + 1,
    sort: { _id: -1 } as const,
    predicate: after === undefined ? {} : { _id: { $lt: after } }
  };
}

export function ownNotesPage(query: unknown, ownerId: Types.ObjectId) {
  const page = objectIdPage(query, cursorScopes.ownNotes(ownerId));
  return { ...page, predicate: { ...page.predicate, ownerId } };
}

export function authorPostsPage(query: unknown, authorId: Types.ObjectId) {
  const page = objectIdPage(query, cursorScopes.authorPosts(authorId));
  return { ...page, predicate: { ...page.predicate, authorId } };
}

export function interestPage(query: unknown) {
  const { limit, cursor } = parseInput(listQuerySchema, query);
  return {
    limit, scope: cursorScopes.interests, fetchLimit: limit + 1,
    afterInterest: cursor === undefined ? undefined : decodeCursor(cursor, cursorScopes.interests, 'interest')
  };
}
