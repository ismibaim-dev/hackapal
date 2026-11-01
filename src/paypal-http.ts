import { log } from './log.js';

/**
 * Minimal fetch wrapper for the PayPal REST calls the SDK doesn't cover
 * (OAuth token, webhook signature verification). Same rules as the SDK path:
 * - every POST carries a PayPal-Request-Id (callers must pass one, reused across retries),
 * - 429, 5xx and network errors are retried with exponential backoff, honouring Retry-After,
 * - every failure is logged with PayPal's debug_id.
 */

export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface RetryPolicy {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  /** Upper bound for one wait, including a server-sent Retry-After. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

export interface HttpDeps {
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  retry: RetryPolicy;
  /** 0..1, used for backoff jitter. Injected so tests are deterministic. */
  random: () => number;
}

export const defaultHttpDeps = (): HttpDeps => ({
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retry: DEFAULT_RETRY,
  random: Math.random,
});

export interface PayPalRequest {
  /** Short name for logs, e.g. "oauth.token" or "webhooks.verify". */
  operation: string;
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /** Required for POST. Sent as PayPal-Request-Id, identical on every retry. */
  requestId?: string;
}

export interface PayPalResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
  debugId: string | undefined;
}

/** A PayPal error response (after retries), or a network failure (status 0). */
export class PayPalHttpError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly debugId: string | undefined,
    readonly errorName: string | undefined,
    readonly issue: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'PayPalHttpError';
  }
}

const RETRYABLE_STATUS = (status: number): boolean => status === 429 || status >= 500;

export async function paypalRequest(req: PayPalRequest, deps: HttpDeps = defaultHttpDeps()): Promise<PayPalResponse> {
  if (req.method === 'POST' && !req.requestId) {
    throw new Error(`PayPal POST ${req.operation} needs a PayPal-Request-Id`);
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  if (req.requestId) headers['PayPal-Request-Id'] = req.requestId;

  for (let attempt = 0; ; attempt += 1) {
    const canRetry = attempt < deps.retry.maxRetries;
    let response: Response;
    try {
      response = await deps.fetch(req.url, { method: req.method, headers, body: req.body });
    } catch (err) {
      if (canRetry) {
        const wait = backoff(deps, attempt);
        log.warn('paypal network error, retrying', { operation: req.operation, attempt: attempt + 1, waitMs: wait });
        await deps.sleep(wait);
        continue;
      }
      log.error('paypal request failed', { operation: req.operation, status: 0, error: errorMessage(err) });
      throw new PayPalHttpError(req.operation, 0, undefined, undefined, undefined, `PayPal ${req.operation}: network error`);
    }

    const debugId = response.headers.get('paypal-debug-id') ?? undefined;
    const json = await readJson(response);

    if (response.ok) return { status: response.status, headers: response.headers, json, debugId };

    if (RETRYABLE_STATUS(response.status) && canRetry) {
      const wait = retryAfterMs(response.headers.get('retry-after'), deps) ?? backoff(deps, attempt);
      log.warn('paypal retryable error, retrying', {
        operation: req.operation,
        status: response.status,
        debug_id: debugIdOf(json) ?? debugId,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await deps.sleep(wait);
      continue;
    }

    const { name, issue, message } = describeError(json);
    const finalDebugId = debugIdOf(json) ?? debugId;
    log.error('paypal request failed', {
      operation: req.operation,
      status: response.status,
      debug_id: finalDebugId,
      name,
      issue,
    });
    throw new PayPalHttpError(
      req.operation,
      response.status,
      finalDebugId,
      name,
      issue,
      `PayPal ${req.operation} failed: HTTP ${response.status}${name ? ` ${name}` : ''}${issue ? ` (${issue})` : ''}${message ? `: ${message}` : ''}`,
    );
  }
}

function backoff(deps: HttpDeps, attempt: number): number {
  const exponential = deps.retry.baseDelayMs * 2 ** attempt;
  const jitter = deps.random() * deps.retry.baseDelayMs;
  return Math.min(deps.retry.maxDelayMs, Math.round(exponential + jitter));
}

/** Retry-After as seconds or an HTTP date. Capped by maxDelayMs; undefined when absent or unusable. */
function retryAfterMs(value: string | null, deps: HttpDeps): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : new Date(value).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(deps.retry.maxDelayMs, Math.round(ms));
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** PayPal REST errors carry debug_id in the body; OAuth errors don't, so the header is the fallback. */
export function debugIdOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body.debug_id === 'string' ? body.debug_id : undefined;
}

/** REST errors: { name, message, details: [{ issue }] }. OAuth errors: { error, error_description }. */
export function describeError(body: unknown): { name?: string; issue?: string; message?: string } {
  if (!isRecord(body)) return {};
  const details = Array.isArray(body.details) ? body.details : [];
  const first: unknown = details[0];
  const issue = isRecord(first) && typeof first.issue === 'string' ? first.issue : undefined;
  const name = typeof body.name === 'string' ? body.name : typeof body.error === 'string' ? body.error : undefined;
  const message =
    typeof body.message === 'string'
      ? body.message
      : typeof body.error_description === 'string'
        ? body.error_description
        : undefined;
  return { name, issue, message };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    return cause?.code ? `${err.message} (${cause.code})` : err.message;
  }
  return String(err);
}
