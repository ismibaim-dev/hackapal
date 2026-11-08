import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { log } from './log.js';
import { formatUsd } from './money.js';
import type { ShopInfo } from './catalog.js';
import { MAX_NOTE_LENGTH, type OrderService } from './orders.js';
import { PayPalHttpError } from './paypal-http.js';
import type { ShopProduct } from './platform.js';
import { RateLimiter } from './rate-limit.js';
import { CartInputSchema, type CartInput } from './pricing.js';
import { ORDER_STATUSES } from './store.js';

/**
 * The "robot door": an MCP server (Streamable HTTP, stateless) that lets an AI
 * assistant browse the shops and start a PayPal checkout for a human buyer.
 * /mcp serves the whole marketplace; /s/<shop_id>/mcp serves one shop, for a seller
 * who wants a link of their own. Shares OrderService with the PayPal routes, so prices
 * still come only from the catalogs and statuses follow the same rules.
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

/**
 * Limits for the public storefront. /mcp has no login (any buyer's assistant must reach
 * it), so these stop a runaway client or spammer from flooding it or mass-creating
 * PayPal orders. Creating an order moves no money and takes no stock.
 */
export interface McpLimits {
  /** MCP HTTP requests per client IP. */
  requestsPerIp: RateLimiter;
  /** create_order calls per client IP. */
  ordersPerIp: RateLimiter;
  /** create_order calls across all clients. */
  ordersGlobal: RateLimiter;
}

export function defaultMcpLimits(): McpLimits {
  return {
    requestsPerIp: new RateLimiter({ limit: 120, windowMs: 60_000 }),
    ordersPerIp: new RateLimiter({ limit: 20, windowMs: 10 * 60_000 }),
    ordersGlobal: new RateLimiter({ limit: 60, windowMs: 10 * 60_000 }),
  };
}

export interface McpServerOptions {
  /** Who is calling (client IP), for the order limits. */
  clientKey?: string;
  limits?: McpLimits;
  /** Scope the server to one shop (/s/:shopId/mcp). Omitted: the whole marketplace (/mcp). */
  shopId?: string;
}

function shopView(shop: Readonly<ShopInfo>) {
  return {
    shop_id: shop.id,
    name: shop.name,
    category: shop.category,
    area: shop.area,
    description: shop.description,
    fulfilment: shop.fulfilment,
    delivery_address: shop.collectsAddress
      ? 'The buyer enters it in PayPal at checkout. Do not ask for it in the chat.'
      : 'Not collected: pickup or arranged with the seller after payment.',
    currency: shop.currency,
  };
}

function productView(p: ShopProduct) {
  return {
    product_id: p.id,
    name: p.name,
    description: p.description,
    unit: p.unit,
    price: formatUsd(p.priceCents),
    price_cents: p.priceCents,
    in_stock: p.stock,
  };
}

const PAY_RULE =
  'Only the human buyer can pay, by opening the PayPal link. Never say an order is paid unless ' +
  'get_order_status returns status COMPLETED.';

