import { randomUUID } from 'node:crypto';
import {
  ApiError,
  CheckoutPaymentIntent,
  Client,
  Environment,
  ItemCategory,
  OrdersController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type OAuthToken,
  type Order as SdkOrder,
  type OrderRequest,
} from '@paypal/paypal-server-sdk';
import { log } from './log.js';
import { toDecimalString } from './money.js';
import { PayPalAuth, type AccessToken } from './paypal-auth.js';
import {
  debugIdOf,
  defaultHttpDeps,
  describeError,
  PAYPAL_SANDBOX_API,
  PayPalHttpError,
  paypalRequest,
  type HttpDeps,
} from './paypal-http.js';
import type { Quote } from './pricing.js';

/**
 * Everything the order service needs from PayPal. Orders v2 goes through
 * @paypal/paypal-server-sdk; webhook verification isn't in the SDK, so it uses fetch.
 * All failures surface as PayPalHttpError (status, PayPal error name, details[0].issue,
 * debug_id), already logged with the debug_id.
 */
export interface PayPalGateway {
  createOrder(input: CreateOrderInput): Promise<PayPalOrderSummary>;
  getOrder(paypalOrderId: string): Promise<PayPalOrderSummary>;
  captureOrder(paypalOrderId: string, options: CaptureOptions): Promise<PayPalOrderSummary>;
  /** True only if PayPal answered verification_status SUCCESS for this exact delivery. */
  verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean>;
}

export interface CreateOrderInput {
  /** Our order id: sent as custom_id and used in the request id create-<orderId>. */
  orderId: string;
  quote: Quote;
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
  /**
   * Seller's PayPal account (option B, design decision 16): when set, the order's
   * purchase_units[0].payee routes the captured funds straight to that merchant instead of
   * the API caller. Omitted: funds go to the account that owns our REST app.
   */
  payeeEmail?: string;
  /** Ask the buyer for a delivery or service address in PayPal (GET_FROM_FILE). Default: no address. */
  collectAddress?: boolean;
  /**
   * Several sellers in one checkout (design decision 18): one purchase unit per seller, each
   * with its own payee, so one approval pays each seller directly. When set, it replaces the
   * single unit built from `quote` and `payeeEmail`.
   */
  units?: OrderUnit[];
}

/** One seller's part of a combined checkout. */
export interface OrderUnit {
  /** purchase_units[].reference_id; we use the shop id. Required by PayPal when there are several units. */
  referenceId: string;
  /** Shown to the buyer, e.g. the shop name. */
  label: string;
  quote: Quote;
  payeeEmail?: string;
}

export interface CaptureOptions {
  /** PayPal-Request-Id, e.g. capture-<orderId>-<attempt>. */
  requestId: string;
  /** Sandbox negative test: make PayPal answer 422 INSTRUMENT_DECLINED for this call. */
  simulateDecline?: boolean;
}

export interface VerifyWebhookInput {
  /** Incoming request headers (Node lowercases names). */
  headers: Record<string, string | string[] | undefined>;
  /** The request body exactly as received. It is spliced into the verify call unmodified. */
  rawBody: Buffer;
  webhookId: string;
}

export interface PayPalOrderSummary {
  id: string;
  /** PayPal order status: CREATED, SAVED, APPROVED, VOIDED, COMPLETED or PAYER_ACTION_REQUIRED. */
  status: string;
  /** Where the buyer approves: rel "payer-action", falling back to "approve". */
  approvalUrl?: string;
  customId?: string;
  /** First capture of the first purchase unit, once there is one. */
  capture?: { id: string; status: string };
  /** Every purchase unit's first capture, in order (one per seller in a combined checkout). */
  captures?: UnitCapture[];
  /** Who paid, once the buyer has approved. For the seller ping only; we don't store it. */
  buyer?: Buyer;
}

export const DECLINE_MOCK_HEADER = JSON.stringify({ mock_application_codes: 'INSTRUMENT_DECLINED' });

const WEBHOOK_HEADERS = {
  auth_algo: 'paypal-auth-algo',
  cert_url: 'paypal-cert-url',
  transmission_id: 'paypal-transmission-id',
  transmission_sig: 'paypal-transmission-sig',
  transmission_time: 'paypal-transmission-time',
} as const;

