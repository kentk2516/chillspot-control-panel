-- CHILL SPOT: WATI conversation state
create table if not exists public.wati_conversations (
  id uuid primary key default gen_random_uuid(),
  wa_id text not null unique,
  channel_phone_number text,
  language text not null default 'en',
  status text not null default 'collecting',
  bike_type text,
  bike_quantity integer,
  pickup_time text,
  return_time text,
  child_seat boolean,
  helmet boolean,
  last_inbound_text text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists wati_conversations_updated_at_idx
  on public.wati_conversations(updated_at desc);

alter table public.wati_conversations enable row level security;

-- No public policies: this table is server-only and is accessed with service_role.
