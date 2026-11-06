import type { Catalog, ShopInfo } from './catalog.js';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { PayPalGateway, PayPalOrderSummary } from './paypal.js';
import { PayPalHttpError } from './paypal-http.js';
import { platformFromCatalogs, type Platform, type ShopProduct } from './platform.js';
import { priceCart, type CartInput, type PricingIssue, type Quote } from './pricing.js';
import { CatalogStockStore, type StockStore } from './stock.js';
import { FINAL_STATUSES, newOrderId, type Order, type OrderStatus, type OrderStore } from './store.js';

/**
 * The money path, shared by the PayPal return page, the webhook, the internal
 * /api/orders endpoints and the MCP tools, so they can't drift apart.
 *
 * Invariants:
 * - Prices come from the shop's catalog via priceCart, never from the caller.
 * - One order belongs to one shop: its brand name and PayPal payee come from that shop.
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

/** Why an order could not be created. Pricing issues, plus which shop it belongs to. */
export type OrderIssue =
  | PricingIssue
  | { code: 'UNKNOWN_SHOP'; shopId: string; message: string }
  | { code: 'MIXED_SHOPS'; shopIds: string[]; message: string };

export type CreateOrderResult = { ok: true; order: Order; quote: Quote; shop: Readonly<ShopInfo> } | { ok: false; issues: OrderIssue[] };

/** Told once per order, when it moves to COMPLETED. */
export interface SellerNotifier {
  orderCompleted(order: Order, shop: Readonly<ShopInfo>): Promise<void>;
}

