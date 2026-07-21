# Switchboard

> **Status: work in progress** — Phase 0 (walking skeleton) is being built in the open.
> The commit history *is* part of the artifact: spec → adversarial design review →
> revised spec → implementation plan → TDD commits.

Switchboard is a forward-deployed-engineering case study built end-to-end in public:
three disconnected SaaS systems (CRM, billing, support) are integrated into a unified,
AI-ready data model with a bounded, auditable AI agent on top — the three-problem stack
that mid-market and enterprise teams most often get stuck on.

**The customer is simulated** (a fictional ~200-person B2B services company, "Meridian
Works") and **all data is synthetic** — `DEMO-` prefixed entities, `@example.com`
emails, enforced by hygiene tests. Real client work can't be published; the point here
is measured engineering results on a system you can run yourself.

## Architecture (three layers on a reliability spine)

1. **Integration** — TypeScript ingestion service consuming webhooks + backfill from
   chaos-enabled mock SaaS APIs, with idempotency keys, transactional outbox,
   dead-letter queue + replay CLI, and a quarantine table for schema drift.
2. **Unification** — dbt models resolving mismatched identities across systems into a
   `customer_360` mart, with data-quality tests gating CI.
3. **Agent** — an MCP server (TypeScript SDK) exposing read tools plus exactly one
   approval-gated write action, driven by a scheduled host worker that generates the
   Monday revenue-risk report. Action-safety evals run in CI.

Every event the mocks emit is written to an append-only ledger first, so "zero lost
events under injected faults" is a reproducible reconciliation test, not a claim.

## Read the trail

- [Design spec (rev 2)](docs/superpowers/specs/2026-07-21-switchboard-design.md) —
  architecture, decisions, and what was deliberately cut
- [Phase 0 implementation plan](docs/superpowers/plans/2026-07-21-phase0-walking-skeleton.md) —
  8 TDD tasks, test-first
- Phase 0 exit criterion: `./scripts/demo.sh` runs the entire skeleton end-to-end from
  one command (works without any API key — deterministic fallback).

## Stack

TypeScript / Node 22 · Postgres · pg-boss · dbt · MCP (Model Context Protocol) ·
Anthropic SDK · OpenTelemetry + Grafana (Phase 4) · Docker Compose
