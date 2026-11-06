import type { Connection } from 'mongoose';
import { getModels } from '../../config/models.js';
import { ensureIndexes } from '../../config/indexes.js';
import { parseInput } from '../../shared/validation.js';
import { registrationSchema } from '../auth/auth.validation.js';
import { hashPassword } from '../auth/password.js';
import { AppError } from '../../shared/errors.js';

export async function bootstrapAdmin(connection: Connection, credentials: unknown, recover = false): Promise<void> {
  const input = parseInput(registrationSchema, credentials);
  await ensureIndexes(connection);
  const { User } = getModels(connection);
  const passwordHash = await hashPassword(input.password);
  if (recover) {
    const user = await User.findOneAndUpdate({ email: input.email }, {
      $set: { name: input.name, passwordHash, role: 'admin' }, $inc: { tokenVersion: 1 }
    });
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Recovery requires an existing account');
  } else {
    await User.create({ name: input.name, email: input.email, passwordHash, role: 'admin', interests: input.interests });
  }
}
