import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Currency } from './money.js';
import { log } from './log.js';
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
  /** Added by migration 20261108000000_buyer_note; absent until it has run. */
  buyer_note?: string | null;
  /** Added by migration 20261110000000_seller_pings; absent until it has run. */
  sellers_pinged?: string[] | null;
  ping_pending?: boolean | null;
  ping_attempts?: number | null;
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
    buyerNote: row.buyer_note ?? null,
    sellersPinged: row.sellers_pinged ?? [],
    pingPending: row.ping_pending ?? false,
    pingAttempts: row.ping_attempts ?? 0,
    // Postgres returns "+00:00"; normalise to the same ISO format as the in-memory store.
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** One server-side client per process, shared by the order and stock stores. */
export function createSupabaseServerClient(url: string, secretKey: string): SupabaseClient {
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export interface SupabaseOrderStoreOptions {
  url: string;
  secretKey: string;
  now?: () => Date;
  /** Test seam. */
  client?: SupabaseClient;
}

/** PostgREST's "column not in schema cache" (PGRST204) or Postgres's undefined column (42703). */
function isMissingColumn(error: { code?: string; message?: string }, column: string): boolean {
  return (error.code === 'PGRST204' || error.code === '42703') && (error.message ?? '').includes(column);
}

const PING_COLUMNS = ['sellers_pinged', 'ping_pending', 'ping_attempts'] as const;
const PING_MIGRATION = 'supabase/migrations/20261110000000_seller_pings.sql';

export class SupabaseOrderStore implements OrderStore {
  readonly #db: SupabaseClient;
  readonly #now: () => Date;
  /** False once we learn the seller-ping columns don't exist yet (migration not run). */
  #pingColumns = true;

  constructor(options: SupabaseOrderStoreOptions) {
    this.#db =
      options.client ?? createSupabaseServerClient(options.url, options.secretKey);
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: NewOrder): Promise<Order> {
    const timestamp = this.#now().toISOString();
    const row = {
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
    };
    const insert = (values: object) => this.#db.from(TABLE).insert(values).select().single<OrderRow>();
    let { data, error } = await insert(input.buyerNote ? { ...row, buyer_note: input.buyerNote } : row);
    if (error && input.buyerNote && isMissingColumn(error, 'buyer_note')) {
      // The migration hasn't run yet: keep taking orders, just without the note.
      log.warn('orders.buyer_note column missing; order saved without the buyer note. Run supabase/migrations/20261108000000_buyer_note.sql', {
        order_id: input.id,
      });
      ({ data, error } = await insert(row));
    }
    if (error || !data) {
      if (!error) throw new StoreError('create', undefined, 'insert returned no row');
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
    const pingChanges: Record<string, unknown> = {};
    if (patch.sellersPinged !== undefined) pingChanges.sellers_pinged = patch.sellersPinged;
    if (patch.pingPending !== undefined) pingChanges.ping_pending = patch.pingPending;
    if (patch.pingAttempts !== undefined) pingChanges.ping_attempts = patch.pingAttempts;
    const withPings = this.#pingColumns && Object.keys(pingChanges).length > 0;

    const run = (values: Record<string, unknown>) =>
      this.#db.from(TABLE).update(values).eq('id', id).select().maybeSingle<OrderRow>();
    let { data, error } = await run(withPings ? { ...changes, ...pingChanges } : changes);
    if (error && withPings && PING_COLUMNS.some((c) => isMissingColumn(error!, c))) {
      // The migration hasn't run: never let ping bookkeeping block a payment status change.
      this.#missingPingColumns();
      ({ data, error } = await run(changes));
    }
    if (error) throw new StoreError('update', error.code, error.message);
    if (!data) throw new OrderNotFoundError(id);
    return toOrder(data);
  }

  async listPingsPending(limit: number): Promise<Order[]> {
    if (!this.#pingColumns) return [];
    const { data, error } = await this.#db
      .from(TABLE)
      .select('*')
      .eq('status', 'COMPLETED')
      .eq('ping_pending', true)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) {
      if (PING_COLUMNS.some((c) => isMissingColumn(error, c))) {
        this.#missingPingColumns();
        return [];
      }
      throw new StoreError('read', error.code, error.message);
    }
    return (data as OrderRow[]).map(toOrder);
  }

  #missingPingColumns(): void {
    if (this.#pingColumns) {
      log.warn(`orders seller-ping columns missing; failed seller pings won't be retried until ${PING_MIGRATION} is run`);
    }
    this.#pingColumns = false;
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