export function createMcpServer(orders: OrderService, options: McpServerOptions = {}): McpServer {
  const clientKey = options.clientKey ?? 'unknown';
  const scoped = options.shopId === undefined ? undefined : orders.shop(options.shopId);
  if (options.shopId !== undefined && !scoped) throw new Error(`Unknown shop: ${options.shopId}`);

  const server = new McpServer(SERVER_INFO, {
    instructions: scoped
      ? `This is ${scoped.name} (${scoped.category}, ${scoped.area}). ${scoped.description} ` +
        "Use list_products to see what's for sale, create_order to start a PayPal checkout for the buyer, " +
        `and get_order_status to check payment. ${PAY_RULE}`
      : 'hackapal is a marketplace of small local sellers who take payment through PayPal. Use list_shops ' +
        'to see the shops, list_products to see what a shop sells, create_order to start a PayPal checkout ' +
        `for the buyer (one order per shop; each seller is paid directly), and get_order_status to check payment. ${PAY_RULE}`,
  });

  async function readProducts(shopId?: string): Promise<ShopProduct[] | CallToolResult> {
    try {
      return await orders.listProducts(shopId);
    } catch (err) {
      log.error('mcp list_products failed', { err });
      return toolError("The shop can't read its stock right now. Try again shortly.");
    }
  }

  if (!scoped) {
    server.registerTool(
      'list_shops',
      {
        title: 'List shops',
        description:
          'Lists the shops on this marketplace: shop_id, name, what kind of seller it is, where it operates, how ' +
          'the buyer receives the order, and how many products it has. Use a shop_id with list_products and create_order.',
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async () => {
        const products = await readProducts();
        if (!Array.isArray(products)) return products;
        return json({
          shops: orders.listShops().map((shop) => {
            const own = products.filter((p) => p.shopId === shop.id);
            return { ...shopView(shop), products: own.length, in_stock: own.filter((p) => p.stock > 0).length };
          }),
        });
      },
    );
  }

  const noteInput = z
    .string()
    .trim()
    .max(MAX_NOTE_LENGTH)
    .optional()
    .describe(
      `Optional note from the buyer to the seller, up to ${MAX_NOTE_LENGTH} characters: delivery time window, unit or gate number, ` +
        'what the cleaner should focus on. Only what the buyer said; never payment details. The address itself is entered in PayPal.',
    );

  const shopIdInput = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('shop_id from list_shops');

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description: scoped
        ? `Lists everything ${scoped.name} sells: product ids, names, what one unit is, USD prices and how many ` +
          'are in stock, plus how the buyer receives the order. Call this before create_order and use the ' +
          'product_id values exactly as returned. Prices are fixed by the shop.'
        : "Lists a shop's products: product ids, names, what one unit is, USD prices and how many are in stock, " +
          'plus how the buyer receives the order. Pass shop_id for one shop, or leave it out to list every shop. ' +
          'Call this before create_order and use the product_id values exactly as returned. Prices are fixed by each shop.',
      ...(scoped ? {} : { inputSchema: { shop_id: shopIdInput.optional() } }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args: { shop_id?: string }) => {
      const shopId = scoped?.id ?? args.shop_id;
      if (shopId !== undefined && !orders.shop(shopId)) {
        return toolError(`Unknown shop_id "${shopId}". Call list_shops for the valid ids.`);
      }
      const products = await readProducts(shopId);
      if (!Array.isArray(products)) return products;
      const forShop = (shop: Readonly<ShopInfo>) => ({
        shop: shopView(shop),
        products: products.filter((p) => p.shopId === shop.id).map(productView),
      });
      if (shopId !== undefined) return json(forShop(orders.shop(shopId)!));
      return json({ shops: orders.listShops().map(forShop) });
    },
  );

  server.registerTool(
    'create_order',
    {
      title: 'Create order',
      description:
        'Creates an order and a PayPal checkout for the buyer. Before calling it, confirm the items, quantities ' +
        'and the total (from list_products) with the buyer. ' +
        (scoped ? '' : 'One order holds items from one shop only; the seller is paid directly through PayPal. ') +
        'The shop prices the order itself; you cannot set prices. If the buyer mentions delivery timing or instructions for ' +
        'the seller, pass them as note. Shops that deliver ask for the address in PayPal, so do not collect it in the chat. ' +
        'Returns the order id, the itemised total and an ' +
        'approval_url. Give the approval_url to the buyer: only the human buyer can pay, by opening it and ' +
        'approving in PayPal. Creating the order does NOT mean it is paid. Never tell the buyer it is paid; ' +
        'check with get_order_status.',
      inputSchema: scoped
        ? { ...CartInputSchema.shape, note: noteInput }
        : {
            shop_id: shopIdInput.optional().describe('shop_id from list_shops. Recommended; if left out, the shop of the items is used.'),
            ...CartInputSchema.shape,
            note: noteInput,
          },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: { shop_id?: string; items: CartInput['items']; note?: string }) => {
      const limits = options.limits;
      if (limits) {
        const perIp = limits.ordersPerIp.hit(clientKey);
        const global = perIp.allowed ? limits.ordersGlobal.hit('global') : perIp;
        if (!perIp.allowed || !global.allowed) {
          log.warn('mcp create_order rate limited', { client: clientKey, scope: perIp.allowed ? 'global' : 'ip' });
          return toolError(
            `The shop is taking too many new orders right now. Nothing was created or charged. ` +
              `Try again in about ${global.retryAfterSeconds} seconds.`,
          );
        }
      }
      const shopId = scoped?.id ?? args.shop_id;
      try {
        const result = await orders.createOrder(
          { items: args.items },
          { ...(shopId === undefined ? {} : { shopId }), ...(args.note ? { note: args.note } : {}) },
        );
        if (!result.ok) {
          return toolError('The order could not be created. Fix these issues and try again.', result.issues);
        }
        const view = orders.view(result.order);
        return json({
          ...view,
          next_step:
            `Give the buyer this PayPal link to pay ${view.total} to ${result.shop.name}: ${view.approval_url} . ` +
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
      const notFound = toolError(`No order with id "${order_id}". Use the order_id returned by create_order.`);
      try {
        // A shop's own endpoint only answers for that shop's orders.
        const existing = await orders.get(order_id);
        if (!existing || (scoped && orders.shopForOrder(existing)?.id !== scoped.id)) return notFound;
        const order = await orders.refresh(order_id);
        if (!order) return notFound;
        const { paypal_order_id: _paypal, ...view } = orders.view(order);
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

const MCP_PATHS = ['/mcp', '/s/:shopId/mcp'];

/** POST /mcp and /s/:shopId/mcp: stateless Streamable HTTP, a new server and transport per request. */
export function mcpRoutes({ orders, limits = defaultMcpLimits() }: { orders: OrderService; limits?: McpLimits }): Router {
  const router = Router();

  router.post(MCP_PATHS, (req, res, next) => {
    // Checked before parsing the body, so a flood costs as little as possible.
    const verdict = limits.requestsPerIp.hit(req.ip ?? 'unknown');
    if (verdict.allowed) {
      next();
      return;
    }
    log.warn('mcp request rate limited', { ip: req.ip });
    res
      .status(429)
      .set('Retry-After', String(verdict.retryAfterSeconds))
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many requests. Slow down.' }, id: null });
  });

  router.post(MCP_PATHS, express.json({ limit: '64kb' }), async (req, res) => {
    const param = (req.params as Record<string, unknown>).shopId;
    const shopId = typeof param === 'string' ? param : undefined;
    if (shopId !== undefined && !orders.shop(shopId)) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: `Unknown shop "${shopId}". The marketplace endpoint /mcp lists every shop.` },
        id: null,
      });
      return;
    }
    const server = createMcpServer(orders, { clientKey: req.ip ?? 'unknown', limits, ...(shopId ? { shopId } : {}) });
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
  router.get(MCP_PATHS, (_req, res) => methodNotAllowed(res));
  router.delete(MCP_PATHS, (_req, res) => methodNotAllowed(res));

  return router;
}
