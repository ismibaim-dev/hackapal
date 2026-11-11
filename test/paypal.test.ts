import { ApiError, CustomError } from '@paypal/paypal-server-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCatalog } from '../src/catalog.js';
import { PayPalAuth } from '../src/paypal-auth.js';
import { PayPalHttpError } from '../src/paypal-http.js';
import { buildOrderRequest, DECLINE_MOCK_HEADER, PayPalClient, summarize, toSdkToken, type OrdersApi } from '../src/paypal.js';
import { priceCart } from '../src/pricing.js';
import { fakeFetch, jsonResponse, testHttp, tokenResponse } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = 'silent';
});

function quote() {
  const priced = priceCart(createCatalog(), {
    items: [
      { product_id: 'choc-chip-cookies', quantity: 2 },
      { product_id: 'kuih-lapis', quantity: 1 },
    ],
  });
  if (!priced.ok) throw new Error('pricing failed');
  return priced.quote;
}

const sdkOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'PP-1',
  status: 'PAYER_ACTION_REQUIRED',
  links: [
    { href: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/PP-1', rel: 'self', method: 'GET' },
    { href: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1', rel: 'payer-action', method: 'GET' },
  ],
  purchaseUnits: [{ customId: 'ord_test' }],
  ...overrides,
});

function apiError(statusCode: number, body: unknown, headers: Record<string, string> = {}, custom = true) {
  const context = {
    request: { method: 'POST', url: 'https://api-m.sandbox.paypal.com/v2/checkout/orders/PP-1/capture' },
    response: { statusCode, headers, body: JSON.stringify(body) },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = custom ? new CustomError(context as any, 'error') : new ApiError(context as any, 'error');
  if (custom) (err as { result?: unknown }).result = body;
  return err;
}

function setup(orders: Partial<Record<keyof OrdersApi, (...args: unknown[]) => unknown>>) {
  const recorded: { method: string; args: Record<string, unknown> }[] = [];
  let builds = 0;
  const f = fakeFetch((call) =>
    call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : jsonResponse(200, { verification_status: 'SUCCESS' }),
  );
  const { deps: http, sleeps } = testHttp(f);
  const client = new PayPalClient({
    clientId: 'id',
    clientSecret: 'secret',
    http,
    ordersFactory: () => {
      builds += 1;
      const wrap =
        (method: keyof OrdersApi) =>
        async (args: Record<string, unknown>) => {
          recorded.push({ method, args });
          const impl = orders[method];
          if (!impl) throw new Error(`unexpected ${method}`);
          return { result: await impl(args) };
        };
      return {
        createOrder: wrap('createOrder'),
        getOrder: wrap('getOrder'),
        captureOrder: wrap('captureOrder'),
      } as unknown as OrdersApi;
    },
  });
  return { client, recorded, sleeps, fetchCalls: f.calls, builds: () => builds };
}

describe('buildOrderRequest', () => {
  it("names the seller as payee when the shop has its own PayPal account (option B)", () => {
    const body = buildOrderRequest({
      orderId: 'ord_abc',
      quote: quote(),
      brandName: 'Kampung Fresh Mart',
      returnUrl: 'https://shop.example/paypal/return',
      cancelUrl: 'https://shop.example/paypal/cancel',
      payeeEmail: 'seller@business.example.com',
    });
    expect(body.purchaseUnits[0]?.payee).toEqual({ emailAddress: 'seller@business.example.com' });
    expect(body.paymentSource?.paypal?.experienceContext?.shippingPreference).toBe('NO_SHIPPING');
    const delivering = buildOrderRequest({
      orderId: 'ord_abc',
      quote: quote(),
      brandName: 'Kampung Fresh Mart',
      returnUrl: 'https://shop.example/paypal/return',
      cancelUrl: 'https://shop.example/paypal/cancel',
      collectAddress: true,
    });
    expect(delivering.paymentSource?.paypal?.experienceContext?.shippingPreference).toBe('GET_FROM_FILE');
    expect(body.purchaseUnits[0]?.description).toBe('Kampung Fresh Mart order ord_abc');
  });

  it('builds an Orders v2 CAPTURE request from the quote only, in decimal strings', () => {
    const body = buildOrderRequest({
      orderId: 'ord_abc',
      quote: quote(),
      brandName: "Auntie's Kitchen",
      returnUrl: 'https://shop.example/paypal/return',
      cancelUrl: 'https://shop.example/paypal/cancel',
    });
    expect(body).toEqual({
      intent: 'CAPTURE',
      purchaseUnits: [
        {
          customId: 'ord_abc',
          description: "Auntie's Kitchen order ord_abc",
          amount: { currencyCode: 'USD', value: '20.00', breakdown: { itemTotal: { currencyCode: 'USD', value: '20.00' } } },
          items: [
            {
              name: 'Chocolate chip cookies',
              description: 'box of 10',
              sku: 'choc-chip-cookies',
              quantity: '2',
              unitAmount: { currencyCode: 'USD', value: '6.00' },
              category: 'PHYSICAL_GOODS',
            },
            {
              name: 'Kuih lapis',
              description: '12 pieces',
              sku: 'kuih-lapis',
              quantity: '1',
              unitAmount: { currencyCode: 'USD', value: '8.00' },
              category: 'PHYSICAL_GOODS',
            },
          ],
        },
      ],
      paymentSource: {
        paypal: {
          experienceContext: {
            brandName: "Auntie's Kitchen",
            locale: 'en-US',
            userAction: 'PAY_NOW',
            shippingPreference: 'NO_SHIPPING',
            returnUrl: 'https://shop.example/paypal/return',
            cancelUrl: 'https://shop.example/paypal/cancel',
          },
        },
      },
    });
  });
});

describe('summarize', () => {
  it('prefers the payer-action link and falls back to approve', () => {
    expect(summarize(sdkOrder() as never).approvalUrl).toBe('https://www.sandbox.paypal.com/checkoutnow?token=PP-1');
    const approveOnly = sdkOrder({ links: [{ href: 'https://approve.example', rel: 'approve', method: 'GET' }] });
    expect(summarize(approveOnly as never).approvalUrl).toBe('https://approve.example');
  });

  it('reads the first capture', () => {
    const captured = sdkOrder({
      status: 'COMPLETED',
      purchaseUnits: [{ customId: 'ord_test', payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED' }] } }],
    });
    expect(summarize(captured as never)).toMatchObject({ status: 'COMPLETED', capture: { id: 'CAP-1', status: 'COMPLETED' } });
  });

  it('reads the delivery address and phone the buyer chose in PayPal', () => {
    const shipped = sdkOrder({
      status: 'COMPLETED',
      paymentSource: { paypal: { emailAddress: 'siti@personal.example.com', name: { givenName: 'Siti', surname: 'Aminah' } } },
      purchaseUnits: [
        {
          customId: 'ord_test',
          shipping: {
            name: { fullName: 'Siti Aminah' },
            phoneNumber: { nationalNumber: '4085551234' },
            address: { addressLine1: '1 Main St', adminArea2: 'San Jose', adminArea1: 'CA', postalCode: '95131', countryCode: 'US' },
          },
        },
      ],
    });
    expect(summarize(shipped as never).buyer).toEqual({
      name: 'Siti Aminah',
      email: 'siti@personal.example.com',
      phone: '4085551234',
      shipTo: { name: 'Siti Aminah', lines: ['1 Main St', 'San Jose, CA 95131', 'US'] },
    });
  });

  it('reads the buyer from payment_source.paypal, falling back to the deprecated payer', () => {
    const fromSource = sdkOrder({
      status: 'COMPLETED',
      paymentSource: { paypal: { emailAddress: 'siti@personal.example.com', name: { givenName: 'Siti', surname: 'Aminah' } } },
      payer: { emailAddress: 'old@personal.example.com' },
    });
    expect(summarize(fromSource as never).buyer).toEqual({ name: 'Siti Aminah', email: 'siti@personal.example.com' });
    const fromPayer = sdkOrder({ status: 'APPROVED', payer: { emailAddress: 'old@personal.example.com' } });
    expect(summarize(fromPayer as never).buyer).toEqual({ email: 'old@personal.example.com' });
    expect(summarize(sdkOrder() as never)).not.toHaveProperty('buyer');
    expect(summarize(sdkOrder({ paymentSource: { paypal: {} } }) as never)).not.toHaveProperty('buyer');
  });
});

describe('PayPalClient (Orders via the SDK)', () => {
  it('creates with PayPal-Request-Id create-<orderId> and a full representation', async () => {
    const { client, recorded } = setup({ createOrder: () => sdkOrder() });
    const summary = await client.createOrder({
      orderId: 'ord_abc',
      quote: quote(),
      brandName: "Auntie's Kitchen",
      returnUrl: 'https://r',
      cancelUrl: 'https://c',
    });
    expect(recorded[0]?.args).toMatchObject({ paypalRequestId: 'create-ord_abc', prefer: 'return=representation' });
    expect(summary).toMatchObject({ id: 'PP-1', approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1' });
  });

  it('captures with the given request id and sends the decline mock only when asked', async () => {
    const { client, recorded } = setup({ captureOrder: () => sdkOrder({ status: 'COMPLETED' }) });
    await client.captureOrder('PP-1', { requestId: 'capture-ord_abc-0' });
    await client.captureOrder('PP-1', { requestId: 'capture-ord_abc-1', simulateDecline: true });
    expect(recorded[0]?.args).toMatchObject({ id: 'PP-1', paypalRequestId: 'capture-ord_abc-0' });
    expect(recorded[0]?.args).not.toHaveProperty('paypalMockResponse');
    expect(recorded[1]?.args).toMatchObject({ paypalRequestId: 'capture-ord_abc-1', paypalMockResponse: DECLINE_MOCK_HEADER });
    expect(JSON.parse(DECLINE_MOCK_HEADER)).toEqual({ mock_application_codes: 'INSTRUMENT_DECLINED' });
  });

  it('maps SDK errors to PayPalHttpError and logs the debug_id', async () => {
    process.env.LOG_LEVEL = 'error';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { client } = setup({
      captureOrder: () => {
        throw apiError(422, {
          name: 'UNPROCESSABLE_ENTITY',
          message: 'The requested action could not be performed.',
          debug_id: 'f0c3a7e1d2b4',
          details: [{ issue: 'INSTRUMENT_DECLINED', description: 'The instrument presented was declined.' }],
        });
      },
    });
    const err = await client.captureOrder('PP-1', { requestId: 'capture-ord_abc-0' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalHttpError);
    expect(err).toMatchObject({ status: 422, issue: 'INSTRUMENT_DECLINED', debugId: 'f0c3a7e1d2b4' });
    const line = JSON.parse(String(errors.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({
      msg: 'paypal request failed',
      operation: 'orders.capture',
      request_id: 'capture-ord_abc-0',
      status: 422,
      debug_id: 'f0c3a7e1d2b4',
      issue: 'INSTRUMENT_DECLINED',
    });
  });

  it('reads the debug_id from a plain ApiError body or the header', async () => {
    const { client } = setup({
      getOrder: () => {
        throw apiError(429, { name: 'RATE_LIMIT_REACHED' }, { 'Paypal-Debug-Id': 'hdr-429' }, false);
      },
    });
    const err = await client.getOrder('PP-1').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, debugId: 'hdr-429', errorName: 'RATE_LIMIT_REACHED' });
  });

  it('rebuilds the SDK client after a failure without a response, then retries', async () => {
    let first = true;
    const { client, builds, sleeps } = setup({
      getOrder: () => {
        if (first) {
          first = false;
          throw new Error('socket hang up');
        }
        return sdkOrder();
      },
    });
    expect(builds()).toBe(1);
    await expect(client.getOrder('PP-1')).resolves.toMatchObject({ id: 'PP-1' });
    expect(builds()).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it('retries 5xx with the same PayPal-Request-Id, honouring Retry-After', async () => {
    let calls = 0;
    const { client, recorded, sleeps } = setup({
      captureOrder: () => {
        calls += 1;
        if (calls === 1) throw apiError(503, { name: 'SERVICE_UNAVAILABLE', debug_id: 'd503' });
        if (calls === 2) throw apiError(429, { name: 'RATE_LIMIT_REACHED' }, { 'Retry-After': '2' }, false);
        return sdkOrder({ status: 'COMPLETED' });
      },
    });
    await expect(client.captureOrder('PP-1', { requestId: 'capture-ord_abc-0' })).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(recorded.map((r) => r.args.paypalRequestId)).toEqual([
      'capture-ord_abc-0',
      'capture-ord_abc-0',
      'capture-ord_abc-0',
    ]);
    expect(sleeps).toEqual([500, 2000]);
  });

  it('never retries a 4xx such as INSTRUMENT_DECLINED', async () => {
    const { client, recorded, sleeps } = setup({
      captureOrder: () => {
        throw apiError(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
      },
    });
    await expect(client.captureOrder('PP-1', { requestId: 'capture-ord_abc-0' })).rejects.toMatchObject({ status: 422 });
    expect(recorded).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the retry budget', async () => {
    const { client, recorded } = setup({
      getOrder: () => {
        throw apiError(500, { name: 'INTERNAL_SERVER_ERROR', debug_id: 'd500' });
      },
    });
    await expect(client.getOrder('PP-1')).rejects.toMatchObject({ status: 500, debugId: 'd500' });
    expect(recorded).toHaveLength(4);
  });

  it('fetches one token for many calls and drops it after a 401', async () => {
    let calls = 0;
    const { client, fetchCalls } = setup({
      getOrder: () => {
        calls += 1;
        if (calls === 3) throw apiError(401, { name: 'AUTHENTICATION_FAILURE', debug_id: 'd401' });
        return sdkOrder();
      },
    });
    await client.getOrder('PP-1');
    await client.getOrder('PP-1');
    await expect(client.getOrder('PP-1')).rejects.toMatchObject({ status: 401 });
    await client.getOrder('PP-1');
    expect(fetchCalls.filter((c) => c.url.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });
});

describe('toSdkToken', () => {
  it('expires the SDK copy when our cache would refresh', () => {
    const sdk = toSdkToken({ value: 'tok', expiresAt: 10_000_000, refreshAt: 9_700_000 });
    expect(sdk).toEqual({ accessToken: 'tok', tokenType: 'Bearer', expiry: 9_700n });
  });
});

describe('PayPalClient.verifyWebhookSignature', () => {
  const headers = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42',
    'paypal-transmission-id': '69cd13f0-d67a-11e5-baa3-778b53f4ae55',
    'paypal-transmission-sig': 'lmI95Jx3Y9nhR5SJWlHVIWpg4AgFk7n9bCHSRxbrd8A9zrhdu2rMyFrmz+Zjh3s3boXB07VXCXUZy/UFzUlnGJn0wDugt7FlSvdKeIJenLRemUxYCPVoEZzg9VFNqOa48gMkvF+XTpxBeUx/kWy6B5cp7GkT2+pOowfRK7OaynuxUoKW3JcMWw272VKjLTtTAShncla7tGF+55rxyt2KNZIIqxNMJ48RDZheGU5w1npu9dZHnPgTXB9iomeVRoD8O/jhRpnKsGrDschyNdkeh81BJJMH4Ctc6lnCCquoP/GzCzz33MMsNdid7vL/NIWaCsekQpW26FpWPi/tfj8nLA==',
    'paypal-transmission-time': '2026-11-01T12:00:00Z',
  };
  // Odd spacing, key order and non-ASCII on purpose: re-serialising would change these bytes.
  const raw = Buffer.from(
    '{"id":"WH-1",  "event_type":"CHECKOUT.ORDER.APPROVED","summary":"Pedido aprobado — café","resource":{"id":"PP-1"}}\n',
    'utf8',
  );

  function verifyClient(answer: string) {
    const f = fakeFetch((call) =>
      call.url.endsWith('/v1/oauth2/token') ? tokenResponse() : jsonResponse(200, { verification_status: answer }),
    );
    const http = testHttp(f).deps;
    const auth = new PayPalAuth({ clientId: 'id', clientSecret: 'secret', http });
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', http, auth, ordersFactory: () => ({}) as OrdersApi });
    return { client, f };
  }

  it('posts the five headers, the webhook id and the raw body byte for byte', async () => {
    const { client, f } = verifyClient('SUCCESS');
    await expect(client.verifyWebhookSignature({ headers, rawBody: raw, webhookId: 'WH-ID-1' })).resolves.toBe(true);

    const call = f.calls.find((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature'))!;
    expect(call.init.method).toBe('POST');
    expect(call.headers.get('authorization')).toBe('Bearer A21-test-token');
    expect(call.headers.get('paypal-request-id')).toMatch(/^verify-[0-9a-f-]{36}$/);

    const sent = Buffer.from(call.init.body as Uint8Array);
    const prefix = Buffer.from(
      JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: 'WH-ID-1',
      }).slice(0, -1) + ',"webhook_event":',
    );
    expect(sent.equals(Buffer.concat([prefix, raw, Buffer.from('}')]))).toBe(true);
    expect(sent.includes(raw)).toBe(true);
    // And it is still valid JSON whose webhook_event is the original event.
    expect(JSON.parse(sent.toString('utf8')).webhook_event).toEqual(JSON.parse(raw.toString('utf8')));
  });

  it('uses a fresh PayPal-Request-Id for every delivery, even with the same transmission id', async () => {
    const { client, f } = verifyClient('SUCCESS');
    await client.verifyWebhookSignature({ headers, rawBody: raw, webhookId: 'WH-ID-1' });
    await client.verifyWebhookSignature({ headers, rawBody: Buffer.from('{"id":"WH-OTHER"}'), webhookId: 'WH-ID-1' });
    const ids = f.calls
      .filter((c) => c.url.endsWith('/v1/notifications/verify-webhook-signature'))
      .map((c) => c.headers.get('paypal-request-id'));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('returns false on FAILURE', async () => {
    const { client } = verifyClient('FAILURE');
    await expect(client.verifyWebhookSignature({ headers, rawBody: raw, webhookId: 'WH-ID-1' })).resolves.toBe(false);
  });

  it('returns false without calling PayPal when a header is missing', async () => {
    const { client, f } = verifyClient('SUCCESS');
    const { ['paypal-transmission-sig']: _drop, ...partial } = headers;
    await expect(client.verifyWebhookSignature({ headers: partial, rawBody: raw, webhookId: 'WH-ID-1' })).resolves.toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});
