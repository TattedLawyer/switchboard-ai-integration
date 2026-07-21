create schema if not exists raw;
create table if not exists raw.raw_crm_events (
  id bigserial primary key,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
