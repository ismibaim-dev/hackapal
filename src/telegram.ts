import type { ShopInfo } from './catalog.js';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { SellerNotifier } from './orders.js';
import type { FetchLike } from './paypal-http.js';
import type { Order } from './store.js';

/**
 * Seller ping on Telegram: one message per order, sent when its capture completes
 * (OrderService calls orderCompleted exactly once, on the move to COMPLETED).
 * One chat for the whole platform (the demo operator); the message names the shop.
 * Uses the Bot API's sendMessage as plain text (no parse_mode, so nothing in an order
 * can turn into markup). The bot token sits in the URL path, so the URL is never logged.
 */
export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429 and 5xx. */
  maxRetries?: number;
}

export class TelegramNotifier implements SellerNotifier {
  readonly #url: string;
  readonly #chatId: string;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(options: TelegramNotifierOptions) {
    this.#url = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
    this.#chatId = options.chatId;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRetries = options.maxRetries ?? 2;
  }

  async orderCompleted(order: Order, shop: Readonly<ShopInfo>): Promise<void> {
    const text = formatOrderMessage(order, shop.name);
    const body = JSON.stringify({ chat_id: this.#chatId, text, disable_web_page_preview: true });

    for (let attempt = 0; ; attempt += 1) {
      let status = 0;
      let description: string | undefined;
      let retryAfterSeconds: number | undefined;
      try {
        const res = await this.#fetch(this.#url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        status = res.status;
        const json = (await res.json().catch(() => undefined)) as
          | { ok?: boolean; description?: string; parameters?: { retry_after?: number } }
          | undefined;
        if (res.ok && json?.ok) {
          log.info('seller pinged on telegram', { order_id: order.id, shop_id: shop.id });
          return;
        }
        description = json?.description;
        retryAfterSeconds = json?.parameters?.retry_after;
      } catch (err) {
        description = err instanceof Error ? err.message : String(err);
      }

      const retryable = status === 0 || status === 429 || status >= 500;
      if (retryable && attempt < this.#maxRetries) {
        await this.#sleep(Math.min(30, retryAfterSeconds ?? 2 ** attempt) * 1000);
        continue;
      }
      // Never include the URL: it carries the bot token.
      log.warn('telegram ping failed', { order_id: order.id, status, description });
      return;
    }
  }
}

/** e.g. "New order! 2 x Chocolate chip cookies, $12.00, paid via PayPal." plus the ids. */
export function formatOrderMessage(order: Order, shopName: string): string {
  const items = order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ');
  return [
    `New order for ${shopName}! ${items}, ${formatUsd(order.totalCents)}, paid via PayPal.`,
    `Order ${order.id}${order.captureId ? ` (PayPal capture ${order.captureId})` : ''}.`,
    'Contact the buyer to arrange delivery, pickup or the booking.',
  ].join('\n');
}
