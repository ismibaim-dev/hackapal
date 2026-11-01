import { describe, expect, it } from 'vitest';
import { createCatalog } from '../src/catalog.js';
import { canTransition, OrderService, toOrderView, type SellerNotifier } from '../src/orders.js';
import { InMemoryOrderStore, ORDER_STATUSES, type Order } from '../src/store.js';
import { deferred, FakePayPal, paypalError } from './helpers.js';

const COOKIES = { items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] };

function setup(options: { allowSimulatedDecline?: boolean } = {}) {
  const catalog = createCatalog();
  const store = new InMemoryOrderStore();
  const paypal = new FakePayPal();
  const completed: Order[] = [];
  const notifier: SellerNotifier = {
    orderCompleted: async (order) => {
      completed.push(order);
    },
  };
  const service = new OrderService({
    catalog,
    store,
    paypal,
    publicBaseUrl: 'https://shop.example',
    allowSimulatedDecline: options.allowSimulatedDecline ?? true,
    notifier,
  });
  const stock = (id = 'choc-chip-cookies') => catalog.getProduct(id)!.stock;
  return { service, store, paypal, catalog, completed, stock };
}

async function created(s: ReturnType<typeof setup>, simulateDecline = false): Promise<Order> {
  const result = await s.service.createOrder(COOKIES, { simulateDecline });
  if (!result.ok) throw new Error('create failed');
  return result.order;
}

describe('OrderService.createOrder', () => {
  it('prices from the catalog and stores a CREATED order with the approval link', async () => {
    const s = setup();
    const order = await created(s);
    expect(order).toMatchObject({ status: 'CREATED', totalCents: 1200, currency: 'USD', captureAttempts: 0 });
    expect(order.approvalUrl).toBe(`https://www.sandbox.paypal.com/checkoutnow?token=${order.paypalOrderId}`);
    expect(s.paypal.createCalls[0]).toMatchObject({
      orderId: order.id,
      brandName: "Auntie's Kitchen",
      returnUrl: 'https://shop.example/paypal/return',
      cancelUrl: 'https://shop.example/paypal/cancel',
    });
    expect(s.paypal.createCalls[0]?.quote.totalCents).toBe(1200);
  });

  it('returns pricing issues without calling PayPal', async () => {
    const s = setup();
    const result = await s.service.createOrder({ items: [{ product_id: 'caviar', quantity: 1 }] });
    expect(result.ok).toBe(false);
    expect(s.paypal.createCalls).toHaveLength(0);
  });

  it('ignores simulate_decline when not allowed', async () => {
    const s = setup({ allowSimulatedDecline: false });
    expect((await created(s, true)).simulateDecline).toBe(false);
  });
});

