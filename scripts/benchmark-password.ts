import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from '../src/modules/auth/password.js';

const password = randomBytes(32).toString('base64url');
const timings: { hashMs: number; verifyMs: number }[] = [];
for (let i = 0; i < 5; i++) {
  const started = performance.now();
  const hash = await hashPassword(password);
  const hashed = performance.now();
  if (!await verifyPassword(hash, password)) throw new Error('Password verification failed');
  timings.push({ hashMs: Math.round(hashed - started), verifyMs: Math.round(performance.now() - hashed) });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch,
  argon2id: { memoryKiB: 19456, iterations: 2, parallelism: 1 }, samples: timings }, null, 2));
