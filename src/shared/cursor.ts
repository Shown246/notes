import { z } from 'zod';
import { AppError } from './errors.js';
import type { ListResponse } from './dto.js';
import { objectIdSchema } from './validation.js';
import { normalizeInterest } from './normalization.js';

const scopeSchema = z.string().min(1).max(200);
const interestSchema = z.string().min(1).max(40)
  .refine((value) => value === normalizeInterest(value));
const cursorSchema = z.strictObject({
  v: z.literal(1), scope: scopeSchema, kind: z.enum(['objectId', 'interest']), key: z.string()
});
export type CursorKind = 'objectId' | 'interest';

function validKey(kind: CursorKind, key: string): boolean {
  return (kind === 'objectId' ? objectIdSchema : interestSchema).safeParse(key).success;
}

export function encodeCursor(scope: string, kind: CursorKind, key: string): string {
  if (!scopeSchema.safeParse(scope).success || !validKey(kind, key)) {
    throw new Error('Invalid internal cursor value');
  }
  return Buffer.from(JSON.stringify({ v: 1, scope, kind, key })).toString('base64url');
}

export function decodeCursor(token: string, scope: string, kind: CursorKind): string {
  try {
    if (token.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error();
    const bytes = Buffer.from(token, 'base64url');
    if (bytes.length > 1024 || bytes.toString('base64url') !== token) throw new Error();
    // Reject malformed UTF-8 rather than accepting replacement characters as keys.
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = cursorSchema.parse(JSON.parse(json));
    if (value.scope !== scope || value.kind !== kind || !validKey(kind, value.key)) throw new Error();
    return value.key;
  } catch { throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor'); }
}

// Pass at most limit + 1 rows from the database. This helper never queries or counts.
export function pageFromRows<T>(
  rows: T[], limit: number, scope: string, kind: CursorKind, keyOf: (row: T) => string
): ListResponse<T> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || rows.length > limit + 1) {
    throw new Error('Invalid internal page bounds');
  }
  const hasMore = rows.length > limit;
  const data = rows.slice(0, limit);
  const last = data.at(-1);
  return {
    data,
    pagination: {
      limit, hasMore,
      nextCursor: hasMore && last !== undefined ? encodeCursor(scope, kind, keyOf(last)) : null
    }
  };
}
