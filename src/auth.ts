import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { log } from './log.js';

/**
 * API key check for the internal /api routes. The key comes from the API_KEY env var
 * and is accepted as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Without a
 * configured key the routes are switched off (503), so they can't be left open by mistake.
 * Comparison is constant-time over SHA-256 digests, so length differences don't leak either.
 */
export function requireApiKey(apiKey: string | undefined): RequestHandler {
  const expected = apiKey ? digest(apiKey) : undefined;
  return (req, res, next) => {
    if (!expected) {
      res.status(503).json({ error: 'api_disabled', message: 'Set API_KEY to enable /api.' });
      return;
    }
    const presented = bearer(req.get('authorization')) ?? req.get('x-api-key');
    if (presented && timingSafeEqual(digest(presented), expected)) {
      next();
      return;
    }
    log.warn('api request rejected: bad or missing API key', { method: req.method, path: req.originalUrl, ip: req.ip });
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
  };
}

function bearer(header: string | undefined): string | undefined {
  const match = header ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
  return match?.[1]?.trim();
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
