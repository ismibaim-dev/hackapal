import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SupabaseOrderStore } from '../src/supabase-store.js';

/** A chainable stand-in for supabase-js: records each query and answers from a script. */
function fakeClient(script: Array<{ data: unknown; error: unknown }>) {
  const queries: { method: string; args: unknown[] }[][] = [];
  const client = {
    from() {
      const ops: { method: string; args: unknown[] }[] = [];
      queries.push(ops);
      const builder: Record<string, unknown> = {};
      for (const method of ['select', 'update', 'insert', 'eq', 'order', 'limit', 'single', 'maybeSingle']) {
        builder[method] = (...args: unknown[]) => {
          ops.push({ method, args });
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => void) => resolve(script.shift() ?? { data: null, error: null });
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, queries };
}

const ROW = {
  id: 'ord_abcdefghjkmn',
  paypal_order_id: 'PP-1',
  approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=PP-1',
  currency: 'USD',
  items: [],
  total_cents: 600,
  status: 'COMPLETED',
  capture_id: 'CAP-1',
  capture_attempts: 0,
  simulate_decline: false,
  created_at: '2026-11-10T00:00:00+00:00',
  updated_at: '2026-11-10T00:00:00+00:00',
};
const MISSING = { code: 'PGRST204', message: "Could not find the 'ping_pending' column of 'orders' in the schema cache" };

describe('SupabaseOrderStore before the seller-ping migration has run', () => {
  it('still saves the status change, then stops sending ping columns', async () => {
    const { client, queries } = fakeClient([
      { data: null, error: MISSING },
      { data: ROW, error: null },
      { data: ROW, error: null },
    ]);
    const store = new SupabaseOrderStore({ url: 'https://x.supabase.co', secretKey: 'k', client });
    const order = await store.update(ROW.id, { status: 'COMPLETED', captureId: 'CAP-1', pingPending: true });
    expect(order).toMatchObject({ status: 'COMPLETED', sellersPinged: [], pingPending: false, pingAttempts: 0 });
    const sent = (q: number) => queries[q]!.find((op) => op.method === 'update')!.args[0] as Record<string, unknown>;
    expect(sent(0)).toMatchObject({ status: 'COMPLETED', ping_pending: true });
    expect(sent(1)).not.toHaveProperty('ping_pending');
    expect(sent(1)).toMatchObject({ status: 'COMPLETED', capture_id: 'CAP-1' });

    // Later writes skip the columns straight away, and the sweep finds nothing to do.
    await store.update(ROW.id, { sellersPinged: ['aunties-kitchen'] });
    expect(queries).toHaveLength(3);
    expect(await store.listPingsPending(10)).toEqual([]);
    expect(queries).toHaveLength(3);
  });

  it('a missing column on the sweep query means no pending pings, not an error', async () => {
    const { client } = fakeClient([{ data: null, error: MISSING }]);
    const store = new SupabaseOrderStore({ url: 'https://x.supabase.co', secretKey: 'k', client });
    expect(await store.listPingsPending(10)).toEqual([]);
  });

  it('other update errors still throw', async () => {
    const { client } = fakeClient([{ data: null, error: { code: '23514', message: 'check violation' } }]);
    const store = new SupabaseOrderStore({ url: 'https://x.supabase.co', secretKey: 'k', client });
    await expect(store.update(ROW.id, { pingAttempts: 1 })).rejects.toThrow('check violation');
  });
});
