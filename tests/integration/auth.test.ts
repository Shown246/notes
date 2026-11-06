import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT, decodeJwt } from 'jose';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import pino from 'pino';
import { createApp } from '../../src/app.js';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes } from '../../src/config/indexes.js';
import { createLogger } from '../../src/middleware/logging.js';
import { verifyPassword } from '../../src/modules/auth/password.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
let app: ReturnType<typeof createApp>;
const password = '  secret password  ';
const registration = { name: ' Member ', email: ' Member@Example.Test ', password, interests: [' Chess ', 'chess', 'READING'] };
function application(limits = { AUTH_LOGIN_LIMIT: 500, AUTH_REGISTER_LIMIT: 500 }) {
  return createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true,
    auth: { connection, config: { ...testEnvironment(), ...limits } } });
}
function safe(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect(['password', 'passwordHash', 'tokenVersion', 'contentRevision', '__v']).not.toContain(key);
    safe(child);
  }
}
async function registerAndLogin() {
  const registered = await request(app).post('/api/auth/register').send(registration);
  expect(registered.status).toBe(201);
  const loggedIn = await request(app).post('/api/auth/login').send({ email: 'member@example.test', password });
  expect(loggedIn.status).toBe(200);
  return { id: registered.body.data.id as string, token: loggedIn.body.data.accessToken as string };
}
async function customToken(id: string, changes: Record<string, unknown> = {}, algorithm = 'HS256', secret = testEnvironment().JWT_SECRET) {
  const config = testEnvironment();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: id, ver: 0, iss: config.JWT_ISSUER, aud: config.JWT_AUDIENCE, iat: now, exp: now + 900, ...changes })
    .setProtectedHeader({ alg: algorithm }).sign(new TextEncoder().encode(secret));
}
async function adminCommand(credentials: Record<string, string>, args: string[] = []) {
  const config = testEnvironment();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../scripts/create-admin.ts', import.meta.url)), ...args], {
    env: { ...process.env, ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, String(value)])),
      ADMIN_NAME: '', ADMIN_EMAIL: '', ADMIN_PASSWORD: '', ...credentials, DOTENV_CONFIG_PATH: '.nonexistent-test-env' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(child, 'exit');
  return { code, output };
}

beforeAll(async () => {
  connection = await testConnection();
  models = getModels(connection);
  await ensureIndexes(connection);
  app = application();
});
beforeEach(async () => { await models.User.deleteMany({}); });
afterAll(async () => { await connection?.close(); });

