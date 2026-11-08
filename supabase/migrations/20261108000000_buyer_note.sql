-- hackapal: the buyer's note for the seller (delivery time window, gate code, unit number),
-- passed by the agent at create_order and shown only in the seller's ping. Optional, short,
-- plain text. The server keeps taking orders (without the note) until this has run.
alter table public.orders
  add column if not exists buyer_note text
  check (buyer_note is null or char_length(buyer_note) <= 300);

comment on column public.orders.buyer_note is 'Buyer''s note for the seller (max 300 chars); shown in the seller ping only.';
