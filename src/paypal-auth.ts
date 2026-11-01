import { randomUUID } from 'node:crypto';
import { defaultHttpDeps, PAYPAL_SANDBOX_API, paypalRequest, type HttpDeps } from './paypal-http.js';

/**
 * OAuth 2.0 client-credentials token cache. One token per process, reused until
 * shortly before PayPal's own expires_in, and shared by the SDK (via its
 * oAuthTokenProvider hook) and our fetch calls. Concurrent callers share one fetch.
 * The token value is never logged.
 */

export interface AccessToken {
  value: string;
  /** Epoch ms when PayPal says it expires. */
  expiresAt: number;
}

export interface PayPalAuthOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** Refresh this long before expiry. Default 5 minutes. */
  refreshMarginMs?: number;
  now?: () => number;
  http?: HttpDeps;
}

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class PayPalAuth {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #baseUrl: string;
  readonly #marginMs: number;
  readonly #now: () => number;
  readonly #http: HttpDeps;
  #cached: AccessToken | undefined;
  #inflight: Promise<AccessToken> | undefined;
  /** Number of token requests made to PayPal. For tests and /health-style diagnostics. */
  fetchCount = 0;

  constructor(options: PayPalAuthOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#baseUrl = options.baseUrl ?? PAYPAL_SANDBOX_API;
    this.#marginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.#now = options.now ?? Date.now;
    this.#http = options.http ?? defaultHttpDeps();
  }

  /** A token valid for at least the refresh margin, fetching one if needed. */
  async getToken(): Promise<AccessToken> {
    const cached = this.peek();
    if (cached) return cached;
    this.#inflight ??= this.#fetchToken().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** The cached token if it is still fresh, without fetching. */
  peek(): AccessToken | undefined {
    const cached = this.#cached;
    return cached && cached.expiresAt - this.#marginMs > this.#now() ? cached : undefined;
  }

  /** Drop the cached token, e.g. after PayPal answered 401. */
  invalidate(): void {
    this.#cached = undefined;
  }

  async #fetchToken(): Promise<AccessToken> {
    this.fetchCount += 1;
    const basic = Buffer.from(`${this.#clientId}:${this.#clientSecret}`).toString('base64');
    const response = await paypalRequest(
      {
        operation: 'oauth.token',
        method: 'POST',
        url: `${this.#baseUrl}/v1/oauth2/token`,
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
        requestId: `token-${randomUUID()}`,
      },
      this.#http,
    );
    const body = response.json as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof body?.access_token !== 'string' || typeof body.expires_in !== 'number') {
      throw new Error(`PayPal oauth.token returned an unexpected body (debug_id ${response.debugId ?? 'n/a'})`);
    }
    const token = { value: body.access_token, expiresAt: this.#now() + body.expires_in * 1000 };
    this.#cached = token;
    return token;
  }
}
