import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { hasPayPalCredentials, type AppConfig } from './config.js';
import { log } from './log.js';

export interface AppDeps {
  config: AppConfig;
}

export function createApp({ config }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

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
    });
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    log.error('unhandled error', { err, method: req.method, path: req.path });
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
