import { createApp, type AppDeps } from './app.js';
import { createCatalog } from './catalog.js';
import { ConfigError, hasPayPalCredentials, loadConfig, loadDotEnv, type AppConfig } from './config.js';
import { log } from './log.js';
import { OrderService } from './orders.js';
import { PayPalClient } from './paypal.js';
import { InMemoryOrderStore, type OrderStore } from './store.js';
import { CatalogStockStore, SupabaseStockStore, type StockStore } from './stock.js';
import { createSupabaseServerClient, SupabaseOrderStore } from './supabase-store.js';

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
  const catalog = createCatalog();
  const db = config.supabase ? createSupabaseServerClient(config.supabase.url, config.supabase.secretKey) : undefined;
  const store: OrderStore = db ? new SupabaseOrderStore({ ...config.supabase!, client: db }) : new InMemoryOrderStore();
  const stock: StockStore = db ? new SupabaseStockStore(db, catalog) : new CatalogStockStore(catalog);
  if (!db) log.warn('SUPABASE_URL/SUPABASE_SECRET_KEY not set: orders and stock are kept in memory and lost on restart');
  deps.orders = new OrderService({
    catalog,
    store,
    stock,
    paypal,
    publicBaseUrl: config.publicBaseUrl,
    allowSimulatedDecline: config.paypal.env === 'sandbox',
  });
} else {
  log.warn('PayPal credentials missing: order, PayPal and webhook routes answer 503');
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
