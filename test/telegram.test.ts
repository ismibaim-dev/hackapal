import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUNTIES_KITCHEN, KAMPUNG_FRESH_MART } from '../src/catalog.js';
import type { Order } from '../src/store.js';
import { formatOrderMessage, TelegramNotifier } from '../src/telegram.js';
import { fakeFetch, jsonResponse } from './helpers.js';

const TOKEN = '123456:TEST-secret-bot-token';

afterEach(() => {
  vi.restoreAllMocks();
  process.env.LOG_LEVEL = 'silent';
});

const order: Order = {
  id: 'ord_zp6ht17jmjzp',
  paypalOrderId: '8C3962828B525862K',
  approvalUrl: 'https://www.sandbox.paypal.com/checkoutnow?token=8C3962828B525862K',
  currency: 'USD',
  items: [
    { productId: 'choc-chip-cookies', name: 'Chocolate chip cookies', unit: 'box of 10', quantity: 2, unitPriceCents: 600, lineTotalCents: 1200 },
    { productId: 'kuih-lapis', name: 'Kuih lapis', unit: '12 pieces', quantity: 1, unitPriceCents: 800, lineTotalCents: 800 },
  ],
  totalCents: 2000,
  status: 'COMPLETED',
  captureId: '0MM61912RS3958306',
  captureAttempts: 0,
  simulateDecline: false,
  createdAt: '2026-11-02T03:17:00.000Z',
  updatedAt: '2026-11-02T03:19:36.000Z',
};

function notifier(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  const sleeps: number[] = [];
  const n = new TelegramNotifier({
    botToken: TOKEN,
    chatId: '-100123',
    fetch: f,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { n, calls: f.calls, sleeps };
}

describe('formatOrderMessage', () => {
  it('lists items, total and ids in plain text', () => {
    expect(formatOrderMessage(order, "Auntie's Kitchen", { name: 'Siti Aminah', email: 'siti@personal.example.com' })).toBe(
      "New order for Auntie's Kitchen! 2 x Chocolate chip cookies, 1 x Kuih lapis, $20.00, paid via PayPal.\n" +
        'Buyer: Siti Aminah, siti@personal.example.com\n' +
        'Order ord_zp6ht17jmjzp (PayPal capture 0MM61912RS3958306).\n' +
        'Contact the buyer to arrange delivery, pickup or the booking.',
    );
  });

  it('says so when PayPal shared no buyer details', () => {
    const text = formatOrderMessage(order, "Auntie's Kitchen");
    expect(text).toContain('Buyer: PayPal did not share contact details');
    expect(text).not.toContain('Contact the buyer');
  });
});

describe('TelegramNotifier', () => {
  it("sends each shop's order to that shop's own chat, and the rest to the default chat", async () => {
    const f = fakeFetch(() => jsonResponse(200, { ok: true }));
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: '-100123', shopChats: { 'kampung-fresh-mart': '-100777' }, fetch: f });
    await n.orderCompleted(order, KAMPUNG_FRESH_MART, { email: 'siti@personal.example.com' });
    await n.orderCompleted(order, AUNTIES_KITCHEN);
    const chats = f.calls.map((c) => JSON.parse(String(c.init.body)).chat_id);
    expect(chats).toEqual(['-100777', '-100123']);
    expect(JSON.parse(String(f.calls[0]!.init.body)).text).toContain('New order for Kampung Fresh Mart!');
    expect(n.chatFor('kilat-home-cleaning')).toEqual({ chatId: '-100123', ownChat: false });
  });

  it('never logs the buyer', async () => {
    process.env.LOG_LEVEL = 'info';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { n } = notifier(() => jsonResponse(200, { ok: true }));
    await n.orderCompleted(order, AUNTIES_KITCHEN, { name: 'Siti Aminah', email: 'siti@personal.example.com' });
    const logged = [...out.mock.calls, ...errors.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).toContain('seller pinged on telegram');
    expect(logged).not.toContain('siti@');
    expect(logged).not.toContain('Siti');
  });

  it('posts sendMessage to the configured chat as plain text', async () => {
    const { n, calls } = notifier(() => jsonResponse(200, { ok: true, result: { message_id: 1 } }));
    await n.orderCompleted(order, AUNTIES_KITCHEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toEqual({ chat_id: '-100123', text: formatOrderMessage(order, "Auntie's Kitchen"), disable_web_page_preview: true });
    expect(body).not.toHaveProperty('parse_mode');
  });

  it('retries 429 using retry_after, then succeeds', async () => {
    const { n, calls, sleeps } = notifier((_, i) =>
      i === 0
        ? jsonResponse(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } })
        : jsonResponse(200, { ok: true }),
    );
    await n.orderCompleted(order, AUNTIES_KITCHEN);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('gives up quietly on a 4xx and never logs the bot token', async () => {
    process.env.LOG_LEVEL = 'warn';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { n, calls } = notifier(() => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
    await expect(n.orderCompleted(order, AUNTIES_KITCHEN)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('chat not found');
    expect(logged).not.toContain(TOKEN);
  });

  it('survives network errors after its retries', async () => {
    const { n, calls } = notifier(() => {
      throw new TypeError('fetch failed');
    });
    await expect(n.orderCompleted(order, AUNTIES_KITCHEN)).resolves.toBeUndefined();
    expect(calls).toHaveLength(3);
  });
});
