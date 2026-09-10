-- CHILL SPOT: migrate WATI conversation flow to plan-based rentals
alter table public.wati_conversations
  add column if not exists rental_plan text,
  add column if not exists unit_price integer,
  add column if not exists total_price integer;

-- return_time remains in the table and is now calculated by the server from plan + pickup time.
