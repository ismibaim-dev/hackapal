// Option B probe (design decision 16): can our REST app create and capture an order whose
// funds go to ANOTHER sandbox merchant via purchase_units[0].payee?
//
//   npm run probe-payee -- --payee seller@business.example.com     (create, prints link)
//   npm run probe-payee -- --capture <PayPal order id>            (after the buyer approves)
//   npm run probe-payee -- --capture <PayPal order id> --wait     (poll until approved, then capture)
//   npm run probe-payee -- --show <PayPal order id>               (read-only: status, payee, amounts)
//
// Talks to PayPal directly with our sandbox credentials; the live shop never sees this order.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { createCatalog } from '../src/catalog.js';
import { hasPayPalCredentials, loadConfig, loadDotEnv } from '../src/config.js';
import { PayPalClient } from '../src/paypal.js';
import { PAYPAL_SANDBOX_API } from '../src/paypal-http.js';
import { priceCart } from '../src/pricing.js';

const { values } = parseArgs({
  options: { payee: { type: 'string' }, capture: { type: 'string' }, wait: { type: 'boolean', default: false }, show: { type: 'string' } },
});

async function showOrder(pp: PayPalClient, id: string): Promise<void> {
  const token = await pp.auth.getToken();
  const res = await fetch(`${PAYPAL_SANDBOX_API}/v2/checkout/orders/${id}`, { headers: { Authorization: `Bearer ${token.value}` } });
  const o = (await res.json()) as any;
  const pu = o.purchase_units?.[0] ?? {};
  const cap = pu.payments?.captures?.[0];
  console.log(JSON.stringify({
    http: res.status,
    status: o.status,
    payee: pu.payee,
    capture: cap && { id: cap.id, status: cap.status, gross: cap.seller_receivable_breakdown?.gross_amount, fee: cap.seller_receivable_breakdown?.paypal_fee, net: cap.seller_receivable_breakdown?.net_amount },
    debug_id: res.headers.get('paypal-debug-id'),
  }, null, 2));
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (!hasPayPalCredentials(config)) throw new Error('PAYPAL_CLIENT_ID/SECRET not set');
  const pp = new PayPalClient({ clientId: config.paypal.clientId!, clientSecret: config.paypal.clientSecret! });

  if (values.show) {
    // Read-only: print an order's status, payee and capture amounts.
    await showOrder(pp, values.show);
    return;
  }
  if (values.capture && values.wait) {
    // Poll until the buyer approves (up to 3 hours), then capture.
    const deadline = Date.now() + 3 * 3600_000;
    for (;;) {
      const status = (await pp.getOrder(values.capture)).status;
      if (status === 'APPROVED') break;
      if (status === 'COMPLETED' || status === 'VOIDED') throw new Error(`order is already ${status}`);
      if (Date.now() > deadline) throw new Error('gave up waiting for approval');
      await new Promise((r) => setTimeout(r, 10_000));
    }
    console.log(`approved at ${new Date().toISOString()}`);
  }
  if (values.capture) {
    const captured = await pp.captureOrder(values.capture, { requestId: `probe-capture-${values.capture}` });
    console.log('capture:', JSON.stringify(captured));
    await showOrder(pp, values.capture);
    return;
  }
  if (!values.payee) throw new Error('pass --payee <email> or --capture <order id>');
  const priced = priceCart(createCatalog(), { items: [{ product_id: 'choc-chip-cookies', quantity: 1 }] });
  if (!priced.ok) throw new Error('pricing failed');
  const created = await pp.createOrder({
    orderId: `probe-${randomUUID().slice(0, 8)}`,
    quote: priced.quote,
    brandName: 'hackapal payee probe',
    returnUrl: 'https://hackapal.onrender.com/health',
    cancelUrl: 'https://hackapal.onrender.com/health',
    payeeEmail: values.payee,
  });
  console.log(`created ${created.id} (${created.status}) with payee ${values.payee}`);
  await showOrder(pp, created.id);
  console.log(`\nApprove as the sandbox BUYER: ${created.approvalUrl}\nThen: npm run probe-payee -- --capture ${created.id}`);
}

main().catch((err: unknown) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
