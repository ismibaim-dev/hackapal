import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createCatalog } from '../src/catalog.js';
import { OrderService } from '../src/orders.js';
import { priceCart } from '../src/pricing.js';
import { CatalogStockStore, StockStoreError, SupabaseStockStore, type StockStore, type StockTakeResult } from '../src/stock.js';
import { InMemoryOrderStore } from '../src/store.js';
import { createSupabaseServerClient } from '../src/supabase-store.js';
import { FakePayPal } from './helpers.js';

describe('CatalogStockStore', () => {
  it('reports levels and takes stock once per order line', async () => {
    const catalog = createCatalog();
    const stock = new CatalogStockStore(catalog);
    expect((await stock.levels()).get('choc-chip-cookies')).toBe(24);

    expect(await stock.take('ord_a', 'choc-chip-cookies', 2)).toEqual({ remaining: 22, shortBy: 0, applied: true });
    expect(await stock.take('ord_a', 'choc-chip-cookies', 2)).toEqual({ remaining: 22, shortBy: 0, applied: false });
    expect(await stock.take('ord_b', 'choc-chip-cookies', 2)).toMatchObject({ remaining: 20, applied: true });
  });

  it('clamps at zero and reports an oversell', async () => {
    const stock = new CatalogStockStore(createCatalog());
    expect(await stock.take('ord_a', 'pineapple-tarts', 13)).toEqual({ remaining: 0, shortBy: 3, applied: true });
  });
});

