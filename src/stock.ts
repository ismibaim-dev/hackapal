import type { SupabaseClient } from '@supabase/supabase-js';
import type { StockResult } from './catalog.js';
import type { Inventory } from './platform.js';

/**
 * Live stock levels, separate from the catalog's product definitions and prices
 * (those stay in src/catalog.ts). Stock is checked when an order is priced and taken
 * once per order line when its capture completes: taking is idempotent per
 * (orderId, productId), so a redelivered webhook or a second code path can't take twice.
 */
export interface StockStore {
  /** Current units per product id, for every catalog product. */
  levels(): Promise<Map<string, number>>;
  /** Remove sold units for one order line. Never refuses: clamps at zero, reports any shortfall. */
  take(orderId: string, productId: string, quantity: number): Promise<StockTakeResult>;
  /**
   * Seller restock: set absolute levels for the given products. Absolute (not +n) on
   * purpose, so a retried request can't double-count. A sale landing at the same
   * instant can be overwritten; fine for a manual restock.
   */
  setLevels(levels: ReadonlyMap<string, number>): Promise<void>;
}

export interface StockTakeResult extends StockResult {
  /** False when this order line was already taken earlier (nothing changed). */
  applied: boolean;
}

/** In-memory stock on the catalog(s) themselves. Lost on restart; used when Supabase isn't configured. */
export class CatalogStockStore implements StockStore {
  readonly #catalog: Inventory;
  readonly #taken = new Map<string, StockResult>();

  constructor(catalog: Inventory) {
    this.#catalog = catalog;
  }

  async levels(): Promise<Map<string, number>> {
    return new Map(this.#catalog.listProducts().map((p) => [p.id, p.stock]));
  }

  async take(orderId: string, productId: string, quantity: number): Promise<StockTakeResult> {
    const key = `${orderId}\u0000${productId}`;
    const earlier = this.#taken.get(key);
    if (earlier) {
      return { remaining: this.#catalog.getProduct(productId)?.stock ?? 0, shortBy: earlier.shortBy, applied: false };
    }
    const result = this.#catalog.takeStock(productId, quantity);
    this.#taken.set(key, result);
    return { ...result, applied: true };
  }

  async setLevels(levels: ReadonlyMap<string, number>): Promise<void> {
    for (const [productId, stock] of levels) this.#catalog.setStock(productId, stock);
  }
}

export class StockStoreError extends Error {
  constructor(operation: string, readonly code: string | undefined, message: string) {
    super(`Stock store ${operation} failed${code ? ` (${code})` : ''}: ${message}`);
    this.name = 'StockStoreError';
  }
}

/**
 * Stock in Supabase (tables public.stock and public.stock_movements, function
 * public.take_stock; see supabase/migrations). Missing products are seeded once from
 * the catalog's initial stock; existing levels are never overwritten.
 */
export class SupabaseStockStore implements StockStore {
  readonly #db: SupabaseClient;
  readonly #catalog: Inventory;
  #seeded: Promise<void> | undefined;

  constructor(db: SupabaseClient, catalog: Inventory) {
    this.#db = db;
    this.#catalog = catalog;
  }

  async levels(): Promise<Map<string, number>> {
    await this.#ensureSeeded();
    const { data, error } = await this.#db.from('stock').select('product_id, stock');
    if (error) throw new StockStoreError('read', error.code, error.message);
    const rows = new Map((data as { product_id: string; stock: number }[]).map((r) => [r.product_id, r.stock]));
    // Only catalog products count; a product missing from the table has no stock to sell.
    return new Map(this.#catalog.productIds().map((id) => [id, rows.get(id) ?? 0]));
  }

  async take(orderId: string, productId: string, quantity: number): Promise<StockTakeResult> {
    await this.#ensureSeeded();
    const { data, error } = await this.#db.rpc('take_stock', {
      p_order_id: orderId,
      p_product_id: productId,
      p_quantity: quantity,
    });
    if (error) throw new StockStoreError('take', error.code, error.message);
    const row = (data as { remaining: number; short_by: number; applied: boolean }[] | null)?.[0];
    if (!row) throw new StockStoreError('take', undefined, 'take_stock returned no row');
    return { remaining: row.remaining, shortBy: row.short_by, applied: row.applied };
  }

  async setLevels(levels: ReadonlyMap<string, number>): Promise<void> {
    await this.#ensureSeeded();
    const now = new Date().toISOString();
    const rows = [...levels].map(([product_id, stock]) => ({ product_id, stock, updated_at: now }));
    if (rows.length === 0) return;
    const { error } = await this.#db.from('stock').upsert(rows, { onConflict: 'product_id' });
    if (error) throw new StockStoreError('set', error.code, error.message);
  }

  /** Insert catalog products that aren't in the table yet. Runs once; retried after a failure. */
  #ensureSeeded(): Promise<void> {
    this.#seeded ??= (async () => {
      const rows = this.#catalog.listProducts().map((p) => ({ product_id: p.id, stock: p.stock }));
      const { error } = await this.#db.from('stock').upsert(rows, { onConflict: 'product_id', ignoreDuplicates: true });
      if (error) throw new StockStoreError('seed', error.code, error.message);
    })().catch((err: unknown) => {
      this.#seeded = undefined;
      throw err;
    });
    return this.#seeded;
  }
}
