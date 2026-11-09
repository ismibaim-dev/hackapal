import { createApp, type AppDeps } from './app.js';
import { ConfigError, hasPayPalCredentials, loadConfig, loadDotEnv, type AppConfig } from './config.js';
import { log } from './log.js';
import { OrderService } from './orders.js';
import { PayPalClient } from './paypal.js';
import { createPlatform } from './platform.js';
import { InMemoryOrderStore, type OrderStore } from './store.js';
import { CatalogStockStore, SupabaseStockStore, type StockStore } from './stock.js';
import { createSupabaseServerClient, SupabaseOrderStore } from './supabase-store.js';
import { TelegramNotifier } from './telegram.js';

/** How often failed seller pings are retried. With MAX_PING_ATTEMPTS that covers about an hour. */
const PING_SWEEP_INTERVAL_MS = 5 * 60_000;

loadDotEnv();

let config: AppConfig;
try {
  config = loadConfig();
} catch (err) {
  log.error('invalid configuration, not starting', {
    issues: err instanceof ConfigError ? err.issues : String(err),
  });
  process.exit(1);
}
for (const warning of config.warnings) log.warn(warning);

const deps: AppDeps = { config };
if (hasPayPalCredentials(config)) {
  const paypal = new PayPalClient({ clientId: config.paypal.clientId!, clientSecret: config.paypal.clientSecret! });
  deps.paypal = paypal;
  const platform = createPlatform();
  const db = config.supabase ? createSupabaseServerClient(config.supabase.url, config.supabase.secretKey) : undefined;
  const store: OrderStore = db ? new SupabaseOrderStore({ ...config.supabase!, client: db }) : new InMemoryOrderStore();
  const stock: StockStore = db
    ? new SupabaseStockStore(db, platform.inventory)
    : new CatalogStockStore(platform.inventory);
  if (!db) log.warn('SUPABASE_URL/SUPABASE_SECRET_KEY not set: orders and stock are kept in memory and lost on restart');
  for (const shopId of new Set([...Object.keys(config.telegram?.shopChats ?? {}), ...Object.keys(config.telegram?.shopBots ?? {})])) {
    if (!platform.shop(shopId)) log.warn('Telegram settings name an unknown shop; they are unused', { shop_id: shopId });
  }
  deps.orders = new OrderService({
    platform,
    store,
    stock,
    paypal,
    ...(config.telegram ? { notifier: new TelegramNotifier(config.telegram) } : {}),
    publicBaseUrl: config.publicBaseUrl,
    allowSimulatedDecline: config.paypal.env === 'sandbox',
  });
} else {
  log.warn('PayPal credentials missing: order, PayPal and webhook routes answer 503');
}
// Retry seller pings that failed (Telegram down, a restart mid-ping). Timers are unref'd so
// they never keep the process alive on shutdown.
if (deps.orders && config.telegram) {
  const orders = deps.orders;
  const sweep = () => {
    orders.retrySellerPings().catch((err: unknown) => log.warn('seller ping sweep failed', { err }));
  };
  setTimeout(sweep, 30_000).unref();
  setInterval(sweep, PING_SWEEP_INTERVAL_MS).unref();
}
if (!config.paypal.webhookId) log.warn('PAYPAL_WEBHOOK_ID not set: webhooks will be refused (503)');

const app = createApp(deps);

const server = app.listen(config.port, (err?: Error) => {
  if (err) {
    log.error('failed to start server', { err, port: config.port });
    process.exit(1);
  }
  log.info('hackapal listening', {
    port: config.port,
    publicBaseUrl: config.publicBaseUrl,
    paypalEnv: config.paypal.env,
    paypalCredentials: hasPayPalCredentials(config),
  });
});

// Render sends SIGTERM on deploys; Ctrl+C sends SIGINT locally (Windows included).
function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
