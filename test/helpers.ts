import type { Buyer, PayPalGateway, PayPalOrderSummary, VerifyWebhookInput, CaptureOptions, CreateOrderInput } from '../src/paypal.js';
import { PayPalHttpError, type FetchLike, type HttpDeps } from '../src/paypal-http.js';

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
  headers: Headers;
}

/** A fetch stand-in that records calls and answers from `handler`. */
export function fakeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fn: FetchLike = async (input, init = {}) => {
    const call = { url: String(input), init, headers: new Headers(init.headers) };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return Object.assign(fn, { calls });
}

/** HttpDeps with recorded, instant sleeps and no jitter. */
export function testHttp(fetchImpl: FetchLike, retry: Partial<HttpDeps['retry']> = {}) {
  const sleeps: number[] = [];
  const deps: HttpDeps = {
    fetch: fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    retry: { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8_000, ...retry },
    random: () => 0,
  };
  return { deps, sleeps };
}

export function tokenResponse(token = 'A21-test-token', expiresIn = 32_400): Response {
  return jsonResponse(200, { access_token: token, token_type: 'Bearer', expires_in: expiresIn, app_id: 'APP-TEST' });
}

export function paypalError(status: number, name: string, issue?: string, debugId = 'dbg-123'): PayPalHttpError {
  return new PayPalHttpError('test', status, debugId, name, issue, `HTTP ${status} ${name}${issue ? ` (${issue})` : ''}`);
}

interface FakeOrder {
  id: string;
  status: string;
  approvalUrl: string;
  customId: string;
  capture?: { id: string; status: string };
}

/**
 * Behaves like the sandbox for the calls we make: orders start in
 * PAYER_ACTION_REQUIRED, capture needs approval, the decline mock answers 422.
 */
export class FakePayPal implements PayPalGateway {
  readonly orders = new Map<string, FakeOrder>();
  readonly createCalls: CreateOrderInput[] = [];
  readonly captureCalls: { paypalOrderId: string; options: CaptureOptions }[] = [];
  readonly verifyCalls: VerifyWebhookInput[] = [];
  getCalls = 0;
  verifyResult: boolean | Error = true;
  /** Who PayPal says paid, once an order is approved. undefined: PayPal shares nothing. */
  buyer: Buyer | undefined = { name: 'Siti Aminah', email: 'siti@personal.example.com' };
  /** Make getOrder fail (after capture paths ran), to test best-effort reads. */
  getOrderError: Error | undefined;
  /** Scripted answers for the next capture calls, used before the default behaviour. */
  readonly captureScript: Array<PayPalHttpError | ((order: FakeOrder) => PayPalOrderSummary)> = [];
  /** Awaited inside captureOrder; lets a test hold a capture open. */
  captureGate: Promise<void> | undefined;
  #seq = 0;

  async createOrder(input: CreateOrderInput): Promise<PayPalOrderSummary> {
    this.createCalls.push(input);
    const id = `PP-${++this.#seq}`;
    const order: FakeOrder = {
      id,
      status: 'PAYER_ACTION_REQUIRED',
      approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
      customId: input.orderId,
    };
    this.orders.set(id, order);
    return this.#summary(order);
  }

  async getOrder(paypalOrderId: string): Promise<PayPalOrderSummary> {
    this.getCalls += 1;
    if (this.getOrderError) throw this.getOrderError;
    const order = this.orders.get(paypalOrderId);
    if (!order) throw paypalError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    return this.#summary(order);
  }

  async captureOrder(paypalOrderId: string, options: CaptureOptions): Promise<PayPalOrderSummary> {
    this.captureCalls.push({ paypalOrderId, options });
    if (this.captureGate) await this.captureGate;
    const order = this.orders.get(paypalOrderId);
    if (!order) throw paypalError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID');
    const scripted = this.captureScript.shift();
    if (scripted instanceof PayPalHttpError) throw scripted;
    if (scripted) return scripted(order);
    if (order.status === 'COMPLETED') throw paypalError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED');
    if (order.status !== 'APPROVED') throw paypalError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED');
    if (options.simulateDecline) throw paypalError(422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED');
    order.status = 'COMPLETED';
    order.capture = { id: `CAP-${order.id}`, status: 'COMPLETED' };
    return this.#summary(order);
  }

  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<boolean> {
    this.verifyCalls.push(input);
    if (this.verifyResult instanceof Error) throw this.verifyResult;
    return this.verifyResult;
  }

  /** The buyer approves in PayPal. */
  approve(paypalOrderId: string): void {
    const order = this.orders.get(paypalOrderId);
    if (!order) throw new Error(`no fake order ${paypalOrderId}`);
    order.status = 'APPROVED';
  }

  #summary(order: FakeOrder): PayPalOrderSummary {
    return {
      id: order.id,
      status: order.status,
      approvalUrl: order.approvalUrl,
      customId: order.customId,
      ...(order.capture ? { capture: { ...order.capture } } : {}),
      ...(this.buyer && (order.status === 'APPROVED' || order.status === 'COMPLETED') ? { buyer: { ...this.buyer } } : {}),
    };
  }
}

/** A promise you can resolve from outside. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait until `check` passes (for work scheduled with setImmediate). */
export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
