import { describe, expect, it } from 'vitest';
import {
  DuplicateOrderError,
  FINAL_STATUSES,
  InMemoryOrderStore,
  newOrderId,
  ORDER_STATUSES,
  OrderNotFoundError,
  type NewOrder,
  type OrderPatch,
} from '../src/store.js';

function fakeClock(start = '2026-11-01T10:00:00.000Z') {
  let current = new Date(start).getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  return {
    id: newOrderId(),
    paypalOrderId: `PP-${Math.random().toString(36).slice(2, 10)}`,
    approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=TEST',
    currency: 'USD',
    items: [
      {
        productId: 'choc-chip-cookies',
        name: 'Chocolate chip cookies',
        unit: 'box of 10',
        quantity: 2,
        unitPriceCents: 600,
        lineTotalCents: 1200,
      },
    ],
    totalCents: 1200,
    ...overrides,
  };
}

describe('InMemoryOrderStore', () => {
  it('creates orders with lifecycle defaults and matching timestamps', async () => {
    const clock = fakeClock();
    const store = new InMemoryOrderStore({ now: clock.now });
    const input = newOrder();
    const order = await store.create(input);

    expect(order).toMatchObject({
      id: input.id,
      paypalOrderId: input.paypalOrderId,
      totalCents: 1200,
      status: 'CREATED',
      captureId: null,
      captureAttempts: 0,
      simulateDecline: false,
      buyerNote: null,
      createdAt: '2026-11-01T10:00:00.000Z',
      updatedAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('finds orders by our id and by PayPal order id', async () => {
    const store = new InMemoryOrderStore();
    const created = await store.create(newOrder({ paypalOrderId: 'PP-123' }));
    expect(await store.get(created.id)).toEqual(created);
    expect(await store.getByPayPalOrderId('PP-123')).toEqual(created);
    expect(await store.get('ord_missing')).toBeUndefined();
    expect(await store.getByPayPalOrderId('PP-missing')).toBeUndefined();
  });

  it('stores copies, like a database would', async () => {
    const store = new InMemoryOrderStore();
    const input = newOrder();
    const created = await store.create(input);

    input.items[0]!.quantity = 99;
    created.status = 'COMPLETED';
    created.items[0]!.lineTotalCents = 1;

    const fresh = await store.get(created.id);
    expect(fresh?.status).toBe('CREATED');
    expect(fresh?.items[0]).toMatchObject({ quantity: 2, lineTotalCents: 1200 });
  });

  it('updates lifecycle fields and bumps updatedAt only', async () => {
    const clock = fakeClock();
    const store = new InMemoryOrderStore({ now: clock.now });
    const created = await store.create(newOrder());
    clock.advance(5_000);

    const updated = await store.update(created.id, { status: 'COMPLETED', captureId: 'CAP-1' });
    expect(updated).toMatchObject({ status: 'COMPLETED', captureId: 'CAP-1', captureAttempts: 0 });
    expect(updated.createdAt).toBe('2026-11-01T10:00:00.000Z');
    expect(updated.updatedAt).toBe('2026-11-01T10:00:05.000Z');
    expect(await store.get(created.id)).toEqual(updated);
  });

  it('never lets a patch rewrite ids, items or totals', async () => {
    const store = new InMemoryOrderStore();
    const created = await store.create(newOrder());
    const sneaky = { status: 'APPROVED', totalCents: 1, id: 'ord_other', items: [] } as unknown as OrderPatch;

    const updated = await store.update(created.id, sneaky);
    expect(updated).toMatchObject({ id: created.id, status: 'APPROVED', totalCents: 1200 });
    expect(updated.items).toHaveLength(1);
  });

  it('throws for unknown orders and duplicate ids', async () => {
    const store = new InMemoryOrderStore();
    await expect(store.update('ord_missing', { status: 'APPROVED' })).rejects.toThrow(OrderNotFoundError);

    const first = await store.create(newOrder({ paypalOrderId: 'PP-dup' }));
    await expect(store.create(newOrder({ id: first.id }))).rejects.toThrow(DuplicateOrderError);
    await expect(store.create(newOrder({ paypalOrderId: 'PP-dup' }))).rejects.toThrow(DuplicateOrderError);
  });
});

describe('order ids and statuses', () => {
  it('generates short, unambiguous, unique ids', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newOrderId()));
    expect(ids.size).toBe(10_000);
    for (const id of [...ids].slice(0, 100)) expect(id).toMatch(/^ord_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('covers the agent-facing lifecycle; only COMPLETED and FAILED are final', () => {
    expect(ORDER_STATUSES).toEqual([
      'CREATED',
      'APPROVED',
      'PAYMENT_PENDING',
      'COMPLETED',
      'NEEDS_NEW_FUNDING',
      'CANCELLED',
      'FAILED',
    ]);
    expect([...FINAL_STATUSES]).toEqual(['COMPLETED', 'FAILED']);
  });
});