/** The subset of the SDK's OrdersController we call. Lets tests substitute a fake. */
export type OrdersApi = Pick<OrdersController, 'createOrder' | 'getOrder' | 'captureOrder'>;

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  auth?: PayPalAuth;
  http?: HttpDeps;
  baseUrl?: string;
  /** Test seam: build the Orders API without a real SDK client. */
  ordersFactory?: (auth: PayPalAuth) => OrdersApi;
  /** SDK request timeout in ms. */
  timeoutMs?: number;
}

/**
 * Builds the SDK client: sandbox only, our token cache, SDK retries OFF.
 *
 * Retries live in PayPalClient#call instead. In @apimatic/core 0.10.30 the error-mapping
 * interceptor runs inside the retry interceptor, so with retryOnTimeout (default true)
 * every declared error response, 404 and 422 INSTRUMENT_DECLINED included, is retried
 * like a timeout: ~8.5 s and three extra attempts per PayPal error (see BUILD_LOG).
 */
export function createSdkOrders(auth: PayPalAuth, timeoutMs = 20_000): OrdersApi {
  const client = new Client({
    environment: Environment.Sandbox,
    timeout: timeoutMs,
    clientCredentialsAuthCredentials: {
      // The SDK never fetches a token itself; it asks our cache. Ids are unused but required.
      oAuthClientId: 'managed-by-hackapal',
      oAuthClientSecret: 'managed-by-hackapal',
      oAuthTokenProvider: async () => toSdkToken(await auth.getToken()),
    },
    httpClientOptions: {
      timeout: timeoutMs,
      retryConfig: { maxNumberOfRetries: 0, retryOnTimeout: false },
    },
  });
  return new OrdersController(client);
}

/** The SDK asks our provider again once `expiry` (epoch seconds) passes, in step with our cache. */
export function toSdkToken(token: AccessToken): OAuthToken {
  return { accessToken: token.value, tokenType: 'Bearer', expiry: BigInt(Math.floor(token.refreshAt / 1000)) };
}

export class PayPalClient implements PayPalGateway {
  readonly auth: PayPalAuth;
  readonly #http: HttpDeps;
  readonly #baseUrl: string;
  readonly #ordersFactory: (auth: PayPalAuth) => OrdersApi;
  #orders: OrdersApi;

  constructor(options: PayPalClientOptions) {
    this.#http = options.http ?? defaultHttpDeps();
    this.#baseUrl = options.baseUrl ?? PAYPAL_SANDBOX_API;
    this.auth =
      options.auth ??
      new PayPalAuth({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        baseUrl: this.#baseUrl,
        http: this.#http,
      });
    this.#ordersFactory = options.ordersFactory ?? ((auth) => createSdkOrders(auth, options.timeoutMs));
    this.#orders = this.#ordersFactory(this.auth);
  }

