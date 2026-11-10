import type { Catalog, ShopInfo } from './catalog.js';
import { log } from './log.js';
import { formatUsd, sumCents } from './money.js';
import type { Buyer, PayPalGateway, PayPalOrderSummary, UnitCapture } from './paypal.js';
import { PayPalHttpError } from './paypal-http.js';
import { platformFromCatalogs, type Platform, type ShopProduct } from './platform.js';
import { priceCart, type CartInput, type PricingIssue, type Quote } from './pricing.js';
import { CatalogStockStore, type StockStore } from './stock.js';
import { FINAL_STATUSES, newOrderId, type Order, type OrderPatch, type OrderStatus, type OrderStore } from './store.js';

/**
 * The money path, shared by the PayPal return page, the webhook, the internal
 * /api/orders endpoints and the MCP tools, so they can't drift apart.
 *
 * Invariants:
 * - Prices come from the shop's catalog via priceCart, never from the caller.
 * - Each shop's part of an order is its own PayPal purchase unit: brand name and payee come from
 *   that shop's catalog entry. One shop gives one unit; a mixed cart gives one unit per shop.
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
  | { code: 'UNKNOWN_SHOP'; shopId: string; message: string };

/** The shops in an order, in item order: one for a normal order, several for a combined checkout. */
export type CreateOrderResult = { ok: true; order: Order; quote: Quote; shops: Readonly<ShopInfo>[] } | { ok: false; issues: OrderIssue[] };

interface PlanPart {
  shop: Readonly<ShopInfo>;
  quote: Quote;
}
type Plan = { ok: true; parts: PlanPart[] } | { ok: false; issues: OrderIssue[] };

/** Brand shown in PayPal for a combined checkout; each purchase unit still names its shop. */
export const PLATFORM_BRAND = 'hackapal';

/** One quote for the whole order (all shops), for storage and display. */
function combineQuotes(quotes: Quote[]): Quote {
  if (quotes.length === 1) return quotes[0]!;
  const lines = quotes.flatMap((q) => q.lines);
  const itemTotalCents = sumCents(quotes.map((q) => q.itemTotalCents));
  return { currency: quotes[0]!.currency, lines, itemTotalCents, totalCents: sumCents(quotes.map((q) => q.totalCents)) };
}

const CAPTURE_DONE = new Set(['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED']);
const CAPTURE_FAILED = new Set(['DECLINED', 'FAILED']);

/**
 * Told when an order moves to COMPLETED, once per paid seller. `buyer` is who paid, when PayPal
 * says. Resolve `false` when the seller wasn't reached: the order then stays pending and the
 * retry sweep (retrySellerPings) tries again. Anything else counts as delivered.
 */
export interface SellerNotifier {
  orderCompleted(order: Order, shop: Readonly<ShopInfo>, buyer?: Buyer): Promise<boolean | void>;
}

/** Retry sweeps per order before we stop and log loudly (one sweep every few minutes). */
export const MAX_PING_ATTEMPTS = 12;
/** Orders handled per sweep. */
const PING_SWEEP_BATCH = 50;

export interface PingSweepResult {
  /** Orders the sweep looked at. */
  checked: number;
  /** Orders whose sellers are now all pinged. */
  delivered: number;
  /** Orders given up on after MAX_PING_ATTEMPTS. */
  abandoned: number;
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
  /** Orders whose sellers are being pinged right now, so the sweep and the inline ping never overlap. */
  readonly #notifying = new Set<string>();
  #sweeping = false;
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

  /** The shops an order belongs to, from its items, in item order (several for a combined checkout). */
  shopsForOrder(order: Order): Readonly<ShopInfo>[] {
    const shops = new Map<string, Readonly<ShopInfo>>();
    for (const item of order.items) {
      const shop = this.#platform.shopOfProduct(item.productId);
      if (shop && !shops.has(shop.id)) shops.set(shop.id, shop);
    }
    return [...shops.values()];
  }

  /** The order's shop when it has exactly one; undefined for a combined checkout. */
  shopForOrder(order: Order): Readonly<ShopInfo> | undefined {
    const shops = this.shopsForOrder(order);
    return shops.length === 1 ? shops[0] : undefined;
  }

