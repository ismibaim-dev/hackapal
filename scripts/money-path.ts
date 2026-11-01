// Test 1: drive a sandbox order through our server: create -> buyer approves in PayPal ->
// capture, then wait for the PAYMENT.CAPTURE.COMPLETED webhook as evidence for T1b.
//
//   npm run money-path -- --base-url https://<service>.onrender.com
//   npm run money-path -- --base-url https://<service>.onrender.com --simulate-decline
//
// It talks to our server over HTTP (/api/orders), never to PayPal directly: each process
// has its own in-memory store, so the order must live where the webhooks arrive.
import { parseArgs } from 'node:util';

interface OrderView {
  order_id: string;
  status: string;
  status_message: string;
  approval_url?: string;
  total: string;
  paypal_order_id: string;
  capture_id: string | null;
  simulate_decline?: boolean;
  webhooks_received?: { event_id: string | null; event_type: string; received_at: string }[];
}

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:3000' },
    'simulate-decline': { type: 'boolean', default: false },
    quantity: { type: 'string', default: '2' },
    'timeout-min': { type: 'string', default: '15' },
    'webhook-wait-sec': { type: 'string', default: '120' },
  },
});

const baseUrl = String(values['base-url']).replace(/\/+$/, '');
const simulateDecline = Boolean(values['simulate-decline']);
const quantity = Number(values.quantity);
const deadline = Date.now() + Number(values['timeout-min']) * 60_000;
const webhookWaitMs = Number(values['webhook-wait-sec']) * 1000;
const POLL_MS = 3_000;
/** Approved at PayPal but not captured for this long: ask the server to capture. */
const NUDGE_AFTER_MS = 45_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (msg: string) => console.log(`[${stamp()}] ${msg}`);

async function api<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep text
  }
  return { status: res.status, body: body as T };
}

async function main(): Promise<void> {
  say(`server ${baseUrl}`);
  const health = await api<{ paypal?: { credentialsConfigured?: boolean; webhookConfigured?: boolean } }>('/health');
  if (health.status !== 200) throw new Error(`/health answered ${health.status}`);
  say(
    `health ok; PayPal credentials ${health.body.paypal?.credentialsConfigured ? 'set' : 'MISSING'}, webhook ${health.body.paypal?.webhookConfigured ? 'set' : 'MISSING'}`,
  );

  const created = await api<OrderView & { error?: string }>('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ product_id: 'choc-chip-cookies', quantity }],
      ...(simulateDecline ? { simulate_decline: true } : {}),
    }),
  });
  if (created.status !== 201) throw new Error(`create failed: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  const order = created.body;
  say(`created ${order.order_id} (PayPal ${order.paypal_order_id}), total ${order.total}, status ${order.status}`);
  if (simulateDecline) say(`simulate_decline: ${order.simulate_decline ? 'on (first capture will be declined)' : 'IGNORED by server'}`);
  console.log(`\n  Open this link and approve as the sandbox BUYER:\n\n  ${order.approval_url}\n`);
  if (simulateDecline) {
    console.log('  After approving, PayPal will send you back to choose another way to pay. Approve again.\n');
  }

  const path: string[] = [order.status];
  let last: OrderView = order;
  let approvedSince: number | undefined;
  let nudged = false;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const res = await api<OrderView>(`/api/orders/${order.order_id}`);
    if (res.status !== 200) {
      say(`status check failed: HTTP ${res.status} ${JSON.stringify(res.body)}`);
      continue;
    }
    last = res.body;
    if (last.status !== path.at(-1)) {
      path.push(last.status);
      say(`status ${last.status}: ${last.status_message}`);
    }
    if (last.status === 'COMPLETED' || last.status === 'FAILED') break;

    if (last.status === 'APPROVED') {
      approvedSince ??= Date.now();
      if (!nudged && Date.now() - approvedSince > NUDGE_AFTER_MS) {
        nudged = true;
        say('approved but not captured yet; asking the server to capture');
        const cap = await api<{ outcome: string }>(`/api/orders/${order.order_id}/capture`, { method: 'POST' });
        say(`capture request: HTTP ${cap.status} ${JSON.stringify(cap.body)}`);
      }
    } else {
      approvedSince = undefined;
    }
  }

  console.log('');
  say(`final status ${last.status}; path ${path.join(' -> ')}`);
  say(`order ${last.order_id}, PayPal order ${last.paypal_order_id}, capture ${last.capture_id ?? 'none'}`);
  if (last.status !== 'COMPLETED') {
    process.exitCode = 1;
    return;
  }

  // T1b evidence: wait for the verified PAYMENT.CAPTURE.COMPLETED webhook (sandbox delivery takes 10-75 s+).
  say(`waiting up to ${webhookWaitMs / 1000}s for the PAYMENT.CAPTURE.COMPLETED webhook...`);
  const webhookDeadline = Date.now() + webhookWaitMs;
  let events: NonNullable<OrderView['webhooks_received']> = [];
  while (Date.now() < webhookDeadline) {
    events = (await api<OrderView>(`/api/orders/${order.order_id}`)).body.webhooks_received ?? [];
    if (events.some((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED')) break;
    await sleep(POLL_MS);
  }
  for (const e of events) say(`webhook verified: ${e.event_type} ${e.event_id ?? ''} at ${e.received_at}`);
  if (!events.some((e) => e.event_type === 'PAYMENT.CAPTURE.COMPLETED')) {
    say('no PAYMENT.CAPTURE.COMPLETED webhook yet. Check the webhook URL/ID and the Render logs ("webhook").');
    process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  console.error(`money-path failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
