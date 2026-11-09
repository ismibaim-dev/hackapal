-- Durable record of which sellers were told about a paid order, so a failed Telegram ping
-- is retried instead of only being logged. One order can pay several sellers (combined
-- checkout), so sellers_pinged lists the shop ids already reached.
--
-- ping_pending is true from COMPLETED until every paid seller is pinged (or retries run out);
-- the server's retry sweep reads only those rows, through the partial index below.
-- Safe to run while the server is live: every column has a default.

alter table public.orders
  add column if not exists sellers_pinged text[] not null default '{}',
  add column if not exists ping_pending boolean not null default false,
  add column if not exists ping_attempts integer not null default 0 check (ping_attempts >= 0);

create index if not exists orders_ping_pending_idx
  on public.orders (created_at)
  where ping_pending;
