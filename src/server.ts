import { createApp } from './app.js';
import { ConfigError, hasPayPalCredentials, loadConfig, loadDotEnv, type AppConfig } from './config.js';
import { log } from './log.js';

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

const app = createApp({ config });

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
