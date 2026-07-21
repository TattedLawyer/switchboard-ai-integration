delete from raw.raw_crm_events a using raw.raw_crm_events b
  where a.event_id = b.event_id and a.id > b.id;
create unique index if not exists uq_raw_crm_events_event_id on raw.raw_crm_events (event_id);
create schema if not exists ingest;
create table if not exists ingest.outbox (
  id bigserial primary key, event_id text not null,
  created_at timestamptz not null default now(), processed_at timestamptz);
create table if not exists ingest.cursors (
  source text primary key, last_seq bigint not null default 0,
  updated_at timestamptz not null default now());
create table if not exists ingest.quarantine (
  id bigserial primary key, payload jsonb not null, reason text not null,
  received_at timestamptz not null default now(), replayed_at timestamptz);
