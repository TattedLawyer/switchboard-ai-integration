# Switchboard — FDE Portfolio Flagship: Design Spec

**Date:** 2026-07-21
**Status:** Draft — awaiting Michael's approval
**Author:** Claude (brainstormed with Michael)

## 1. Purpose

A single, comprehensive, public portfolio artifact that demonstrates the full Forward
Deployed Engineer loop — discovery, architecture, deployment, evaluation, operations —
on the problem stack that 2026 demand research shows both mid-market and enterprise
buyers are stuck on:

1. Systems that don't talk (78% of enterprises struggle to connect AI tools to
   existing systems — Zapier survey, Oct 2025; ~60% of AI leaders cite legacy
   integration as the primary agentic-AI blocker — IBM).
2. Data that isn't AI-ready (Gartner: 60% of AI projects abandoned through 2026 for
   lack of AI-ready data).
3. No trusted way to put an agent on top (manual reporting/analytics is the single
   most-validated mid-market pain point — BigIdeasDB 148K-complaint study).

Anthropic's own FDE job posting lists the target deliverables verbatim: MCP servers
and sub-agents for production workflows, evaluation frameworks, TypeScript/Python.
Switchboard produces exactly those artifacts.

## 2. The Fictional Customer

**Meridian Works** — a fictional ~200-person B2B services company running three
disconnected SaaS systems (all simulated locally with synthetic data):

- **CRM** (HubSpot-shaped): companies, contacts, deals, owners
- **Billing** (Stripe/QuickBooks-shaped): customers, invoices, payments, credit notes
- **Support** (Zendesk-shaped): tickets, satisfaction ratings, SLA timers

Pain narrative (mirrors the researched pain points): the Monday revenue-risk report
takes an ops person ~4 hours of manual cross-referencing; customer IDs don't match
across systems; churn signals live in support but nobody in finance sees them.

## 3. Architecture — three layers on a reliability spine

```
[Mock CRM]   [Mock Billing]   [Mock Support]     ← chaos-enabled mock SaaS harness
     │ webhooks + polling backfill │
     ▼                             ▼
┌───────────────────────────────────────────┐
│ LAYER 1: Ingestion service (TypeScript)   │  idempotency keys, retry w/ backoff+jitter,
│ Postgres raw tables + pg-boss queue       │  transactional outbox, dead-letter queue,
└───────────────────────────────────────────┘  per-source cursors
     ▼
┌───────────────────────────────────────────┐
│ LAYER 2: Unification (dbt-core)           │  staging → identity resolution →
│ customer_360 marts + data-quality tests   │  dedupe; dbt tests gate every build
└───────────────────────────────────────────┘
     ▼
┌───────────────────────────────────────────┐
│ LAYER 3: MCP server + agent (TS SDK)      │  read tools over customer_360;
│ + eval suite + human-approval gate        │  ONE bounded write action; audit log
└───────────────────────────────────────────┘
     ▼
 Observability: OpenTelemetry → Grafana dashboard + alerts
```

### Layer 0 — Chaos-enabled mock SaaS harness
Three small Express services with seeded synthetic data (deterministic seed),
realistic pagination, webhook delivery, and **injectable faults**: dropped webhooks,
duplicate deliveries, 429s, 5xxs, out-of-order events, schema drift. The harness is
itself portfolio evidence: it lets the write-up *demonstrate* recovery, not claim it.

Fixture hygiene (hard rule): zero real PII. `@example.com` emails only, `DEMO-`
prefixed names, all-zero UUID ranges, no realistic phone/SSN patterns. A hygiene
test greps fixtures for violations.

### Layer 1 — Ingestion / integration
- TypeScript + Node, Postgres for raw event/entity tables.
- **pg-boss** for the queue (Postgres-backed: one datastore, exactly-once-ish
  semantics, retention). Trade-off vs BullMQ/Redis documented in an ADR; Temporal
  cited as the "at scale you'd reach for this" comparison.
- Reliability spine, hand-built deliberately (the point is to show understanding):
  idempotency keys on every write; exponential backoff + jitter; transactional
  outbox for downstream signals; dead-letter queue with a replay CLI; per-source
  sync cursors for backfill vs streaming.

### Layer 2 — Unification (AI-ready data)
- **dbt-core**: raw → staging → `customer_360` marts.
- Identity resolution across mismatched IDs (email/domain/fuzzy-name match with
  explicit precedence rules), dedupe, survivorship rules.
