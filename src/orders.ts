import type { Catalog, Product } from './catalog.js';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { PayPalGateway, PayPalOrderSummary } from './paypal.js';
import { PayPalHttpError } from './paypal-http.js';
import { priceCart, type CartInput, type PricingIssue, type Quote } from './pricing.js';
import { CatalogStockStore, type StockStore } from './stock.js';
import { FINAL_STATUSES, newOrderId, type Order, type OrderStatus, type OrderStore } from './store.js';

/**
 * The money path, shared by the PayPal return page, the webhook, the internal
 * /api/orders endpoints and the MCP tools, so they can't drift apart.
 *
 * Invariants:
 * - Prices come from the catalog via priceCart, never from the caller.
 * - One capture call per order at a time (single-flight); its PayPal-Request-Id is
 *   capture-<orderId>-<attempt>, and the attempt goes up after every definitive
 *   rejection (4xx), so a later capture never replays a cached error.
 * - Status changes follow ALLOWED_TRANSITIONS: nothing moves backwards and final
 *   statuses never change. Stock and the seller ping happen once, on the move to COMPLETED.
 */

const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  CREATED: ['APPROVED', 'PAYMENT_PENDING', 'COMPLETED', 'NEEDS_NEW_FUNDING', 'CANCELLED', 'FAILED'],
  CANCELLED: ['APPROVED', 'PAYMENT_PENDING', 'COMPLETED', 'NEEDS_NEW_FUNDING', 'FAILED'],
  NEEDS_NEW_FUNDING: ['APPROVED', 'PAYMENT_PENDING', 'COMPLETED', 'NEEDS_NEW_FUNDING', 'CANCELLED', 'FAILED'],
  APPROVED: ['PAYMENT_PENDING', 'COMPLETED', 'NEEDS_NEW_FUNDING', 'FAILED'],
  PAYMENT_PENDING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** 422 issues after which this PayPal order can never be paid. */
const UNPAYABLE_ISSUES = new Set([
  'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
  'TRANSACTION_REFUSED',
  'PAYER_CANNOT_PAY',
  'ORDER_EXPIRED',
  'COMPLIANCE_VIOLATION',
  'DUPLICATE_INVOICE_ID',
  'ORDER_CANNOT_BE_SAVED',
]);

export type CaptureTrigger = 'return' | 'webhook' | 'reconcile' | 'api';

export type CaptureOutcome =
  /** Money captured (now or earlier). */
  | 'completed'
  /** Capture accepted but PayPal is holding the funds. */
  | 'pending'
  /** INSTRUMENT_DECLINED: send the buyer back to the approval link. */
  | 'declined'
  /** The buyer hasn't approved (or re-approved) yet. */
  | 'not_approved'
  /** The order can't be paid any more. */
  | 'failed';

export interface CaptureResult {
  outcome: CaptureOutcome;
  order: Order;
}

export type CreateOrderResult = { ok: true; order: Order; quote: Quote } | { ok: false; issues: PricingIssue[] };

/** Told once per order, when it moves to COMPLETED. Phase 5 plugs Telegram in here. */
export interface SellerNotifier {
  orderCompleted(order: Order): Promise<void>;
}

export interface OrderServiceOptions {
  catalog: Catalog;
  store: OrderStore;
  /** Live stock. Defaults to in-memory stock on the catalog. */
  stock?: StockStore;
  paypal: PayPalGateway;
  publicBaseUrl: string;
  /** Whether simulate_decline may be honoured (sandbox only). */
  allowSimulatedDecline: boolean;
  notifier?: SellerNotifier;
}

/** A PayPal webhook event, as much of it as we read. */
export interface WebhookEvent {
  id?: string;
  event_type?: string;
  create_time?: string;
  resource?: {
    id?: string;
    status?: string;
    custom_id?: string;
    supplementary_data?: { related_ids?: { order_id?: string } };
  };
}

export interface WebhookRecord {
  event_id: string | null;
  event_type: string;
  /** PayPal's create_time for the event. */
  event_time: string | null;
  /** When we received and verified it. */
  received_at: string;
}

export class OrderService {
  readonly #catalog: Catalog;
  readonly #stock: StockStore;
  readonly #store: OrderStore;
  readonly #paypal: PayPalGateway;
  readonly #baseUrl: string;
  readonly #allowSimulatedDecline: boolean;
  readonly #notifier: SellerNotifier | undefined;
  readonly #captures = new Map<string, Promise<CaptureResult>>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #seenEvents = new Set<string>();
  /** Verified webhook events per order, newest last. Evidence for T1b; in memory only. */
  readonly #webhookLog = new Map<string, WebhookRecord[]>();

