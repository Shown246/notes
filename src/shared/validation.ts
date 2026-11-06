import { Types } from 'mongoose';
import { z } from 'zod';
import { AppError } from './errors.js';

export function parseInput<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed',
      result.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })));
  }
  return result.data;
}

export const objectIdSchema = z.string().regex(/^[a-fA-F0-9]{24}$/, 'Expected a 24-character ObjectId');

export function parseObjectId(value: unknown): Types.ObjectId {
  return new Types.ObjectId(parseInput(objectIdSchema, value));
}

// HTTP feature schemas must use strictObject so unknown fields cannot be mass-assigned.
export const listQuerySchema = z.strictObject({
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).default(20),
  cursor: z.string().min(1).max(2048).optional()
});