  async createOrder(input: CreateOrderInput): Promise<PayPalOrderSummary> {
    const body = buildOrderRequest(input);
    const requestId = `create-${input.orderId}`;
    const result = await this.#call('orders.create', requestId, (orders) =>
      orders.createOrder({ body, paypalRequestId: requestId, prefer: 'return=representation' }),
    );
    return summarize(result);
  }

  async getOrder(paypalOrderId: string): Promise<PayPalOrderSummary> {
    const result = await this.#call('orders.get', undefined, (orders) => orders.getOrder({ id: paypalOrderId }));
    return summarize(result);
  }

  async captureOrder(paypalOrderId: string, options: CaptureOptions): Promise<PayPalOrderSummary> {
    const result = await this.#call('orders.capture', options.requestId, (orders) =>
      orders.captureOrder({
        id: paypalOrderId,
        paypalRequestId: options.requestId,
        prefer: 'return=representation',
        ...(options.simulateDecline ? { paypalMockResponse: DECLINE_MOCK_HEADER } : {}),
        body: {},
      }),
    );
    return summarize(result);
  }

  async verifyWebhookSignature({ headers, rawBody, webhookId }: VerifyWebhookInput): Promise<boolean> {
    const values: Record<string, string> = {};
    for (const [field, header] of Object.entries(WEBHOOK_HEADERS)) {
      const value = headers[header];
      if (typeof value !== 'string' || value === '') {
        log.warn('webhook rejected: missing PayPal header', { header });
        return false;
      }
      values[field] = value;
    }
    // Splice the raw body in byte for byte: re-serialised JSON can fail verification.
    const prefix = JSON.stringify({ ...values, webhook_id: webhookId });
    const body = Buffer.concat([
      Buffer.from(`${prefix.slice(0, -1)},"webhook_event":`, 'utf8'),
      rawBody,
      Buffer.from('}', 'utf8'),
    ]);
    const token = await this.auth.getToken();
    const response = await paypalRequest(
      {
        operation: 'webhooks.verify',
        method: 'POST',
        url: `${this.#baseUrl}/v1/notifications/verify-webhook-signature`,
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
        body,
        // Random per delivery, never derived from the (sender-supplied) transmission id, so a
        // stored verification result can't be replayed for a different delivery.
        requestId: `verify-${randomUUID()}`,
      },
      this.#http,
    );
    const status = (response.json as { verification_status?: unknown } | undefined)?.verification_status;
    if (status !== 'SUCCESS') {
      log.warn('webhook signature not verified', {
        verification_status: status,
        transmission_id: values.transmission_id,
        debug_id: response.debugId,
      });
    }
    return status === 'SUCCESS';
  }

  /**
   * Runs one SDK call with a fresh token. Retries 429, 5xx and network failures with
   * backoff (honouring Retry-After), reusing the same PayPal-Request-Id, so a retried
   * POST can't act twice. Every final failure is a logged PayPalHttpError.
   */
  async #call<T>(
    operation: string,
    requestId: string | undefined,
    run: (orders: OrdersApi) => Promise<{ result: T }>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      // Fetch the token here so a token failure is ours to report. Inside the SDK a failed
      // token fetch would stick to the client forever (see BUILD_LOG, ContextMatic notes).
      await this.auth.getToken();
      try {
        const response = await run(this.#orders);
        return response.result;
      } catch (err) {
        const failure = this.#describeFailure(err);
        if (failure.status === 401) this.auth.invalidate();
        if (failure.status === 0) this.#orders = this.#ordersFactory(this.auth);
        const retryable = failure.status === 0 || failure.status === 429 || failure.status >= 500;
        if (retryable && attempt < this.#http.retry.maxRetries) {
          const wait = this.#waitMs(attempt, failure.retryAfter);
          log.warn('paypal retryable error, retrying', {
            operation,
            request_id: requestId,
            status: failure.status,
            debug_id: failure.debugId,
            attempt: attempt + 1,
            waitMs: wait,
          });
          await this.#http.sleep(wait);
          continue;
        }
        log.error('paypal request failed', {
          operation,
          request_id: requestId,
          status: failure.status,
          debug_id: failure.debugId,
          name: failure.name,
          issue: failure.issue,
          ...(failure.status === 0 ? { error: failure.message } : {}),
        });
        throw new PayPalHttpError(
          operation,
          failure.status,
          failure.debugId,
          failure.name,
          failure.issue,
          failure.status === 0
            ? `PayPal ${operation}: ${failure.message}`
            : `PayPal ${operation} failed: HTTP ${failure.status}${failure.name ? ` ${failure.name}` : ''}${failure.issue ? ` (${failure.issue})` : ''}${failure.message ? `: ${failure.message}` : ''}`,
        );
      }
    }
  }

  /** Status 0 means no HTTP response (network error, timeout, SDK failure). */
  #describeFailure(err: unknown): {
    status: number;
    debugId?: string;
    name?: string;
    issue?: string;
    message?: string;
    retryAfter?: string;
  } {
    if (err instanceof ApiError) {
      const body = parseBody(err.result ?? err.body);
      const { name, issue, message } = describeError(body);
      return {
        status: err.statusCode,
        debugId: debugIdOf(body) ?? headerValue(err.headers, 'paypal-debug-id'),
        name,
        issue,
        message,
        retryAfter: headerValue(err.headers, 'retry-after'),
      };
    }
    return { status: 0, message: err instanceof Error ? err.message : String(err) };
  }

  #waitMs(attempt: number, retryAfter: string | undefined): number {
    const { baseDelayMs, maxDelayMs } = this.#http.retry;
    const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxDelayMs, Math.round(seconds * 1000));
    return Math.min(maxDelayMs, Math.round(baseDelayMs * 2 ** attempt + this.#http.random() * baseDelayMs));
  }
}

