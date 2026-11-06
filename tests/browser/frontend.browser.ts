import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { chromium, expect as check } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Connection } from 'mongoose';
import { createApp } from '../../src/app.js';
import { getModels } from '../../src/config/models.js';
import { ensureIndexes } from '../../src/config/indexes.js';
import { createLogger } from '../../src/middleware/logging.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { testConnection, testEnvironment } from '../helpers/database.js';

let connection: Connection;
let models: ReturnType<typeof getModels>;
let server: Server;
let browser: Browser;
let session: BrowserContext;
let page: Page;
let origin: string;
let passwordHash: string;
const password = 'browser-test-password';
const errors: string[] = [];

beforeAll(async () => {
  connection = await testConnection();
  models = getModels(connection);
  await ensureIndexes(connection);
  passwordHash = await hashPassword(password);
  const config = { ...testEnvironment(), AUTH_LOGIN_LIMIT: 1000, AUTH_REGISTER_LIMIT: 1000 };
  const app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => true, auth: { connection, config } });
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP port');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});
beforeEach(async () => {
  await models.Note.deleteMany({});
  await models.Post.deleteMany({});
  await models.User.deleteMany({});
  await models.User.create([
    { name: 'Admin', email: 'admin@example.test', passwordHash, role: 'admin', interests: ['chess'] },
    { name: 'Alice', email: 'alice@example.test', passwordHash, interests: ['chess', 'reading'] },
    { name: 'Bob', email: 'bob@example.test', passwordHash, interests: [] }
  ]);
  session = await browser.newContext();
  page = await session.newPage();
  errors.length = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
});
afterEach(async () => {
  await session?.close();
  expect(errors).toEqual([]);
});
afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await connection?.close();
});

async function login(email = 'alice@example.test', target = page, secret = password) {
  await target.getByLabel('Email', { exact: true }).fill(email);
  await target.getByLabel('Password (12–128 characters)', { exact: true }).fill(secret);
  await target.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
  await check(target.getByRole('heading', { name: 'My notes', exact: true })).toBeVisible();
}
async function nav(label: string, target = page) {
  await target.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();
}
async function createNote(title: string, content = 'Private content', target = page) {
  await target.getByRole('button', { name: 'Create note', exact: true }).click();
  await target.getByLabel('Title', { exact: true }).fill(title);
  await target.getByLabel('Content', { exact: true }).fill(content);
  await target.getByRole('button', { name: 'Save note' }).click();
  await check(target.getByRole('heading', { name: title, exact: true })).toBeVisible();
}
async function row(title: string, target = page) {
  const result = target.locator('article').filter({ has: target.getByRole('heading', { name: title, exact: true }) });
  await check(result).toBeVisible();
  return result;
}