describe('OrderService.capture', () => {
  it('captures an approved order once, takes stock and pings the seller', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);

    const result = await s.service.capture(order.id, 'return');
    expect(result.outcome).toBe('completed');
    expect(result.order).toMatchObject({ status: 'COMPLETED', captureId: `CAP-${order.paypalOrderId}` });
    expect(s.paypal.captureCalls[0]?.options).toEqual({ requestId: `capture-${order.id}-0`, simulateDecline: false });
    expect(s.stock()).toBe(22);
    await Promise.resolve();
    expect(s.completed.map((o) => o.id)).toEqual([order.id]);

    // A second capture is a no-op: no PayPal call, no second stock take.
    expect((await s.service.capture(order.id, 'api')).outcome).toBe('completed');
    expect(s.paypal.captureCalls).toHaveLength(1);
    expect(s.stock()).toBe(22);
  });

  it('shares one in-flight capture between concurrent callers (single-flight)', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    const gate = deferred();
    s.paypal.captureGate = gate.promise;

    const a = s.service.capture(order.id, 'return');
    const b = s.service.capture(order.id, 'webhook');
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.outcome).toBe('completed');
    expect(rb.outcome).toBe('completed');
    expect(s.paypal.captureCalls).toHaveLength(1);
    expect(s.stock()).toBe(22);
  });

  it('declines once when simulated, then succeeds with a fresh request id after re-approval', async () => {
    const s = setup();
    const order = await created(s, true);
    expect(order.simulateDecline).toBe(true);
    s.paypal.approve(order.paypalOrderId);

    const first = await s.service.capture(order.id, 'return');
    expect(first.outcome).toBe('declined');
    expect(first.order).toMatchObject({ status: 'NEEDS_NEW_FUNDING', captureAttempts: 1, simulateDecline: false });
    expect(s.paypal.captureCalls[0]?.options).toEqual({ requestId: `capture-${order.id}-0`, simulateDecline: true });

    // The buyer picks another funding source and comes back.
    const second = await s.service.capture(order.id, 'return');
    expect(second.outcome).toBe('completed');
    expect(s.paypal.captureCalls[1]?.options).toEqual({ requestId: `capture-${order.id}-1`, simulateDecline: false });
    expect(s.stock()).toBe(22);
  });

  it('bumps the attempt after ORDER_NOT_APPROVED so a later capture never reuses that key', async () => {
    const s = setup();
    const order = await created(s);
    const early = await s.service.capture(order.id, 'api');
    expect(early.outcome).toBe('not_approved');
    expect(early.order).toMatchObject({ status: 'CREATED', captureAttempts: 1 });

    s.paypal.approve(order.paypalOrderId);
    expect((await s.service.capture(order.id, 'return')).outcome).toBe('completed');
    expect(s.paypal.captureCalls.map((c) => c.options.requestId)).toEqual([
      `capture-${order.id}-0`,
      `capture-${order.id}-1`,
    ]);
  });

  it('keeps the request id after a 5xx so a retry cannot capture twice', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    s.paypal.captureScript.push(paypalError(503, 'SERVICE_UNAVAILABLE'));
    await expect(s.service.capture(order.id, 'return')).rejects.toMatchObject({ status: 503 });
    expect((await s.store.get(order.id))?.captureAttempts).toBe(0);
    await s.service.capture(order.id, 'return');
    expect(s.paypal.captureCalls.map((c) => c.options.requestId)).toEqual([
      `capture-${order.id}-0`,
      `capture-${order.id}-0`,
    ]);
  });

  it('treats ORDER_ALREADY_CAPTURED as success after reading the order', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    const fake = s.paypal.orders.get(order.paypalOrderId)!;
    fake.status = 'COMPLETED';
    fake.capture = { id: 'CAP-EARLIER', status: 'COMPLETED' };
    const result = await s.service.capture(order.id, 'return');
    expect(result).toMatchObject({ outcome: 'completed', order: { status: 'COMPLETED', captureId: 'CAP-EARLIER' } });
  });

  it('maps a PENDING capture to PAYMENT_PENDING and an unpayable order to FAILED', async () => {
    const s = setup();
    const a = await created(s);
    s.paypal.approve(a.paypalOrderId);
    s.paypal.captureScript.push((o) => ({ id: o.id, status: 'COMPLETED', capture: { id: 'CAP-P', status: 'PENDING' } }));
    expect((await s.service.capture(a.id, 'return')).order.status).toBe('PAYMENT_PENDING');

    const b = await created(s);
    s.paypal.approve(b.paypalOrderId);
    s.paypal.captureScript.push(paypalError(422, 'UNPROCESSABLE_ENTITY', 'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED'));
    expect((await s.service.capture(b.id, 'return')).order.status).toBe('FAILED');
  });
});

describe('OrderService webhooks', () => {
  const approved = (paypalOrderId: string, id = 'WH-A1') => ({
    id,
    event_type: 'CHECKOUT.ORDER.APPROVED',
    resource: { id: paypalOrderId, status: 'APPROVED' },
  });
  const captureCompleted = (order: Order, id = 'WH-C1') => ({
    id,
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: `CAP-${order.paypalOrderId}`,
      status: 'COMPLETED',
      custom_id: order.id,
      supplementary_data: { related_ids: { order_id: order.paypalOrderId } },
    },
  });

  it('captures on CHECKOUT.ORDER.APPROVED and skips duplicate deliveries', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    await s.service.handleWebhookEvent(approved(order.paypalOrderId));
    await s.service.handleWebhookEvent(approved(order.paypalOrderId));
    expect(s.paypal.captureCalls).toHaveLength(1);
    expect((await s.store.get(order.id))?.status).toBe('COMPLETED');
  });

  it('respects simulate_decline on the webhook path too', async () => {
    const s = setup();
    const order = await created(s, true);
    s.paypal.approve(order.paypalOrderId);
    await s.service.handleWebhookEvent(approved(order.paypalOrderId));
    expect((await s.store.get(order.id))?.status).toBe('NEEDS_NEW_FUNDING');
    expect(s.paypal.captureCalls[0]?.options.simulateDecline).toBe(true);
  });

  it('ignores a late approval while waiting for the buyer to re-approve', async () => {
    const s = setup();
    const order = await created(s, true);
    s.paypal.approve(order.paypalOrderId);
    await s.service.capture(order.id, 'return');
    await s.service.handleWebhookEvent(approved(order.paypalOrderId, 'WH-LATE'));
    expect(s.paypal.captureCalls).toHaveLength(1);
    expect((await s.store.get(order.id))?.status).toBe('NEEDS_NEW_FUNDING');
  });

  it('takes stock once when both the return page and PAYMENT.CAPTURE.COMPLETED complete the order', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    await s.service.capture(order.id, 'return');
    await s.service.handleWebhookEvent(captureCompleted(order));
    expect(s.stock()).toBe(22);
    expect(s.completed).toHaveLength(1);
  });

  it('stays idempotent when the dedupe memory is gone (same capture, new event id)', async () => {
    const s = setup();
    const order = await created(s);
    await s.service.handleWebhookEvent(captureCompleted(order, 'WH-C-FIRST'));
    await s.service.handleWebhookEvent(captureCompleted(order, 'WH-C-AGAIN'));
    expect(s.stock()).toBe(22);
    await Promise.resolve();
    expect(s.completed).toHaveLength(1);
  });

  it('completes from PAYMENT.CAPTURE.COMPLETED alone (buyer closed the tab)', async () => {
    const s = setup();
    const order = await created(s);
    await s.service.handleWebhookEvent(captureCompleted(order));
    expect(await s.store.get(order.id)).toMatchObject({ status: 'COMPLETED', captureId: `CAP-${order.paypalOrderId}` });
    expect(s.stock()).toBe(22);
  });

  it('never moves backwards: a late approval or denial after COMPLETED does nothing', async () => {
    const s = setup();
    const order = await created(s);
    await s.service.handleWebhookEvent(captureCompleted(order));
    await s.service.handleWebhookEvent(approved(order.paypalOrderId, 'WH-A-LATE'));
    await s.service.handleWebhookEvent({ ...captureCompleted(order, 'WH-D1'), event_type: 'PAYMENT.CAPTURE.DENIED' });
    expect((await s.store.get(order.id))?.status).toBe('COMPLETED');
    expect(s.paypal.captureCalls).toHaveLength(0);
  });

  it('marks FAILED on PAYMENT.CAPTURE.DENIED', async () => {
    const s = setup();
    const order = await created(s);
    await s.service.handleWebhookEvent({ ...captureCompleted(order, 'WH-D2'), event_type: 'PAYMENT.CAPTURE.DENIED' });
    expect((await s.store.get(order.id))?.status).toBe('FAILED');
    expect(s.stock()).toBe(24);
  });

  it('ignores unknown orders and event types', async () => {
    const s = setup();
    await expect(s.service.handleWebhookEvent(approved('PP-UNKNOWN'))).resolves.toBeUndefined();
    await expect(s.service.handleWebhookEvent({ id: 'X', event_type: 'BILLING.PLAN.CREATED' })).resolves.toBeUndefined();
  });
});

