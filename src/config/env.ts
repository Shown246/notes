import { z } from 'zod';

const positiveInteger = (fallback: number, maximum = 2_147_483_647) =>
  z.coerce.number().int().min(1).max(maximum).default(fallback);

export function databaseNameFromUri(uri: string): string {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?/#]+)(?:\?[^#]*)?$/.exec(uri);
  if (!match?.[1] || !/^[a-zA-Z0-9_-]+$/.test(match[1])) {
    throw new Error('An explicit alphanumeric MongoDB database name is required');
  }
  if (['admin', 'local', 'config'].includes(match[1].toLowerCase())) {
    throw new Error('A dedicated application database is required');
  }
  return match[1];
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: positiveInteger(3000, 65535),
  MONGODB_URI: z.string().min(1).superRefine((uri, context) => {
    try { databaseNameFromUri(uri); }
    catch { context.addIssue({ code: 'custom', message: 'Use a MongoDB URI with an explicit dedicated database name' }); }
  }),
  JWT_SECRET: z.string().min(32).refine((value) => Buffer.byteLength(value) >= 32),
  JWT_ISSUER: z.string().trim().min(1).default('secure-notes'),
  JWT_AUDIENCE: z.string().trim().min(1).default('secure-notes-web'),
  JWT_TTL_SECONDS: positiveInteger(900, 3600),
  AUTH_LOGIN_LIMIT: positiveInteger(20, 1000),
  AUTH_REGISTER_LIMIT: positiveInteger(10, 1000),
  AUTH_RATE_WINDOW_MS: positiveInteger(900_000, 86_400_000),
  DB_SERVER_SELECTION_TIMEOUT_MS: positiveInteger(5000, 60000),
  QUERY_TIMEOUT_MS: positiveInteger(5000, 60000),
  REPORT_TIMEOUT_MS: positiveInteger(5000, 60000),
  SHUTDOWN_TIMEOUT_MS: positiveInteger(10000, 60000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info')
});

export type Environment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv): Environment {
  const result = environmentSchema.safeParse(source);
  if (!result.success) {
    // Report field names only: validation must not print secrets or connection strings.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid configuration fields: ${fields.join(', ')}`);
  }
  return result.data;
}
