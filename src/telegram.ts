import type { ShopInfo } from './catalog.js';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { SellerNotifier } from './orders.js';
import type { Buyer } from './paypal.js';
import { receiptNumber, renderReceiptPdf } from './receipt.js';
import type { FetchLike } from './paypal-http.js';
import type { Order } from './store.js';

/**
 * Seller ping on Telegram: one message per paid seller, sent when the capture completes. A
 * failure resolves false, and OrderService's retry sweep tries again later.
 * Each shop's ping goes to that shop's own chat (TELEGRAM_SHOP_CHATS), sent by that shop's own
 * bot when it has one (TELEGRAM_BOT_TOKEN_<SHOP>), or by the default bot to the default chat
 * when the shop has none. The message names the shop and, when PayPal says, the buyer,
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
  /** Each shop's own bot token, by shop id. Used only for shops that have their own chat. */
  shopBots?: Readonly<Record<string, string>>;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt, for 429 and 5xx. */
  maxRetries?: number;
  /** Send a PDF receipt after each order card. Default true. */
  receipts?: boolean;
}

function sendMessageUrl(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}/sendMessage`;
}

export class TelegramNotifier implements SellerNotifier {
  readonly #url: string;
  readonly #chatId: string;
  readonly #shopChats: Readonly<Record<string, string>>;
  readonly #shopBots: Readonly<Record<string, string>>;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #maxRetries: number;
  readonly #receipts: boolean;

  constructor(options: TelegramNotifierOptions) {
    this.#url = sendMessageUrl(options.botToken);
    this.#chatId = options.chatId;
    this.#shopChats = { ...options.shopChats };
    this.#shopBots = { ...options.shopBots };
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#maxRetries = options.maxRetries ?? 2;
    this.#receipts = options.receipts ?? true;
  }

  /**
   * Where a shop's pings go and which bot sends them. A shop's own bot is only used with its
   * own chat: it isn't a member of the default chat.
   */
  #routeFor(shopId: string): { url: string; chatId: string; ownChat: boolean; ownBot: boolean } {
    const chatId = this.#shopChats[shopId];
    if (!chatId) return { url: this.#url, chatId: this.#chatId, ownChat: false, ownBot: false };
    const token = this.#shopBots[shopId];
    return { url: token ? sendMessageUrl(token) : this.#url, chatId, ownChat: true, ownBot: Boolean(token) };
  }

  /** The routing for a shop, without the bot token. */
  chatFor(shopId: string): { chatId: string; ownChat: boolean; ownBot: boolean } {
    const { chatId, ownChat, ownBot } = this.#routeFor(shopId);
    return { chatId, ownChat, ownBot };
  }

  /** True when Telegram accepted the message; false when the seller wasn't reached (retried later). */
  async orderCompleted(order: Order, shop: Readonly<ShopInfo>, buyer?: Buyer): Promise<boolean> {
    const text = formatOrderMessage(order, shop.name, buyer);
    const { url, chatId, ownChat, ownBot } = this.#routeFor(shop.id);
    const body = JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true });
    const sent = await this.#call(url, () => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body }), order.id, 'telegram ping');
    if (!sent) return false;
    log.info('seller pinged on telegram', { order_id: order.id, shop_id: shop.id, shop_chat: ownChat, shop_bot: ownBot, buyer_known: Boolean(buyer) });

    // The PDF receipt follows the card. The card is what counts as "seller reached": if the
    // PDF fails we log it and stop, so the retry sweep never sends the card twice.
    if (this.#receipts) {
      try {
        const pdf = await renderReceiptPdf(order, shop, buyer);
        const filename = `receipt-${receiptNumber(order, shop)}.pdf`;
        const docUrl = url.replace(/sendMessage$/, 'sendDocument');
        const ok = await this.#call(
          docUrl,
          () => {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('caption', `Receipt ${receiptNumber(order, shop)} · ${formatUsd(order.totalCents)} paid via PayPal`);
            form.append('document', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);
            return { method: 'POST', body: form };
          },
          order.id,
          'telegram receipt',
        );
        if (ok) log.info('receipt pdf sent on telegram', { order_id: order.id, shop_id: shop.id, bytes: pdf.length });
      } catch (err) {
        log.warn('receipt pdf could not be built', { order_id: order.id, shop_id: shop.id, err });
      }
    }
    return true;
  }

  /** One Bot API call with retries on 429 (honouring retry_after), 5xx and network errors. */
  async #call(url: string, init: () => RequestInit, orderId: string, what: string): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      let status = 0;
      let description: string | undefined;
      let retryAfterSeconds: number | undefined;
      try {
        const res = await this.#fetch(url, init());
        status = res.status;
        const json = (await res.json().catch(() => undefined)) as
          | { ok?: boolean; description?: string; parameters?: { retry_after?: number } }
          | undefined;
        if (res.ok && json?.ok) return true;
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
      log.warn(`${what} failed`, { order_id: orderId, status, description });
      return false;
    }
  }
}

/**
 * The seller's order card, plain text (no parse_mode, so nothing a buyer types can become
 * markup). Items, total, where to deliver, how to reach the buyer and their note.
 */
export function formatOrderMessage(order: Order, shopName: string, buyer?: Buyer): string {
  const lines: string[] = [
    `NEW ORDER - ${shopName}`,
    `Order ${order.id}, paid ${formatUsd(order.totalCents)} via PayPal${order.captureId ? ` (capture ${order.captureId})` : ''}`,
    '',
    'Items',
    ...order.items.map((i) => `  ${i.quantity} x ${i.name} (${formatUsd(i.unitPriceCents)} each)  ${formatUsd(i.lineTotalCents)}`),
  ];

  if (buyer?.shipTo) {
    lines.push('', 'Deliver to / service address', ...[buyer.shipTo.name, ...buyer.shipTo.lines].filter(Boolean).map((l) => `  ${l}`));
  }

  const contact = [buyer?.name, buyer?.email, buyer?.phone].filter(Boolean);
  lines.push('', 'Contact');
  lines.push(...(contact.length > 0 ? contact.map((c) => `  ${c}`) : ['  PayPal did not share contact details; check the payment in your PayPal account.']));

  if (order.buyerNote) lines.push('', 'Note from the buyer', `  ${order.buyerNote}`);

  lines.push('', 'Please contact the buyer to confirm delivery, pickup or the booking time.');
  return lines.join('\n');
}
