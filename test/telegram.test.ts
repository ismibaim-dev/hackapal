import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUNTIES_KITCHEN, KAMPUNG_FRESH_MART } from '../src/catalog.js';
import type { Order } from '../src/store.js';
import { formatOrderMessage, TelegramNotifier } from '../src/telegram.js';
import { receiptNumber, renderReceiptPdf } from '../src/receipt.js';
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
  buyerNote: null,
  sellersPinged: [],
  pingPending: true,
  pingAttempts: 0,
  createdAt: '2026-11-02T03:17:00.000Z',
  updatedAt: '2026-11-02T03:19:36.000Z',
};

function notifier(handler: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(handler);
  const sleeps: number[] = [];
  const n = new TelegramNotifier({ receipts: false,
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
  it('is an order card: items, total, address, contact and the buyer note', () => {
    const text = formatOrderMessage({ ...order, buyerNote: 'Please deliver after 6pm, blue gate' }, 'Kampung Fresh Mart', {
      name: 'Siti Aminah',
      email: 'siti@personal.example.com',
      phone: '4085551234',
      shipTo: { name: 'Siti Aminah', lines: ['12 Jalan Mawar', 'Shah Alam, Selangor 40000', 'MY'] },
    });
    expect(text).toBe(
      [
        'NEW ORDER - Kampung Fresh Mart',
        'Order ord_zp6ht17jmjzp, paid $20.00 via PayPal (capture 0MM61912RS3958306)',
        '',
        'Items',
        '  2 x Chocolate chip cookies ($6.00 each)  $12.00',
        '  1 x Kuih lapis ($8.00 each)  $8.00',
        '',
        'Deliver to / service address',
        '  Siti Aminah',
        '  12 Jalan Mawar',
        '  Shah Alam, Selangor 40000',
        '  MY',
        '',
        'Contact',
        '  Siti Aminah',
        '  siti@personal.example.com',
        '  4085551234',
        '',
        'Note from the buyer',
        '  Please deliver after 6pm, blue gate',
        '',
        'Please contact the buyer to confirm delivery, pickup or the booking time.',
      ].join('\n'),
    );
  });

  it('leaves out the address and note when there are none, and says so when PayPal shared no contact', () => {
    const text = formatOrderMessage(order, "Auntie's Kitchen");
    expect(text).not.toContain('Deliver to');
    expect(text).not.toContain('Note from the buyer');
    expect(text).toContain('PayPal did not share contact details');
  });
});

describe('TelegramNotifier', () => {
  it("sends each shop's order to that shop's own chat, and the rest to the default chat", async () => {
    const f = fakeFetch(() => jsonResponse(200, { ok: true }));
    const n = new TelegramNotifier({ receipts: false, botToken: TOKEN, chatId: '-100123', shopChats: { 'kampung-fresh-mart': '-100777' }, fetch: f });
    await n.orderCompleted(order, KAMPUNG_FRESH_MART, { email: 'siti@personal.example.com' });
    await n.orderCompleted(order, AUNTIES_KITCHEN);
    const chats = f.calls.map((c) => JSON.parse(String(c.init.body)).chat_id);
    expect(chats).toEqual(['-100777', '-100123']);
    expect(JSON.parse(String(f.calls[0]!.init.body)).text).toContain('NEW ORDER - Kampung Fresh Mart');
    expect(n.chatFor('kilat-home-cleaning')).toEqual({ chatId: '-100123', ownChat: false, ownBot: false });
  });

  it("sends from a shop's own bot to its own chat, and falls back to the default bot otherwise", async () => {
    const f = fakeFetch(() => jsonResponse(200, { ok: true }));
    const n = new TelegramNotifier({ receipts: false,
      botToken: TOKEN,
      chatId: '-100123',
      shopChats: { 'kampung-fresh-mart': '-100777', 'kilat-home-cleaning': '-100888' },
      // The cleaner has a chat but no bot of its own; the stray bot for auntie has no chat, so it is never used.
      shopBots: { 'kampung-fresh-mart': '777:grocer-bot', 'aunties-kitchen': '999:stray-bot' },
      fetch: f,
    });
    await n.orderCompleted(order, KAMPUNG_FRESH_MART);
    await n.orderCompleted(order, { ...KAMPUNG_FRESH_MART, id: 'kilat-home-cleaning', name: 'Kilat Home Cleaning' });
    await n.orderCompleted(order, AUNTIES_KITCHEN);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.telegram.org/bot777:grocer-bot/sendMessage',
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    ]);
    expect(f.calls.map((c) => JSON.parse(String(c.init.body)).chat_id)).toEqual(['-100777', '-100888', '-100123']);
    expect(n.chatFor('kampung-fresh-mart')).toEqual({ chatId: '-100777', ownChat: true, ownBot: true });
    expect(n.chatFor('kilat-home-cleaning')).toEqual({ chatId: '-100888', ownChat: true, ownBot: false });
    expect(n.chatFor('aunties-kitchen')).toEqual({ chatId: '-100123', ownChat: false, ownBot: false });
  });

  it("never logs any shop's bot token", async () => {
    process.env.LOG_LEVEL = 'info';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const n = new TelegramNotifier({ receipts: false,
      botToken: TOKEN,
      chatId: '-100123',
      shopChats: { 'kampung-fresh-mart': '-100777' },
      shopBots: { 'kampung-fresh-mart': '777:grocer-secret-token' },
      fetch: fakeFetch(() => jsonResponse(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })),
      sleep: async () => undefined,
    });
    await n.orderCompleted(order, KAMPUNG_FRESH_MART);
    const logged = [...out.mock.calls, ...errors.mock.calls].map((c) => String(c[0])).join('\n');
    expect(logged).toContain('telegram ping failed');
    expect(logged).not.toContain('grocer-secret-token');
    expect(logged).not.toContain(TOKEN);
  });

  it('never logs the buyer', async () => {
    process.env.LOG_LEVEL = 'info';
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { n } = notifier(() => jsonResponse(200, { ok: true }));
    await expect(n.orderCompleted(order, AUNTIES_KITCHEN, { name: 'Siti Aminah', email: 'siti@personal.example.com' })).resolves.toBe(true);
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
    await expect(n.orderCompleted(order, AUNTIES_KITCHEN)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('chat not found');
    expect(logged).not.toContain(TOKEN);
  });

  it('survives network errors after its retries', async () => {
    const { n, calls } = notifier(() => {
      throw new TypeError('fetch failed');
    });
    await expect(n.orderCompleted(order, AUNTIES_KITCHEN)).resolves.toBe(false);
    expect(calls).toHaveLength(3);
  });
});

