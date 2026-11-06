import { z } from 'zod';
import { nameSchema, passwordSchema } from '../auth/auth.validation.js';
import { emailSchema, interestsSchema } from '../../shared/normalization.js';

const roleSchema = z.enum(['user', 'admin']);
export const createUserSchema = z.strictObject({
  name: nameSchema, email: emailSchema, password: passwordSchema,
  interests: interestsSchema.default([]), role: roleSchema.default('user')
});
export const updateUserSchema = z.strictObject({
  name: nameSchema.optional(), email: emailSchema.optional(),
  password: passwordSchema.optional(), interests: interestsSchema.optional(), role: roleSchema.optional()
}).refine((value) => Object.keys(value).length > 0, 'Provide at least one field');
