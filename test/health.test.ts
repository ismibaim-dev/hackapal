import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const FAKE_SECRET = 'fake-client-secret-should-never-appear';
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({ PAYPAL_CLIENT_ID: 'fake-client-id', PAYPAL_CLIENT_SECRET: FAKE_SECRET });
  const app = createApp({ config });
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /health', () => {
  it('reports ok and PayPal readiness without leaking credentials', async () => {
    const res = await fetch(`${baseUrl}/health`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(FAKE_SECRET);
    expect(text).not.toContain('fake-client-id');

    const body = JSON.parse(text);
    expect(body).toMatchObject({
      status: 'ok',
      service: 'hackapal',
      paypal: { env: 'sandbox', credentialsConfigured: true, webhookConfigured: false },
    });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', path: '/nope' });
  });
});
