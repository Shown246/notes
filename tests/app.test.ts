import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/middleware/logging.js';

function application(ready = true) {
  return createApp({ logger: createLogger('silent'), isDatabaseReady: async () => ready });
}

describe('HTTP foundation', () => {
  it('returns readiness and protective headers with a locally generated request ID', async () => {
    const response = await request(application()).get('/api/health').set('X-Request-Id', 'untrusted');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { status: 'ok' } });
    expect(response.headers['x-request-id']).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('returns the same JSON error contract for database unavailability and missing routes', async () => {
    for (const [path, status, code] of [['/api/health', 503, 'DATABASE_UNAVAILABLE'], ['/api/missing', 404, 'NOT_FOUND'], ['/missing', 404, 'NOT_FOUND']] as const) {
      const response = await request(application(false)).get(path);
      expect(response.status).toBe(status);
      expect(response.body.error).toMatchObject({ code, requestId: response.headers['x-request-id'] });
      expect(response.body.error.stack).toBeUndefined();
    }
  });
  it('does not leak unexpected errors and handles rejected asynchronous handlers', async () => {
    const app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => { throw new Error('mongodb://private:secret@host'); } });
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
  it('maps database connection failures to a sanitized 503', async () => {
    const app = createApp({ logger: createLogger('silent'), isDatabaseReady: async () => {
      const error = new Error('mongodb://private:secret@host');
      error.name = 'MongoNetworkError';
      throw error;
    } });
    const response = await request(app).get('/api/health');
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });
  it('rejects malformed and oversized JSON before routing', async () => {
    const invalid = await request(application()).post('/api/missing').set('Content-Type', 'application/json').send('{');
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_JSON');
    const large = await request(application()).post('/api/missing').send({ content: 'x'.repeat(110_000) });
    expect(large.status).toBe(413);
    expect(large.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
  it('serves handwritten static content and reserves missing API routes as JSON', async () => {
    const response = await request(application()).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('<h1>Secure Notes</h1>');
    expect((await request(application()).get('/api/index.html')).status).toBe(404);
    expect((await request(application()).get('/.env')).status).toBe(404);
  });
  it('logs safe request metadata without headers, body, URL query or path secrets', async () => {
    let output = '';
    const sink = new Writable({ write(chunk, _encoding, done) { output += String(chunk); done(); } });
    const logger = pino({ level: 'info' }, sink);
    const app = createApp({ logger, isDatabaseReady: async () => true });
    await request(app).post('/api/private-path?token=private-query')
      .set('Authorization', 'Bearer private-token').set('Cookie', 'session=private-cookie')
      .send({ password: 'private-password' });
    expect(output).toContain('Request completed');
    expect(output).not.toMatch(/private-(path|query|token|cookie|password)/);
  });
});
