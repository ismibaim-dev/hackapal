import { describe, expect, it } from 'vitest';
import type { ShopInfo } from '../src/catalog.js';
import { createCatalog } from '../src/catalog.js';
import { createPlatform } from '../src/platform.js';
import { canTransition, cleanNote, MAX_NOTE_LENGTH, OrderService, toOrderView, type SellerNotifier } from '../src/orders.js';
import { InMemoryOrderStore, ORDER_STATUSES, type Order } from '../src/store.js';
import { buildOrderRequest, type Buyer } from '../src/paypal.js';
import { deferred, eventually, FakePayPal, paypalError } from './helpers.js';

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

  it('processes a redelivered event after the first attempt failed', async () => {
    const s = setup();
    const order = await created(s);
    s.paypal.approve(order.paypalOrderId);
    // PayPal is down for the first capture attempt: the event fails, so it must not count as seen.
    s.paypal.captureScript.push(paypalError(503, 'SERVICE_UNAVAILABLE'));
    await expect(s.service.handleWebhookEvent(approved(order.paypalOrderId, 'WH-FLAKY'))).rejects.toThrow();
    expect((await s.store.get(order.id))?.status).toBe('APPROVED');

    await s.service.handleWebhookEvent(approved(order.paypalOrderId, 'WH-FLAKY'));
    expect((await s.store.get(order.id))?.status).toBe('COMPLETED');
    expect(s.paypal.captureCalls).toHaveLength(2);
    // Same attempt number after a 5xx, so the retry reuses the PayPal-Request-Id.
    expect(s.paypal.captureCalls[1]?.options.requestId).toBe(s.paypal.captureCalls[0]?.options.requestId);

    // And once it has worked, a further redelivery is a duplicate again.
    await s.service.handleWebhookEvent(approved(order.paypalOrderId, 'WH-FLAKY'));
    expect(s.paypal.captureCalls).toHaveLength(2);
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

describe('OrderService on the marketplace', () => {
  function market() {
    const paypal = new FakePayPal();
    const pinged: { order: Order; shop: Readonly<ShopInfo>; buyer: Buyer | undefined }[] = [];
    const service = new OrderService({
      platform: createPlatform(),
      store: new InMemoryOrderStore(),
      paypal,
      publicBaseUrl: 'https://shop.example',
      allowSimulatedDecline: true,
      notifier: {
        orderCompleted: async (order, shop, buyer) => {
          pinged.push({ order, shop, buyer });
        },
      },
    });
    return { service, paypal, pinged };
  }

  it("brands each checkout with its shop and pays the shop's own account when it has one", async () => {
    const { service, paypal } = market();
    const cleaning = await service.createOrder({ items: [{ product_id: 'standard-clean-3h', quantity: 1 }] });
    const baking = await service.createOrder({ items: [{ product_id: 'kuih-lapis', quantity: 1 }] }, { shopId: 'aunties-kitchen' });
    expect(cleaning.ok && baking.ok).toBe(true);
    expect(paypal.createCalls[0]).toMatchObject({ brandName: 'Kilat Home Cleaning', payeeEmail: 'sb-cjqou53656464@business.example.com' });
    expect(paypal.createCalls[0]?.quote.totalCents).toBe(4500);
    expect(paypal.createCalls[1]?.brandName).toBe("Auntie's Kitchen");
    expect(paypal.createCalls[1]).not.toHaveProperty('payeeEmail');
  });

  it('refuses an unknown shop, and a foreign item when shop_id is given, without calling PayPal', async () => {
    const { service, paypal } = market();
    const unknown = await service.createOrder({ items: [{ product_id: 'eggs-30', quantity: 1 }] }, { shopId: 'nope' });
    expect(unknown).toMatchObject({ ok: false, issues: [{ code: 'UNKNOWN_SHOP', shopId: 'nope' }] });
    const foreign = await service.createOrder({ items: [{ product_id: 'eggs-30', quantity: 1 }] }, { shopId: 'kilat-home-cleaning' });
    expect(foreign).toMatchObject({ ok: false, issues: [{ code: 'UNKNOWN_PRODUCT', productId: 'eggs-30' }] });
    expect(paypal.createCalls).toHaveLength(0);
  });

  it('tells the seller which shop was paid, and shows the shop on the order', async () => {
    const { service, paypal, pinged } = market();
    const result = await service.createOrder({ items: [{ product_id: 'fresh-santan-1kg', quantity: 2 }] });
    if (!result.ok) throw new Error('create failed');
    paypal.approve(result.order.paypalOrderId);
    const done = (await service.capture(result.order.id, 'return')).order;
    expect(done.status).toBe('COMPLETED');
    expect(pinged.map((p) => p.shop.id)).toEqual(['kampung-fresh-mart']);
    expect(service.view(done).shop).toEqual({ shop_id: 'kampung-fresh-mart', name: 'Kampung Fresh Mart' });
    const santan = (await service.listProducts('kampung-fresh-mart')).find((p) => p.id === 'fresh-santan-1kg');
    expect(santan?.stock).toBe(18);
  });

  it('lists and restocks products across shops by product id', async () => {
    const { service } = market();
    expect(await service.listProducts('nope')).toEqual([]);
    expect((await service.listProducts()).length).toBe(18);
    expect(await service.setStock({ 'eggs-30': 60, 'choc-chip-cookies': 50 })).toEqual({ ok: true });
    const all = await service.listProducts();
    expect(all.find((p) => p.id === 'eggs-30')).toMatchObject({ shopId: 'kampung-fresh-mart', stock: 60 });
    expect(all.find((p) => p.id === 'choc-chip-cookies')).toMatchObject({ shopId: 'aunties-kitchen', stock: 50 });
  });
});

describe('buyer details for the seller ping', () => {
  function withPings() {
    const paypal = new FakePayPal();
    const pinged: { order: Order; buyer: Buyer | undefined }[] = [];
    const service = new OrderService({
      platform: createPlatform(),
      store: new InMemoryOrderStore(),
      paypal,
      publicBaseUrl: 'https://shop.example',
      allowSimulatedDecline: true,
      notifier: {
        orderCompleted: async (order, _shop, buyer) => {
          pinged.push({ order, buyer });
        },
      },
    });
    const place = async () => {
      const result = await service.createOrder({ items: [{ product_id: 'eggs-30', quantity: 1 }] });
      if (!result.ok) throw new Error('create failed');
      return result.order;
    };
    return { service, paypal, pinged, place };
  }

  it('passes the buyer from the capture response, with no extra PayPal call', async () => {
    const { service, paypal, pinged, place } = withPings();
    const order = await place();
    paypal.approve(order.paypalOrderId);
    await service.capture(order.id, 'return');
    await eventually(() => pinged.length === 1);
    expect(pinged[0]?.buyer).toEqual({ name: 'Siti Aminah', email: 'siti@personal.example.com' });
    expect(paypal.getCalls).toBe(0);
  });

  it('looks the buyer up when only the PAYMENT.CAPTURE.COMPLETED webhook completed the order', async () => {
    const { service, paypal, pinged, place } = withPings();
    const order = await place();
    paypal.approve(order.paypalOrderId);
    await service.handleWebhookEvent({
      id: 'WH-BUYER-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-X', status: 'COMPLETED', custom_id: order.id, supplementary_data: { related_ids: { order_id: order.paypalOrderId } } },
    });
    await eventually(() => pinged.length === 1);
    expect(pinged[0]?.buyer?.email).toBe('siti@personal.example.com');
    expect(paypal.getCalls).toBe(1);
  });

  it('still pings the seller, without a buyer, when that lookup fails', async () => {
    const { service, paypal, pinged, place } = withPings();
    const order = await place();
    paypal.getOrderError = paypalError(503, 'SERVICE_UNAVAILABLE');
    await service.handleWebhookEvent({
      id: 'WH-BUYER-2',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: { id: 'CAP-Y', status: 'COMPLETED', custom_id: order.id, supplementary_data: { related_ids: { order_id: order.paypalOrderId } } },
    });
    await eventually(() => pinged.length === 1);
    expect(pinged[0]?.order.status).toBe('COMPLETED');
    expect(pinged[0]?.buyer).toBeUndefined();
  });
});

describe('delivery address and buyer note', () => {
  function service() {
    const paypal = new FakePayPal();
    const store = new InMemoryOrderStore();
    const pinged: Order[] = [];
    const orders = new OrderService({
      platform: createPlatform(),
      store,
      paypal,
      publicBaseUrl: 'https://shop.example',
      allowSimulatedDecline: true,
      notifier: { orderCompleted: async (order) => void pinged.push(order) },
    });
    return { orders, paypal, store, pinged };
  }

  it('asks PayPal for an address only for shops that deliver', async () => {
    const { orders, paypal } = service();
    await orders.createOrder({ items: [{ product_id: 'eggs-30', quantity: 1 }] });
    await orders.createOrder({ items: [{ product_id: 'kuih-lapis', quantity: 1 }] });
    expect(paypal.createCalls[0]?.collectAddress).toBe(true);
    expect(paypal.createCalls[1]).not.toHaveProperty('collectAddress');
  });

  it('stores a cleaned buyer note and hands it to the seller ping', async () => {
    const { orders, paypal, pinged } = service();
    const result = await orders.createOrder(
      { items: [{ product_id: 'deep-clean-6h', quantity: 1 }] },
      { note: '  Unit 5-2,\n\tparking B2   please  ' },
    );
    if (!result.ok) throw new Error('create failed');
    expect(result.order.buyerNote).toBe('Unit 5-2, parking B2 please');
    expect(orders.view(result.order).note).toBe('Unit 5-2, parking B2 please');
    paypal.approve(result.order.paypalOrderId);
    await orders.capture(result.order.id, 'return');
    await eventually(() => pinged.length === 1);
    expect(pinged[0]?.buyerNote).toBe('Unit 5-2, parking B2 please');
  });

  it('keeps no note when it is blank, and cuts a long one to the limit', () => {
    expect(cleanNote('   \n ')).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
    expect(cleanNote('x'.repeat(400))).toHaveLength(MAX_NOTE_LENGTH);
  });

  it('never cuts an emoji in half or keeps a lone surrogate', () => {
    // 299 letters + 2 emoji = 301 characters: the cut lands between the two emoji.
    const cut = cleanNote(`${'a'.repeat(299)}\u{1F600}\u{1F600}`)!;
    expect(Array.from(cut)).toHaveLength(MAX_NOTE_LENGTH);
    expect(() => encodeURIComponent(cut)).not.toThrow(); // throws on a lone surrogate
    expect(cut.endsWith('\u{1F600}')).toBe(true);
    // A note that fits is kept whole, emoji included.
    expect(cleanNote(`${'a'.repeat(299)}\u{1F600}`)).toBe(`${'a'.repeat(299)}\u{1F600}`);
    // Broken input (a surrogate escape with no partner) is repaired, not stored.
    const repaired = cleanNote('deliver \ud83d after 6pm')!;
    expect(() => encodeURIComponent(repaired)).not.toThrow();
    expect(repaired).toBe('deliver \uFFFD after 6pm');
  });
});

describe('combined checkout (several shops, one PayPal approval)', () => {
  function combined() {
    const paypal = new FakePayPal();
    const store = new InMemoryOrderStore();
    const pings: { order: Order; shop: Readonly<ShopInfo> }[] = [];
    const service = new OrderService({
      platform: createPlatform(),
      store,
      paypal,
      publicBaseUrl: 'https://shop.example',
      allowSimulatedDecline: true,
      notifier: { orderCompleted: async (order, shop) => void pings.push({ order, shop }) },
    });
    const cart = {
      items: [
        { product_id: 'kuih-lapis', quantity: 1 },
        { product_id: 'eggs-30', quantity: 2 },
        { product_id: 'choc-chip-cookies', quantity: 1 },
      ],
    };
    return { service, paypal, store, pings, cart };
  }

  it("builds one PayPal order with a purchase unit per shop, each priced from its own catalog and paid to its own account", async () => {
    const { service, paypal, cart } = combined();
    const result = await service.createOrder(cart, { note: 'After 6pm' });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.shops.map((s) => s.id)).toEqual(['aunties-kitchen', 'kampung-fresh-mart']);
    expect(result.order.totalCents).toBe(800 + 1100 + 600);
    const call = paypal.createCalls[0]!;
    expect(call.brandName).toBe('hackapal');
    expect(call.collectAddress).toBe(true);
    expect(call.units?.map((u) => ({ ref: u.referenceId, total: u.quote.totalCents, payee: u.payeeEmail }))).toEqual([
      { ref: 'aunties-kitchen', total: 1400, payee: undefined },
      { ref: 'kampung-fresh-mart', total: 1100, payee: 'sb-cjqou53656464@business.example.com' },
    ]);
    // The request PayPal gets: one unit per shop with reference_id and payee, our order id on each.
    const request = buildOrderRequest(call);
    expect(request.purchaseUnits.map((u) => [u.referenceId, u.payee?.emailAddress, u.amount.value, u.customId])).toEqual([
      ['aunties-kitchen', undefined, '14.00', result.order.id],
      ['kampung-fresh-mart', 'sb-cjqou53656464@business.example.com', '11.00', result.order.id],
    ]);
  });

  it("refuses the whole cart if any shop's part can't be priced", async () => {
    const { service, paypal } = combined();
    const result = await service.createOrder({
      items: [
        { product_id: 'eggs-30', quantity: 1 },
        { product_id: 'move-out-clean', quantity: 5 },
      ],
    });
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'OUT_OF_STOCK', productId: 'move-out-clean' }] });
    expect(paypal.createCalls).toHaveLength(0);
  });

  it('completes on one capture call, takes stock once, and pings each seller with only their lines and capture', async () => {
    const { service, paypal, pings, cart } = combined();
    const result = await service.createOrder(cart);
    if (!result.ok) throw new Error('create failed');
    paypal.approve(result.order.paypalOrderId);
    const done = await service.capture(result.order.id, 'return');
    expect(done.outcome).toBe('completed');
    expect(paypal.captureCalls).toHaveLength(1);
    const pp = result.order.paypalOrderId;
    expect(done.order.captureId).toBe(`CAP-${pp}-aunties-kitchen,CAP-${pp}-kampung-fresh-mart`);
    await eventually(() => pings.length === 2);
    const byShop = Object.fromEntries(pings.map((p) => [p.shop.id, p.order]));
    expect(byShop['aunties-kitchen']).toMatchObject({ totalCents: 1400, captureId: `CAP-${pp}-aunties-kitchen` });
    expect(byShop['aunties-kitchen']!.items.map((i) => i.productId)).toEqual(['kuih-lapis', 'choc-chip-cookies']);
    expect(byShop['kampung-fresh-mart']).toMatchObject({ totalCents: 1100, captureId: `CAP-${pp}-kampung-fresh-mart` });
    const stock = Object.fromEntries((await service.listProducts()).map((p) => [p.id, p.stock]));
    expect(stock).toMatchObject({ 'kuih-lapis': 14, 'eggs-30': 38, 'choc-chip-cookies': 23 });
    expect(service.view(done.order)).toMatchObject({
      shops: [
        { shop_id: 'aunties-kitchen', total: '$14.00' },
        { shop_id: 'kampung-fresh-mart', total: '$11.00' },
      ],
    });
    expect(service.view(done.order)).not.toHaveProperty('shop');
  });

  it("waits while one seller's capture is pending", async () => {
    const { service, paypal, pings, cart } = combined();
    paypal.unitCaptureStatus['kampung-fresh-mart'] = 'PENDING';
    const result = await service.createOrder(cart);
    if (!result.ok) throw new Error('create failed');
    paypal.approve(result.order.paypalOrderId);
    const outcome = await service.capture(result.order.id, 'return');
    expect(outcome).toMatchObject({ outcome: 'pending', order: { status: 'PAYMENT_PENDING' } });
    expect(pings).toHaveLength(0);
  });

  it('completes for the seller who was paid when another capture is declined, and pings only them', async () => {
    const { service, paypal, pings, cart } = combined();
    paypal.unitCaptureStatus['kampung-fresh-mart'] = 'DECLINED';
    const result = await service.createOrder(cart);
    if (!result.ok) throw new Error('create failed');
    paypal.approve(result.order.paypalOrderId);
    const outcome = await service.capture(result.order.id, 'return');
    expect(outcome.order.status).toBe('COMPLETED');
    await eventually(() => pings.length === 1);
    expect(pings[0]?.shop.id).toBe('aunties-kitchen');
    const stock = Object.fromEntries((await service.listProducts()).map((p) => [p.id, p.stock]));
    expect(stock['eggs-30']).toBe(40);
    expect(stock['kuih-lapis']).toBe(14);
  });

  it('reconciles from PayPal when a per-seller capture webhook arrives, so one event does not complete the whole order', async () => {
    const { service, paypal, pings, cart } = combined();
    const result = await service.createOrder(cart);
    if (!result.ok) throw new Error('create failed');
    paypal.approve(result.order.paypalOrderId);
    // PayPal captured (e.g. the buyer closed the tab after the return-page capture started elsewhere).
    await paypal.captureOrder(result.order.paypalOrderId, { requestId: 'x', simulateDecline: false });
    await service.handleWebhookEvent({
      id: 'WH-COMBINED-1',
      event_type: 'PAYMENT.CAPTURE.COMPLETED',
      resource: {
        id: `CAP-${result.order.paypalOrderId}-kampung-fresh-mart`,
        status: 'COMPLETED',
        custom_id: result.order.id,
        supplementary_data: { related_ids: { order_id: result.order.paypalOrderId } },
      },
    });
    const order = await service.get(result.order.id);
    expect(order?.status).toBe('COMPLETED');
    expect(order?.captureId?.split(',')).toHaveLength(2);
    await eventually(() => pings.length === 2);
  });
});