export function buildOrderRequest({
  orderId,
  quote,
  brandName,
  returnUrl,
  cancelUrl,
  payeeEmail,
  collectAddress,
  units,
}: CreateOrderInput): OrderRequest {
  const parts: (Omit<OrderUnit, 'referenceId'> & { referenceId?: string })[] = units ?? [{ label: brandName, quote, ...(payeeEmail ? { payeeEmail } : {}) }];
  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: parts.map((part) => {
      const currencyCode = part.quote.currency;
      return {
        ...(part.referenceId ? { referenceId: part.referenceId } : {}),
        // Our order id on every unit, so a capture webhook for any unit finds the order.
        customId: orderId,
        ...(part.payeeEmail ? { payee: { emailAddress: part.payeeEmail } } : {}),
        description: `${part.label} order ${orderId}`.slice(0, 127),
        amount: {
          currencyCode,
          value: toDecimalString(part.quote.totalCents),
          breakdown: { itemTotal: { currencyCode, value: toDecimalString(part.quote.itemTotalCents) } },
        },
        items: part.quote.lines.map((line) => ({
          name: line.name.slice(0, 127),
          description: line.unit,
          sku: line.productId,
          quantity: String(line.quantity),
          unitAmount: { currencyCode, value: toDecimalString(line.unitPriceCents) },
          category: ItemCategory.PhysicalGoods,
        })),
      };
    }),
    paymentSource: {
      paypal: {
        experienceContext: {
          brandName,
          // English checkout pages, whatever the buyer's region (the demo buyer is in Malaysia).
          locale: 'en-US',
          userAction: PaypalExperienceUserAction.PayNow,
          // GET_FROM_FILE: the buyer picks or adds an address in PayPal; it comes back on the purchase unit.
          shippingPreference: collectAddress
            ? PaypalWalletContextShippingPreference.GetFromFile
            : PaypalWalletContextShippingPreference.NoShipping,
          returnUrl,
          cancelUrl,
        },
      },
    },
  };
}

/** The paying buyer as PayPal reports them. Any field may be missing. */
export interface UnitCapture {
  /** The unit's reference_id ("default" for a single-unit order). */
  referenceId: string;
  id: string;
  status: string;
}

export interface Buyer {
  name?: string;
  email?: string;
  phone?: string;
  /** Delivery or service address the buyer chose in PayPal (shops that collect one). */
  shipTo?: { name?: string; lines: string[] };
}

/**
 * The buyer from payment_source.paypal, falling back to the deprecated top-level payer
 * (the SDK marks payer as deprecated in favour of payment_source.paypal).
 */
function buyerOf(order: SdkOrder): Buyer | undefined {
  const wallet = order.paymentSource?.paypal;
  const source = wallet ?? order.payer;
  const shipping = order.purchaseUnits?.[0]?.shipping;
  const name = [source?.name?.givenName, source?.name?.surname].filter(Boolean).join(' ').trim();
  const phone =
    shipping?.phoneNumber?.nationalNumber ?? wallet?.phoneNumber?.nationalNumber ?? order.payer?.phone?.phoneNumber?.nationalNumber;
  const address = shipping?.address;
  const lines = address
    ? [
        address.addressLine1,
        address.addressLine2,
        [address.adminArea2, [address.adminArea1, address.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
        address.countryCode,
      ].filter((line): line is string => Boolean(line && line.trim()))
    : [];
  const buyer: Buyer = {
    ...(name ? { name } : {}),
    ...(source?.emailAddress ? { email: source.emailAddress } : {}),
    ...(phone ? { phone } : {}),
    ...(lines.length > 0 ? { shipTo: { ...(shipping?.name?.fullName ? { name: shipping.name.fullName } : {}), lines } } : {}),
  };
  return Object.keys(buyer).length > 0 ? buyer : undefined;
}

export function summarize(order: SdkOrder | undefined): PayPalOrderSummary {
  if (!order?.id || !order.status) throw new Error('PayPal returned an order without id or status');
  const links = order.links ?? [];
  const approvalUrl = (links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve'))?.href;
  const unit = order.purchaseUnits?.[0];
  const capture = unit?.payments?.captures?.[0];
  const captures: UnitCapture[] = (order.purchaseUnits ?? []).flatMap((u) => {
    const c = u.payments?.captures?.[0];
    return c?.id && c.status ? [{ referenceId: u.referenceId ?? 'default', id: c.id, status: String(c.status) }] : [];
  });
  const buyer = buyerOf(order);
  return {
    id: order.id,
    status: String(order.status),
    ...(approvalUrl ? { approvalUrl } : {}),
    ...(unit?.customId ? { customId: unit.customId } : {}),
    ...(capture?.id && capture.status ? { capture: { id: capture.id, status: String(capture.status) } } : {}),
    ...(captures.length > 0 ? { captures } : {}),
    ...(buyer ? { buyer } : {}),
  };
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}
