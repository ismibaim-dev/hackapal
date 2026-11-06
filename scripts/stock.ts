// Seller restock: show live stock, or set absolute levels, on a running server.
//
//   npm run stock -- --base-url https://hackapal.onrender.com
//   npm run stock -- --base-url https://hackapal.onrender.com --set choc-chip-cookies=50 --set kuih-lapis=30
//
// Needs the server's API_KEY: --api-key <key>, or HACKAPAL_API_KEY in the env or .env.
// Levels are absolute (50 means "now 50 in stock"), so running it twice is harmless.
import { parseArgs } from 'node:util';
import { loadDotEnv } from '../src/config.js';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    set: { type: 'string', multiple: true, default: [] },
    'api-key': { type: 'string' },
  },
});

loadDotEnv();
const baseUrl = String(values['base-url']).replace(/\/+$/, '');
const apiKey = values['api-key'] ?? process.env.HACKAPAL_API_KEY ?? process.env.API_KEY;

type StockReply = { products?: { product_id: string; name: string; in_stock: number }[]; error?: string; issues?: unknown };

function parseLevels(pairs: string[]): Record<string, number> {
  const levels: Record<string, number> = {};
  for (const pair of pairs) {
    const match = /^([a-z0-9-]+)=(\d+)$/.exec(pair.trim());
    if (!match) throw new Error(`--set expects product-id=number, got "${pair}"`);
    levels[match[1]!] = Number(match[2]);
  }
  return levels;
}

async function main(): Promise<void> {
  if (!apiKey) throw new Error('no API key: pass --api-key or set HACKAPAL_API_KEY (Render > hackapal > Environment > API_KEY)');
  const levels = parseLevels(values.set ?? []);
  const setting = Object.keys(levels).length > 0;
  const res = await fetch(`${baseUrl}/api/stock`, {
    method: setting ? 'PUT' : 'GET',
    headers: { authorization: `Bearer ${apiKey}`, ...(setting ? { 'content-type': 'application/json' } : {}) },
    ...(setting ? { body: JSON.stringify({ levels }) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as StockReply;
  if (res.status === 401) throw new Error('the server refused the API key');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body.issues ?? body.error ?? body)}`);
  console.log(setting ? 'Stock updated. Live levels now:' : 'Live stock:');
  for (const p of body.products ?? []) console.log(`  ${p.product_id.padEnd(20)} ${String(p.in_stock).padStart(4)}  ${p.name}`);
}

main().catch((err: unknown) => {
  console.error(`stock failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
