-- 010 — the DURABLE gap ledger (Task D), plus the stream-identity column the
-- subscribe/replay paradigm needs to name WHY a cursor died.
--
-- Until now, gap detection was per-process: a connector noticed that its cursor had
-- aged out of the source's retention window, printed the loss, and forgot it on exit.
-- Two things were wrong with that. Reconcile-as-gate became timing-dependent — whether
-- a permanent loss failed the run depended on whether the same PROCESS had run the
-- fallback. And alerting had to key on a log line instead of on state.
--
-- This table is the state. It is deliberately shaped for BOTH loss-bearing paradigms
-- (phase plan §3 consequence 2 — the pipeline's two admitted data-loss boundaries):
--   · stripefeed: a cursor older than the feed's 30-day retention window (cause
--     'retention'; from_event_id is the last event we actually ingested, to_occurred_at
--     is the earliest event the feed still retains).
--   · casebus: a replay id outside the bus's 72-hour window (cause 'retention') OR
--     invalidated by a stream reset regardless of age (cause 'reset' — the vendor
--     documents the reset but publishes no distinguishing error code, so the connector
--     derives the cause from the stream identity, which is why cursors remember it).
-- Each paradigm fills the bounds it can honestly express; the rest stay NULL. A NULL
-- here means "not knowable", never "zero" — the same discipline as the mart's
-- missing-vs-zero rule.
--
-- ACKNOWLEDGEMENT is the point of the ack columns. A gap is permanent by definition:
-- no retry closes it, so a reconcile that fails forever on it would train operators to
-- stop reading reconcile. Instead reconcile fails on any UNACKNOWLEDGED gap and passes
-- once an operator acknowledges it — loud exactly once, then a standing, disclosed,
-- still-listed condition. The operator path is `src/cli/gap-ack.ts` (RUNBOOK).
create table if not exists ingest.gap_ledger (
  id             bigint generated always as identity primary key,
  tenant_id      uuid not null default '00000000-0000-0000-0000-000000000000',
  source         text not null,
  -- The two honest boundaries, as a closed vocabulary rather than free text: a cause
  -- nobody can enumerate is a cause nobody can alert on.
  cause          text not null check (cause in ('retention', 'reset')),
  -- Near edge: the last event this (tenant, source) verifiably ingested before the loss.
  -- NULL when there was no prior cursor at all (a reset on a first-ever subscribe).
  from_event_id  text,
  from_occurred_at timestamptz,
  -- Far edge: the earliest event the source still retains at detection time. NULL when
  -- the source retained nothing — the loss has no knowable near edge on that side.
  to_event_id    text,
  to_occurred_at timestamptz,
  detected_at    timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,
  note           text
);

-- ONE permanent loss is ONE row, however many times it is re-detected: a cron loop that
-- re-runs catchUp every minute must not manufacture a row per minute for a single loss.
-- Identity is (tenant, source, cause, from_event_id) — cause is IN the key because the
-- same cursor genuinely can be lost to a reset after being lost to age-out, and those
-- are different facts. coalesce() rather than `nulls not distinct` so the uniqueness
-- holds on every supported server version: in SQL, NULL <> NULL, which would let an
-- unknown-near-edge gap duplicate without bound.
create unique index if not exists uq_gap_ledger_identity
  on ingest.gap_ledger (tenant_id, source, cause, coalesce(from_event_id, ''));

-- The operator's and reconcile's read path: this source's open losses, newest first.
create index if not exists ix_gap_ledger_open
  on ingest.gap_ledger (tenant_id, source, acknowledged_at, detected_at desc);

-- Same tenant posture as every ingest table (006): app-role access + forced RLS with the
-- documented unset-context fallback.
grant select, insert, update, delete on ingest.gap_ledger to switchboard_app;

alter table ingest.gap_ledger enable row level security;
alter table ingest.gap_ledger force row level security;
drop policy if exists tenant_isolation on ingest.gap_ledger;
create policy tenant_isolation on ingest.gap_ledger
  using (
    coalesce(current_setting('switchboard.tenant_id', true), '') = ''
    or tenant_id::text = current_setting('switchboard.tenant_id', true)
  )
  with check (
    coalesce(current_setting('switchboard.tenant_id', true), '') = ''
    or tenant_id::text = current_setting('switchboard.tenant_id', true)
  );

-- The subscribe/replay paradigm's cause detection is STRUCTURAL, not a vendor hint: an
-- aged-out replay id and a reset-away replay id are byte-identical on the wire (verified
-- against the vendor's error table — one code, `…replayid.corrupted`, for both). The one
-- honest signal is the stream's identity, because the documented root cause of a reset is
-- the org being moved to a new instance. So a cursor row remembers which stream its
-- replay id belongs to; a changed stream identity at invalidation time means 'reset', an
-- unchanged one means 'retention'. Additive and idempotent, exactly like 008: no other
-- source reads this column.
alter table ingest.cursors add column if not exists stream_id text;
