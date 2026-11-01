import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayPalHttpError, paypalRequest } from '../src/paypal-http.js';
import { fakeFetch, jsonResponse, testHttp } from './helpers.js';

const URL_ = 'https://api-m.sandbox.paypal.com/v1/test';

afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = 'silent';
});

describe('paypalRequest', () => {
  it('refuses a POST without a PayPal-Request-Id', async () => {
    const f = fakeFetch(() => jsonResponse(200, {}));
    await expect(paypalRequest({ operation: 'x', method: 'POST', url: URL_ }, testHttp(f).deps)).rejects.toThrow(
      /PayPal-Request-Id/,
    );
    expect(f.calls).toHaveLength(0);
  });

  it('sends the same PayPal-Request-Id on every retry', async () => {
    const f = fakeFetch((_, i) => (i < 2 ? jsonResponse(503, { name: 'SERVICE_UNAVAILABLE' }) : jsonResponse(201, { ok: 1 })));
    const res = await paypalRequest(
      { operation: 'x', method: 'POST', url: URL_, body: '{}', requestId: 'create-ord_1' },
      testHttp(f).deps,
    );
    expect(res.status).toBe(201);
    expect(f.calls.map((c) => c.headers.get('paypal-request-id'))).toEqual([
      'create-ord_1',
      'create-ord_1',
      'create-ord_1',
    ]);
  });

  it('backs off exponentially on 5xx', async () => {
    const f = fakeFetch((_, i) => (i < 3 ? jsonResponse(500, {}) : jsonResponse(200, {})));
    const { deps, sleeps } = testHttp(f);
    await paypalRequest({ operation: 'x', method: 'GET', url: URL_ }, deps);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('honours Retry-After on 429, capped by maxDelayMs', async () => {
    const f = fakeFetch((_, i) =>
      i === 0
        ? jsonResponse(429, { name: 'RATE_LIMIT_REACHED' }, { 'retry-after': '3' })
        : i === 1
          ? jsonResponse(429, {}, { 'retry-after': '120' })
          : jsonResponse(200, {}),
    );
    const { deps, sleeps } = testHttp(f);
    await paypalRequest({ operation: 'x', method: 'GET', url: URL_ }, deps);
    expect(sleeps).toEqual([3000, 8000]);
  });

  it('retries network errors', async () => {
    const f = fakeFetch((_, i) => {
      if (i === 0) throw new TypeError('fetch failed');
      return jsonResponse(200, { fine: true });
    });
    const res = await paypalRequest({ operation: 'x', method: 'GET', url: URL_ }, testHttp(f).deps);
    expect(res.json).toEqual({ fine: true });
    expect(f.calls).toHaveLength(2);
  });

  it('does not retry 4xx and reports name, issue and debug_id', async () => {
    const f = fakeFetch(() =>
      jsonResponse(422, {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        debug_id: 'f93639164818b',
        details: [{ issue: 'INSTRUMENT_DECLINED', description: 'declined' }],
      }),
    );
    const err = await paypalRequest(
      { operation: 'orders.capture', method: 'POST', url: URL_, body: '{}', requestId: 'capture-ord_1-0' },
      testHttp(f).deps,
    ).catch((e: unknown) => e);
    expect(f.calls).toHaveLength(1);
    expect(err).toBeInstanceOf(PayPalHttpError);
    expect(err).toMatchObject({ status: 422, issue: 'INSTRUMENT_DECLINED', debugId: 'f93639164818b' });
  });

  it('gives up after maxRetries and logs the debug_id', async () => {
    process.env.LOG_LEVEL = 'error';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const f = fakeFetch(() => jsonResponse(500, { name: 'INTERNAL_SERVER_ERROR', debug_id: 'dbg-500' }));
    const err = await paypalRequest({ operation: 'x', method: 'GET', url: URL_ }, testHttp(f, { maxRetries: 2 }).deps).catch(
      (e: unknown) => e,
    );
    expect(f.calls).toHaveLength(3);
    expect(err).toMatchObject({ status: 500, debugId: 'dbg-500' });
    const line = JSON.parse(String(errors.mock.calls.at(-1)?.[0]));
    expect(line).toMatchObject({ msg: 'paypal request failed', status: 500, debug_id: 'dbg-500', operation: 'x' });
  });

  it('falls back to the paypal-debug-id header (OAuth errors have no body debug_id)', async () => {
    const f = fakeFetch(() =>
      jsonResponse(401, { error: 'invalid_client', error_description: 'Client Authentication failed' }, { 'paypal-debug-id': 'hdr-1' }),
    );
    const err = await paypalRequest(
      { operation: 'oauth.token', method: 'POST', url: URL_, body: 'x', requestId: 'token-1' },
      testHttp(f).deps,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, debugId: 'hdr-1', errorName: 'invalid_client' });
  });

  it('sends Uint8Array bodies unchanged', async () => {
    const f = fakeFetch(() => jsonResponse(200, {}));
    const bytes = Buffer.from('{"a":  1}');
    await paypalRequest({ operation: 'x', method: 'POST', url: URL_, body: bytes, requestId: 'r' }, testHttp(f).deps);
    expect(f.calls[0]?.init.body).toBe(bytes);
  });
});
