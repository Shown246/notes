import { SignJWT, jwtVerify } from 'jose';
import type { Environment } from '../../config/env.js';
import { objectIdSchema } from '../../shared/validation.js';
import { AppError } from '../../shared/errors.js';

export type TokenConfig = Pick<Environment, 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'JWT_TTL_SECONDS'>;
export const unauthorized = () => new AppError(401, 'UNAUTHORIZED', 'Authentication required');

export function issueToken(subject: string, version: number, config: TokenConfig): Promise<string> {
  if (!objectIdSchema.safeParse(subject).success || !Number.isSafeInteger(version) || version < 0) {
    throw new Error('Invalid internal token claims');
  }
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ver: version }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(subject).setIssuer(config.JWT_ISSUER).setAudience(config.JWT_AUDIENCE)
    .setIssuedAt(now).setExpirationTime(now + config.JWT_TTL_SECONDS)
    .sign(new TextEncoder().encode(config.JWT_SECRET));
}

export async function verifyToken(token: string, config: TokenConfig): Promise<{ subject: string; version: number }> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.JWT_SECRET), {
      algorithms: ['HS256'], issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE,
      requiredClaims: ['sub', 'ver', 'iss', 'aud', 'iat', 'exp'], maxTokenAge: config.JWT_TTL_SECONDS
    });
    if (!objectIdSchema.safeParse(payload.sub).success || !Number.isSafeInteger(payload.ver) || Number(payload.ver) < 0 ||
        !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
        payload.exp! <= payload.iat! || payload.exp! - payload.iat! > config.JWT_TTL_SECONDS) throw new Error();
    return { subject: payload.sub!, version: payload.ver as number };
  } catch { throw unauthorized(); }
}