/** Just enough of SupabaseClient for SupabaseStockStore, recording what it was asked. */
function fakeDb(options: { stockRows?: { product_id: string; stock: number }[]; failSeedOnce?: boolean } = {}) {
  const calls: { op: string; args: unknown[] }[] = [];
  let failSeed = options.failSeedOnce ?? false;
  const db = {
    from(table: string) {
      return {
        upsert: async (...args: unknown[]) => {
          calls.push({ op: `upsert:${table}`, args });
          if (failSeed) {
            failSeed = false;
            return { error: { code: '08006', message: 'connection failure' } };
          }
          return { error: null };
        },
        select: async (...args: unknown[]) => {
          calls.push({ op: `select:${table}`, args });
          return { data: options.stockRows ?? [], error: null };
        },
      };
    },
    async rpc(...args: unknown[]) {
      calls.push({ op: 'rpc', args });
      return { data: [{ remaining: 18, short_by: 0, applied: true }], error: null };
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

describe('SupabaseStockStore (fake client)', () => {
  it('seeds missing catalog products once without overwriting existing levels', async () => {
    const { db, calls } = fakeDb({ stockRows: [{ product_id: 'choc-chip-cookies', stock: 3 }] });
    const stock = new SupabaseStockStore(db, createCatalog());
    const levels = await stock.levels();
    await stock.levels();

    const seeds = calls.filter((c) => c.op === 'upsert:stock');
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.args).toEqual([
      [
        { product_id: 'choc-chip-cookies', stock: 24 },
        { product_id: 'kuih-lapis', stock: 15 },
        { product_id: 'pineapple-tarts', stock: 10 },
      ],
      { onConflict: 'product_id', ignoreDuplicates: true },
    ]);
    // Live level wins; a catalog product missing from the table counts as 0, not its seed value.
    expect(levels).toEqual(new Map([['choc-chip-cookies', 3], ['kuih-lapis', 0], ['pineapple-tarts', 0]]));
  });

  it('takes stock through take_stock with the order id', async () => {
    const { db, calls } = fakeDb();
    const stock = new SupabaseStockStore(db, createCatalog());
    expect(await stock.take('ord_abc', 'kuih-lapis', 2)).toEqual({ remaining: 18, shortBy: 0, applied: true });
    expect(calls.find((c) => c.op === 'rpc')?.args).toEqual([
      'take_stock',
      { p_order_id: 'ord_abc', p_product_id: 'kuih-lapis', p_quantity: 2 },
    ]);
  });

  it('retries the seed after a failure instead of caching it', async () => {
    const { db, calls } = fakeDb({ failSeedOnce: true });
    const stock = new SupabaseStockStore(db, createCatalog());
    await expect(stock.levels()).rejects.toBeInstanceOf(StockStoreError);
    await expect(stock.levels()).resolves.toBeInstanceOf(Map);
    expect(calls.filter((c) => c.op === 'upsert:stock')).toHaveLength(2);
  });
});

describe('priceCart with live stock levels', () => {
  it('uses the given levels instead of the catalog stock', () => {
    const catalog = createCatalog();
    const levels = new Map([['choc-chip-cookies', 1], ['kuih-lapis', 0]]);
    const result = priceCart(catalog, { items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] }, levels);
    expect(result).toMatchObject({ ok: false, issues: [{ code: 'OUT_OF_STOCK', available: 1 }] });
    const soldOut = priceCart(catalog, { items: [{ product_id: 'kuih-lapis', quantity: 1 }] }, levels);
    expect(soldOut).toMatchObject({ ok: false, issues: [{ message: '"Kuih lapis" is sold out.' }] });
    // A product absent from the levels has nothing to sell.
    const absent = priceCart(catalog, { items: [{ product_id: 'pineapple-tarts', quantity: 1 }] }, levels);
    expect(absent.ok).toBe(false);
  });
});

describe('OrderService with a stock store', () => {
  function setup(stock: StockStore) {
    const paypal = new FakePayPal();
    const service = new OrderService({
      catalog: createCatalog(),
      store: new InMemoryOrderStore(),
      stock,
      paypal,
      publicBaseUrl: 'https://shop.example',
      allowSimulatedDecline: true,
    });
    return { service, paypal };
  }

  it('prices against live levels and lists live stock', async () => {
    const levels = new Map([['choc-chip-cookies', 1], ['kuih-lapis', 15], ['pineapple-tarts', 10]]);
    const stock: StockStore = { levels: async () => levels, take: async () => ({ remaining: 0, shortBy: 0, applied: true }) };
    const { service, paypal } = setup(stock);
    const result = await service.createOrder({ items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] });
    expect(result.ok).toBe(false);
    expect(paypal.createCalls).toHaveLength(0);
    expect((await service.listProducts()).find((p) => p.id === 'choc-chip-cookies')?.stock).toBe(1);
  });

  it('takes stock with the order id when a capture completes, and survives a stock failure', async () => {
    const takes: [string, string, number][] = [];
    let fail = true;
    const stock: StockStore = {
      levels: async () => new Map([['choc-chip-cookies', 24], ['kuih-lapis', 15], ['pineapple-tarts', 10]]),
      take: async (orderId, productId, quantity): Promise<StockTakeResult> => {
        takes.push([orderId, productId, quantity]);
        if (fail) {
          fail = false;
          throw new StockStoreError('take', '08006', 'connection failure');
        }
        return { remaining: 10, shortBy: 0, applied: true };
      },
    };
    const { service, paypal } = setup(stock);
    const created = await service.createOrder({
      items: [
        { product_id: 'choc-chip-cookies', quantity: 2 },
        { product_id: 'kuih-lapis', quantity: 1 },
      ],
    });
    if (!created.ok) throw new Error('create failed');
    paypal.approve(created.order.paypalOrderId);
    const result = await service.capture(created.order.id, 'return');
    // The first line's stock take failed; the order still completes and the second line is taken.
    expect(result.outcome).toBe('completed');
    expect(takes).toEqual([
      [created.order.id, 'choc-chip-cookies', 2],
      [created.order.id, 'kuih-lapis', 1],
    ]);
  });
});

const url = process.env.TEST_SUPABASE_URL;
const key = process.env.TEST_SUPABASE_SECRET_KEY;

describe.skipIf(!(url && key))('SupabaseStockStore (live, needs TEST_SUPABASE_URL/TEST_SUPABASE_SECRET_KEY)', () => {
  it('seeds, takes once per order line, and clamps', async () => {
    // A throwaway product id so the real shop's stock is never touched.
    const id = `test-${Math.random().toString(36).slice(2, 10)}`;
    const catalog = createCatalog({
      id: 'test-shop',
      name: 'Test shop',
      description: 'test',
      fulfilment: 'test',
      currency: 'USD',
      products: [{ id, name: 'Test item', description: 'test', unit: 'each', priceCents: 100, stock: 3 }],
    });
    const stock = new SupabaseStockStore(createSupabaseServerClient(url!, key!), catalog);
    expect((await stock.levels()).get(id)).toBe(3);
    expect(await stock.take('ord_testaaaaaaaa', id, 2)).toEqual({ remaining: 1, shortBy: 0, applied: true });
    expect(await stock.take('ord_testaaaaaaaa', id, 2)).toMatchObject({ remaining: 1, applied: false });
    expect(await stock.take('ord_testbbbbbbbb', id, 5)).toEqual({ remaining: 0, shortBy: 4, applied: true });
  });
});
