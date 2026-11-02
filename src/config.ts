import { existsSync } from 'node:fs';
import { z } from 'zod';

/**
 * Loads `.env` into process.env if the file exists. Real environment variables
 * (Render, the shell) always win over the file. Uses Node's built-in loader,
 * so there is no dotenv dependency and nothing happens when the file is absent.
 */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path);
}

const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_BASE_URL: z.url({ protocol: /^https?$/, error: 'PUBLIC_BASE_URL must be an http(s) URL' }).optional(),
  // Set by Render on every web service (https://<service>.onrender.com). Fallback for PUBLIC_BASE_URL.
  RENDER_EXTERNAL_URL: z.url({ protocol: /^https?$/, error: 'RENDER_EXTERNAL_URL must be an http(s) URL' }).optional(),
  // Sandbox only for this project. Anything else fails at startup on purpose.
  PAYPAL_ENV: z
    .literal('sandbox', { error: 'PAYPAL_ENV must be "sandbox" (live payments are out of scope)' })
    .default('sandbox'),
  PAYPAL_CLIENT_ID: z.string().optional(),
  PAYPAL_CLIENT_SECRET: z.string().optional(),
  PAYPAL_WEBHOOK_ID: z.string().optional(),
  // Protects the internal /api routes. Long random string; without it /api is switched off.
  API_KEY: z.string().min(24, { error: 'API_KEY must be at least 24 characters' }).optional(),
  SUPABASE_URL: z.url({ protocol: /^https$/, error: 'SUPABASE_URL must be an https URL' }).optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
});

export interface AppConfig {
  port: number;
  /** Base URL PayPal sends the buyer back to. No trailing slash. */
  publicBaseUrl: string;
  paypal: {
    env: 'sandbox';
    clientId?: string;
    clientSecret?: string;
    webhookId?: string;
  };
  /** Key for the internal /api routes; /api answers 503 without it. */
  apiKey?: string;
  /** Present when both SUPABASE_URL and SUPABASE_SECRET_KEY are set; otherwise orders live in memory. */
  supabase?: { url: string; secretKey: string };
  telegram?: { botToken: string; chatId: string };
  /** Non-fatal problems worth logging at startup. Never contains secret values. */
  warnings: string[];
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

/** Blank values (common in a freshly copied .env) count as "not set". Values are trimmed. */
function withoutBlanks(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(withoutBlanks(env));
  if (!parsed.success) {
    // zod issues carry the path and message but not the input, so secrets can't leak here.
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  const warnings: string[] = [];

  if (Boolean(e.PAYPAL_CLIENT_ID) !== Boolean(e.PAYPAL_CLIENT_SECRET)) {
    warnings.push('Only one of PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET is set; PayPal calls will fail.');
  }
  if (Boolean(e.SUPABASE_URL) !== Boolean(e.SUPABASE_SECRET_KEY)) {
    warnings.push('Supabase needs both SUPABASE_URL and SUPABASE_SECRET_KEY; using the in-memory order store.');
  }
  if (Boolean(e.TELEGRAM_BOT_TOKEN) !== Boolean(e.TELEGRAM_CHAT_ID)) {
    warnings.push('Telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID; seller pings are off.');
  }

  return {
    port: e.PORT,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL ?? `http://localhost:${e.PORT}`).replace(/\/+$/, ''),
    paypal: {
      env: e.PAYPAL_ENV,
      clientId: e.PAYPAL_CLIENT_ID,
      clientSecret: e.PAYPAL_CLIENT_SECRET,
      webhookId: e.PAYPAL_WEBHOOK_ID,
    },
    apiKey: e.API_KEY,
    supabase:
      e.SUPABASE_URL && e.SUPABASE_SECRET_KEY ? { url: e.SUPABASE_URL, secretKey: e.SUPABASE_SECRET_KEY } : undefined,
    telegram:
      e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID
        ? { botToken: e.TELEGRAM_BOT_TOKEN, chatId: e.TELEGRAM_CHAT_ID }
        : undefined,
    warnings,
  };
}

export function hasPayPalCredentials(config: AppConfig): boolean {
  return Boolean(config.paypal.clientId && config.paypal.clientSecret);
}
