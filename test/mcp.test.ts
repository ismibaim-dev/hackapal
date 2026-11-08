import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { OrderService } from '../src/orders.js';
import { createPlatform } from '../src/platform.js';
import { InMemoryOrderStore } from '../src/store.js';
import { FakePayPal } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

/** The demo marketplace. `path` picks the endpoint: /mcp or /s/<shop_id>/mcp. */
async function start(path = '/mcp') {
  const config = loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://shop.example' });
  const paypal = new FakePayPal();
  const store = new InMemoryOrderStore();
  const orders = new OrderService({ platform: createPlatform(), store, paypal, publicBaseUrl: config.publicBaseUrl, allowSimulatedDecline: true });
  const app = createApp({ config, orders, paypal });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`)));
  cleanups.push(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base, client, paypal, store };
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const parse = (r: unknown) => JSON.parse((r as ToolResult).content[0]!.text) as Record<string, any>;

describe('/mcp (marketplace)', () => {
  it('lists four tools with descriptions written for an agent', async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_order', 'get_order_status', 'list_products', 'list_shops']);
    const create = tools.find((t) => t.name === 'create_order')!;
    expect(create.description).toMatch(/only the human buyer can pay/i);
    expect(create.description).toMatch(/never tell the buyer it is paid/i);
    expect(create.description).toMatch(/may mix shops/i);
    expect(Object.keys((create.inputSchema as { properties: object }).properties)).toEqual(['shop_id', 'items', 'note']);
  });

  it('list_shops returns every shop without the sellers\' PayPal accounts', async () => {
    const { client } = await start();
    const result = (await client.callTool({ name: 'list_shops', arguments: {} })) as ToolResult;
    const body = parse(result);
    expect(body.shops.map((s: { shop_id: string }) => s.shop_id)).toEqual(['aunties-kitchen', 'kampung-fresh-mart', 'kilat-home-cleaning']);
    expect(body.shops[1]).toMatchObject({ name: 'Kampung Fresh Mart', category: 'Groceries', products: 6 });
    expect(result.content[0]!.text).not.toContain('@');
  });

  it('list_products returns one shop with shop_id, or every shop without it', async () => {
    const { client } = await start();
    const one = parse(await client.callTool({ name: 'list_products', arguments: { shop_id: 'aunties-kitchen' } }));
    expect(one.shop.name).toBe("Auntie's Kitchen");
    expect(one.products).toContainEqual(
      expect.objectContaining({ product_id: 'choc-chip-cookies', price: '$6.00', price_cents: 600, in_stock: 24 }),
    );
    expect(one.products.map((p: { product_id: string }) => p.product_id)).not.toContain('eggs-30');

    const all = parse(await client.callTool({ name: 'list_products', arguments: {} }));
    expect(all.shops).toHaveLength(3);
    expect(all.shops[2].products).toContainEqual(expect.objectContaining({ product_id: 'deep-clean-6h', price: '$120.00' }));

    const unknown = (await client.callTool({ name: 'list_products', arguments: { shop_id: 'nope' } })) as ToolResult;
    expect(unknown.isError).toBe(true);
  });

  it("create_order pays the shop's own PayPal account and brands the checkout with its name", async () => {
    const { client, paypal } = await start();
    const body = parse(
      await client.callTool({
        name: 'create_order',
        arguments: { shop_id: 'kampung-fresh-mart', items: [{ product_id: 'eggs-30', quantity: 2 }] },
      }),
    );
    expect(body).toMatchObject({ status: 'CREATED', total: '$11.00', shop: { shop_id: 'kampung-fresh-mart', name: 'Kampung Fresh Mart' } });
    expect(body.next_step).toContain('Kampung Fresh Mart');
    expect(paypal.createCalls[0]).toMatchObject({ brandName: 'Kampung Fresh Mart', payeeEmail: 'sb-cjqou53656464@business.example.com' });
  });

  it('create_order passes the buyer note to the seller, and asks PayPal for the address', async () => {
    const { client, paypal } = await start();
    const body = parse(
      await client.callTool({
        name: 'create_order',
        arguments: { shop_id: 'kampung-fresh-mart', items: [{ product_id: 'veg-bundle', quantity: 1 }], note: 'After 6pm please' },
      }),
    );
    expect(body.note).toBe('After 6pm please');
    expect(paypal.createCalls[0]?.collectAddress).toBe(true);
    const tooLong = (await client.callTool({
      name: 'create_order',
      arguments: { items: [{ product_id: 'veg-bundle', quantity: 1 }], note: 'x'.repeat(301) },
    })) as ToolResult;
    expect(tooLong.isError).toBe(true);
  });

  it('create_order puts a cart from two shops in one checkout, and points at the right shop when shop_id excludes an item', async () => {
    const { client, paypal } = await start();
    const mixed = (await client.callTool({
      name: 'create_order',
      arguments: { items: [{ product_id: 'eggs-30', quantity: 1 }, { product_id: 'kuih-lapis', quantity: 1 }] },
    })) as ToolResult;
    expect(mixed.isError).toBeFalsy();
    const body = parse(mixed);
    expect(body).toMatchObject({ total: '$13.50', status: 'CREATED' });
    expect(body.shops).toEqual([
      { shop_id: 'kampung-fresh-mart', name: 'Kampung Fresh Mart', total: '$5.50' },
      { shop_id: 'aunties-kitchen', name: "Auntie's Kitchen", total: '$8.00' },
    ]);
    expect(body.next_step).toContain('in one checkout');
    expect(paypal.createCalls).toHaveLength(1);
    paypal.createCalls.length = 0;

    const foreign = (await client.callTool({
      name: 'create_order',
      arguments: { shop_id: 'aunties-kitchen', items: [{ product_id: 'eggs-30', quantity: 1 }] },
    })) as ToolResult;
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toContain('sold by Kampung Fresh Mart');
    expect(paypal.createCalls).toHaveLength(0);
  });

  it('create_order prices from the catalog only and returns the approval link', async () => {
    const { client, paypal } = await start();
    const result = await client.callTool({
      name: 'create_order',
      arguments: { items: [{ product_id: 'choc-chip-cookies', quantity: 2, price: 0.01 }] },
    });
    expect((result as ToolResult).isError).toBeFalsy();
    const body = parse(result);
    expect(body).toMatchObject({ status: 'CREATED', total: '$12.00', total_cents: 1200 });
    expect(body.approval_url).toMatch(/^https:\/\/www\.sandbox\.paypal\.com\//);
    expect(body.next_step).toContain(body.approval_url);
    expect(paypal.createCalls[0]?.quote.totalCents).toBe(1200);
  });

  it('create_order reports pricing problems as a tool error without calling PayPal', async () => {
    const { client, paypal } = await start();
    const result = (await client.callTool({
      name: 'create_order',
      arguments: { items: [{ product_id: 'caviar', quantity: 1 }] },
    })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('UNKNOWN_PRODUCT');
    expect(paypal.createCalls).toHaveLength(0);
  });

  it('get_order_status follows the order to COMPLETED after the buyer approves', async () => {
    const { client, paypal } = await start();
    const created = parse(await client.callTool({ name: 'create_order', arguments: { items: [{ product_id: 'kuih-lapis', quantity: 1 }] } }));
    const before = parse(await client.callTool({ name: 'get_order_status', arguments: { order_id: created.order_id } }));
    expect(before.status).toBe('CREATED');
    expect(before).not.toHaveProperty('paypal_order_id');

    paypal.approve(created.paypal_order_id);
    const after = parse(await client.callTool({ name: 'get_order_status', arguments: { order_id: created.order_id } }));
    expect(after).toMatchObject({ status: 'COMPLETED', total: '$8.00' });
    expect(after.status_message).toMatch(/^Paid\./);
    expect(after).not.toHaveProperty('approval_url');
  });

  it('get_order_status on an unknown id is a tool error', async () => {
    const { client } = await start();
    const result = (await client.callTool({ name: 'get_order_status', arguments: { order_id: 'ord_nope' } })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it('answers 405 to GET and DELETE', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
    expect((await fetch(`${base}/mcp`, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('/s/<shop_id>/mcp (one shop)', () => {
  it("offers only that shop's tools and products", async () => {
    const { client } = await start('/s/kilat-home-cleaning/mcp');
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_order', 'get_order_status', 'list_products']);
    const create = tools.find((t) => t.name === 'create_order')!;
    expect(Object.keys((create.inputSchema as { properties: object }).properties)).toEqual(['items', 'note']);
    const body = parse(await client.callTool({ name: 'list_products', arguments: {} }));
    expect(body.shop.delivery_address).toMatch(/enters it in PayPal/);
    expect(body.shop).toMatchObject({ shop_id: 'kilat-home-cleaning', category: 'Home cleaning' });
    expect(body.products.map((p: { product_id: string }) => p.product_id)).toEqual([
      'standard-clean-3h',
      'deep-clean-6h',
      'move-out-clean',
      'sofa-shampoo',
    ]);
  });

  it("refuses other shops' products and doesn't answer for their orders", async () => {
    const { client, base } = await start('/s/aunties-kitchen/mcp');
    const foreign = (await client.callTool({ name: 'create_order', arguments: { items: [{ product_id: 'sofa-shampoo', quantity: 1 }] } })) as ToolResult;
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]!.text).toContain('Kilat Home Cleaning');

    const other = new Client({ name: 'test', version: '0.0.0' });
    await other.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const created = parse(await other.callTool({ name: 'create_order', arguments: { items: [{ product_id: 'sofa-shampoo', quantity: 1 }] } }));
    await other.close();
    const status = (await client.callTool({ name: 'get_order_status', arguments: { order_id: created.order_id } })) as ToolResult;
    expect(status.isError).toBe(true);
  });

  it('answers 404 for an unknown shop', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/s/nope/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    expect((await fetch(`${base}/s/aunties-kitchen/mcp`)).status).toBe(405);
  });
});