  /** What agents and scripts see for an order, with its shop or shops. */
  view(order: Order): OrderView {
    const shops = this.shopsForOrder(order);
    if (shops.length <= 1) return toOrderView(order, shops[0]);
    const totalFor = (shopId: string) =>
      sumCents(order.items.filter((i) => this.#platform.shopOfProduct(i.productId)?.id === shopId).map((i) => i.lineTotalCents));
    return {
      ...toOrderView(order),
      shops: shops.map((s) => ({ shop_id: s.id, name: s.name, total: formatUsd(totalFor(s.id)) })),
    };
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
   * Price and create an order. With `shopId`, every item must come from that shop. Without it,
   * the items decide: one shop gives a normal order, several shops give one combined checkout
   * (design decision 18): one PayPal order with a purchase unit per shop, each paying that
   * shop's own account, so the buyer approves once and every seller is paid directly.
   */
  async createOrder(
    input: CartInput,
    options: { shopId?: string; simulateDecline?: boolean; note?: string } = {},
  ): Promise<CreateOrderResult> {
    const levels = await this.#stock.levels();
    const planned = options.shopId !== undefined ? this.#planForShop(input, options.shopId, levels) : this.#planByItems(input, levels);
    if (!planned.ok) return planned;
    const { parts } = planned;
    const shops = parts.map((p) => p.shop);
    const combined = parts.length > 1;
    const quote = combineQuotes(parts.map((p) => p.quote));

    const id = newOrderId();
    const paypalOrder = await this.#paypal.createOrder({
      orderId: id,
      quote,
      brandName: combined ? PLATFORM_BRAND : shops[0]!.name,
      returnUrl: `${this.#baseUrl}/paypal/return`,
      cancelUrl: `${this.#baseUrl}/paypal/cancel`,
      ...(combined
        ? {
            units: parts.map((p) => ({
              referenceId: p.shop.id,
              label: p.shop.name,
              quote: p.quote,
              ...(p.shop.payeeEmail ? { payeeEmail: p.shop.payeeEmail } : {}),
            })),
          }
        : shops[0]!.payeeEmail
          ? { payeeEmail: shops[0]!.payeeEmail }
          : {}),
      ...(shops.some((s) => s.collectsAddress) ? { collectAddress: true } : {}),
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
      buyerNote: cleanNote(options.note),
    });
    log.info('order created', {
      order_id: id,
      shop_ids: shops.map((s) => s.id),
      paypal_order_id: paypalOrder.id,
      total: formatUsd(order.totalCents),
      simulate_decline: order.simulateDecline,
      has_note: order.buyerNote !== null,
    });
    return { ok: true, order, quote, shops };
  }

  #planForShop(input: CartInput, shopId: string, levels: ReadonlyMap<string, number>): Plan {
    const catalog = this.#platform.catalog(shopId);
    if (!catalog) {
      const valid = this.#platform.shops().map((s) => s.id).join(', ');
      return { ok: false, issues: [{ code: 'UNKNOWN_SHOP', shopId, message: `Unknown shop_id "${shopId}". Valid ids: ${valid}.` }] };
    }
    const priced = priceCart(catalog, input, levels);
    if (!priced.ok) return { ok: false, issues: priced.issues.map((issue) => this.#explainForeignProduct(issue, catalog.shop)) };
    return { ok: true, parts: [{ shop: catalog.shop, quote: priced.quote }] };
  }

  /** Group the items by the shop that sells them and price each group from that shop's catalog. */
  #planByItems(input: CartInput, levels: ReadonlyMap<string, number>): Plan {
    const groups = new Map<string, CartInput['items']>();
    const unknown: CartInput['items'] = [];
    for (const item of input.items) {
      const shop = this.#platform.shopOfProduct(item.product_id.trim());
      if (!shop) {
        unknown.push(item);
        continue;
      }
      groups.set(shop.id, [...(groups.get(shop.id) ?? []), item]);
    }
    // Unknown ids are priced against a catalog so the buyer gets the usual message with valid ids.
    const fallback = [...groups.keys()][0] ?? this.#platform.shops()[0]!.id;
    if (unknown.length > 0) groups.set(fallback, [...(groups.get(fallback) ?? []), ...unknown]);

    const parts: PlanPart[] = [];
    const issues: OrderIssue[] = [];
    for (const [shopId, items] of groups) {
      const catalog = this.#platform.catalog(shopId)!;
      const priced = priceCart(catalog, { items }, levels);
      if (priced.ok) parts.push({ shop: catalog.shop, quote: priced.quote });
      else issues.push(...priced.issues);
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, parts };
  }

  /** A product another shop sells gets a clearer message than "unknown". */
  #explainForeignProduct(issue: PricingIssue, shop: Readonly<ShopInfo>): OrderIssue {
    if (issue.code !== 'UNKNOWN_PRODUCT') return issue;
    const owner = this.#platform.shopOfProduct(issue.productId);
    if (!owner || owner.id === shop.id) return issue;
    return {
      ...issue,
      message: `"${issue.productId}" is sold by ${owner.name} (shop_id ${owner.id}), not ${shop.name}. Leave out shop_id to buy from several shops in one checkout.`,
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

  /**
   * Apply a PayPal order that may carry captures (capture response or a fresh GET). A combined
   * checkout has one capture per seller: COMPLETED once every seller's capture is done; while
   * any is still PENDING we wait; if some failed and the rest are done, the order completes for
   * the sellers who were paid (stock and pings for those only) and the failure is logged.
   */
  async #applyCaptured(orderId: string, paypalOrder: PayPalOrderSummary): Promise<CaptureResult> {
    const captures: UnitCapture[] =
      paypalOrder.captures ?? (paypalOrder.capture ? [{ referenceId: 'default', ...paypalOrder.capture }] : []);
    const captureId = captures.map((c) => c.id).join(',');
    const done = captures.filter((c) => CAPTURE_DONE.has(c.status));
    const failed = captures.filter((c) => CAPTURE_FAILED.has(c.status));
    const pending = captures.length - done.length - failed.length;

    if (captures.length > 0 && pending === 0 && done.length > 0) {
      if (failed.length > 0) {
        log.error('combined checkout partly captured: some sellers were not paid', {
          order_id: orderId,
          paid: done.map((c) => c.referenceId),
          failed: failed.map((c) => `${c.referenceId}:${c.status}`),
        });
      }
      const { order } = await this.#markCompleted(orderId, captureId, paypalOrder.buyer, done);
      return { outcome: order.status === 'COMPLETED' ? 'completed' : statusOutcome(order.status), order };
    }
    if (pending > 0 && captures.some((c) => c.status === 'PENDING')) {
      const { order } = await this.#transition(orderId, 'PAYMENT_PENDING', { captureId });
      return { outcome: statusOutcome(order.status), order };
    }
    if (captures.length > 0 && failed.length === captures.length) {
      const { order } = await this.#transition(orderId, 'FAILED', { captureId });
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
      // Remembered before any await, so two concurrent deliveries can't both get through.
      this.#rememberEvent(event.id);
    }
    try {
      await this.#processWebhookEvent(event);
    } catch (err) {
      // Processing failed (PayPal 5xx, store outage): forget the id, so a redelivery of this
      // event is processed instead of being skipped as a duplicate of work that never happened.
      if (event.id) this.#seenEvents.delete(event.id);
      throw err;
    }
  }

  async #processWebhookEvent(event: WebhookEvent): Promise<void> {
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
      if (this.shopsForOrder(order).length > 1) {
        // One event per seller's capture: read the whole order so every seller's capture counts.
        if (FINAL_STATUSES.has(order.status)) return this.#ignore(event, `order already ${order.status}`);
        const reconciled = await this.#applyCaptured(order.id, await this.#paypal.getOrder(order.paypalOrderId));
        log.info('webhook processed', { event_id: event.id, event_type: type, order_id: order.id, outcome: reconciled.outcome });
        return;
      }
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

  /**
   * Move to COMPLETED, then take stock and ping each paid seller once. `paid` lists the
   * captures that completed (per seller in a combined checkout); without it every line counts.
   */
  async #markCompleted(
    orderId: string,
    captureId: string,
    buyer?: Buyer,
    paid?: UnitCapture[],
  ): Promise<{ order: Order; changed: boolean }> {
    const result = await this.#transition(orderId, 'COMPLETED', { captureId, ...(this.#notifier ? { pingPending: true } : {}) });
    if (!result.changed) return result;
    const shops = this.shopsForOrder(result.order);
    const captureFor = new Map<string, string>(
      shops.length > 1 ? (paid ?? []).map((c) => [c.referenceId, c.id] as [string, string]) : shops.map((s) => [s.id, captureId] as [string, string]),
    );
    const isPaid = (productId: string) => {
      const shop = this.#platform.shopOfProduct(productId);
      return shops.length <= 1 || (shop !== undefined && captureFor.has(shop.id));
    };
    for (const item of result.order.items.filter((i) => isPaid(i.productId))) {
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
    // Fire and forget: the seller pings never delay or fail the payment. A seller who isn't
    // reached stays recorded as pending and is retried by retrySellerPings.
    void this.#notifySellers(result.order, captureFor, { buyer, lookUpBuyer: true }).catch((err: unknown) => {
      log.warn('seller notification failed', { order_id: orderId, err });
    });
    return result;
  }

  /**
   * Ping each paid seller not pinged yet, recording each success on the order, and clear
   * pingPending once all are done. Each seller gets only their own lines, total and capture.
   * `captureFor` maps shop id to its capture; in a combined checkout only those shops were paid.
   * Returns true when every paid seller has now been pinged.
   */
  async #notifySellers(
    order: Order,
    captureFor: ReadonlyMap<string, string>,
    { buyer, lookUpBuyer }: { buyer?: Buyer; lookUpBuyer: boolean },
  ): Promise<boolean> {
    const notifier = this.#notifier;
    if (!notifier || this.#notifying.has(order.id)) return false;
    this.#notifying.add(order.id);
    try {
      const shops = this.shopsForOrder(order);
      const paid = shops.filter((s) => shops.length <= 1 || captureFor.has(s.id));
      const pinged = [...order.sellersPinged];
      const todo = paid.filter((s) => !pinged.includes(s.id));
      if (todo.length > 0) {
        const who = buyer ?? (lookUpBuyer ? await this.#buyerFor(order) : undefined);
        for (const shop of todo) {
          const items = order.items.filter((i) => this.#platform.shopOfProduct(i.productId)?.id === shop.id);
          const slice: Order = {
            ...order,
            items,
            totalCents: sumCents(items.map((i) => i.lineTotalCents)),
            captureId: captureFor.get(shop.id) ?? order.captureId,
          };
          const reached = await notifier.orderCompleted(slice, shop, who).then(
            (answer) => answer !== false,
            (err: unknown) => {
              log.warn('seller notification failed', { order_id: order.id, shop_id: shop.id, err });
              return false;
            },
          );
          if (!reached) continue;
          pinged.push(shop.id);
          await this.#saveQuietly(order.id, { sellersPinged: [...pinged] });
        }
      }
      const done = paid.every((s) => pinged.includes(s.id));
      if (done && order.pingPending) await this.#saveQuietly(order.id, { pingPending: false });
      if (!done) {
        log.warn('seller ping pending, will retry', {
          order_id: order.id,
          missing: paid.filter((s) => !pinged.includes(s.id)).map((s) => s.id),
        });
      }
      return done;
    } finally {
      this.#notifying.delete(order.id);
    }
  }

  /** Ping bookkeeping must never throw into the payment path; a failed write is retried later. */
  async #saveQuietly(orderId: string, patch: OrderPatch): Promise<void> {
    try {
      await this.#store.update(orderId, patch);
    } catch (err) {
      log.warn('could not record seller ping state', { order_id: orderId, err });
    }
  }

  /**
   * Retry sellers who weren't reached when their order was paid (Telegram down, a restart
   * mid-ping). Run on a timer. Each pass re-reads the order from PayPal for the buyer and,
   * in a combined checkout, which sellers were actually paid. After MAX_PING_ATTEMPTS passes
   * an order is dropped with an error log, so a permanently broken chat can't loop forever.
   */
  async retrySellerPings(): Promise<PingSweepResult> {
    const result: PingSweepResult = { checked: 0, delivered: 0, abandoned: 0 };
    if (!this.#notifier || this.#sweeping) return result;
    this.#sweeping = true;
    try {
      for (const order of await this.#store.listPingsPending(PING_SWEEP_BATCH)) {
        if (this.#notifying.has(order.id)) continue;
        result.checked += 1;
        if (order.pingAttempts >= MAX_PING_ATTEMPTS) {
          await this.#saveQuietly(order.id, { pingPending: false });
          log.error('seller ping abandoned: seller was never told about this paid order', {
            order_id: order.id,
            attempts: order.pingAttempts,
            pinged: order.sellersPinged,
          });
          result.abandoned += 1;
          continue;
        }
        await this.#saveQuietly(order.id, { pingAttempts: order.pingAttempts + 1 });
        const current = { ...order, pingAttempts: order.pingAttempts + 1 };

        let summary: PayPalOrderSummary | undefined;
        try {
          summary = await this.#paypal.getOrder(order.paypalOrderId);
        } catch (err) {
          log.warn('ping retry: could not read the order from PayPal', {
            order_id: order.id,
            debug_id: err instanceof PayPalHttpError ? err.debugId : undefined,
          });
        }
        const shops = this.shopsForOrder(order);
        let captureFor: Map<string, string>;
        if (shops.length <= 1) {
          captureFor = new Map(shops.map((s) => [s.id, order.captureId ?? 'unknown']));
        } else if (summary?.captures) {
          captureFor = new Map(summary.captures.filter((c) => CAPTURE_DONE.has(c.status)).map((c) => [c.referenceId, c.id]));
        } else {
          // Without PayPal we can't tell which sellers in a combined checkout were paid. Next pass.
          continue;
        }
        if (await this.#notifySellers(current, captureFor, { ...(summary?.buyer ? { buyer: summary.buyer } : {}), lookUpBuyer: false })) {
          result.delivered += 1;
        }
      }
    } finally {
      this.#sweeping = false;
    }
    if (result.checked > 0) log.info('seller ping retry sweep', { ...result });
    return result;
  }

  /**
   * Who paid, for the seller ping, when the completion came without it (the
   * PAYMENT.CAPTURE.COMPLETED webhook carries the capture, not the payer). Best effort.
   */
  async #buyerFor(order: Order): Promise<Buyer | undefined> {
    try {
      return (await this.#paypal.getOrder(order.paypalOrderId)).buyer;
    } catch (err) {
      log.warn('could not read the buyer for the seller ping', {
        order_id: order.id,
        debug_id: err instanceof PayPalHttpError ? err.debugId : undefined,
      });
      return undefined;
    }
  }

  /**
   * Move an order to `to` if ALLOWED_TRANSITIONS permits, under a per-order lock so
   * concurrent paths (return page, webhook, status poll) can't both apply side effects.
   */
  #transition(
    orderId: string,
    to: OrderStatus,
    extra: { captureId?: string; pingPending?: boolean } = {},
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

/** Longest buyer note we keep; matches the column check in supabase/migrations. */
export const MAX_NOTE_LENGTH = 300;

/** A UTF-16 surrogate with no partner: not valid text, and Postgres and Telegram reject it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Plain, single-spaced text, cut to MAX_NOTE_LENGTH characters; null when empty. The cut counts
 * code points (as the column's char_length check does), so an emoji is never split in half.
 */
export function cleanNote(note: string | undefined): string | null {
  const cleaned = (note ?? '')
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  const characters = Array.from(cleaned);
  return characters.length > MAX_NOTE_LENGTH ? characters.slice(0, MAX_NOTE_LENGTH).join('').trimEnd() : cleaned;
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
  /** The seller, for an order from one shop. */
  shop?: { shop_id: string; name: string };
  /** Every seller and their part of the total, for a combined checkout. */
  shops?: { shop_id: string; name: string; total: string }[];
  /** The buyer's note for the seller, as stored. */
  note?: string;
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
    ...(order.buyerNote ? { note: order.buyerNote } : {}),
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
