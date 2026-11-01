-- hackapal order store. One row per order; mirrors src/store.ts (Order).
-- Only the server touches this table, with the project's secret key, which bypasses
-- row level security. RLS is on with no policies, and anon/authenticated get no grants,
-- so the publishable key can never read or write orders.

create table if not exists public.orders (
  id                text primary key check (id ~ '^ord_[0-9a-z]{12}$'),
  paypal_order_id   text not null unique,
  approval_url      text not null,
  currency          text not null check (currency = 'USD'),
  items             jsonb not null check (jsonb_typeof(items) = 'array'),
  total_cents       integer not null check (total_cents >= 0),
  status            text not null default 'CREATED' check (status in
                      ('CREATED', 'APPROVED', 'PAYMENT_PENDING', 'COMPLETED',
                       'NEEDS_NEW_FUNDING', 'CANCELLED', 'FAILED')),
  capture_id        text,
  capture_attempts  integer not null default 0 check (capture_attempts >= 0),
  simulate_decline  boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.orders is 'hackapal orders (server-only; prices in integer cents).';

alter table public.orders enable row level security;
revoke all on table public.orders from anon, authenticated;
