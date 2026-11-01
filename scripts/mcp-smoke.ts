// Test 2a: connect to our MCP endpoint as a client, list the tools, call
// list_products and create_order, and print the PayPal approval link.
//
//   npm run mcp-smoke -- https://hackapal.onrender.com/mcp
//   npm run mcp-smoke                    (defaults to http://localhost:3000/mcp)
//
// It creates a real sandbox order; nothing is charged unless someone approves the link.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

const url = new URL(process.argv[2] ?? 'http://localhost:3000/mcp');
const text = (r: unknown) => (r as ToolResult).content.map((c) => c.text ?? '').join('\n');

async function main(): Promise<void> {
  const client = new Client({ name: 'hackapal-mcp-smoke', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  try {
    const server = client.getServerVersion();
    console.log(`connected to ${url} (${server?.name} ${server?.version})`);

    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

    const products = JSON.parse(text(await client.callTool({ name: 'list_products', arguments: {} })));
    for (const p of products.products) console.log(`  ${p.product_id}: ${p.name}, ${p.price} per ${p.unit}, ${p.in_stock} in stock`);

    const result = await client.callTool({
      name: 'create_order',
      arguments: { items: [{ product_id: 'choc-chip-cookies', quantity: 2 }] },
    });
    if ((result as ToolResult).isError) throw new Error(`create_order failed: ${text(result)}`);
    const order = JSON.parse(text(result));
    console.log(`create_order: ${order.order_id}, status ${order.status}, total ${order.total}`);
    console.log(`approval link: ${order.approval_url}`);

    const status = JSON.parse(text(await client.callTool({ name: 'get_order_status', arguments: { order_id: order.order_id } })));
    console.log(`get_order_status: ${status.status}`);
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`mcp-smoke failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
