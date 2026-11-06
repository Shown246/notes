import { z } from 'zod';
import { emailSchema, interestsSchema } from '../../shared/normalization.js';

export const nameSchema = z.string().trim().min(1).max(100);
// Passwords are measured as supplied, without trimming, coercion, or truncation.
export const passwordSchema = z.string().min(12).max(128);
export const registrationSchema = z.strictObject({
  name: nameSchema, email: emailSchema, password: passwordSchema,
  interests: interestsSchema.default([])
});
export const loginSchema = z.strictObject({ email: emailSchema, password: passwordSchema });
export const profileUpdateSchema = z.strictObject({
  name: nameSchema.optional(), interests: interestsSchema.optional()
}).refine((value) => value.name !== undefined || value.interests !== undefined, 'Provide name or interests');
export const emptyQuerySchema = z.strictObject({});
