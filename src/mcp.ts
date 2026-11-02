import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { log } from './log.js';
import { formatUsd } from './money.js';
import { toOrderView, type OrderService } from './orders.js';
import { PayPalHttpError } from './paypal-http.js';
import { CartInputSchema } from './pricing.js';
import { ORDER_STATUSES } from './store.js';

/**
 * The "robot door": an MCP server (Streamable HTTP, stateless) that lets an AI
 * assistant browse the shop and start a PayPal checkout for a human buyer.
 * Shares OrderService with the PayPal routes, so prices still come only from the
 * catalog and statuses follow the same rules.
 */

const SERVER_INFO = { name: 'hackapal', version: '0.1.0' };

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function toolError(message: string, details?: unknown): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: details === undefined ? message : `${message}\n${JSON.stringify(details, null, 2)}` }],
  };
}

export function createMcpServer(orders: OrderService): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions:
      "This is Auntie's Kitchen, a small home bakery. Use list_products to see what's for sale, " +
      'create_order to start a PayPal checkout for the buyer, and get_order_status to check payment. ' +
      'Only the human buyer can pay, by opening the PayPal link. Never say an order is paid unless ' +
      'get_order_status returns status COMPLETED.',
  });

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description:
        "Lists everything Auntie's Kitchen sells: product ids, names, what one unit is, USD prices and how many " +
        'are in stock, plus how the buyer receives the order. Call this before create_order and use the ' +
        'product_id values exactly as returned. Prices are fixed by the shop.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const shop = orders.catalog.shop;
      let products;
      try {
        products = await orders.listProducts();
      } catch (err) {
        log.error('mcp list_products failed', { err });
        return toolError("The shop can't read its stock right now. Try again shortly.");
      }
      return json({
        shop: { name: shop.name, description: shop.description, fulfilment: shop.fulfilment, currency: shop.currency },
        products: products.map((p) => ({
          product_id: p.id,
          name: p.name,
          description: p.description,
          unit: p.unit,
          price: formatUsd(p.priceCents),
          price_cents: p.priceCents,
          in_stock: p.stock,
        })),
      });
    },
  );

  server.registerTool(
    'create_order',
    {
      title: 'Create order',
      description:
        'Creates an order and a PayPal checkout for the buyer. Before calling it, confirm the items, quantities ' +
        'and the total (from list_products) with the buyer. The shop prices the order itself; you cannot set ' +
        'prices. Returns the order id, the itemised total and an approval_url. Give the approval_url to the ' +
        'buyer: only the human buyer can pay, by opening it and approving in PayPal. Creating the order does ' +
        'NOT mean it is paid. Never tell the buyer it is paid; check with get_order_status.',
      inputSchema: CartInputSchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ items }) => {
      try {
        const result = await orders.createOrder({ items });
        if (!result.ok) {
          return toolError('The order could not be priced. Fix these items and try again.', result.issues);
        }
        const view = toOrderView(result.order);
        return json({
          ...view,
          next_step:
            `Give the buyer this PayPal link to pay ${view.total}: ${view.approval_url} . ` +
            'After they approve, call get_order_status with this order_id. It is not paid until status is COMPLETED.',
        });
      } catch (err) {
        log.error('mcp create_order failed', { err });
        return toolError(
          err instanceof PayPalHttpError
            ? `PayPal could not create the checkout right now (debug_id ${err.debugId ?? 'n/a'}). Nothing was charged. Try again shortly.`
            : 'The shop could not create the order right now. Nothing was charged. Try again shortly.',
        );
      }
    },
  );

  server.registerTool(
    'get_order_status',
    {
      title: 'Get order status',
      description:
        `Checks an order's payment status with PayPal. Status is one of ${ORDER_STATUSES.join(', ')}. ` +
        'Only COMPLETED means paid. CREATED or CANCELLED: the buyer still needs to open approval_url and ' +
        'approve. NEEDS_NEW_FUNDING: the payment method was declined; the buyer must open approval_url again ' +
        'and choose another way to pay. PAYMENT_PENDING: PayPal is holding the payment; check again later. ' +
        'FAILED: cannot be paid; start a new order if the buyer still wants it. Follow status_message.',
      inputSchema: { order_id: z.string().trim().min(1).max(64).describe('order_id returned by create_order') },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ order_id }) => {
      try {
        const order = await orders.refresh(order_id);
        if (!order) return toolError(`No order with id "${order_id}". Use the order_id returned by create_order.`);
        const { paypal_order_id: _paypal, ...view } = toOrderView(order);
        return json(view);
      } catch (err) {
        log.error('mcp get_order_status failed', { order_id, err });
        return toolError('Could not reach PayPal to check this order right now. Try again shortly; do not assume it is paid.');
      }
    },
  );

  return server;
}

function methodNotAllowed(res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
}

/** POST /mcp: stateless Streamable HTTP, a new server and transport per request. */
export function mcpRoutes({ orders }: { orders: OrderService }): Router {
  const router = Router();

  router.post('/mcp', express.json({ limit: '64kb' }), async (req, res) => {
    const server = createMcpServer(orders);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('mcp request failed', { err });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  router.get('/mcp', (_req, res) => methodNotAllowed(res));
  router.delete('/mcp', (_req, res) => methodNotAllowed(res));

  return router;
}