describe('handwritten frontend with real API and MongoDB', () => {
  it('browses posts anonymously and exposes complete author and interest views', async () => {
    const alice = (await models.User.findOne({ email: 'alice@example.test' }))!;
    await models.Post.insertMany(Array.from({ length: 25 }, (_, i) => ({ authorId: alice._id, title: `Public post ${i}`, body: 'Public body' })));
    await nav('Posts');
    await check(page.getByRole('heading', { name: 'Posts', exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Create post', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Posts by ${alice.id}`, exact: true }).first().click();
    await page.getByRole('button', { name: 'Show all author posts', exact: true }).click();
    await check(page.locator('article')).toHaveCount(25);
    await nav('Log in');
    await login('admin@example.test');
    await nav('Interests report');
    await page.getByRole('button', { name: 'Show all groups and members', exact: true }).click();
    await check(page.locator('article').filter({ has: page.getByRole('heading', { name: 'chess', exact: true }) }).getByRole('listitem')).toHaveCount(2);
  });
  it('registers, surfaces validation/credential errors, edits a normalized profile, and forgets login after reload', async () => {
    await nav('Register');
    await page.getByLabel('Name', { exact: true }).fill('New User');
    await page.getByLabel('Email', { exact: true }).fill('new@example.test');
    await page.getByLabel('Password (12–128 characters)').fill(password);
    await page.getByLabel('Interests', { exact: false }).fill('chess,,reading');
    await page.getByRole('button', { name: 'Create account' }).click();
    await check(page.getByRole('alert')).toContainText('interests.1');
    await page.getByLabel('Interests', { exact: false }).fill(' Chess, chess, Reading ');
    await page.getByRole('button', { name: 'Create account' }).click();
    await check(page.getByText('Account created. Log in with your new credentials.')).toBeVisible();
    await page.getByLabel('Email', { exact: true }).fill('new@example.test');
    await page.getByLabel('Password (12–128 characters)').fill('incorrect-password');
    await page.locator('form').getByRole('button', { name: 'Log in', exact: true }).click();
    await check(page.getByRole('alert')).toContainText('Invalid');
    await login('new@example.test');
    await check(page.getByRole('button', { name: 'Manage users', exact: true })).toHaveCount(0);
    await nav('Profile');
    await check(page.getByLabel('Interests', { exact: false })).toHaveValue('chess, reading');
    await page.getByLabel('Name', { exact: true }).fill('Updated User');
    await page.getByLabel('Interests', { exact: false }).fill(' Music, MUSIC, chess ');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await check(page.getByLabel('Interests', { exact: false })).toHaveValue('music, chess');
    await check(page.locator('#account')).toContainText('Updated User');
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookie: document.cookie })))
      .toEqual({ local: 0, session: 0, cookie: '' });
    await page.reload();
    await check(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
  });

  it('completes own-note CRUD, treats hostile content as text, and isolates a second user', async () => {
    await login();
    await check(page.getByText('No notes on this page.')).toBeVisible();
    const title = '<img src=x onerror=alert(1)>';
    await createNote(title, '<script>throw new Error("unsafe")</script>');
    expect(await page.locator('article img').count()).toBe(0);
    await (await row(title)).getByRole('button', { name: 'Open note' }).click();
    await check(page.getByLabel('Content', { exact: true })).toHaveValue('<script>throw new Error("unsafe")</script>');
    await page.getByLabel('Title', { exact: true }).fill('Edited note');
    await page.getByRole('button', { name: 'Save note' }).click();
    await (await row('Edited note')).getByRole('button', { name: 'Open note' }).click();
    await page.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel deletion' }).click();
    await check(page.getByLabel('Title', { exact: true })).toHaveValue('Edited note');
    await page.getByRole('button', { name: 'Delete note', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm deletion' }).click();
    await check(page.getByText('No notes on this page.')).toBeVisible();
    await createNote('Retained Alice note');
    await nav('Log out');
    await login('bob@example.test');
    await check(page.getByText('No notes on this page.')).toBeVisible();
    await createNote('Bob note');
    await check(page.getByText('Retained Alice note', { exact: true })).toHaveCount(0);
  });

  it('paginates all six list views and resets cursors after mutations and author changes', async () => {
    const alice = await models.User.findOne({ email: 'alice@example.test' }).orFail();
    const admin = await models.User.findOne({ email: 'admin@example.test' }).orFail();
    await models.Note.create(Array.from({ length: 7 }, (_, i) => ({ ownerId: admin._id, title: `Note ${i}`, content: '' })));
    await models.Post.create(Array.from({ length: 7 }, (_, i) => ({ authorId: alice._id, title: `Post ${i}`, body: 'body' })));
    await models.User.create(Array.from({ length: 7 }, (_, i) => ({ name: `Member ${i}`, email: `member${i}@example.test`, passwordHash, interests: ['chess', `topic${i}`] })));
    await login('admin@example.test');
    async function traverse(label?: string) {
      if (label) await nav(label);
      await page.getByLabel('Page size', { exact: true }).selectOption('5');
      await check(page.locator('article')).toHaveCount(5);
      const first = await page.locator('article h3').allTextContents();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      await check(page.locator('article').first()).toBeVisible();
      const second = await page.locator('article h3').allTextContents();
      expect(second.some(title => first.includes(title))).toBe(false);
      await page.getByRole('button', { name: 'First page / Refresh' }).click();
      await check(page.locator('article h3')).toHaveText(first);
    }
    await traverse();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await check(page.locator('article')).toHaveCount(2);
    await createNote('Newest note');
    await check(page.locator('article').first()).toContainText('Newest note');
    await traverse('All notes');
    await traverse('Manage users');
    await traverse('Interests report');
    await traverse('Posts');
    await page.locator('article').first().getByRole('button', { name: /^Posts by/ }).click();
    await traverse();
    await check(page.getByText(`Author: Alice (${alice.id})`)).toBeVisible();
    await nav('Posts');
    await page.getByRole('button', { name: 'My author page' }).click();
    await check(page.getByText('No posts on this page.')).toBeVisible();
    await check(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  });

  it('creates posts and follows author links as either reader; admin reads both users notes without write controls', async () => {
    await login();
    await createNote('Alice private note', 'Alice secret');
    await nav('Posts');
    await check(page.getByText('No posts on this page.')).toBeVisible();
    await page.getByRole('button', { name: 'Create post', exact: true }).click();
    await page.getByLabel('Title', { exact: true }).fill('Shared post');
    await page.getByLabel('Body', { exact: true }).fill('<b>Literal body</b>');
    await page.getByRole('button', { name: 'Publish post' }).click();
    await check(page.getByText('<b>Literal body</b>', { exact: true })).toBeVisible();
    await nav('Log out');
    await login('bob@example.test');
    await createNote('Bob private note');
    await nav('Posts');
    await (await row('Shared post')).getByRole('button', { name: /^Posts by/ }).click();
    await check(page.getByText(/^Author: Alice/)).toBeVisible();
    await check(page.getByRole('heading', { name: 'Shared post' })).toBeVisible();
    await nav('Log out');
    await login('admin@example.test');
    await createNote('Admin own note');
    await nav('All notes');
    await check(page.locator('article')).toHaveCount(3);
    await (await row('Alice private note')).getByRole('button', { name: 'Open note' }).click();
    await check(page.getByText('Alice secret', { exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Save note' })).toHaveCount(0);
    await check(page.getByRole('button', { name: 'Delete note' })).toHaveCount(0);
  });

  it('admin creates, edits, resets passwords and deletes an account with its content, and displays report previews', async () => {
    await login('admin@example.test');
    await nav('Manage users');
    await (await row('Admin')).getByRole('button', { name: 'Edit user' }).click();
    await check(page.getByLabel('Role', { exact: true })).toBeDisabled();
    await check(page.getByRole('button', { name: 'Delete user', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to users' }).click();
    await page.getByRole('button', { name: 'Create user', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Managed');
    await page.getByLabel('Email', { exact: true }).fill('managed@example.test');
    await page.getByLabel('Password (12–128 characters)').fill(password);
    await page.getByLabel('Interests', { exact: false }).fill('Chess');
    await page.getByRole('button', { name: 'Save user' }).click();
    const other = await session.newPage();
    await other.goto(origin);
    await login('managed@example.test', other);
    await createNote('Managed note', 'content', other);
    await nav('Posts', other);
    await other.getByRole('button', { name: 'Create post', exact: true }).click();
    await other.getByLabel('Title', { exact: true }).fill('Managed post');
    await other.getByLabel('Body', { exact: true }).fill('content');
    await other.getByRole('button', { name: 'Publish post' }).click();
    await check(other.getByRole('heading', { name: 'Managed post' })).toBeVisible();
    await (await row('Managed')).getByRole('button', { name: 'Edit user' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Managed updated');
    await page.getByLabel('Role', { exact: true }).selectOption('admin');
    await page.getByLabel('New password', { exact: false }).fill('replacement-password');
    await page.getByRole('button', { name: 'Save user' }).click();
    await check(page.getByRole('heading', { name: 'Managed updated', exact: true })).toBeVisible();
    await nav('Profile', other);
    await check(other.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await check(other.getByText(/session expired or was invalidated/)).toBeVisible();
    await login('managed@example.test', other, 'replacement-password');
    await check(other.getByRole('button', { name: 'Manage users', exact: true })).toBeVisible();
    await (await row('Managed updated')).getByRole('button', { name: 'Edit user' }).click();
    await page.getByRole('button', { name: 'Delete user', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm deletion' }).click();
    await check(page.getByRole('heading', { name: 'Manage users', exact: true })).toBeVisible();
    expect(await models.Note.countDocuments({ title: 'Managed note' })).toBe(0);
    expect(await models.Post.countDocuments({ title: 'Managed post' })).toBe(0);
    await nav('Profile', other);
    await check(other.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await models.User.create(Array.from({ length: 6 }, (_, i) => ({ name: `Chess ${i}`, email: `chess${i}@example.test`, passwordHash, interests: ['chess'] })));
    await nav('Interests report');
    const chess = await row('chess');
    await check(chess).toContainText('Members: 8');
    await check(chess.locator('li')).toHaveCount(5);
    await check(chess).toContainText('More members exist');
    await mkdir('.cache/browser', { recursive: true });
    await page.screenshot({ path: '.cache/browser/interests-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 375, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/browser/interests-mobile.png', fullPage: true });
  });

  it('shows loading, 403 and server failures, and prevents late requests from restoring content after logout', async () => {
    await login('admin@example.test');
    await page.route('**/api/admin/users?*', route => route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN', message: 'Forbidden', requestId: 'test-request' } } }));
    await nav('Manage users');
    await check(page.getByRole('alert')).toContainText('Access denied');
    await check(page.getByRole('alert')).toContainText('test-request');
    await page.unroute('**/api/admin/users?*');
    await page.route('**/api/posts?*', route => route.fulfill({ status: 503, json: { error: { code: 'DATABASE_UNAVAILABLE', message: 'Database is unavailable' } } }));
    await nav('Posts');
    await check(page.getByRole('alert')).toContainText('Database is unavailable');
    await check(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await page.unroute('**/api/posts?*');
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/notes?*', async route => {
      await held;
      await route.fulfill({ json: { data: [{ title: 'Late private data', ownerId: 'hidden' }], pagination: { hasMore: false, nextCursor: null, limit: 20 } } });
    });
    await nav('My notes');
    await check(page.getByRole('status')).toContainText('Loading');
    await nav('Log out');
    release();
    await check(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await check(page.getByText('Late private data')).toHaveCount(0);
  });

  it('refreshes current role before admin navigation and ends the session at the declared lifetime', async () => {
    await login('admin@example.test');
    await models.User.updateOne({ email: 'admin@example.test' }, { $set: { role: 'user' } });
    await nav('Manage users');
    await check(page.getByRole('heading', { name: 'Access denied', exact: true })).toBeVisible();
    await check(page.getByRole('button', { name: 'Manage users', exact: true })).toHaveCount(0);
    await nav('Log out');
    await page.clock.install();
    await login();
    await page.clock.fastForward(901_000);
    await check(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await check(page.getByText('Your session expired. Please log in again.')).toBeVisible();
  });

  it('ends a self password-reset session, handles network failures, and clears login even for a non-JSON 401', async () => {
    await login('admin@example.test');
    await nav('Manage users');
    await (await row('Admin')).getByRole('button', { name: 'Edit user' }).click();
    await page.getByLabel('New password', { exact: false }).fill('changed-admin-password');
    await page.getByRole('button', { name: 'Save user' }).click();
    await check(page.getByText('Your password was reset. Log in with your new password.')).toBeVisible();
    await login('admin@example.test', page, 'changed-admin-password');
    await page.route('**/api/posts?*', route => route.abort('failed'));
    await nav('Posts');
    await check(page.getByRole('alert')).toContainText('Failed to fetch');
    await check(page.getByRole('button', { name: 'First page / Refresh' })).toBeEnabled();
    await page.unroute('**/api/posts?*');
    await page.getByRole('button', { name: 'First page / Refresh' }).click();
    await check(page.getByText('No posts on this page.')).toBeVisible();
    await page.route('**/api/auth/me', route => route.fulfill({ status: 401, contentType: 'text/plain', body: 'Unauthorized' }));
    await nav('Profile');
    await check(page.getByRole('heading', { name: 'Log in', exact: true })).toBeVisible();
    await check(page.getByText(/session expired or was invalidated/)).toBeVisible();
    await check(page.getByRole('button', { name: 'Manage users', exact: true })).toHaveCount(0);
  });
});
