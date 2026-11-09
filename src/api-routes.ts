import express, { Router } from 'express';
import { z } from 'zod';
import { MAX_NOTE_LENGTH, type OrderService } from './orders.js';
import type { ShopProduct } from './platform.js';
import { CartInputSchema } from './pricing.js';

/**
 * Internal API for scripts (money-path) and debugging. Shares OrderService with the
 * MCP tools. Prices still come only from the catalogs: unknown fields are stripped.
 * Mounted behind requireApiKey (src/auth.ts): callers need the API_KEY.
 */
const CreateOrderBody = CartInputSchema.extend({
  /** Optional: defaults to the shop that sells the items. */
  shop_id: z.string().trim().min(1).max(64).optional(),
  /** Optional buyer note for the seller. */
  note: z.string().trim().max(MAX_NOTE_LENGTH).optional(),
  /** Sandbox demo: make the first capture fail with INSTRUMENT_DECLINED. */
  simulate_decline: z.boolean().optional(),
});

const SetStockBody = z.object({
  levels: z.record(z.string(), z.number()),
});

const stockRows = (products: ShopProduct[]) =>
  products.map((p) => ({ shop_id: p.shopId, product_id: p.id, name: p.name, in_stock: p.stock }));

export function apiRoutes({ orders }: { orders: OrderService }): Router {
  const router = Router();
  router.use(express.json({ limit: '32kb' }));

  // Seller restock. GET shows live levels (?shop=<shop_id> for one shop); PUT sets absolute levels.
  // Product ids are unique across shops, so PUT needs no shop.
  router.get('/stock', async (req, res) => {
    const shop = typeof req.query.shop === 'string' ? req.query.shop : undefined;
    if (shop !== undefined && !orders.shop(shop)) {
      res.status(404).json({ error: 'shop_not_found', shops: orders.listShops().map((s) => s.id) });
      return;
    }
    res.json({ products: stockRows(await orders.listProducts(shop)) });
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
    res.json({ products: stockRows(await orders.listProducts()) });
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
    const { items, shop_id: shopId, note, simulate_decline: simulateDecline = false } = parsed.data;
    const result = await orders.createOrder({ items }, { simulateDecline, ...(shopId ? { shopId } : {}), ...(note ? { note } : {}) });
    if (!result.ok) {
      res.status(422).json({ error: 'cannot_price_cart', issues: result.issues });
      return;
    }
    res.status(201).json({ ...orders.view(result.order), simulate_decline: result.order.simulateDecline });
  });

  router.get('/orders/:id', async (req, res) => {
    const order = await orders.refresh(req.params.id);
    if (!order) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    // Webhook evidence is for scripts (T1b), not part of the agent-facing view.
    res.json({
      ...orders.view(order),
      webhooks_received: orders.webhookEventsFor(order.id),
      sellers_pinged: order.sellersPinged,
      seller_ping_pending: order.pingPending,
    });
  });

  router.post('/orders/:id/capture', async (req, res) => {
    if (!(await orders.get(req.params.id))) {
      res.status(404).json({ error: 'order_not_found' });
      return;
    }
    const result = await orders.capture(req.params.id, 'api');
    res.json({ outcome: result.outcome, order: orders.view(result.order) });
  });

  return router;
}