describe('OrderService.refresh and cancel', () => {
  it('captures when PayPal says APPROVED but we have not captured (lost webhook)', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    expect((await s.service.refresh(order.id))?.status).toBe('COMPLETED');
  });

  it('does not capture from a status poll while waiting for re-approval', async () => {
    const s = setup();
    const order = await created(s, true);
    s.paypal.approve(order.paypalOrderId);
    await s.service.capture(order.id, 'return');
    expect((await s.service.refresh(order.id))?.status).toBe('NEEDS_NEW_FUNDING');
    expect(s.paypal.captureCalls).toHaveLength(1);
  });

  it('leaves an unapproved order alone and skips PayPal for final orders', async () => {
    const s = setup();
    const order = await created(s);
    expect((await s.service.refresh(order.id))?.status).toBe('CREATED');
    s.paypal.approve(order.paypalOrderId);
    await s.service.capture(order.id, 'return');
    const gets = s.paypal.getCalls;
    await s.service.refresh(order.id);
    expect(s.paypal.getCalls).toBe(gets);
  });

  it('marks FAILED when PayPal no longer knows the order', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.orders.delete(order.paypalOrderId);
    expect((await s.service.refresh(order.id))?.status).toBe('FAILED');
  });

  it('cancels, but never over a final status; a cancelled order can still be paid', async () => {
    const s = setup();
    const order = await created(s);
    expect((await s.service.cancelByPayPalOrderId(order.paypalOrderId))?.status).toBe('CANCELLED');
    s.paypal.approve(order.paypalOrderId);
    expect((await s.service.capture(order.id, 'return')).outcome).toBe('completed');
    expect((await s.service.cancelByPayPalOrderId(order.paypalOrderId))?.status).toBe('COMPLETED');
  });
});

describe('transitions and views', () => {
  it('final statuses have no way out and nothing returns to CREATED', () => {
    for (const to of ORDER_STATUSES) {
      expect(canTransition('COMPLETED', to)).toBe(false);
      expect(canTransition('FAILED', to)).toBe(false);
      for (const from of ORDER_STATUSES) if (to === 'CREATED') expect(canTransition(from, to)).toBe(false);
    }
    expect(canTransition('PAYMENT_PENDING', 'CANCELLED')).toBe(false);
    expect(canTransition('APPROVED', 'CANCELLED')).toBe(false);
  });

  it('shows the approval link only while the buyer has something to do', async () => {
    const s = setup();
    const order = await created(s);
    const view = toOrderView(order);
    expect(view).toMatchObject({ status: 'CREATED', total: '$12.00', total_cents: 1200 });
    expect(view.approval_url).toBe(order.approvalUrl);
    expect(view.items[0]).toEqual({
      product_id: 'choc-chip-cookies',
      name: 'Chocolate chip cookies',
      unit: 'box of 10',
      quantity: 2,
      unit_price: '$6.00',
      line_total: '$12.00',
    });
    s.paypal.approve(order.paypalOrderId);
    const done = (await s.service.capture(order.id, 'return')).order;
    expect(toOrderView(done).approval_url).toBeUndefined();
    expect(toOrderView(done).status_message).toMatch(/^Paid\./);
  });
});
