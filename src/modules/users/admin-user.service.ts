import type { Connection, Types } from 'mongoose';
import type { z } from 'zod';
import { getModels } from '../../config/models.js';
import { withContentTransaction } from '../../shared/content-transaction.js';
import { pageFromRows } from '../../shared/cursor.js';
import { toUserDto, userProjection } from '../../shared/dto.js';
import { AppError } from '../../shared/errors.js';
import { cursorScopes, objectIdPage } from '../../shared/pagination.js';
import { hashPassword } from '../auth/password.js';
import type { createUserSchema, updateUserSchema } from './admin-user.validation.js';

const notFound = () => new AppError(404, 'USER_NOT_FOUND', 'User not found');
const selfConflict = () => new AppError(409, 'SELF_ACCOUNT_OPERATION', 'Cannot delete your own account or update your own role');

export function createAdminUserService(connection: Connection, queryTimeoutMs: number) {
  const { User, Note, Post } = getModels(connection);
  return {
    async list(query: unknown) {
      const page = objectIdPage(query, cursorScopes.users);
      const users = await User.find(page.predicate).select(userProjection).sort(page.sort)
        .limit(page.fetchLimit).maxTimeMS(queryTimeoutMs).lean();
      return pageFromRows(users.map(toUserDto), page.limit, page.scope, 'objectId', (user) => user.id);
    },
    async read(userId: Types.ObjectId) {
      const user = await User.findById(userId).select(userProjection).maxTimeMS(queryTimeoutMs).lean();
      if (!user) throw notFound();
      return toUserDto(user);
    },
    async create(input: z.output<typeof createUserSchema>) {
      const passwordHash = await hashPassword(input.password);
      const user = await User.create({ name: input.name, email: input.email, passwordHash,
        interests: input.interests, role: input.role });
      return toUserDto(user);
    },
    async update(actorId: Types.ObjectId, userId: Types.ObjectId, input: z.output<typeof updateUserSchema>) {
      if (actorId.equals(userId) && input.role !== undefined) throw selfConflict();
      const fields: { name?: string; email?: string; interests?: string[]; role?: 'user' | 'admin'; passwordHash?: string } = {};
      if (input.name !== undefined) fields.name = input.name;
      if (input.email !== undefined) fields.email = input.email;
      if (input.interests !== undefined) fields.interests = input.interests;
      if (input.role !== undefined) fields.role = input.role;
      if (input.password !== undefined) fields.passwordHash = await hashPassword(input.password);
      // Hashing precedes the single atomic write. A duplicate-email failure
      // leaves both the password and tokenVersion unchanged.
      const user = await User.findOneAndUpdate({ _id: userId }, {
        $set: fields, ...(fields.passwordHash === undefined ? {} : { $inc: { tokenVersion: 1 } })
      }, { returnDocument: 'after', maxTimeMS: queryTimeoutMs }).select(userProjection).lean();
      if (!user) throw notFound();
      return toUserDto(user);
    },
    async delete(actorId: Types.ObjectId, userId: Types.ObjectId) {
      if (actorId.equals(userId)) throw selfConflict();
      await withContentTransaction(connection, async (session) => {
        // Delete the parent first: this conflicts with content creation's
        // contentRevision write and makes retries observe committed children.
        const user = await User.findOneAndDelete({ _id: userId }, { session, maxTimeMS: queryTimeoutMs })
          .select({ _id: 1 }).lean();
        if (!user) throw notFound();
        await Note.deleteMany({ ownerId: userId }, { session, maxTimeMS: queryTimeoutMs });
        await Post.deleteMany({ authorId: userId }, { session, maxTimeMS: queryTimeoutMs });
      });
    }
  };
}
