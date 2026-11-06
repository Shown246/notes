import type { Connection, Types } from 'mongoose';
import type { z } from 'zod';
import { getModels } from '../../config/models.js';
import type { CurrentUser } from '../../middleware/auth.js';
import { withParentContentWrite } from '../../shared/content-transaction.js';
import { pageFromRows } from '../../shared/cursor.js';
import { postProjection, toPostDto, toUserPreviewDto } from '../../shared/dto.js';
import { AppError } from '../../shared/errors.js';
import { cursorScopes, objectIdPage } from '../../shared/pagination.js';
import { createPostRepository } from './post.repository.js';
import type { createPostSchema } from './post.validation.js';

export function createPostService(connection: Connection, queryTimeoutMs: number) {
  const { Post } = getModels(connection);
  const repository = createPostRepository(connection, queryTimeoutMs);
  return {
    async allByAuthor(authorId: Types.ObjectId) {
      const rows = await repository.allByAuthor(authorId);
      const author = rows[0];
      if (!author) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      return {
        data: rows.flatMap((row) => row.post ? [toPostDto(row.post)] : []),
        author: toUserPreviewDto(author)
      };
    },
    async create(user: CurrentUser, input: z.output<typeof createPostSchema>) {
      return withParentContentWrite(connection, user, async (session) => {
        const [post] = await Post.create([{ authorId: user._id, title: input.title, body: input.body }], { session });
        return toPostDto(post!);
      });
    },
    async list(query: unknown) {
      const page = objectIdPage(query, cursorScopes.posts);
      const rows = await Post.find(page.predicate).select(postProjection)
        .sort(page.sort).limit(page.fetchLimit).maxTimeMS(queryTimeoutMs).lean();
      return pageFromRows(rows.map(toPostDto), page.limit, page.scope, 'objectId', (row) => row.id);
    },
    async byAuthor(authorId: Types.ObjectId, query: unknown) {
      const page = objectIdPage(query, cursorScopes.authorPosts(authorId));
      const author = await repository.byAuthor(authorId, page);
      if (!author) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
      return {
        ...pageFromRows(author.posts.map(toPostDto), page.limit, page.scope, 'objectId', (row) => row.id),
        author: toUserPreviewDto(author)
      };
    }
  };
}
