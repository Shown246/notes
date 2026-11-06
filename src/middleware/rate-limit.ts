import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';

// Fixed-window, per-peer limits for this single-process deployment. Memory is
// bounded; X-Forwarded-For is ignored because Express trust proxy stays disabled.
export function createRateLimiter(
  options: { max: number; windowMs: number; maxKeys?: number }, now = Date.now
): RequestHandler {
  const entries = new Map<string, { count: number; expires: number }>();
  return (request, response, next) => {
    const time = now();
    const key = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    let entry = entries.get(key);
    if (entry && entry.expires <= time) { entries.delete(key); entry = undefined; }
    if (!entry && entries.size >= (options.maxKeys ?? 10_000)) {
      for (const [ip, value] of entries) if (value.expires <= time) entries.delete(ip);
    }
    if (!entry && entries.size < (options.maxKeys ?? 10_000)) {
      entry = { count: 0, expires: time + options.windowMs };
      entries.set(key, entry);
    }
    if (!entry || entry.count >= options.max) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil(((entry?.expires ?? time + options.windowMs) - time) / 1000))));
      throw new AppError(429, 'RATE_LIMITED', 'Too many attempts; try again later');
    }
    entry.count++;
    next();
  };
}