describe('registration and login', () => {
  it('hashes the exact password with Argon2id, returns safe DTOs, and signs only the specified claims', async () => {
    const registered = await request(app).post('/api/auth/register').send(registration);
    expect(registered.status).toBe(201);
    expect(registered.body.data).toMatchObject({ name: 'Member', email: 'member@example.test', role: 'user', interests: ['chess', 'reading'] });
    safe(registered.body);
    const stored = await models.User.collection.findOne({ _id: new Types.ObjectId(registered.body.data.id) });
    expect(stored!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(stored!.passwordHash, password)).toBe(true);
    expect(await verifyPassword(stored!.passwordHash, password.trim())).toBe(false);
    const loggedIn = await request(app).post('/api/auth/login').send({ email: ' MEMBER@Example.Test ', password });
    expect(loggedIn.status).toBe(200);
    safe(loggedIn.body);
    expect(loggedIn.body.data.expiresIn).toBe(900);
    const claims = decodeJwt(loggedIn.body.data.accessToken);
    expect(Object.keys(claims).sort()).toEqual(['sub', 'ver', 'iss', 'aud', 'iat', 'exp'].sort());
    expect(claims.exp! - claims.iat!).toBe(900);
    const profile = await request(app).get('/api/auth/me').auth(loggedIn.body.data.accessToken, { type: 'bearer' });
    expect(profile.status).toBe(200);
    expect(profile.body).toEqual(registered.body);
    safe(profile.body);
  });
  it('rejects invalid, oversized, unknown, and operator inputs without account creation', async () => {
    const invalid: Record<string, unknown>[] = [
      { password: 'short' }, { password: 'x'.repeat(129) }, { password: 123456789012 },
      { name: ' ' }, { name: 'x'.repeat(101) }, { email: 'invalid' }, { email: { $ne: null } },
      { interests: [''] }, { interests: ['x'.repeat(41)] }, { interests: ['0','1','2','3','4','5','6','7','8','9','10'] },
      { role: 'admin' }, { _id: new Types.ObjectId().toString() }, { passwordHash: 'injected' },
      { tokenVersion: 0 }, { contentRevision: 0 }, { $set: { role: 'admin' } }
    ];
    for (const fields of invalid) {
      const response = await request(app).post('/api/auth/register').send({ ...registration, ...fields });
      expect(response.status, JSON.stringify(fields)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      safe(response.body);
    }
    expect(await models.User.countDocuments()).toBe(0);
    expect((await request(app).post('/api/auth/register?role=admin').send(registration)).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ email: { $ne: null }, password })).status).toBe(400);
    expect((await request(app).post('/api/auth/login').send({ email: 'a@example.test', password, role: 'admin' })).status).toBe(400);
  });
  it('supports password bounds without truncation and defaults interests to an empty array', async () => {
    for (const length of [12, 128]) {
      const input = { name: 'Member', email: `length${length}@example.test`, password: 'x'.repeat(length) };
      const response = await request(app).post('/api/auth/register').send(input);
      expect(response.status).toBe(201);
      expect(response.body.data.interests).toEqual([]);
      expect((await request(app).post('/api/auth/login').send({ email: input.email, password: input.password })).status).toBe(200);
    }
  });
  it('maps a concurrent normalized-email race to one success and one sanitized conflict', async () => {
    const responses = await Promise.all([
      request(app).post('/api/auth/register').send(registration),
      request(app).post('/api/auth/register').send({ ...registration, email: 'member@example.test' })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const conflict = responses.find((response) => response.status === 409)!;
    expect(conflict.body.error.code).toBe('EMAIL_ALREADY_EXISTS');
    expect(JSON.stringify(conflict.body)).not.toMatch(/E11000|password|member@example|stack/);
    expect(await models.User.countDocuments()).toBe(1);
  });
  it('uses the same credential error for unknown users, wrong passwords, and corrupt stored hashes', async () => {
    await registerAndLogin();
    const failures = [
      await request(app).post('/api/auth/login').send({ email: 'unknown@example.test', password }),
      await request(app).post('/api/auth/login').send({ email: 'member@example.test', password: 'incorrect password' })
    ];
    await models.User.updateOne({ email: 'member@example.test' }, { $set: { passwordHash: 'corrupt' } });
    failures.push(await request(app).post('/api/auth/login').send({ email: 'member@example.test', password }));
    for (const response of failures) {
      expect(response.status).toBe(401);
      expect(response.body.error).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', requestId: response.headers['x-request-id'] });
    }
  });
});

