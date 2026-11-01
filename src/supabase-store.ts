import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from './money.js';
import {
  DuplicateOrderError,
  OrderNotFoundError,
  type NewOrder,
  type Order,
  type OrderItem,
  type OrderPatch,
  type OrderStatus,
  type OrderStore,
} from './store.js';

/**
 * OrderStore on Supabase Postgres (table public.orders, see supabase/migrations).
 * Server-only: it uses the project's secret key, which bypasses RLS. Never expose it.
 * Same contract as InMemoryOrderStore (test/store-contract.test.ts runs against both).
 */

const TABLE = 'orders';

interface OrderRow {
  id: string;
  paypal_order_id: string;
  approval_url: string;
  currency: string;
  items: OrderItem[];
  total_cents: number;
  status: string;
  capture_id: string | null;
  capture_attempts: number;
  simulate_decline: boolean;
  created_at: string;
  updated_at: string;
}

export class StoreError extends Error {
  constructor(operation: string, readonly code: string | undefined, message: string) {
    super(`Order store ${operation} failed${code ? ` (${code})` : ''}: ${message}`);
    this.name = 'StoreError';
  }
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    paypalOrderId: row.paypal_order_id,
    approvalUrl: row.approval_url,
    currency: row.currency as Currency,
    items: row.items,
    totalCents: row.total_cents,
    status: row.status as OrderStatus,
    captureId: row.capture_id,
    captureAttempts: row.capture_attempts,
    simulateDecline: row.simulate_decline,
    // Postgres returns "+00:00"; normalise to the same ISO format as the in-memory store.
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface SupabaseOrderStoreOptions {
  url: string;
  secretKey: string;
  now?: () => Date;
  /** Test seam. */
  client?: SupabaseClient;
}

export class SupabaseOrderStore implements OrderStore {
  readonly #db: SupabaseClient;
  readonly #now: () => Date;

  constructor(options: SupabaseOrderStoreOptions) {
    this.#db =
      options.client ??
      createClient(options.url, options.secretKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: NewOrder): Promise<Order> {
    const timestamp = this.#now().toISOString();
    const { data, error } = await this.#db
      .from(TABLE)
      .insert({
        id: input.id,
        paypal_order_id: input.paypalOrderId,
        approval_url: input.approvalUrl,
        currency: input.currency,
        items: input.items,
        total_cents: input.totalCents,
        status: input.status ?? 'CREATED',
        simulate_decline: input.simulateDecline ?? false,
        created_at: timestamp,
        updated_at: timestamp,
      })
      .select()
      .single<OrderRow>();
    if (error) {
      if (error.code === '23505') throw new DuplicateOrderError(`Order already exists: ${error.details ?? error.message}`);
      throw new StoreError('create', error.code, error.message);
    }
    return toOrder(data);
  }

  get(id: string): Promise<Order | undefined> {
    return this.#findBy('id', id);
  }

  getByPayPalOrderId(paypalOrderId: string): Promise<Order | undefined> {
    return this.#findBy('paypal_order_id', paypalOrderId);
  }

  async update(id: string, patch: OrderPatch): Promise<Order> {
    // Lifecycle fields only, as in the in-memory store: ids, items and totals never change.
    const changes: Record<string, unknown> = { updated_at: this.#now().toISOString() };
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.captureId !== undefined) changes.capture_id = patch.captureId;
    if (patch.captureAttempts !== undefined) changes.capture_attempts = patch.captureAttempts;
    if (patch.simulateDecline !== undefined) changes.simulate_decline = patch.simulateDecline;

    const { data, error } = await this.#db.from(TABLE).update(changes).eq('id', id).select().maybeSingle<OrderRow>();
    if (error) throw new StoreError('update', error.code, error.message);
    if (!data) throw new OrderNotFoundError(id);
    return toOrder(data);
  }

  /** Cheap reachability check for diagnostics (never used by /health, which must stay fast). */
  async ping(): Promise<void> {
    const { error } = await this.#db.from(TABLE).select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw new StoreError('ping', error.code, error.message);
  }

  async #findBy(column: 'id' | 'paypal_order_id', value: string): Promise<Order | undefined> {
    const { data, error } = await this.#db.from(TABLE).select('*').eq(column, value).maybeSingle<OrderRow>();
    if (error) throw new StoreError('read', error.code, error.message);
    return data ? toOrder(data) : undefined;
  }
}
