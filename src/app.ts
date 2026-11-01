import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { apiRoutes } from './api-routes.js';
import { hasPayPalCredentials, type AppConfig } from './config.js';
import { log } from './log.js';
import { mcpRoutes } from './mcp.js';
import type { OrderService } from './orders.js';
import type { PayPalGateway } from './paypal.js';
import { PayPalHttpError } from './paypal-http.js';
import { paypalRoutes } from './paypal-routes.js';

export interface AppDeps {
  config: AppConfig;
  /** Present when PayPal credentials are configured (see server.ts). */
  orders?: OrderService;
  paypal?: PayPalGateway;
}

export function createApp({ config, orders, paypal }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  // Render terminates TLS in front of us; trust its X-Forwarded-* headers.
  app.set('trust proxy', 1);

  // No global express.json() on purpose: the PayPal webhook route needs the raw,
  // unmodified body to verify the signature, so body parsers are mounted per route.

  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store').json({
      status: 'ok',
      service: 'hackapal',
      version: process.env.npm_package_version ?? 'dev',
      commit: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
      uptimeSeconds: Math.round(process.uptime()),
      paypal: {
        env: config.paypal.env,
        credentialsConfigured: hasPayPalCredentials(config),
        webhookConfigured: Boolean(config.paypal.webhookId),
      },
      orderStore: config.supabase ? 'supabase' : 'memory',
    });
  });

  if (orders && paypal) {
    app.use(paypalRoutes({ orders, paypal, webhookId: config.paypal.webhookId }));
    app.use('/api', apiRoutes({ orders }));
    app.use(mcpRoutes({ orders }));
  } else {
    app.use(['/paypal', '/webhooks', '/api', '/mcp'], (_req, res) => {
      res.status(503).json({ error: 'paypal_not_configured' });
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof PayPalHttpError) {
      // Already logged with its debug_id where it happened.
      res.status(502).json({ error: 'paypal_error', message: err.message, debug_id: err.debugId ?? null });
      return;
    }
    const status = (err as { status?: unknown } | null)?.status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Body parser errors: malformed JSON, payload too large.
      res.status(status).json({ error: status === 413 ? 'payload_too_large' : 'invalid_request' });
      return;
    }
    log.error('unhandled error', { err, method: req.method, path: req.path });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