describe('JWT and current database authorization', () => {
  it('rejects forged, expired, malformed, wrongly scoped, missing, and invalid claims', async () => {
    const { id, token } = await registerAndLogin();
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      '', 'junk', token + 'junk',
      await customToken(id, {}, 'HS256', 'different-secret-for-testing-only-32-bytes'),
      await customToken(id, {}, 'HS384'),
      await customToken(id, { exp: now - 1, iat: now - 100 }),
      await customToken(id, { iss: 'wrong' }), await customToken(id, { aud: 'wrong' }),
      await customToken(id, { sub: 'invalid' }), await customToken(id, { sub: undefined }),
      await customToken(id, { ver: undefined }), await customToken(id, { ver: '0' }),
      await customToken(id, { ver: -1 }), await customToken(id, { ver: 0.5 }),
      await customToken(id, { ver: {} }), await customToken(id, { exp: undefined }),
      await customToken(id, { iat: undefined }), await customToken(id, { iat: now + 60 }),
      await customToken(id, { exp: now + 3600 }), await customToken(id, { nbf: now + 60 }),
      `${Buffer.from('{"alg":"none"}').toString('base64url')}.${token.split('.')[1]}.unsigned`
    ];
    for (const value of tokens) {
      const response = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${value}`);
      expect(response.status, value).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      safe(response.body);
    }
    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', `Basic ${token}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/me?access_token=' + token)).status).toBe(401);
  });
  it('uses current roles rather than JWT claims and applies the admin guard to every admin path', async () => {
    const { id, token } = await registerAndLogin();
    const forgedRole = await customToken(id, { role: 'admin' });
    for (const path of ['/api/admin/users', '/api/admin/notes', '/api/admin/reports/users-by-interest']) {
      expect((await request(app).get(path)).status).toBe(401);
      expect((await request(app).get(path).auth(forgedRole, { type: 'bearer' })).status).toBe(403);
    }
    await models.User.updateOne({ _id: id }, { $set: { role: 'admin' } });
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).body.data.role).toBe('admin');
    expect((await request(app).get('/api/admin/users').auth(token, { type: 'bearer' })).status).toBe(200);
    await models.User.updateOne({ _id: id }, { $set: { role: 'user' } });
    expect((await request(app).get('/api/admin/users').auth(token, { type: 'bearer' })).status).toBe(403);
  });
  it('rejects old tokens after a version change and rejects tokens for deleted accounts', async () => {
    const { id, token } = await registerAndLogin();
    await models.User.updateOne({ _id: id }, { $inc: { tokenVersion: 1 } });
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).status).toBe(401);
    const login = await request(app).post('/api/auth/login').send({ email: registration.email, password });
    expect(decodeJwt(login.body.data.accessToken).ver).toBe(1);
    await models.User.deleteOne({ _id: id });
    expect((await request(app).get('/api/auth/me').auth(login.body.data.accessToken, { type: 'bearer' })).status).toBe(401);
  });
});

describe('profile updates', () => {
  it('normalizes only name/interests for both roles and persists a safe DTO', async () => {
    const { id, token } = await registerAndLogin();
    for (const role of ['user', 'admin']) {
      await models.User.updateOne({ _id: id }, { $set: { role } });
      const response = await request(app).patch('/api/auth/me').auth(token, { type: 'bearer' })
        .send({ name: ' Updated ', interests: [' Coding ', 'coding'] });
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ id, name: 'Updated', interests: ['coding'], email: 'member@example.test', role });
      safe(response.body);
    }
    const cleared = await request(app).patch('/api/auth/me').auth(token, { type: 'bearer' }).send({ interests: [] });
    expect(cleared.body.data.interests).toEqual([]);
    expect((await request(app).get('/api/auth/me').auth(token, { type: 'bearer' })).body).toEqual(cleared.body);
  });
  it('rejects privilege, identity, password, internal, and operator updates without changing the account', async () => {
    const { id, token } = await registerAndLogin();
    for (const body of [{}, { role: 'admin' }, { email: 'new@example.test' }, { password }, { passwordHash: 'raw' },
      { _id: new Types.ObjectId() }, { tokenVersion: 0 }, { contentRevision: 0 }, { $set: { role: 'admin' } },
      { name: { $ne: null } }, { interests: [' '] }]) {
      expect((await request(app).patch('/api/auth/me').auth(token, { type: 'bearer' }).send(body)).status).toBe(400);
    }
    expect((await request(app).patch('/api/auth/me?role=admin').auth(token, { type: 'bearer' }).send({ name: 'Updated' })).status).toBe(400);
    expect((await request(app).patch('/api/auth/me').send({ name: 'Updated' })).status).toBe(401);
    expect(await models.User.findById(id).lean()).toMatchObject({ name: 'Member', role: 'user', email: 'member@example.test' });
  });
});

