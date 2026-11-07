import type { ShopInfo } from './catalog.js';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { SellerNotifier } from './orders.js';
import type { Buyer } from './paypal.js';
import type { FetchLike } from './paypal-http.js';
import type { Order } from './store.js';

/**
 * Seller ping on Telegram: one message per order, sent when its capture completes
 * (OrderService calls orderCompleted exactly once, on the move to COMPLETED).
 * Each shop's ping goes to that shop's own chat (TELEGRAM_SHOP_CHATS), or to the default
 * chat when the shop has none. The message names the shop and, when PayPal says, the buyer,
 * so the seller knows whom to contact. Buyer details are never logged.
 * Uses the Bot API's sendMessage as plain text (no parse_mode, so nothing in an order
 * can turn into markup). The bot token sits in the URL path, so the URL is never logged.
 */
export interface TelegramNotifierOptions {
  botToken: string;
  /** Default chat, for shops without their own. */
  chatId: string;
  /** Each shop's own chat, by shop id. */
  shopChats?: Readonly<Record<string, string>>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429 and 5xx. */
  maxRetries?: number;
}

export class TelegramNotifier implements SellerNotifier {
  readonly #url: string;
  readonly #chatId: string;
  readonly #shopChats: Readonly<Record<string, string>>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;

  constructor(options: TelegramNotifierOptions) {
    this.#url = `https://api.telegram.org/bot${options.botToken}/sendMessage`;
    this.#chatId = options.chatId;
    this.#shopChats = { ...options.shopChats };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRetries = options.maxRetries ?? 2;
  }

  /** Where a shop's pings go. */
  chatFor(shopId: string): { chatId: string; ownChat: boolean } {
    const own = this.#shopChats[shopId];
    return own ? { chatId: own, ownChat: true } : { chatId: this.#chatId, ownChat: false };
  }

  async orderCompleted(order: Order, shop: Readonly<ShopInfo>, buyer?: Buyer): Promise<void> {
    const text = formatOrderMessage(order, shop.name, buyer);
    const { chatId, ownChat } = this.chatFor(shop.id);
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });

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
          log.info('seller pinged on telegram', { order_id: order.id, shop_id: shop.id, shop_chat: ownChat, buyer_known: Boolean(buyer) });
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

/** e.g. "New order for Auntie's Kitchen! 2 x Chocolate chip cookies, $12.00, paid via PayPal." plus buyer and ids. */
export function formatOrderMessage(order: Order, shopName: string, buyer?: Buyer): string {
  const items = order.items.map((i) => `${i.quantity} x ${i.name}`).join(', ');
  const who = [buyer?.name, buyer?.email].filter(Boolean).join(', ');
  return [
    `New order for ${shopName}! ${items}, ${formatUsd(order.totalCents)}, paid via PayPal.`,
    who ? `Buyer: ${who}` : 'Buyer: PayPal did not share contact details; check the payment in your PayPal account.',
    `Order ${order.id}${order.captureId ? ` (PayPal capture ${order.captureId})` : ''}.`,
    who ? 'Contact the buyer to arrange delivery, pickup or the booking.' : 'Arrange delivery, pickup or the booking with the buyer.',
  ].join('\n');
}
