import { describe, expect, it } from 'vitest';
import {
  DuplicateOrderError,
  InMemoryOrderStore,
  newOrderId,
  OrderNotFoundError,
  type NewOrder,
  type OrderStore,
} from '../src/store.js';
import { SupabaseOrderStore } from '../src/supabase-store.js';

/**
 * One contract, two stores. The Supabase run needs a project with the migration in
 * supabase/migrations applied, and is skipped unless TEST_SUPABASE_URL and
 * TEST_SUPABASE_SECRET_KEY are set (never in CI by default).
 */
function newOrder(overrides: Partial<NewOrder> = {}): NewOrder {
  const id = newOrderId();
  return {
    id,
    paypalOrderId: `TEST-${id.slice(4).toUpperCase()}`,
    approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=TEST-${id}`,
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

const supabaseUrl = process.env.TEST_SUPABASE_URL;
const supabaseKey = process.env.TEST_SUPABASE_SECRET_KEY;

const stores: [string, () => OrderStore, boolean][] = [
  ['InMemoryOrderStore', () => new InMemoryOrderStore(), true],
  [
    'SupabaseOrderStore',
    () => new SupabaseOrderStore({ url: supabaseUrl ?? '', secretKey: supabaseKey ?? '' }),
    Boolean(supabaseUrl && supabaseKey),
  ],
];

for (const [name, make, enabled] of stores) {
  describe.skipIf(!enabled)(`OrderStore contract: ${name}`, () => {
    it('creates with lifecycle defaults and reads back by both ids', async () => {
      const store = make();
      const input = newOrder({ simulateDecline: true });
      const created = await store.create(input);
      expect(created).toMatchObject({
        id: input.id,
        paypalOrderId: input.paypalOrderId,
        status: 'CREATED',
        captureId: null,
        captureAttempts: 0,
        simulateDecline: true,
        totalCents: 1200,
        items: input.items,
      });
      expect(created.createdAt).toBe(created.updatedAt);
      expect(await store.get(input.id)).toEqual(created);
      expect(await store.getByPayPalOrderId(input.paypalOrderId)).toEqual(created);
      expect(await store.get(newOrderId())).toBeUndefined();
      expect(await store.getByPayPalOrderId('TEST-NOPE')).toBeUndefined();
    });

    it('updates lifecycle fields only and bumps updatedAt', async () => {
      const store = make();
      const created = await store.create(newOrder());
      await new Promise((r) => setTimeout(r, 5));
      const updated = await store.update(created.id, {
        status: 'COMPLETED',
        captureId: 'CAP-1',
        captureAttempts: 2,
        simulateDecline: false,
        // A stray field must not rewrite money.
        ...({ totalCents: 1 } as object),
      });
      expect(updated).toMatchObject({ status: 'COMPLETED', captureId: 'CAP-1', captureAttempts: 2, totalCents: 1200 });
      expect(updated.createdAt).toBe(created.createdAt);
      expect(updated.updatedAt > created.updatedAt).toBe(true);
      expect(await store.get(created.id)).toEqual(updated);
    });

    it('rejects duplicate ids and PayPal order ids, and unknown updates', async () => {
      const store = make();
      const first = newOrder();
      await store.create(first);
      await expect(store.create({ ...newOrder(), id: first.id })).rejects.toBeInstanceOf(DuplicateOrderError);
      await expect(store.create({ ...newOrder(), paypalOrderId: first.paypalOrderId })).rejects.toBeInstanceOf(
        DuplicateOrderError,
      );
      await expect(store.update(newOrderId(), { status: 'FAILED' })).rejects.toBeInstanceOf(OrderNotFoundError);
    });
  });
}