it('rate limits login and registration independently before hashing and ignores spoofed proxy headers', async () => {
  const limited = application({ AUTH_LOGIN_LIMIT: 2, AUTH_REGISTER_LIMIT: 1 });
  const body = { email: 'absent@example.test', password };
  for (let i = 0; i < 2; i++) expect((await request(limited).post('/api/auth/login').send(body)).status).toBe(401);
  const blocked = await request(limited).post('/api/auth/login').set('X-Forwarded-For', '203.0.113.5').send(body);
  expect(blocked.status).toBe(429);
  expect(blocked.body.error.code).toBe('RATE_LIMITED');
  expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  expect((await request(limited).post('/api/auth/register').send(registration)).status).toBe(201);
  expect((await request(limited).post('/api/auth/register').send({ ...registration, email: 'another@example.test' })).status).toBe(429);
  expect(await models.User.countDocuments()).toBe(1);
});

it('keeps credentials, bearer tokens, and hashes out of authentication request logs', async () => {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
  const logged = createApp({ logger: pino({ level: 'info' }, sink), isDatabaseReady: async () => true,
    auth: { connection, config: testEnvironment() } });
  expect((await request(logged).post('/api/auth/register').send(registration)).status).toBe(201);
  const login = await request(logged).post('/api/auth/login').send({ email: registration.email, password });
  expect(login.status).toBe(200);
  await request(logged).get('/api/auth/me').auth(login.body.data.accessToken, { type: 'bearer' });
  expect(output).toContain('Request completed');
  expect(output).not.toContain(password);
  expect(output).not.toContain('member@example.test');
  expect(output).not.toContain(login.body.data.accessToken);
  expect(output).not.toContain('$argon2');
});

describe('actual admin command', () => {
  it('installs indexes, hashes credentials, refuses duplicates, and recovers only with the explicit flag', async () => {
    await models.User.collection.dropIndex('users_email_unique');
    const credentials = { ADMIN_NAME: ' First Admin ', ADMIN_EMAIL: ' Admin@Example.Test ', ADMIN_PASSWORD: password };
    try {
      const created = await adminCommand(credentials);
      expect(created.code, created.output).toBe(0);
    } finally { await ensureIndexes(connection); }
    const user = (await models.User.findOne({ email: 'admin@example.test' }).select('+passwordHash +tokenVersion'))!;
    expect(user.role).toBe('admin');
    expect(await verifyPassword(user.passwordHash, password)).toBe(true);
    const login = await request(app).post('/api/auth/login').send({ email: 'admin@example.test', password });
    expect(login.status).toBe(200);
    const refused = await adminCommand({ ...credentials, ADMIN_PASSWORD: 'replacement password' });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain('email already exists');
    expect(await verifyPassword((await models.User.findById(user._id).select('+passwordHash'))!.passwordHash, password)).toBe(true);
    await models.User.updateOne({ _id: user._id }, { $set: { role: 'user' } });
    const recovered = await adminCommand({ ...credentials, ADMIN_PASSWORD: 'replacement password' }, ['--recover']);
    expect(recovered.code, recovered.output).toBe(0);
    expect((await models.User.findById(user._id).select('+tokenVersion'))).toMatchObject({ role: 'admin', tokenVersion: 1 });
    expect((await request(app).get('/api/auth/me').auth(login.body.data.accessToken, { type: 'bearer' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'admin@example.test', password: 'replacement password' })).status).toBe(200);
    for (const output of [refused.output, recovered.output]) expect(output).not.toContain(password);
  });
  it('has no default credentials, refuses unknown arguments and refuses recovery of missing accounts', async () => {
    for (const result of [
      await adminCommand({}),
      await adminCommand({ ADMIN_NAME: 'Admin', ADMIN_EMAIL: 'absent@example.test', ADMIN_PASSWORD: password }, ['--recover']),
      await adminCommand({ ADMIN_NAME: 'Admin', ADMIN_EMAIL: 'absent@example.test', ADMIN_PASSWORD: password }, ['--force'])
    ]) {
      expect(result.code).toBe(1);
      expect(result.output).not.toContain(password);
    }
    expect(await models.User.countDocuments()).toBe(0);
  });
});
