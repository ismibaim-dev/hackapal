import { describe, expect, it } from 'vitest';
import { ConfigError, hasPayPalCredentials, loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('uses safe defaults when nothing is set', () => {
    const config = loadConfig({});
    expect(config.port).toBe(3000);
    expect(config.publicBaseUrl).toBe('http://localhost:3000');
    expect(config.paypal.env).toBe('sandbox');
    expect(hasPayPalCredentials(config)).toBe(false);
    expect(config.telegram).toBeUndefined();
    expect(config.warnings).toEqual([]);
  });

  it('derives the local base URL from PORT and strips trailing slashes', () => {
    expect(loadConfig({ PORT: '8080' }).publicBaseUrl).toBe('http://localhost:8080');
    expect(loadConfig({ PUBLIC_BASE_URL: 'https://shop.onrender.com//' }).publicBaseUrl).toBe(
      'https://shop.onrender.com',
    );
  });

  it("falls back to Render's RENDER_EXTERNAL_URL, but an explicit PUBLIC_BASE_URL wins", () => {
    expect(loadConfig({ RENDER_EXTERNAL_URL: 'https://hackapal.onrender.com' }).publicBaseUrl).toBe(
      'https://hackapal.onrender.com',
    );
    expect(
      loadConfig({ RENDER_EXTERNAL_URL: 'https://hackapal.onrender.com', PUBLIC_BASE_URL: 'https://shop.example/' })
        .publicBaseUrl,
    ).toBe('https://shop.example');
  });

  it('treats blank values from a fresh .env copy as unset and trims the rest', () => {
    const config = loadConfig({ PORT: '', PAYPAL_CLIENT_ID: '   ', PAYPAL_WEBHOOK_ID: ' WH-123 ' });
    expect(config.port).toBe(3000);
    expect(config.paypal.clientId).toBeUndefined();
    expect(config.paypal.webhookId).toBe('WH-123');
  });

  it('refuses anything but the sandbox, without echoing secrets', () => {
    const attempt = () => loadConfig({ PAYPAL_ENV: 'live', PAYPAL_CLIENT_SECRET: 'super-secret-value' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/PAYPAL_ENV must be "sandbox"/);
    expect(attempt).not.toThrow(/super-secret-value/);
  });

  it('rejects malformed URLs and ports', () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'not a url' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'ftp://example.com' })).toThrow(/PUBLIC_BASE_URL/);
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('warns about half-configured PayPal or Telegram settings', () => {
    const config = loadConfig({ PAYPAL_CLIENT_ID: 'id-only', TELEGRAM_BOT_TOKEN: 'bot-only' });
    expect(config.warnings).toHaveLength(2);
    expect(config.telegram).toBeUndefined();
    expect(hasPayPalCredentials(config)).toBe(false);
  });

  it('enables Telegram only when both values are present', () => {
    const config = loadConfig({ TELEGRAM_BOT_TOKEN: 'bot', TELEGRAM_CHAT_ID: '42' });
    expect(config.telegram).toEqual({ botToken: 'bot', chatId: '42', shopChats: {}, shopBots: {} });
  });
});

describe('TELEGRAM_SHOP_CHATS', () => {
  it('maps shops to their own chats and keeps the default chat', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_SHOP_CHATS: ' kampung-fresh-mart = -1001234567890 , kilat-home-cleaning=@kilatorders ',
    });
    expect(config.telegram).toEqual({
      botToken: 'bot',
      chatId: '42',
      shopChats: { 'kampung-fresh-mart': '-1001234567890', 'kilat-home-cleaning': '@kilatorders' },
      shopBots: {},
    });
    expect(config.warnings).toEqual([]);
  });

  it('skips malformed entries with a warning instead of refusing to start', () => {
    const config = loadConfig({
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_CHAT_ID: '42',
      TELEGRAM_SHOP_CHATS: 'kampung-fresh-mart=-100123,Bad Shop=1,kilat-home-cleaning=abc,x=1=2',
    });
    expect(config.telegram?.shopChats).toEqual({ 'kampung-fresh-mart': '-100123' });
    expect(config.warnings).toHaveLength(3);
    expect(config.warnings.join(' ')).not.toContain('Bad Shop');
  });
});

describe('per-shop Telegram bots', () => {
  const base = { TELEGRAM_BOT_TOKEN: 'default-bot', TELEGRAM_CHAT_ID: '42' };

  it('reads a bot per shop from TELEGRAM_BOT_TOKEN_<SHOP>, keyed by the shop id', () => {
    const config = loadConfig({
      ...base,
      TELEGRAM_SHOP_CHATS: 'kampung-fresh-mart=-100111,kilat-home-cleaning=-100222',
      TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART: 'grocer-bot',
      TELEGRAM_BOT_TOKEN_KILAT_HOME_CLEANING: 'cleaner-bot',
    });
    expect(config.telegram?.shopBots).toEqual({ 'kampung-fresh-mart': 'grocer-bot', 'kilat-home-cleaning': 'cleaner-bot' });
    expect(config.warnings).toEqual([]);
  });

  it("drops a shop's bot that has no chat of its own, and never puts a token in a warning", () => {
    const config = loadConfig({ ...base, TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART: 'secret-grocer-token' });
    expect(config.telegram?.shopBots).toEqual({});
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART');
    expect(config.warnings[0]).not.toContain('secret-grocer-token');
  });

  it("doesn't mistake the default token for a shop's, and ignores blanks", () => {
    const config = loadConfig({ ...base, TELEGRAM_SHOP_CHATS: 'kampung-fresh-mart=-100111', TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART: '   ' });
    expect(config.telegram?.shopBots).toEqual({});
    expect(config.warnings).toEqual([]);
  });

  it('turns pings off, with a warning, when only per-shop settings exist', () => {
    const config = loadConfig({ TELEGRAM_SHOP_CHATS: 'kampung-fresh-mart=-100111', TELEGRAM_BOT_TOKEN_KAMPUNG_FRESH_MART: 'grocer-bot' });
    expect(config.telegram).toBeUndefined();
    expect(config.warnings.join(' ')).toContain('need the default TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  });
});
