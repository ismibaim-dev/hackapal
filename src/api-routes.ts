import express, { Router } from 'express';
import { z } from 'zod';
import { toOrderView, type OrderService } from './orders.js';
import { CartInputSchema } from './pricing.js';

/**
 * Internal API for scripts (money-path) and debugging. Shares OrderService with the
 * MCP tools. Prices still come only from the catalog: unknown fields are stripped.
 * Mounted behind requireApiKey (src/auth.ts): callers need the API_KEY.
 */
const CreateOrderBody = CartInputSchema.extend({
  /** Sandbox demo: make the first capture fail with INSTRUMENT_DECLINED. */
  simulate_decline: z.boolean().optional(),
});

const SetStockBody = z.object({
  levels: z.record(z.string(), z.number()),
});

export function apiRoutes({ orders }: { orders: OrderService }): Router {
  const router = Router();
  router.use(express.json({ limit: '32kb' }));

  // Seller restock. GET shows live levels; PUT sets absolute levels.
  router.get('/stock', async (_req, res) => {
    const products = await orders.listProducts();
    res.json({ products: products.map((p) => ({ product_id: p.id, name: p.name, in_stock: p.stock })) });
  });

  router.put('/stock', async (req, res) => {
    const parsed = SetStockBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_request', issues: parsed.error.issues.map((i) => i.message) });
      return;
    }
    const result = await orders.setStock(parsed.data.levels);
    if (!result.ok) {
      res.status(400).json({ error: 'invalid_levels', issues: result.errors });
      return;
    }
    const products = await orders.listProducts();
    res.json({ products: products.map((p) => ({ product_id: p.id, name: p.name, in_stock: p.stock })) });
  });

  router.post('/orders', async (req, res) => {
    const parsed = CreateOrderBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid_request',
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    const result = await orders.createOrder(
      { items: parsed.data.items },
      { simulateDecline: parsed.data.simulate_decline ?? false },
    );
    if (!result.ok) {
      res.status(422).json({ error: 'cannot_price_cart', issues: result.issues });
      return;
    }
    res.status(201).json({ ...toOrderView(result.order), simulate_decline: result.order.simulateDecline });
  });

  router.get('/orders/:id', async (req, res) => {
    const order = await orders.refresh(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    // Webhook evidence is for scripts (T1b), not part of the agent-facing view.
    res.json({ ...toOrderView(order), webhooks_received: orders.webhookEventsFor(order.id) });
  });

  router.post('/orders/:id/capture', async (req, res) => {
    if (!(await orders.get(req.params.id))) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    const result = await orders.capture(req.params.id, 'api');
    res.json({ outcome: result.outcome, order: toOrderView(result.order) });
  });

  return router;
}
