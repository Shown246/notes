import { z } from 'zod';

// Application policy: preserve dots and plus suffixes; no provider-specific rewrites.
export const normalizeEmail = (value: string): string => value.trim().toLowerCase();
export const normalizeInterest = (value: string): string => value.trim().toLowerCase();
export const emailSchema = z.string().transform(normalizeEmail).pipe(z.email());
export const interestSchema = z.string().transform(normalizeInterest).pipe(z.string().min(1).max(40));
export const interestsSchema = z.array(interestSchema)
  .transform((values) => [...new Set(values)])
  .pipe(z.array(z.string()).max(10));

export function normalizeInterests(value: unknown): string[] {
  return interestsSchema.parse(value);
}
