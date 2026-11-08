// Probe (design decision 18): can ONE PayPal order pay TWO sellers? Two purchase units, each
// with its own payee: Auntie's Kitchen (the app's own account) and Kampung Fresh Mart (the
// second sandbox merchant). If PayPal accepts and captures it without partner onboarding, a
// single checkout link for a multi-shop cart is possible.
//
//   npm run probe-multi-payee                       (create; prints the approval link)
//   npm run probe-multi-payee -- --capture <id>     (after the buyer approves)
//   npm run probe-multi-payee -- --capture <id> --wait
//   npm run probe-multi-payee -- --show <id>
//
// Raw REST JSON on purpose, so the exact request is visible. The live shop never sees this order.
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { hasPayPalCredentials, loadConfig, loadDotEnv } from '../src/config.js';
import { PayPalClient } from '../src/paypal.js';

const API = 'https://api-m.sandbox.paypal.com';
const SECOND_MERCHANT = 'sb-cjqou53656464@business.example.com';
const { values } = parseArgs({
  options: { capture: { type: 'string' }, show: { type: 'string' }, wait: { type: 'boolean', default: false } },
});

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (!hasPayPalCredentials(config)) throw new Error('PAYPAL_CLIENT_ID/SECRET not set');
  const pp = new PayPalClient({ clientId: config.paypal.clientId!, clientSecret: config.paypal.clientSecret! });
  const call = async (method: string, path: string, body?: unknown) => {
    const token = (await pp.auth.getToken()).value;
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(method === 'POST' ? { 'PayPal-Request-Id': `probe-multi-${randomUUID()}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, debugId: res.headers.get('paypal-debug-id'), body: (await res.json().catch(() => ({}))) as any };
  };
  const report = (label: string, r: { status: number; debugId: string | null; body: any }) => {
    const units = (r.body.purchase_units ?? []).map((u: any) => ({
      reference_id: u.reference_id,
      payee: u.payee,
      amount: u.amount?.value,
      captures: (u.payments?.captures ?? []).map((c: any) => ({
        id: c.id,
        status: c.status,
        net: c.seller_receivable_breakdown?.net_amount?.value,
        fee: c.seller_receivable_breakdown?.paypal_fee?.value,
      })),
    }));
    console.log(JSON.stringify({ step: label, http: r.status, debug_id: r.debugId, status: r.body.status, name: r.body.name, details: r.body.details, units }, null, 2));
  };

  if (values.show) return report('show', await call('GET', `/v2/checkout/orders/${values.show}`));

  if (values.capture) {
    if (values.wait) {
      const deadline = Date.now() + 3 * 3600_000;
      for (;;) {
        const r = await call('GET', `/v2/checkout/orders/${values.capture}`);
        if (r.body.status === 'APPROVED') break;
        if (r.body.status === 'COMPLETED' || r.body.status === 'VOIDED') throw new Error(`order is already ${r.body.status}`);
        if (Date.now() > deadline) throw new Error('gave up waiting for approval');
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
      console.log(`approved at ${new Date().toISOString()}`);
    }
    return report('capture', await call('POST', `/v2/checkout/orders/${values.capture}/capture`, {}));
  }

  const unit = (referenceId: string, brand: string, sku: string, name: string, value: string, payee?: string) => ({
    reference_id: referenceId,
    description: `${brand} (multi-payee probe)`,
    custom_id: `probe-multi-${referenceId}`,
    ...(payee ? { payee: { email_address: payee } } : {}),
    amount: { currency_code: 'USD', value, breakdown: { item_total: { currency_code: 'USD', value } } },
    items: [{ name, sku, quantity: '1', unit_amount: { currency_code: 'USD', value }, category: 'PHYSICAL_GOODS' }],
  });
  const created = await call('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      unit('aunties-kitchen', "Auntie's Kitchen", 'choc-chip-cookies', 'Chocolate chip cookies', '6.00'),
      unit('kampung-fresh-mart', 'Kampung Fresh Mart', 'eggs-30', 'Grade A eggs', '5.50', SECOND_MERCHANT),
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'hackapal',
          user_action: 'PAY_NOW',
          shipping_preference: 'NO_SHIPPING',
          return_url: `${config.publicBaseUrl}/health`,
          cancel_url: `${config.publicBaseUrl}/health`,
        },
      },
    },
  });
  report('create', created);
  const link = (created.body.links ?? []).find((l: any) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
  if (link) console.log(`\nApprove as the sandbox BUYER: ${link}\nThen: npm run probe-multi-payee -- --capture ${created.body.id} --wait`);
}

main().catch((err: unknown) => {
  console.error(`probe-multi-payee failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
