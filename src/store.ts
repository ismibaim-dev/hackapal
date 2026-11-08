import { randomBytes } from 'node:crypto';
import type { Currency } from './money.js';
import type { QuoteLine } from './pricing.js';

/**
 * Order lifecycle as agents see it. An agent may only tell the buyer "paid" on COMPLETED.
 *
 * - CREATED            PayPal order exists; waiting for the buyer to approve via the link.
 * - APPROVED           Buyer approved in PayPal; capture not finished yet.
 * - PAYMENT_PENDING    Capture accepted but PayPal is holding the funds (e.g. review). Wait.
 * - COMPLETED          Money captured. Final.
 * - NEEDS_NEW_FUNDING  Capture declined (INSTRUMENT_DECLINED). Buyer reopens the same link
 *                      and picks another funding source.
 * - CANCELLED          Buyer cancelled at PayPal. Not final: the PayPal order stays valid for
 *                      a while, so the buyer can still reopen the link and pay.
 * - FAILED             Capture denied or the order can't be paid any more. Final; start over.
 */
export const ORDER_STATUSES = [
  'CREATED',
  'APPROVED',
  'PAYMENT_PENDING',
  'COMPLETED',
  'NEEDS_NEW_FUNDING',
  'CANCELLED',
  'FAILED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Statuses that never change again, so there's no need to ask PayPal for updates. */
export const FINAL_STATUSES: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['COMPLETED', 'FAILED']);

export type OrderItem = QuoteLine;

export interface Order {
  /** Our id. Also sent to PayPal as purchase_units[0].custom_id. */
  id: string;
  paypalOrderId: string;
  /** Where the buyer approves (PayPal's payer-action link). Reused after a decline. */
  approvalUrl: string;
  currency: Currency;
  items: OrderItem[];
  totalCents: number;
  status: OrderStatus;
  captureId: string | null;
  /**
   * Bumped after each declined capture. Part of the capture PayPal-Request-Id
   * (capture-<id>-<attempt>), so a retry after a decline gets a fresh key while
   * concurrent captures within one attempt share a key.
   */
  captureAttempts: number;
  /** Sandbox demo only: decline the next capture once, then clear. */
  simulateDecline: boolean;
  /** The buyer's note for the seller (delivery time, gate code...), passed by the agent. Shown to the seller only. */
  buyerNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export type NewOrder = Pick<Order, 'id' | 'paypalOrderId' | 'approvalUrl' | 'currency' | 'items' | 'totalCents'> &
  Partial<Pick<Order, 'status' | 'simulateDecline' | 'buyerNote'>>;

/** Only lifecycle fields can change. Ids, items and totals are fixed once created. */
export type OrderPatch = Partial<Pick<Order, 'status' | 'captureId' | 'captureAttempts' | 'simulateDecline'>>;

const PATCHABLE_KEYS = ['status', 'captureId', 'captureAttempts', 'simulateDecline'] as const;

/** Persistence boundary. Async on purpose: the in-memory version is swapped for Supabase later. */
export interface OrderStore {
  /** Rejects a duplicate id or PayPal order id, like a unique index would. */
  create(order: NewOrder): Promise<Order>;
  get(id: string): Promise<Order | undefined>;
  getByPayPalOrderId(paypalOrderId: string): Promise<Order | undefined>;
  /** Throws OrderNotFoundError if the order doesn't exist. */
  update(id: string, patch: OrderPatch): Promise<Order>;
}

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`Order not found: ${orderId}`);
    this.name = 'OrderNotFoundError';
  }
}

export class DuplicateOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateOrderError';
  }
}

// Crockford base32 without i, l, o, u: short, unambiguous ids that agents can repeat back.
const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** e.g. "ord_7k2m9q4xw1zc" (60 random bits). */
export function newOrderId(): string {
  let suffix = '';
  for (const byte of randomBytes(12)) suffix += ID_ALPHABET[byte & 31];
  return `ord_${suffix}`;
}

export class InMemoryOrderStore implements OrderStore {
  readonly #orders = new Map<string, Order>();
  readonly #byPayPalId = new Map<string, string>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async create(input: NewOrder): Promise<Order> {
    if (this.#orders.has(input.id)) throw new DuplicateOrderError(`Order id already exists: ${input.id}`);
    if (this.#byPayPalId.has(input.paypalOrderId)) {
      throw new DuplicateOrderError(`PayPal order already linked: ${input.paypalOrderId}`);
    }
    const timestamp = this.#now().toISOString();
    const order: Order = {
      id: input.id,
      paypalOrderId: input.paypalOrderId,
      approvalUrl: input.approvalUrl,
      currency: input.currency,
      items: structuredClone(input.items),
      totalCents: input.totalCents,
      status: input.status ?? 'CREATED',
      captureId: null,
      captureAttempts: 0,
      simulateDecline: input.simulateDecline ?? false,
      buyerNote: input.buyerNote ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#orders.set(order.id, order);
    this.#byPayPalId.set(order.paypalOrderId, order.id);
    return structuredClone(order);
  }

  async get(id: string): Promise<Order | undefined> {
    const order = this.#orders.get(id);
    return order ? structuredClone(order) : undefined;
  }

  async getByPayPalOrderId(paypalOrderId: string): Promise<Order | undefined> {
    const id = this.#byPayPalId.get(paypalOrderId);
    return id ? this.get(id) : undefined;
  }

  async update(id: string, patch: OrderPatch): Promise<Order> {
    const order = this.#orders.get(id);
    if (!order) throw new OrderNotFoundError(id);
    // Copy allowed keys only, so a stray field can never rewrite items or totals at runtime.
    const changes: OrderPatch = {};
    for (const key of PATCHABLE_KEYS) {
      if (patch[key] !== undefined) Object.assign(changes, { [key]: patch[key] });
    }
    const updated: Order = { ...order, ...changes, updatedAt: this.#now().toISOString() };
    this.#orders.set(id, updated);
    return structuredClone(updated);
  }
}
