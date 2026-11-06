import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Connection } from 'mongoose';
import { Types } from 'mongoose';
import { getModels } from '../../src/config/models.js';
import { connectDatabase } from '../../src/config/database.js';
import { verifyIndexes } from '../../src/config/indexes.js';
import { verifyPassword } from '../../src/modules/auth/password.js';
import { seedDemo } from '../../scripts/seed-fixtures.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
const password = 'seed-test-only-password';
beforeAll(async () => { connection = await testConnection(); models = getModels(connection); });
beforeEach(async () => {
  await models.Note.deleteMany({});
  await models.Post.deleteMany({});
  await models.User.deleteMany({});
});
afterAll(async () => { await connection?.close(); });

function command(overrides: NodeJS.ProcessEnv, args: string[] = []) {
  const config = testEnvironment();
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../scripts/seed-demo.ts', import.meta.url)), ...args], {
      env: { ...process.env, ...Object.fromEntries(Object.entries(config).map(([key, value]) => [key, String(value)])),
        DOTENV_CONFIG_PATH: '.nonexistent-test-env', ...overrides },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
}

describe('explicit additive demo fixtures', () => {
  it('uses normalized model writes, real hashes and bounded pageable fixtures without creating admins', async () => {
    await seedDemo(connection, password);
    expect(await models.User.countDocuments()).toBe(12);
    expect(await models.Note.countDocuments()).toBe(84);
    expect(await models.Post.countDocuments()).toBe(84);
    expect(await models.User.countDocuments({ role: 'admin' })).toBe(0);
    const user = await models.User.findOne({ email: 'demo01@example.test' }).select('+passwordHash').orFail();
    expect(user.interests).toEqual(['chess', 'topic-01', 'hobby-01']);
    expect(await verifyPassword(user.passwordHash, password)).toBe(true);
    expect(await models.Note.countDocuments({ ownerId: user._id })).toBe(7);
    expect(await models.Post.countDocuments({ authorId: user._id })).toBe(7);
    await verifyIndexes(connection);
  });

  it('retains existing passwords, profile/content edits and unrelated accounts on repeat runs', async () => {
    await seedDemo(connection, password);
    const user = await models.User.findOne({ email: 'demo01@example.test' }).orFail();
    await models.User.updateOne({ _id: user._id }, { $set: { name: 'Edited', interests: ['music'] } });
    await models.Note.updateOne({ ownerId: user._id }, { $set: { title: 'Edited note' } });
    await models.User.create({ name: 'Retained admin', email: 'admin@example.test', role: 'admin', passwordHash: 'synthetic-hash' });
    await seedDemo(connection, 'different-seed-password');
    const retained = await models.User.findById(user._id).select('+passwordHash').orFail();
    expect(retained).toMatchObject({ name: 'Edited', interests: ['music'] });
    expect(await verifyPassword(retained.passwordHash, password)).toBe(true);
    expect(await models.Note.countDocuments({ title: 'Edited note' })).toBe(1);
    expect(await models.User.countDocuments()).toBe(13);
    expect(await models.Note.countDocuments()).toBe(84);
    expect(await models.Post.countDocuments()).toBe(84);
  });

  it('rolls back every fixture on a conflicting ID and rejects invalid passwords before writes', async () => {
    await expect(seedDemo(connection, 'short')).rejects.toThrow();
    expect(await models.User.countDocuments()).toBe(0);
    await models.Post.create({ _id: new Types.ObjectId('de9000000000000300000065'), authorId: new Types.ObjectId(), title: 'Collision', body: 'Retain' });
    await expect(seedDemo(connection, password)).rejects.toThrow('Fixture ID collision');
    expect(await models.User.countDocuments()).toBe(0);
    expect(await models.Note.countDocuments()).toBe(0);
    expect(await models.Post.countDocuments()).toBe(1);
  });

  it('refuses unsafe destinations, production, missing acknowledgement/password, and unsupported arguments without leaking input', async () => {
    const config = testEnvironment();
    const demoUri = config.MONGODB_URI.replace(/\/notes_test_[a-f0-9]{32}/, '/notes_demo_command');
    for (const [overrides, args] of [
      [{ NODE_ENV: 'development', SEED_DATABASE: 'notes_demo_command', SEED_PASSWORD: password }, []],
      [{ NODE_ENV: 'production', MONGODB_URI: demoUri, SEED_DATABASE: 'notes_demo_command', SEED_PASSWORD: password }, []],
      [{ NODE_ENV: 'development', MONGODB_URI: demoUri, SEED_PASSWORD: password }, []],
      [{ NODE_ENV: 'development', MONGODB_URI: demoUri, SEED_DATABASE: 'notes_demo_command' }, []],
      [{ NODE_ENV: 'development', MONGODB_URI: demoUri, SEED_DATABASE: 'notes_demo_command', SEED_PASSWORD: password }, ['--reset']]
    ] as [NodeJS.ProcessEnv, string[]][]) {
      const result = await command({ SEED_DATABASE: '', SEED_PASSWORD: '', ...overrides }, args);
      expect(result.code).toBe(1);
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain(config.MONGODB_URI);
      expect(result.output).not.toContain(demoUri);
    }
    expect(await models.User.countDocuments()).toBe(0);
  });

  it('runs the actual command twice against an explicitly selected disposable demo database', async () => {
    const config = testEnvironment();
    const name = `notes_demo_${config.MONGODB_URI.match(/notes_test_([a-f0-9]{32})/)![1]}`;
    const demo = await connectDatabase({ ...config, MONGODB_URI: config.MONGODB_URI.replace(/notes_test_[a-f0-9]{32}/, name) });
    try {
      for (let i = 0; i < 2; i++) {
        const result = await command({ NODE_ENV: 'development',
          MONGODB_URI: config.MONGODB_URI.replace(/notes_test_[a-f0-9]{32}/, name),
          SEED_DATABASE: name, SEED_PASSWORD: password });
        expect(result.code, result.output).toBe(0);
        expect(result.output).toContain('Demo fixtures ready');
        expect(result.output).not.toContain(password);
      }
      const seeded = getModels(demo);
      expect(await seeded.User.countDocuments()).toBe(12);
      expect(await seeded.Note.countDocuments()).toBe(84);
      expect(await seeded.Post.countDocuments()).toBe(84);
      await verifyIndexes(demo);
    } finally { await demo.close(); }
  });
});