- dbt tests (uniqueness, referential integrity, freshness, accepted ranges) run in
  CI and gate the build. Great Expectations noted as optional extension.

### Layer 3 — Bounded MCP agent
- MCP server via the official TypeScript SDK (pattern-matched against
  modelcontextprotocol/servers reference implementations).
- **Read tools:** account health lookup, revenue-risk query, cohort summaries.
- **One bounded write action:** `flag_account_for_review` — creates a review task
  with evidence attached. Requires human approval (approval-gate table + CLI/simple
  UI), writes an append-only audit log. The agent owns a complete decision that
  ends cleanly; it does not free-form mutate systems.
- **Killer demo:** the Monday revenue-risk report generated automatically (the #1
  validated mid-market pain), with links back to underlying unified records.
- **Eval suite:** golden question/answer set over seeded data; action-safety tests
  (agent must decline out-of-scope writes); regression-run in CI with score
  thresholds. This matches the "evaluation frameworks" requirement in FDE postings.

### Observability & ops
- OpenTelemetry instrumentation → Grafana (Cloud free tier or docker-compose'd
  Grafana+Prometheus locally). Dashboard: sync lag, DLQ depth, dedupe rate,
  webhook failure/retry rates, agent eval scores, approval rate.
- At least one alert rule (DLQ depth > threshold).
- Docker Compose for the full stack; GitHub Actions CI (typecheck, unit +
  integration tests, dbt build + tests, agent evals).
- Deploy target: Fly.io or Railway (long-running workers; Vercel is a poor fit for
  queue consumers). Decision deferred to implementation, captured as ADR.

## 4. Measurable outcomes to instrument (before/after)

| Metric | Before (simulated baseline) | After |
|---|---|---|
| Monday revenue-risk report | ~4 hrs manual, 12 steps | generated automatically, 0 manual steps |
| Cross-system sync lag | batch/manual (days) | seconds (measured p50/p95) |
| Duplicate customer records | seeded ~8% dupe rate | measured post-resolution rate |
| Injected-fault recovery | n/a | 0 lost events at N% webhook failure (chaos run) |
| Agent quality | n/a | eval score ≥ threshold, 100% out-of-scope writes declined |

## 5. Repo & write-up structure

```
switchboard/
  README.md              ← the case study: problem, role, architecture diagram,
                            stack, metrics table, post-launch evolution
  docs/
    adr/                 ← queue choice, identity-resolution rules, deploy target
    superpowers/specs/   ← this spec; later phase plans
  mocks/                 ← Layer 0 harness (3 services + seed + chaos config)
  ingest/                ← Layer 1 service
  warehouse/             ← Layer 2 dbt project
  agent/                 ← Layer 3 MCP server + evals
  ops/                   ← docker-compose, grafana dashboards, CI
```

## 6. Phases (each = its own implementation plan, TDD throughout)

- **Phase 0:** Scaffold, mock harness + seeded data + fault injection. Exit: chaos
  run reproducible from one command.
- **Phase 1:** Ingestion + reliability spine. Exit: chaos run with zero data loss;
  DLQ replay works.
- **Phase 2:** dbt unification + quality tests. Exit: customer_360 builds green;
  dupe metric measured.
- **Phase 3:** MCP agent + approval gate + eval suite. Exit: evals pass in CI;
  Monday report demo.
- **Phase 4:** Observability, deploy, README case study, demo script/video. Exit:
  live URL + dashboard screenshot + final metrics table.

## 7. Explicitly out of scope (YAGNI)

- No real third-party SaaS credentials or OAuth flows (mock harness instead).
- No multi-tenant auth product; basic auth on exposed endpoints only.
- No front-end app beyond a minimal approval/report view.
- No Temporal/Airbyte/Nango dependency — they are comparison points in ADRs, not
  the deliverable (a portfolio must show the reliability layer built, not bought).
- No second (health-domain) case study yet — possible follow-on, separate project.

## 8. Open questions (defaults chosen, flag if wrong)

1. **Language split:** all-TypeScript (Michael's stack) incl. MCP server; Python
   only inside dbt tooling. Default: yes.
2. **LLM for the agent + evals:** Claude via Anthropic SDK (with prompt caching).
   Default: yes.
3. **Public repo name:** `switchboard` (rename trivial before publishing).
