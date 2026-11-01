import { describe, expect, it } from 'vitest';
import { PayPalAuth } from '../src/paypal-auth.js';
import { fakeFetch, jsonResponse, testHttp, tokenResponse } from './helpers.js';

function setup(handler = () => tokenResponse()) {
  let now = 1_000_000;
  const f = fakeFetch(handler);
  const auth = new PayPalAuth({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    http: testHttp(f).deps,
    now: () => now,
  });
  return { auth, f, advance: (ms: number) => (now += ms) };
}

describe('PayPalAuth', () => {
  it('fetches a client-credentials token with Basic auth and a request id', async () => {
    const { auth, f } = setup();
    const token = await auth.getToken();
    expect(token.value).toBe('A21-test-token');
    const call = f.calls[0]!;
    expect(call.url).toBe('https://api-m.sandbox.paypal.com/v1/oauth2/token');
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe('grant_type=client_credentials');
    expect(call.headers.get('authorization')).toBe(`Basic ${Buffer.from('client-id:client-secret').toString('base64')}`);
    expect(call.headers.get('paypal-request-id')).toMatch(/^token-/);
  });

  it('reuses the cached token until 5 minutes before expires_in', async () => {
    const { auth, f, advance } = setup();
    await auth.getToken();
    advance(32_400_000 - 5 * 60_000 - 1);
    await auth.getToken();
    expect(f.calls).toHaveLength(1);
    advance(2);
    await auth.getToken();
    expect(f.calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent callers', async () => {
    const { auth, f } = setup();
    const tokens = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect(new Set(tokens.map((t) => t.value)).size).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(auth.fetchCount).toBe(1);
  });

  it('refetches after invalidate()', async () => {
    const { auth, f } = setup();
    await auth.getToken();
    auth.invalidate();
    await auth.getToken();
    expect(f.calls).toHaveLength(2);
  });

  it('recovers after a failed fetch instead of caching the failure', async () => {
    const { auth, f } = setup((() => {
      let first = true;
      return () => {
        if (first) {
          first = false;
          return jsonResponse(200, { unexpected: true });
        }
        return tokenResponse('second');
      };
    })());
    await expect(auth.getToken()).rejects.toThrow(/unexpected body/);
    expect((await auth.getToken()).value).toBe('second');
    expect(f.calls).toHaveLength(2);
  });

  it('never puts the secret or the token in an error message', async () => {
    const { auth } = setup(() => jsonResponse(401, { error: 'invalid_client' }, { 'paypal-debug-id': 'd1' }));
    const err = (await auth.getToken().then(
      () => new Error('expected a failure'),
      (e: unknown) => e,
    )) as Error;
    expect(err.message).not.toContain('client-secret');
    expect(err.message).toContain('401');
  });
});
