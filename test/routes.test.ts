import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { OrderService } from '../src/orders.js';
import { createPlatform } from '../src/platform.js';
import { InMemoryOrderStore } from '../src/store.js';
import { eventually, FakePayPal } from './helpers.js';

const API_KEY = 'test-api-key-0123456789abcdef';
const AUTH = { authorization: `Bearer ${API_KEY}` };
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
});

async function start(env: Record<string, string> = {}, withOrders = true) {
  const config = loadConfig({
    PAYPAL_CLIENT_ID: 'id',
    PAYPAL_CLIENT_SECRET: 'secret',
    PAYPAL_WEBHOOK_ID: 'WH-ID-1',
    PUBLIC_BASE_URL: 'https://shop.example',
    API_KEY,
    ...env,
  });
  const paypal = new FakePayPal();
  const store = new InMemoryOrderStore();
  const orders = new OrderService({
    platform: createPlatform(),
    store,
    paypal,
    publicBaseUrl: config.publicBaseUrl,
    allowSimulatedDecline: true,
  });
  const app = createApp(withOrders ? { config, orders, paypal } : { config });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, paypal, store, orders };
}

async function createOrder(base: string, body: unknown = { items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] }) {
  const res = await fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /health', () => {
  it('answers without touching PayPal or the store, even if PayPal never responds', async () => {
    const { base, paypal } = await start();
    const never = () => new Promise<never>(() => undefined);
    paypal.createOrder = never;
    paypal.getOrder = never;
    paypal.captureOrder = never;
    paypal.verifyWebhookSignature = never;
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', paypal: { credentialsConfigured: true, webhookConfigured: true } });
  });

  it('lists which shops have their own seller chat, never the chat ids', async () => {
    const { base } = await start({
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_SHOP_CHATS: 'kampung-fresh-mart=-100777,kilat-home-cleaning=-100888',
      TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART: '777:grocer-secret-token',
    });
    const res = await fetch(`${base}/health`);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      sellerPing: 'telegram',
      sellerChats: ['kampung-fresh-mart', 'kilat-home-cleaning'],
      sellerBots: ['kampung-fresh-mart'],
    });
    expect(text).not.toContain('-100777');
    expect(text).not.toContain('grocer-secret-token');
  });
});

describe('security headers', () => {
  it('are sent on pages, JSON and errors alike', async () => {
    const { base } = await start();
    for (const path of ['/', '/health', '/paypal/return?token=nope', '/no-such-page']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });
});

describe('GET /', () => {
  it('lists every shop with its own MCP link', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('https://shop.example/mcp');
    expect(html).toContain('https://shop.example/s/kampung-fresh-mart/mcp');
    expect(html).toContain('Kilat Home Cleaning');
    expect(html).toContain('Auntie&#39;s Kitchen');
    expect(html).not.toContain('@');
  });
});

