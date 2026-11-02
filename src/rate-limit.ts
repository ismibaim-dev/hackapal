/**
 * Fixed-window rate limiter, in memory (one Render instance). Good enough to stop a
 * runaway client or a spammer from flooding /mcp or burning PayPal quota; not a
 * distributed limiter. Keys are client IPs (or "global").
 */
export interface RateLimitOptions {
  /** Allowed hits per window. */
  limit: number;
  windowMs: number;
  now?: () => number;
  /** Prune expired windows once the map holds this many keys. */
  maxKeys?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets (for Retry-After). */
  retryAfterSeconds: number;
}

export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(options: RateLimitOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 10_000;
  }

  /** Counts one hit for `key` and says whether it is allowed. */
  hit(key: string): RateLimitResult {
    const now = this.#now();
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.#windowMs) {
      if (!window && this.#windows.size >= this.#maxKeys) this.#prune(now);
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    const retryAfterSeconds = Math.max(1, Math.ceil((window.start + this.#windowMs - now) / 1000));
    if (window.count >= this.#limit) return { allowed: false, remaining: 0, retryAfterSeconds };
    window.count += 1;
    return { allowed: true, remaining: this.#limit - window.count, retryAfterSeconds };
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