  constructor(options: OrderServiceOptions) {
    this.#catalog = options.catalog;
    this.#stock = options.stock ?? new CatalogStockStore(options.catalog);
    this.#store = options.store;
    this.#paypal = options.paypal;
    this.#baseUrl = options.publicBaseUrl;
    this.#allowSimulatedDecline = options.allowSimulatedDecline;
    this.#notifier = options.notifier;
  }

  get catalog(): Catalog {
    return this.#catalog;
  }

  /** Catalog products with live stock levels (for list_products). */
  async listProducts(): Promise<Product[]> {
    const levels = await this.#stock.levels();
    return this.#catalog.listProducts().map((p) => ({ ...p, stock: levels.get(p.id) ?? 0 }));
  }

  async createOrder(input: CartInput, options: { simulateDecline?: boolean } = {}): Promise<CreateOrderResult> {
    const priced = priceCart(this.#catalog, input, await this.#stock.levels());
    if (!priced.ok) return priced;
    const { quote } = priced;

    const id = newOrderId();
    const paypalOrder = await this.#paypal.createOrder({
      orderId: id,
      quote,
      brandName: this.#catalog.shop.name,
      returnUrl: `${this.#baseUrl}/paypal/return`,
      cancelUrl: `${this.#baseUrl}/paypal/cancel`,
    });
    if (!paypalOrder.approvalUrl) {
      throw new Error(`PayPal order ${paypalOrder.id} has no payer-action or approve link`);
    }
    const order = await this.#store.create({
      id,
      paypalOrderId: paypalOrder.id,
      approvalUrl: paypalOrder.approvalUrl,
      currency: quote.currency,
      items: quote.lines,
      totalCents: quote.totalCents,
      simulateDecline: Boolean(options.simulateDecline) && this.#allowSimulatedDecline,
    });
    log.info('order created', {
      order_id: id,
      paypal_order_id: paypalOrder.id,
      total: formatUsd(order.totalCents),
      simulate_decline: order.simulateDecline,
    });
    return { ok: true, order, quote };
  }

  get(orderId: string): Promise<Order | undefined> {
    return this.#store.get(orderId);
  }

  /** Verified webhook events that matched this order, oldest first. */
  webhookEventsFor(orderId: string): WebhookRecord[] {
    return [...(this.#webhookLog.get(orderId) ?? [])];
  }

  getByPayPalOrderId(paypalOrderId: string): Promise<Order | undefined> {
    return this.#store.getByPayPalOrderId(paypalOrderId);
  }

  /**
   * Current status, reconciled with PayPal unless final. If PayPal says the buyer
   * approved and we haven't captured, capture now, so a lost webhook or a closed tab
   * can't strand a payment. After a decline we wait for the buyer to re-approve
   * (their return to /paypal/return), because PayPal still reports the old approval.
   */
  async refresh(orderId: string): Promise<Order | undefined> {
    const order = await this.#store.get(orderId);
    if (!order || FINAL_STATUSES.has(order.status)) return order;

    let paypalOrder: PayPalOrderSummary;
    try {
      paypalOrder = await this.#paypal.getOrder(order.paypalOrderId);
    } catch (err) {
      if (err instanceof PayPalHttpError && err.status === 404) {
        // The PayPal order is gone (expired unapproved orders are deleted).
        return (await this.#transition(order.id, 'FAILED')).order;
      }
      throw err;
    }

    switch (paypalOrder.status) {
      case 'APPROVED':
        if (order.status === 'NEEDS_NEW_FUNDING' || order.status === 'PAYMENT_PENDING') return order;
        return (await this.capture(order.id, 'reconcile')).order;
      case 'COMPLETED':
        return (await this.#applyCaptured(order.id, paypalOrder)).order;
      case 'VOIDED':
        return (await this.#transition(order.id, 'FAILED')).order;
      default:
        return order;
    }
  }

  /** Capture once per order at a time; concurrent callers share the same result. */
  capture(orderId: string, trigger: CaptureTrigger): Promise<CaptureResult> {
    const inflight = this.#captures.get(orderId);
    if (inflight) return inflight;
    const run = this.#capture(orderId, trigger).finally(() => this.#captures.delete(orderId));
    this.#captures.set(orderId, run);
    return run;
  }

  async #capture(orderId: string, trigger: CaptureTrigger): Promise<CaptureResult> {
    const order = await this.#mustGet(orderId);
    if (order.status === 'COMPLETED') return { outcome: 'completed', order };
    if (order.status === 'FAILED') return { outcome: 'failed', order };
    if (order.status === 'PAYMENT_PENDING') return { outcome: 'pending', order };

    // PayPal itself told us the buyer approved (webhook or GET), so say so while we capture.
    // The buyer's return alone doesn't count: an ORDER_NOT_APPROVED answer couldn't undo it.
    if (trigger === 'webhook' || trigger === 'reconcile') await this.#transition(order.id, 'APPROVED');

    const attempt = order.captureAttempts;
    const requestId = `capture-${order.id}-${attempt}`;
    const simulateDecline = order.simulateDecline;
    // The simulated decline is one-shot: clear it before the call so no other path repeats it.
    if (simulateDecline) await this.#store.update(order.id, { simulateDecline: false });

    log.info('capturing', { order_id: order.id, trigger, attempt, request_id: requestId, simulate_decline: simulateDecline });
    try {
      const paypalOrder = await this.#paypal.captureOrder(order.paypalOrderId, { requestId, simulateDecline });
      return await this.#applyCaptured(order.id, paypalOrder);
    } catch (err) {
      if (!(err instanceof PayPalHttpError)) throw err;
      return this.#handleCaptureError(order, attempt, err);
    }
  }

  async #handleCaptureError(order: Order, attempt: number, err: PayPalHttpError): Promise<CaptureResult> {
    // A definitive rejection: later captures must use a fresh PayPal-Request-Id, since
    // PayPal may replay the stored error for a repeated id. Network errors and 5xx keep
    // the id, so a retry can't capture twice.
    const definitive = err.status >= 400 && err.status < 500;
    if (definitive) await this.#store.update(order.id, { captureAttempts: attempt + 1 });

    if (err.status === 422 && err.issue === 'INSTRUMENT_DECLINED') {
      const { order: updated } = await this.#transition(order.id, 'NEEDS_NEW_FUNDING');
      log.warn('capture declined, buyer must choose another funding source', {
        order_id: order.id,
        debug_id: err.debugId,
        next_attempt: attempt + 1,
      });
      return { outcome: 'declined', order: updated };
    }
    if (err.status === 422 && err.issue === 'ORDER_ALREADY_CAPTURED') {
      return this.#applyCaptured(order.id, await this.#paypal.getOrder(order.paypalOrderId));
    }
    if (err.status === 422 && (err.issue === 'ORDER_NOT_APPROVED' || err.issue === 'PAYER_ACTION_REQUIRED')) {
      return { outcome: 'not_approved', order: await this.#mustGet(order.id) };
    }
    if ((err.status === 422 && err.issue && UNPAYABLE_ISSUES.has(err.issue)) || err.status === 404) {
      const { order: updated } = await this.#transition(order.id, 'FAILED');
      return { outcome: 'failed', order: updated };
    }
    throw err;
  }

  /** Apply a PayPal order that may carry a capture (capture response or a fresh GET). */
  async #applyCaptured(orderId: string, paypalOrder: PayPalOrderSummary): Promise<CaptureResult> {
    const capture = paypalOrder.capture;
    if (capture?.status === 'COMPLETED' || capture?.status === 'PARTIALLY_REFUNDED' || capture?.status === 'REFUNDED') {
      const { order } = await this.#markCompleted(orderId, capture.id);
      return { outcome: order.status === 'COMPLETED' ? 'completed' : statusOutcome(order.status), order };
    }
    if (capture?.status === 'PENDING') {
      const { order } = await this.#transition(orderId, 'PAYMENT_PENDING', { captureId: capture.id });
      return { outcome: statusOutcome(order.status), order };
    }
    if (capture?.status === 'DECLINED' || capture?.status === 'FAILED') {
      const { order } = await this.#transition(orderId, 'FAILED', { captureId: capture.id });
      return { outcome: 'failed', order };
    }
    // No capture yet (e.g. PayPal still shows APPROVED): report what we know.
    const order = await this.#mustGet(orderId);
    return { outcome: statusOutcome(order.status), order };
  }

  /** Buyer pressed cancel at PayPal. Never overrides a final or in-progress status. */
  async cancelByPayPalOrderId(paypalOrderId: string): Promise<Order | undefined> {
    const order = await this.#store.getByPayPalOrderId(paypalOrderId);
    if (!order) return undefined;
    if (order.status !== 'CREATED' && order.status !== 'NEEDS_NEW_FUNDING') return order;
    return (await this.#transition(order.id, 'CANCELLED')).order;
  }

  /**
   * A verified webhook event. Duplicate deliveries are skipped by event id.
   * Unknown orders and event types are ignored (logged), never an error.
   */
  async handleWebhookEvent(event: WebhookEvent): Promise<void> {
    if (event.id) {
      if (this.#seenEvents.has(event.id)) {
        log.info('webhook duplicate skipped', { event_id: event.id, event_type: event.event_type });
        return;
      }
      this.#rememberEvent(event.id);
    }
    const type = event.event_type;
    const resource = event.resource ?? {};

    if (type === 'CHECKOUT.ORDER.APPROVED') {
      const order = resource.id ? await this.#store.getByPayPalOrderId(resource.id) : undefined;
      if (!order) return this.#ignore(event, 'unknown order');
      this.#record(order.id, event);
      if (order.status === 'NEEDS_NEW_FUNDING') {
        // Could be the approval from before the decline arriving late. Only the buyer's
        // return after re-approving (or get_order_status) may capture again.
        return this.#ignore(event, 'order is waiting for the buyer to re-approve');
      }
      if (FINAL_STATUSES.has(order.status) || order.status === 'PAYMENT_PENDING') {
        return this.#ignore(event, `order already ${order.status}`);
      }
      const result = await this.capture(order.id, 'webhook');
      log.info('webhook processed', { event_id: event.id, event_type: type, order_id: order.id, outcome: result.outcome });
      return;
    }

    if (type === 'PAYMENT.CAPTURE.COMPLETED' || type === 'PAYMENT.CAPTURE.DENIED') {
      const order = await this.#orderForCapture(resource);
      if (!order) return this.#ignore(event, 'unknown order');
      this.#record(order.id, event);
      const result =
        type === 'PAYMENT.CAPTURE.COMPLETED'
          ? await this.#markCompleted(order.id, resource.id ?? order.captureId ?? 'unknown')
          : await this.#transition(order.id, 'FAILED', resource.id ? { captureId: resource.id } : {});
      log.info('webhook processed', {
        event_id: event.id,
        event_type: type,
        order_id: order.id,
        status: result.order.status,
        changed: result.changed,
      });
      return;
    }

    this.#ignore(event, 'event type not handled');
  }

  async #orderForCapture(resource: NonNullable<WebhookEvent['resource']>): Promise<Order | undefined> {
    const paypalOrderId = resource.supplementary_data?.related_ids?.order_id;
    const byPayPal = paypalOrderId ? await this.#store.getByPayPalOrderId(paypalOrderId) : undefined;
    if (byPayPal) return byPayPal;
    return resource.custom_id ? this.#store.get(resource.custom_id) : undefined;
  }

  #record(orderId: string, event: WebhookEvent): void {
    const list = this.#webhookLog.get(orderId) ?? [];
    list.push({
      event_id: event.id ?? null,
      event_type: event.event_type ?? 'unknown',
      event_time: event.create_time ?? null,
      received_at: new Date().toISOString(),
    });
    this.#webhookLog.set(orderId, list.slice(-20));
  }

  #ignore(event: WebhookEvent, reason: string): void {
    log.info('webhook ignored', { event_id: event.id, event_type: event.event_type, reason });
  }

  #rememberEvent(id: string): void {
    this.#seenEvents.add(id);
    if (this.#seenEvents.size > 5000) {
      const oldest = this.#seenEvents.values().next().value;
      if (oldest !== undefined) this.#seenEvents.delete(oldest);
    }
  }

  async #markCompleted(orderId: string, captureId: string): Promise<{ order: Order; changed: boolean }> {
    const result = await this.#transition(orderId, 'COMPLETED', { captureId });
    if (!result.changed) return result;
    for (const item of result.order.items) {
      try {
        const { remaining, shortBy, applied } = await this.#stock.take(orderId, item.productId, item.quantity);
        if (!applied) {
          log.info('stock already taken for this order line', { order_id: orderId, product_id: item.productId });
        } else if (shortBy > 0) {
          log.warn('oversold', { order_id: orderId, product_id: item.productId, short_by: shortBy });
        } else {
          log.info('stock taken', { order_id: orderId, product_id: item.productId, quantity: item.quantity, remaining });
        }
      } catch (err) {
        // The money has moved; a stock failure must not undo the order. Log loudly to fix by hand.
        log.error('stock take failed', { order_id: orderId, product_id: item.productId, quantity: item.quantity, err });
      }
    }
    log.info('order completed', { order_id: orderId, capture_id: captureId, total: formatUsd(result.order.totalCents) });
    if (this.#notifier) {
      this.#notifier.orderCompleted(result.order).catch((err: unknown) => {
        log.warn('seller notification failed', { order_id: orderId, err });
      });
    }
    return result;
  }

  /**
   * Move an order to `to` if ALLOWED_TRANSITIONS permits, under a per-order lock so
   * concurrent paths (return page, webhook, status poll) can't both apply side effects.
   */
  #transition(
    orderId: string,
    to: OrderStatus,
    extra: { captureId?: string } = {},
  ): Promise<{ order: Order; changed: boolean }> {
    return this.#withLock(orderId, async () => {
      const current = await this.#mustGet(orderId);
      if (!canTransition(current.status, to)) {
        if (current.status !== to) {
          log.info('status change skipped', { order_id: orderId, from: current.status, to });
        }
        return { order: current, changed: false };
      }
      const order = await this.#store.update(orderId, { status: to, ...extra });
      if (current.status !== to) log.info('status changed', { order_id: orderId, from: current.status, to });
      return { order, changed: current.status !== to };
    });
  }

  async #withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const settled = run.catch(() => undefined);
    this.#locks.set(key, settled);
    try {
      return await run;
    } finally {
      if (this.#locks.get(key) === settled) this.#locks.delete(key);
    }
  }

  async #mustGet(orderId: string): Promise<Order> {
    const order = await this.#store.get(orderId);
    if (!order) throw new Error(`Order not found: ${orderId}`);
    return order;
  }
}