export type OrderServiceOptions = (
  | {
      /** The shops. */
      platform: Platform;
    }
  | {
      /** A single shop (tests and single-seller setups). */
      catalog: Catalog;
    }
) & {
  store: OrderStore;
  /** Live stock. Defaults to in-memory stock on the catalogs. */
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

/** Upper bound for a restock level; guards against typos like 5000 for 50. */
export const MAX_STOCK = 1000;

export class OrderService {
  readonly #platform: Platform;
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
    this.#platform = 'platform' in options ? options.platform : platformFromCatalogs([options.catalog]);
    this.#stock = options.stock ?? new CatalogStockStore(this.#platform.inventory);
    this.#store = options.store;
    this.#paypal = options.paypal;
    this.#baseUrl = options.publicBaseUrl;
    this.#allowSimulatedDecline = options.allowSimulatedDecline;
    this.#notifier = options.notifier;
  }

  get platform(): Platform {
    return this.#platform;
  }

  listShops(): Readonly<ShopInfo>[] {
    return this.#platform.shops();
  }

  shop(shopId: string): Readonly<ShopInfo> | undefined {
    return this.#platform.shop(shopId);
  }

  /** The shop an order belongs to, from its items (every line of an order is from one shop). */
  shopForOrder(order: Order): Readonly<ShopInfo> | undefined {
    for (const item of order.items) {
      const shop = this.#platform.shopOfProduct(item.productId);
      if (shop) return shop;
    }
    return undefined;
  }

  /** What agents and scripts see for an order, with its shop. */
  view(order: Order): OrderView {
    return toOrderView(order, this.shopForOrder(order));
  }

  /**
   * Seller restock: set absolute stock levels. Every id must be a product of some shop and
   * every level a whole number from 0 to MAX_STOCK; otherwise nothing is changed.
   */
  async setStock(levels: Record<string, number>): Promise<{ ok: true } | { ok: false; errors: string[] }> {
    const errors: string[] = [];
    for (const [productId, stock] of Object.entries(levels)) {
      if (!this.#platform.inventory.getProduct(productId)) errors.push(`Unknown product_id "${productId}".`);
      if (!Number.isSafeInteger(stock) || stock < 0 || stock > MAX_STOCK) {
        errors.push(`Stock for "${productId}" must be a whole number from 0 to ${MAX_STOCK} (got ${stock}).`);
      }
    }
    if (Object.keys(levels).length === 0) errors.push('Give at least one product level.');
    if (errors.length > 0) return { ok: false, errors };
    await this.#stock.setLevels(new Map(Object.entries(levels)));
    log.info('stock set', { levels });
    return { ok: true };
  }

  /** Products with live stock levels: one shop's, or every shop's. Unknown shop: none. */
  async listProducts(shopId?: string): Promise<ShopProduct[]> {
    const shops = shopId === undefined ? this.#platform.shops() : [this.#platform.shop(shopId)].filter((s) => s !== undefined);
    const levels = await this.#stock.levels();
    return shops.flatMap((shop) =>
      (this.#platform.catalog(shop.id)?.listProducts() ?? []).map((p) => ({ ...p, shopId: shop.id, stock: levels.get(p.id) ?? 0 })),
    );
  }

  /**
   * Price and create an order for one shop. The shop is `shopId` when given, otherwise the
   * shop that sells the items. A cart can't mix shops: each seller gets paid separately.
   */
  async createOrder(
    input: CartInput,
    options: { shopId?: string; simulateDecline?: boolean } = {},
  ): Promise<CreateOrderResult> {
    const resolved = this.#resolveShop(input, options.shopId);
    if (!resolved.ok) return resolved;
    const { catalog } = resolved;
    const shop = catalog.shop;

    const priced = priceCart(catalog, input, await this.#stock.levels());
    if (!priced.ok) return { ok: false, issues: priced.issues.map((issue) => this.#explainForeignProduct(issue, shop)) };
    const { quote } = priced;

    const id = newOrderId();
    const paypalOrder = await this.#paypal.createOrder({
      orderId: id,
      quote,
      brandName: shop.name,
      returnUrl: `${this.#baseUrl}/paypal/return`,
      cancelUrl: `${this.#baseUrl}/paypal/cancel`,
      ...(shop.payeeEmail ? { payeeEmail: shop.payeeEmail } : {}),
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
      shop_id: shop.id,
      paypal_order_id: paypalOrder.id,
      total: formatUsd(order.totalCents),
      simulate_decline: order.simulateDecline,
    });
    return { ok: true, order, quote, shop };
  }

  #resolveShop(
    input: CartInput,
    shopId: string | undefined,
  ): { ok: true; catalog: Catalog } | { ok: false; issues: OrderIssue[] } {
    if (shopId !== undefined) {
      const catalog = this.#platform.catalog(shopId);
      if (catalog) return { ok: true, catalog };
      const valid = this.#platform.shops().map((s) => s.id).join(', ');
      return { ok: false, issues: [{ code: 'UNKNOWN_SHOP', shopId, message: `Unknown shop_id "${shopId}". Valid ids: ${valid}.` }] };
    }
    const shopIds = [
      ...new Set(input.items.flatMap((item) => this.#platform.shopOfProduct(item.product_id.trim())?.id ?? [])),
    ];
    if (shopIds.length > 1) {
      const names = shopIds.map((id) => this.#platform.shop(id)?.name ?? id).join(' and ');
      return {
        ok: false,
        issues: [
          {
            code: 'MIXED_SHOPS',
            shopIds,
            message: `These items come from ${names}. Each shop is paid separately, so create one order per shop.`,
          },
        ],
      };
    }
    // No known product at all: price against the first shop so the buyer sees which ids are wrong.
    const catalog = this.#platform.catalog(shopIds[0] ?? this.#platform.shops()[0]!.id)!;
    return { ok: true, catalog };
  }

  /** A product another shop sells gets a clearer message than "unknown". */
  #explainForeignProduct(issue: PricingIssue, shop: Readonly<ShopInfo>): OrderIssue {
    if (issue.code !== 'UNKNOWN_PRODUCT') return issue;
    const owner = this.#platform.shopOfProduct(issue.productId);
    if (!owner || owner.id === shop.id) return issue;
    return {
      ...issue,
      message: `"${issue.productId}" is sold by ${owner.name} (shop_id ${owner.id}), not ${shop.name}. Create a separate order for it.`,
    };
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
    const shop = this.shopForOrder(result.order);
    if (this.#notifier && shop) {
      this.#notifier.orderCompleted(result.order, shop).catch((err: unknown) => {
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
  /** The seller. Absent only if the order's products no longer exist in any shop. */
  shop?: { shop_id: string; name: string };
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
  COMPLETED: 'Paid. The payment was captured. The seller will contact the buyer to arrange delivery, pickup or the booking.',
  NEEDS_NEW_FUNDING:
    'The payment method was declined. The buyer must open the same PayPal link again and choose another way to pay. Not paid yet.',
  CANCELLED:
    'The buyer cancelled at PayPal. Nothing was charged. The same PayPal link still works if the buyer changes their mind.',
  FAILED: 'This order cannot be paid. Nothing was charged. Start a new order if the buyer still wants to buy.',
};

const NEEDS_BUYER: ReadonlySet<OrderStatus> = new Set(['CREATED', 'NEEDS_NEW_FUNDING', 'CANCELLED']);

export function toOrderView(order: Order, shop?: Readonly<ShopInfo>): OrderView {
  return {
    order_id: order.id,
    ...(shop ? { shop: { shop_id: shop.id, name: shop.name } } : {}),
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
