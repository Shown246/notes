import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { parseInput } from '../../shared/validation.js';
import { passwordSchema } from './auth.validation.js';

export const passwordHashOptions = {
  type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1
} as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(parseInput(passwordSchema, password), passwordHashOptions);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try { return await argon2.verify(hash, password); }
  catch { return false; } // A malformed stored hash must not disclose account existence.
}

let dummyHash: Promise<string> | undefined;
export function unknownAccountHash(): Promise<string> {
  // Unknown accounts still perform Argon2 verification. This is not a login credential.
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}