describe('PDF receipt', () => {
  const buyer = {
    name: 'Siti Aminah',
    email: 'siti@personal.example.com',
    shipTo: { name: 'Siti Aminah', lines: ['12 Jalan Mawar', 'Shah Alam, Selangor 40000', 'MY'] },
  };

  it('is a one-page PDF titled with the receipt number, and survives text the PDF fonts cannot draw', async () => {
    const pdf = await renderReceiptPdf({ ...order, buyerNote: 'Deliver after 6pm 🙂 谢谢' }, KAMPUNG_FRESH_MART, buyer, { compress: false });
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-')).toBe(true);
    expect(raw).toContain(`Receipt ${receiptNumber(order, KAMPUNG_FRESH_MART)}`);
    expect(raw.match(/\/Type \/Page\b/g)).toHaveLength(1);
    // Without the buyer (PayPal shared nothing) it still renders.
    const bare = await renderReceiptPdf(order, AUNTIES_KITCHEN, undefined);
    expect(bare.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('gives each seller in a combined checkout its own receipt number', () => {
    expect(receiptNumber(order, AUNTIES_KITCHEN)).toBe('R-ZP6HT17JMJZP-AK');
    expect(receiptNumber(order, KAMPUNG_FRESH_MART)).toBe('R-ZP6HT17JMJZP-KFM');
  });

  it('is sent after the order card with sendDocument, to the same chat and bot', async () => {
    const f = fakeFetch(() => jsonResponse(200, { ok: true }));
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: '-100123', shopChats: { 'kampung-fresh-mart': '-100777' }, shopBots: { 'kampung-fresh-mart': '777:grocer-bot' }, fetch: f });
    expect(await n.orderCompleted(order, KAMPUNG_FRESH_MART, buyer)).toBe(true);
    expect(f.calls.map((c) => c.url)).toEqual([
      'https://api.telegram.org/bot777:grocer-bot/sendMessage',
      'https://api.telegram.org/bot777:grocer-bot/sendDocument',
    ]);
    const form = f.calls[1]!.init.body as FormData;
    expect(form.get('chat_id')).toBe('-100777');
    expect(String(form.get('caption'))).toContain('$20.00 paid via PayPal');
    const file = form.get('document') as File;
    expect(file.name).toBe(`receipt-${receiptNumber(order, KAMPUNG_FRESH_MART)}.pdf`);
    expect(file.type).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still counts the seller as reached when only the PDF fails, so the card is never resent', async () => {
    const f = fakeFetch((call) => (call.url.endsWith('sendDocument') ? jsonResponse(400, { ok: false, description: 'Bad Request' }) : jsonResponse(200, { ok: true })));
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: '-100123', fetch: f, sleep: async () => undefined });
    expect(await n.orderCompleted(order, AUNTIES_KITCHEN, buyer)).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it('sends no PDF when the order card itself failed', async () => {
    const f = fakeFetch(() => jsonResponse(400, { ok: false, description: 'chat not found' }));
    const n = new TelegramNotifier({ botToken: TOKEN, chatId: '-100123', fetch: f });
    expect(await n.orderCompleted(order, AUNTIES_KITCHEN)).toBe(false);
    expect(f.calls.map((c) => c.url.split('/').pop())).toEqual(['sendMessage']);
  });
});
