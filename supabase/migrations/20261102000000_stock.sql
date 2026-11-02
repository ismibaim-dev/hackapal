-- hackapal stock levels. Product definitions and prices stay in src/catalog.ts; only the
-- live stock count lives here, so it survives restarts. Rows are seeded by the server
-- (insert ... on conflict do nothing) from the catalog's initial stock.
--
-- Stock is taken once per order line through public.take_stock, which records a
-- movement keyed by (order_id, product_id). A repeated call for the same order line
-- (webhook redelivery, a second code path, a restart mid-way) changes nothing.
-- Server-only, like public.orders: RLS on, no policies, no grants for anon/authenticated.

create table if not exists public.stock (
  product_id  text primary key,
  stock       integer not null check (stock >= 0),
  updated_at  timestamptz not null default now()
);

create table if not exists public.stock_movements (
  order_id    text not null,
  product_id  text not null references public.stock (product_id),
  quantity    integer not null check (quantity > 0),
  -- Units we could not cover (oversold). 0 in the normal case.
  short_by    integer not null default 0 check (short_by >= 0),
  created_at  timestamptz not null default now(),
  primary key (order_id, product_id)
);

alter table public.stock enable row level security;
alter table public.stock_movements enable row level security;
revoke all on table public.stock, public.stock_movements from anon, authenticated;

-- Takes stock for one order line, at most once. Money has already moved when this runs,
-- so it never refuses: it clamps at zero and reports any shortfall.
create or replace function public.take_stock(p_order_id text, p_product_id text, p_quantity integer)
returns table (remaining integer, short_by integer, applied boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_before integer;
  v_short  integer;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be a positive whole number' using errcode = '22023';
  end if;

  -- Lock the stock row first so concurrent takes for the same product serialise.
  select s.stock into v_before from public.stock s where s.product_id = p_product_id for update;
  if not found then
    raise exception 'unknown product %', p_product_id using errcode = 'P0002';
  end if;

  v_short := greatest(p_quantity - v_before, 0);
  insert into public.stock_movements (order_id, product_id, quantity, short_by)
  values (p_order_id, p_product_id, p_quantity, v_short)
  on conflict (order_id, product_id) do nothing;

  if not found then
    -- Already taken for this order line: report the current level, change nothing.
    return query
      select v_before, m.short_by, false
      from public.stock_movements m
      where m.order_id = p_order_id and m.product_id = p_product_id;
    return;
  end if;

  update public.stock s
     set stock = greatest(v_before - p_quantity, 0), updated_at = now()
   where s.product_id = p_product_id;

  return query select greatest(v_before - p_quantity, 0), v_short, true;
end;
$$;

revoke execute on function public.take_stock(text, text, integer) from public, anon, authenticated;
grant execute on function public.take_stock(text, text, integer) to service_role;
