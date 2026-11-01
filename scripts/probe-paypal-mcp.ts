// Phase 4 probe: which tools does PayPal's sandbox MCP server list for our app,
// without and with `x-feature-flags: commerce:true`? Reports whether the commerce
// tools (search_product, create_cart, checkout_cart) appear.
//
// Auth: a plain REST client-credentials token as Bearer, which is what PayPal's own
// AI Toolkit .mcp.json does. Transport: SSE first, Streamable HTTP as a fallback.
//
//   npm run probe-paypal-mcp
//
// Needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (env or .env). Never prints the token.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { hasPayPalCredentials, loadConfig, loadDotEnv } from '../src/config.js';
import { PayPalAuth } from '../src/paypal-auth.js';

const SSE_URL = 'https://mcp.sandbox.paypal.com/sse';
const HTTP_URL = 'https://mcp.sandbox.paypal.com/mcp';
const COMMERCE_TOOLS = ['search_product', 'create_cart', 'checkout_cart'] as const;
const TIMEOUT_MS = 30_000;

interface ProbeResult {
  variant: string;
  transport?: 'sse' | 'streamable-http';
  server?: string;
  tools?: string[];
  errors: string[];
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS / 1000}s`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as Error & { code?: unknown }).code;
  return code !== undefined ? `${err.message} (code ${String(code)})` : err.message;
}

async function listAllTools(transport: Transport, label: string): Promise<{ tools: string[]; server?: string }> {
  const client = new Client({ name: 'hackapal-probe', version: '0.1.0' });
  try {
    await withTimeout(client.connect(transport), `${label} connect`);
    const server = client.getServerVersion();
    const tools: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : {}), `${label} tools/list`);
      tools.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return { tools, server: server ? `${server.name} ${server.version}` : undefined };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Lists tools over one transport. Both transports are probed, since a flag might only be honoured on one. */
async function probe(
  variant: string,
  transport: 'sse' | 'streamable-http',
  token: string,
  extraHeaders: Record<string, string>,
): Promise<ProbeResult> {
  const headers = { Authorization: `Bearer ${token}`, ...extraHeaders };
  const label = `${variant}, ${transport}`;
  try {
    const t =
      transport === 'sse'
        ? new SSEClientTransport(new URL(SSE_URL), { requestInit: { headers } })
        : new StreamableHTTPClientTransport(new URL(HTTP_URL), { requestInit: { headers } });
    const { tools, server } = await listAllTools(t, transport);
    return { variant: label, transport, tools, server, errors: [] };
  } catch (err) {
    return { variant: label, transport, errors: [describe(err)] };
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (!hasPayPalCredentials(config)) {
    console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox) first.');
    process.exitCode = 1;
    return;
  }
  const auth = new PayPalAuth({ clientId: config.paypal.clientId!, clientSecret: config.paypal.clientSecret! });
  const token = await auth.getToken();
  console.log(`Got a sandbox REST token (expires in ${Math.round((token.expiresAt - Date.now()) / 60000)} min).`);

  const flag = { 'x-feature-flags': 'commerce:true' };
  const results: ProbeResult[] = [];
  for (const transport of ['sse', 'streamable-http'] as const) {
    results.push(await probe('without commerce flag', transport, token.value, {}));
    results.push(await probe('with x-feature-flags: commerce:true', transport, token.value, flag));
  }

  let baseline: string[] | undefined;
  for (const r of results) {
    console.log(`\n=== ${r.variant}`);
    for (const e of r.errors) console.log(`  failed: ${e}`);
    if (!r.tools) continue;
    console.log(`  server: ${r.server ?? 'unknown'}`);
    if (!baseline) {
      baseline = r.tools;
      console.log(`  ${r.tools.length} tools: ${[...r.tools].sort().join(', ')}`);
    } else {
      const added = r.tools.filter((t) => !baseline!.includes(t));
      const missing = baseline.filter((t) => !r.tools!.includes(t));
      console.log(
        `  ${r.tools.length} tools; vs the first list: added [${added.join(', ')}], missing [${missing.join(', ')}]`,
      );
    }
    for (const name of COMMERCE_TOOLS) console.log(`  ${name}: ${r.tools.includes(name) ? 'PRESENT' : 'absent'}`);
  }
}

main().catch((err: unknown) => {
  console.error(`probe failed: ${describe(err)}`);
  process.exitCode = 1;
});