function statusOutcome(status: OrderStatus): CaptureOutcome {
  switch (status) {
    case 'COMPLETED':
      return 'completed';
    case 'PAYMENT_PENDING':
      return 'pending';
    case 'FAILED':
      return 'failed';
    case 'NEEDS_NEW_FUNDING':
      return 'declined';
    default:
      return 'not_approved';
  }
}

/** What agents and scripts see. Amounts as display strings and cents; no internals. */
export interface OrderView {
  order_id: string;
  status: OrderStatus;
  status_message: string;
  /** Present while the buyer still has something to do in PayPal. */
  approval_url?: string;
  currency: string;
  items: { product_id: string; name: string; unit: string; quantity: number; unit_price: string; line_total: string }[];
  total: string;
  total_cents: number;
  paypal_order_id: string;
  capture_id: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_MESSAGES: Record<OrderStatus, string> = {
  CREATED: 'Waiting for the buyer to open the PayPal link and approve. Not paid yet.',
  APPROVED: 'The buyer approved in PayPal; the payment is being captured. Not paid yet.',
  PAYMENT_PENDING: 'PayPal accepted the payment but is holding the funds for review. Not paid yet; check again later.',
  COMPLETED: 'Paid. The payment was captured. The seller will contact the buyer about pickup or delivery.',
  NEEDS_NEW_FUNDING:
    'The payment method was declined. The buyer must open the same PayPal link again and choose another way to pay. Not paid yet.',
  CANCELLED:
    'The buyer cancelled at PayPal. Nothing was charged. The same PayPal link still works if the buyer changes their mind.',
  FAILED: 'This order cannot be paid. Nothing was charged. Start a new order if the buyer still wants to buy.',
};

const NEEDS_BUYER: ReadonlySet<OrderStatus> = new Set(['CREATED', 'NEEDS_NEW_FUNDING', 'CANCELLED']);

export function toOrderView(order: Order): OrderView {
  return {
    order_id: order.id,
    status: order.status,
    status_message: STATUS_MESSAGES[order.status],
    ...(NEEDS_BUYER.has(order.status) ? { approval_url: order.approvalUrl } : {}),
    currency: order.currency,
    items: order.items.map((item) => ({
      product_id: item.productId,
      name: item.name,
      unit: item.unit,
      quantity: item.quantity,
      unit_price: formatUsd(item.unitPriceCents),
      line_total: formatUsd(item.lineTotalCents),
    })),
    total: formatUsd(order.totalCents),
    total_cents: order.totalCents,
    paypal_order_id: order.paypalOrderId,
    capture_id: order.captureId,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
  };
}
