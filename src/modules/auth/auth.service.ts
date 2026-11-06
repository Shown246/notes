import type { getModels } from '../../config/models.js';
import { AppError } from '../../shared/errors.js';
import { toUserDto } from '../../shared/dto.js';
import { hashPassword, unknownAccountHash, verifyPassword } from './password.js';
import { issueToken } from './token.js';
import type { TokenConfig } from './token.js';
import type { z } from 'zod';
import type { registrationSchema, loginSchema, profileUpdateSchema } from './auth.validation.js';
import type { CurrentUser } from '../../middleware/auth.js';

export function createAuthService(models: ReturnType<typeof getModels>, config: TokenConfig) {
  return {
    async register(input: z.output<typeof registrationSchema>) {
      const passwordHash = await hashPassword(input.password);
      const user = await models.User.create({
        name: input.name, email: input.email, interests: input.interests, passwordHash, role: 'user'
      });
      return toUserDto(user);
    },
    async login(input: z.output<typeof loginSchema>) {
      const user = await models.User.findOne({ email: input.email }).select('+passwordHash +tokenVersion');
      const valid = await verifyPassword(user?.passwordHash ?? await unknownAccountHash(), input.password);
      if (!user || !valid) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      return {
        accessToken: await issueToken(user.id, user.tokenVersion, config),
        expiresIn: config.JWT_TTL_SECONDS, user: toUserDto(user)
      };
    },
    async updateProfile(user: CurrentUser, input: z.output<typeof profileUpdateSchema>) {
      const fields: { name?: string; interests?: string[] } = {};
      if (input.name !== undefined) fields.name = input.name;
      if (input.interests !== undefined) fields.interests = input.interests;
      const updated = await models.User.findOneAndUpdate(
        { _id: user._id, tokenVersion: user.tokenVersion }, { $set: fields }, { returnDocument: 'after' }
      );
      if (!updated) throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
      return toUserDto(updated);
    }
  };
}
