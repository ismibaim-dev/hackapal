import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import type { McpLimits } from '../src/mcp.js';
import { OrderService } from '../src/orders.js';
import { RateLimiter } from '../src/rate-limit.js';
import { InMemoryOrderStore } from '../src/store.js';
import { FakePayPal } from './helpers.js';

describe('RateLimiter', () => {
  it('allows `limit` hits per window per key, then reports when to retry', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 2, windowMs: 10_000, now: () => now });
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.hit('a')).toMatchObject({ allowed: true, remaining: 0 });
    now = 4_000;
    expect(limiter.hit('a')).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 6 });
    expect(limiter.hit('b').allowed).toBe(true);
    now = 10_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('prunes expired windows instead of growing without bound', () => {
    let now = 0;
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, now: () => now, maxKeys: 2 });
    limiter.hit('a');
    limiter.hit('b');
    now = 5_000;
    limiter.hit('c');
    // 'a' was pruned, so it starts a fresh window and is allowed again.
    expect(limiter.hit('a').allowed).toBe(true);
  });
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function start(limits: McpLimits) {
  const config = loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://shop.example' });
  const paypal = new FakePayPal();
  const orders = new OrderService({
    catalog: createCatalog(),
    store: new InMemoryOrderStore(),
    paypal,
    publicBaseUrl: config.publicBaseUrl,
    allowSimulatedDecline: true,
  });
  const app = createApp({ config, orders, paypal, mcpLimits: limits });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, paypal };
}

const roomy = () => new RateLimiter({ limit: 1000, windowMs: 60_000 });

describe('/mcp limits', () => {
  it('answers 429 with Retry-After once a client exceeds its request budget', async () => {
    const { url } = await start({ requestsPerIp: new RateLimiter({ limit: 2, windowMs: 60_000 }), ordersPerIp: roomy(), ordersGlobal: roomy() });
    const ping = () =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    expect((await ping()).status).not.toBe(429);
    expect((await ping()).status).not.toBe(429);
    const limited = await ping();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('caps create_order without calling PayPal, but still lets the client browse', async () => {
    const { url, paypal } = await start({
      requestsPerIp: roomy(),
      ordersPerIp: new RateLimiter({ limit: 1, windowMs: 60_000 }),
      ordersGlobal: roomy(),
    });
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    cleanups.push(() => client.close());

    const order = { name: 'create_order', arguments: { items: [{ product_id: 'kuih-lapis', quantity: 1 }] } };
    expect((await client.callTool(order)).isError).toBeFalsy();
    const second = (await client.callTool(order)) as { isError?: boolean; content: { text: string }[] };
    expect(second.isError).toBe(true);
    expect(second.content[0]!.text).toMatch(/too many new orders.*Nothing was created or charged/);
    expect(paypal.createCalls).toHaveLength(1);
    expect((await client.callTool({ name: 'list_products', arguments: {} })).isError).toBeFalsy();
  });
});