describe('/api/orders', () => {
  it('creates an order priced from the catalog, ignoring any price the client sends', async () => {
    const { base } = await start();
    const { res, body } = await createOrder(base, {
      items: [{ product_id: 'choc-chip-cookies', quantity: 2, price: 0.01, unit_price_cents: 1 }],
      total: '0.01',
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ status: 'CREATED', total: '$12.00', total_cents: 1200, simulate_decline: false });
    expect(String(body.approval_url)).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
  });

  it('rejects malformed input (400) and unknown products (422)', async () => {
    const { base } = await start();
    expect((await createOrder(base, { items: [{ product_id: 'choc-chip-cookies', quantity: 0 }] })).res.status).toBe(400);
    const unknown = await createOrder(base, { items: [{ product_id: 'caviar', quantity: 1 }] });
    expect(unknown.res.status).toBe(422);
    expect(unknown.body).toMatchObject({ error: 'cannot_price_cart', issues: [{ code: 'UNKNOWN_PRODUCT' }] });
    const broken = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json', ...AUTH }, body: '{' });
    expect(broken.status).toBe(400);
  });

  it('refreshes status on GET and captures on POST .../capture', async () => {
    const { base, paypal } = await start();
    const { body } = await createOrder(base);
    const id = String(body.order_id);
    expect(((await (await fetch(`${base}/api/orders/${id}`, { headers: AUTH })).json()) as { status: string }).status).toBe('CREATED');
    paypal.approve(String(body.paypal_order_id));
    const capture = await fetch(`${base}/api/orders/${id}/capture`, { method: 'POST', headers: AUTH });
    expect(await capture.json()).toMatchObject({ outcome: 'completed', order: { status: 'COMPLETED' } });
    expect((await fetch(`${base}/api/orders/ord_missing`, { headers: AUTH })).status).toBe(404);
  });

  it('shows and restocks live stock behind the API key', async () => {
    const { base } = await start();
    const json = { 'content-type': 'application/json', ...AUTH };
    const before = (await (await fetch(`${base}/api/stock`, { headers: AUTH })).json()) as { products: { product_id: string; in_stock: number }[] };
    expect(before.products.find((p) => p.product_id === 'choc-chip-cookies')?.in_stock).toBe(24);

    const ok = await fetch(`${base}/api/stock`, { method: 'PUT', headers: json, body: JSON.stringify({ levels: { 'choc-chip-cookies': 50 } }) });
    expect(ok.status).toBe(200);
    const after = (await ok.json()) as { products: { product_id: string; in_stock: number }[] };
    expect(after.products.find((p) => p.product_id === 'choc-chip-cookies')?.in_stock).toBe(50);

    const bad = await fetch(`${base}/api/stock`, { method: 'PUT', headers: json, body: JSON.stringify({ levels: { caviar: 5 } }) });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/stock`)).status).toBe(401);
  });

  it('lists stock per shop and creates orders for a named shop', async () => {
    const { base } = await start();
    const grocer = (await (await fetch(`${base}/api/stock?shop=kampung-fresh-mart`, { headers: AUTH })).json()) as {
      products: { shop_id: string; product_id: string }[];
    };
    expect(grocer.products).toHaveLength(6);
    expect(grocer.products.every((p) => p.shop_id === 'kampung-fresh-mart')).toBe(true);
    expect((await fetch(`${base}/api/stock?shop=nope`, { headers: AUTH })).status).toBe(404);

    const ok = await createOrder(base, { shop_id: 'kilat-home-cleaning', items: [{ product_id: 'sofa-shampoo', quantity: 1 }] });
    expect(ok.res.status).toBe(201);
    expect(ok.body).toMatchObject({ total: '$40.00', shop: { shop_id: 'kilat-home-cleaning' } });
    const wrong = await createOrder(base, { shop_id: 'nope', items: [{ product_id: 'sofa-shampoo', quantity: 1 }] });
    expect(wrong.res.status).toBe(422);
    expect(JSON.stringify(wrong.body)).toContain('UNKNOWN_SHOP');
  });

  it('refuses requests without the right API key', async () => {
    const { base, paypal } = await start();
    const body = JSON.stringify({ items: [{ product_id: 'choc-chip-cookies', quantity: 1 }] });
    const json = { 'content-type': 'application/json' };
    const none = await fetch(`${base}/api/orders`, { method: 'POST', headers: json, body });
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await fetch(`${base}/api/orders`, { method: 'POST', headers: { ...json, authorization: 'Bearer nope' }, body });
    expect(wrong.status).toBe(401);
    const viaHeader = await fetch(`${base}/api/orders`, { method: 'POST', headers: { ...json, 'x-api-key': API_KEY }, body });
    expect(viaHeader.status).toBe(201);
    expect((await fetch(`${base}/api/orders/ord_x`)).status).toBe(401);
    expect(paypal.createCalls).toHaveLength(1);
  });

  it('switches /api off when no API key is configured', async () => {
    const { base } = await start({ API_KEY: '' });
    expect((await fetch(`${base}/api/orders/ord_x`, { headers: AUTH })).status).toBe(503);
    expect(await (await fetch(`${base}/health`)).json()).toMatchObject({ apiKeyConfigured: false });
  });

  it('answers 503 when PayPal is not configured', async () => {
    const { base } = await start({}, false);
    expect((await createOrder(base)).res.status).toBe(503);
  });
});

describe('/paypal/return and /paypal/cancel', () => {
  it('captures on return and shows the success page', async () => {
    const { base, paypal, store } = await start();
    const { body } = await createOrder(base);
    paypal.approve(String(body.paypal_order_id));
    const res = await fetch(`${base}/paypal/return?token=${body.paypal_order_id}&PayerID=TESTPAYER`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('Payment complete, you can go back to your assistant.');
    expect((await store.get(String(body.order_id)))?.status).toBe('COMPLETED');
  });

  it('redirects the buyer back to the same approval link after a decline', async () => {
    const { base, paypal, store } = await start();
    const { body } = await createOrder(base, { items: [{ product_id: 'kuih-lapis', quantity: 1 }], simulate_decline: true });
    expect(body.simulate_decline).toBe(true);
    paypal.approve(String(body.paypal_order_id));
    const res = await fetch(`${base}/paypal/return?token=${body.paypal_order_id}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(body.approval_url);
    expect((await store.get(String(body.order_id)))?.status).toBe('NEEDS_NEW_FUNDING');

    // Buyer re-approves with another funding source and returns again.
    const again = await fetch(`${base}/paypal/return?token=${body.paypal_order_id}`);
    expect(await again.text()).toContain('Payment complete');
  });

  it('shows a friendly page for an unknown token and for a cancel', async () => {
    const { base, store } = await start();
    expect((await fetch(`${base}/paypal/return?token=NOPE`)).status).toBe(404);
    const { body } = await createOrder(base);
    const cancel = await fetch(`${base}/paypal/cancel?token=${body.paypal_order_id}`);
    expect(cancel.status).toBe(200);
    expect(await cancel.text()).toContain('Nothing was charged.');
    expect((await store.get(String(body.order_id)))?.status).toBe('CANCELLED');
  });

  it('escapes everything it echoes', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/paypal/cancel?token=%3Cscript%3E`);
    expect(await res.text()).not.toContain('<script>');
  });
});

describe('POST /webhooks/paypal', () => {
  const headers = {
    'content-type': 'application/json',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1',
    'paypal-transmission-id': 'tx-1',
    'paypal-transmission-sig': 'sig',
    'paypal-transmission-time': '2026-11-01T12:00:00Z',
  };

  it('hands the verifier the raw body byte for byte, answers 200, then processes', async () => {
    const { base, paypal, store } = await start();
    const { body } = await createOrder(base);
    paypal.approve(String(body.paypal_order_id));
    const raw = `{"id":"WH-1",   "event_type":"CHECKOUT.ORDER.APPROVED","resource":{"id":"${body.paypal_order_id}"},"note":"café ✓"}`;

    const res = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: raw });
    expect(res.status).toBe(200);
    expect(paypal.verifyCalls).toHaveLength(1);
    const call = paypal.verifyCalls[0]!;
    expect(call.rawBody.equals(Buffer.from(raw, 'utf8'))).toBe(true);
    expect(call.webhookId).toBe('WH-ID-1');
    expect(call.headers['paypal-transmission-id']).toBe('tx-1');

    await eventually(async () => (await store.get(String(body.order_id)))?.status === 'COMPLETED');
    const view = (await (await fetch(`${base}/api/orders/${body.order_id}`, { headers: AUTH })).json()) as Record<string, unknown>;
    expect(view.webhooks_received).toEqual([
      expect.objectContaining({ event_id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED' }),
    ]);
  });

  it('handles a redelivered event (PayPal retry) without acting twice', async () => {
    const { base, paypal, store } = await start();
    const { body } = await createOrder(base);
    paypal.approve(String(body.paypal_order_id));
    const raw = JSON.stringify({ id: 'WH-RETRY', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: body.paypal_order_id } });

    const first = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: raw });
    await eventually(async () => (await store.get(String(body.order_id)))?.status === 'COMPLETED');
    const second = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: raw });
    await new Promise((r) => setTimeout(r, 20));

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(paypal.verifyCalls).toHaveLength(2);
    expect(paypal.captureCalls).toHaveLength(1);
    // The event-id dedupe caught the second delivery: it was never recorded or processed.
    const view = (await (await fetch(`${base}/api/orders/${body.order_id}`, { headers: AUTH })).json()) as Record<string, unknown>;
    expect(view.webhooks_received).toEqual([expect.objectContaining({ event_id: 'WH-RETRY' })]);
  });

  it('rejects an unverified event with 400 and does not process it', async () => {
    const { base, paypal, store } = await start();
    const { body } = await createOrder(base);
    paypal.approve(String(body.paypal_order_id));
    paypal.verifyResult = false;
    const event = { id: 'WH-2', event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: body.paypal_order_id } };
    const res = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: JSON.stringify(event) });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 20));
    expect(paypal.captureCalls).toHaveLength(0);
    expect((await store.get(String(body.order_id)))?.status).toBe('CREATED');
  });

  it('answers 503 when verification is unavailable, so PayPal retries', async () => {
    const { base, paypal } = await start();
    paypal.verifyResult = new Error('PayPal down');
    const res = await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: '{"id":"WH-3"}' });
    expect(res.status).toBe(503);
  });

  it('refuses invalid JSON without calling PayPal, and refuses everything without a webhook id', async () => {
    const { base, paypal } = await start();
    expect((await fetch(`${base}/webhooks/paypal`, { method: 'POST', headers, body: 'not json' })).status).toBe(400);
    expect(paypal.verifyCalls).toHaveLength(0);

    const noId = await start({ PAYPAL_WEBHOOK_ID: '' });
    expect((await fetch(`${noId.base}/webhooks/paypal`, { method: 'POST', headers, body: '{}' })).status).toBe(503);
  });
});
