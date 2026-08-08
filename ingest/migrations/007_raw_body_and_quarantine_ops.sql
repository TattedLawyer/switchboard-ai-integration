-- 007 — raw-body custody (2b-D4 expand phase), quarantine replay accounting (register C4),
-- and the FOR ROLE default-privilege correction (register C2). All additive and idempotent.

-- ── raw.raw_events.raw_body ──────────────────────────────────────────────────────────────
-- The EXPAND phase of the raw-storage parallel change (2b-D4): exact wire bytes when the
-- door has them; NULL when the paradigm provides none (legacy poll feed); connector-canonical
-- JSON when the connector is the event's origin (Sheets, Task A4). The CONTRACT step
-- (claim-check enqueue, nullable payload) is Phase 4 — this column must not change any
-- existing read path.
alter table raw.raw_events add column if not exists raw_body text;

-- ── ingest.quarantine replay accounting (C4) ─────────────────────────────────────────────
-- Replay must record that it was TRIED, not only that it succeeded: without a trace, a
-- permanently-unreplayable row is retried forever and an operator cannot answer the question
-- dead-letter handling exists to answer — has this been tried, and is it safely replayable?
-- attempts counts every replay attempt (successful or still-invalid); last_attempt_at is
-- when the most recent one happened. Existing rows adopt 0/NULL: honestly untried.
alter table ingest.quarantine add column if not exists attempts integer not null default 0;
alter table ingest.quarantine add column if not exists last_attempt_at timestamptz;

-- ── C2: default privileges with an EXPLICIT target role ──────────────────────────────────
-- PostgreSQL's ALTER DEFAULT PRIVILEGES binds to the CURRENT role when FOR ROLE is omitted
-- (target-role scoping is explicit — see KNOWN-ISSUES), so the dynamic grant in
-- migrate.ts::grantAgentReadOnly only governs objects created by whichever role happened to
-- run the migration. In a split-role deploy (migrating role ≠ the role that creates marts),
-- that silently covers nothing and the agent hits a bare 42501 on the next dbt rebuild.
-- Pin the target role explicitly to `switchboard` — the role dbt connects as in every
-- shipped configuration (docker-compose DBT_USER) and the same role migration 006 already
-- names in its FOR ROLE grants — so the grant survives being applied by any migrator.
--
-- Scoped to `public_analytics`, the documented DBT_SCHEMA default, created here so the
-- privileges can attach before dbt's first build (same reasoning as grantAgentReadOnly).
-- Disclosed residual: a deployment that BOTH overrides DBT_SCHEMA AND migrates under a
-- different role still depends on the runtime grant in migrate.ts; a static migration
-- cannot name a schema that is runtime config.
create schema if not exists public_analytics;
grant usage on schema public_analytics to switchboard_agent;
alter default privileges for role switchboard in schema public_analytics
  grant select on tables to switchboard_agent;
