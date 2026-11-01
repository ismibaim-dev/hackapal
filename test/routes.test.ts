import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { OrderService } from '../src/orders.js';
import { InMemoryOrderStore } from '../src/store.js';
import { eventually, FakePayPal } from './helpers.js';

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
    ...env,
  });
  const paypal = new FakePayPal();
  const store = new InMemoryOrderStore();
  const orders = new OrderService({
    catalog: createCatalog(),
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { res, body: (await res.json()) as Record<string, unknown> };
}

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
    const broken = await fetch(`${base}/api/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    expect(broken.status).toBe(400);
  });

  it('refreshes status on GET and captures on POST .../capture', async () => {
    const { base, paypal } = await start();
    const { body } = await createOrder(base);
    const id = String(body.order_id);
    expect(((await (await fetch(`${base}/api/orders/${id}`)).json()) as { status: string }).status).toBe('CREATED');
    paypal.approve(String(body.paypal_order_id));
    const capture = await fetch(`${base}/api/orders/${id}/capture`, { method: 'POST' });
    expect(await capture.json()).toMatchObject({ outcome: 'completed', order: { status: 'COMPLETED' } });
    expect((await fetch(`${base}/api/orders/ord_missing`)).status).toBe(404);
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
    const view = (await (await fetch(`${base}/api/orders/${body.order_id}`)).json()) as Record<string, unknown>;
    expect(view.webhooks_received).toEqual([
      expect.objectContaining({ event_id: 'WH-1', event_type: 'CHECKOUT.ORDER.APPROVED' }),
    ]);
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
