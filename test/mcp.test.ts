import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createCatalog } from '../src/catalog.js';
import { loadConfig } from '../src/config.js';
import { OrderService } from '../src/orders.js';
import { InMemoryOrderStore } from '../src/store.js';
import { FakePayPal } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

async function start() {
  const config = loadConfig({ PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret', PUBLIC_BASE_URL: 'https://shop.example' });
  const paypal = new FakePayPal();
  const store = new InMemoryOrderStore();
  const orders = new OrderService({ catalog: createCatalog(), store, paypal, publicBaseUrl: config.publicBaseUrl, allowSimulatedDecline: true });
  const app = createApp({ config, orders, paypal });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  cleanups.push(async () => {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { base, client, paypal, store };
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };
const parse = (r: unknown) => JSON.parse((r as ToolResult).content[0]!.text) as Record<string, any>;

describe('/mcp', () => {
  it('lists the three tools with descriptions written for an agent', async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['create_order', 'get_order_status', 'list_products']);
    const create = tools.find((t) => t.name === 'create_order')!;
    expect(create.description).toMatch(/only the human buyer can pay/i);
    expect(create.description).toMatch(/never tell the buyer it is paid/i);
    expect(Object.keys((create.inputSchema as { properties: object }).properties)).toEqual(['items']);
  });

  it('list_products returns the shop, prices and stock', async () => {
    const { client } = await start();
    const body = parse(await client.callTool({ name: 'list_products', arguments: {} }));
    expect(body.shop.name).toBe("Auntie's Kitchen");
    expect(body.products).toContainEqual(
      expect.objectContaining({ product_id: 'choc-chip-cookies', price: '$6.00', price_cents: 600, in_stock: 24 }),
    );
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
