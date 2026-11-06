import type { Connection, Types } from 'mongoose';
import { getModels } from '../../config/models.js';
import { postProjection } from '../../shared/dto.js';
import { AppError } from '../../shared/errors.js';
import type { Post } from './post.model.js';

// Values are validated and cast by objectIdPage/parseObjectId before reaching
// this builder. Native collection aggregation does not perform Mongoose casts.
export function authorPostsPipeline(authorId: Types.ObjectId, page: {
  predicate: { _id?: { $lt: Types.ObjectId } }; fetchLimit: number;
}) {
  return [
    { $match: { _id: authorId } },
    { $lookup: {
      from: 'posts', localField: '_id', foreignField: 'authorId',
      pipeline: [
        ...(page.predicate._id === undefined ? [] : [{ $match: { _id: page.predicate._id } }]),
        { $sort: { _id: -1 } },
        { $limit: page.fetchLimit },
        { $project: postProjection }
      ],
      as: 'posts'
    } },
    { $project: { _id: 1, name: 1, posts: 1 } }
  ];
}

interface AuthorPostsRow {
  _id: Types.ObjectId; name: string; posts: (Post & { _id: Types.ObjectId })[];
}

// Unwind directly after lookup so MongoDB can coalesce the stages rather than
// materializing every post inside a single BSON result document.
export function allAuthorPostsPipeline(authorId: Types.ObjectId) {
  return [
    { $match: { _id: authorId } },
    { $lookup: {
      from: 'posts', localField: '_id', foreignField: 'authorId', as: 'posts',
      pipeline: [{ $sort: { _id: -1 } }, { $project: postProjection }]
    } },
    { $unwind: { path: '$posts', preserveNullAndEmptyArrays: true } },
    { $project: { _id: 1, name: 1, post: '$posts' } }
  ];
}

export function createPostRepository(connection: Connection, queryTimeoutMs: number) {
  const { User } = getModels(connection);
  return {
    async allByAuthor(authorId: Types.ObjectId) {
      try {
        const cursor = User.collection.aggregate<{
          _id: Types.ObjectId; name: string; post?: AuthorPostsRow['posts'][number];
        }>(allAuthorPostsPipeline(authorId), { maxTimeMS: queryTimeoutMs, allowDiskUse: true });
        return await cursor.toArray();
      } catch (error: unknown) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 50) {
          throw new AppError(503, 'QUERY_TIMEOUT', 'Post query exceeded its execution time budget; use the paginated author view');
        }
        throw error;
      }
    },
    async byAuthor(authorId: Types.ObjectId, page: Parameters<typeof authorPostsPipeline>[1]) {
      // Exactly one data query; no author preflight, fallback find, or populate.
      const cursor = User.collection.aggregate<AuthorPostsRow>(authorPostsPipeline(authorId, page), {
        maxTimeMS: queryTimeoutMs
      });
      const rows = await cursor.toArray();
      return rows[0];
    }
  };
}
