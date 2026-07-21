# Switchboard — FDE Portfolio Flagship: Design Spec

**Date:** 2026-07-21 (rev 2, after adversarial subagent review)
**Status:** Draft — awaiting Michael's approval
**Author:** Claude (brainstormed with Michael; 12 review findings applied)

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

Anthropic's FDE posting lists MCP servers, sub-agents, and evaluation frameworks as
deliverables. Switchboard produces exactly those artifacts.

> **Pre-publish gate:** re-verify every citation above (and the job-posting claim)
> immediately before the repo goes public; stats go in the README only with links.

## 2. The Simulated Customer (disclosed as such)

**Meridian Works** — a *fictional* ~200-person B2B services company running three
disconnected SaaS systems (all simulated locally with synthetic data):

- **CRM** (HubSpot-shaped): companies, contacts, deals, owners
- **Billing** (Stripe/QuickBooks-shaped): customers, invoices, payments, credit notes
- **Support** (Zendesk-shaped): tickets, satisfaction ratings, SLA timers

The README states prominently that the customer is simulated and why (real client
work can't be published). Credibility comes from **measured engineering results on
this system**, never from the fictional narrative.

**Discovery artifact (FDE signal):** a written discovery memo — framed openly as a
simulated engagement — covering stakeholders, constraints, why this scope, and what
was deliberately not built; plus a short "customer conversation" segment in the demo
video explaining how discovery led to the single bounded write action.

## 3. Architecture — three layers + host on a reliability spine

```
[Mock CRM]   [Mock Billing]   [Mock Support]     ← chaos harness: seeded data,
     │  webhooks + polling backfill  │             seeded fault plan, append-only
     ▼                               ▼             emitted-events ledger
┌───────────────────────────────────────────┐
│ LAYER 1: Ingestion service (TypeScript)   │  idempotency keys, transactional
│ Postgres raw tables + pg-boss queue       │  outbox, per-source cursors,
└───────────────────────────────────────────┘  DLQ replay CLI, quarantine table
     ▼
┌───────────────────────────────────────────┐
│ LAYER 2: Unification (dbt-core, sidecar)  │  staging → 3-tier identity
│ customer_360 marts + data-quality tests   │  resolution → dedupe; scheduled
└───────────────────────────────────────────┘  micro-batch every 5 min
     ▼
┌───────────────────────────────────────────┐
│ LAYER 3: MCP server (TS SDK)              │  read tools + ONE approval-gated
│   + HOST: scheduled agent worker          │  write action; audit log; evals
│     (Anthropic SDK, agentic loop)         │
└───────────────────────────────────────────┘
     ▼
 Observability: OpenTelemetry → Grafana dashboard + DLQ-depth alert
 Demo surface: read-only status/report page (the "live URL")
```

### Layer 0 — Chaos-enabled mock SaaS harness
Three small Express services with seeded synthetic data (deterministic seed),
realistic pagination, webhook delivery, and injectable faults: dropped webhooks,
duplicate deliveries, 429s, 5xxs, out-of-order events, schema drift.

**Verification oracle:** the mocks (a) take a **fault-plan seed** so every chaos run
is reproducible, and (b) write an **append-only ledger** of every event emitted. The
chaos exit test is reconciliation — ledger vs. ingested raw tables — from one
command. "Zero lost events" is a test result, not a claim.

Fixture hygiene (hard rule): zero real PII. `@example.com` emails only, `DEMO-`
prefixed names, all-zero UUID ranges, no realistic phone/SSN patterns. A hygiene
test greps fixtures for violations.

### Layer 1 — Ingestion / integration
- TypeScript + Node, Postgres for raw event/entity tables.
- **Build-vs-buy line (stated in code and ADR — this judgment is the FDE signal):**
  - **pg-boss provides:** job scheduling, retry with exponential backoff, DLQ
    mechanics, queue storage (Postgres-backed: one datastore).
  - **Hand-built:** idempotency keys on every write, transactional outbox,
    per-source sync cursors (backfill vs streaming), the **DLQ replay CLI**, and
    the **quarantine table** for unknown-shape payloads (schema drift → quarantine
    + alert, replay after mapping fix — never silent drop).
  - Temporal cited in the ADR as the "at scale you'd reach for this" comparison.

### Layer 2 — Unification (AI-ready data)
- **dbt-core**: raw → staging → `customer_360` marts.
- **Orchestration (decided):** dbt runs as a Python sidecar container; a pg-boss
  scheduled job triggers `dbt build` every 5 minutes (micro-batch). No TS↔Python
  in-process bridging.
- **Identity resolution — three deterministic tiers, no scoring/ML:**
  1. exact email match → 2. normalized domain + company name → 3. unmatched rows
  land in a manual-review seed table. Record-linkage literature cited in ADR as the
  "at scale" comparison.
- dbt tests (uniqueness, referential integrity, freshness, accepted ranges) run in
  CI and gate the build. Great Expectations noted as optional extension.

### Layer 3 — MCP server + agent host
- **MCP server** via the official TypeScript SDK, pattern-matched against
  modelcontextprotocol/servers reference implementations.
  - **Transports:** stdio for local dev and Claude Desktop demo; **streamable HTTP
    with bearer-token auth** for the deployed instance.
  - **Read tools:** account health lookup, revenue-risk query, cohort summaries.
  - **One bounded write action:** `flag_account_for_review` — creates a review task
    with evidence attached; requires human approval (approval-gate table + minimal
    view); append-only audit log. The agent owns a complete decision that ends
    cleanly; it does not free-form mutate systems.
- **Host (the agent runtime):** a thin scheduled worker using the Anthropic SDK
  (Claude + prompt caching) that runs the agentic loop against the MCP server and
  generates the **Monday revenue-risk report** — the killer demo, linking every
  claim back to unified records.
- **Eval suite, split by determinism:**
  - **Every push (CI-gating):** deterministic action-safety tests — assert which
    tool call the agent *attempts* on golden inputs (mockable), 100% of
    out-of-scope writes declined.
  - **Nightly / on-label (non-gating):** LLM-judged quality evals on a small golden
    Q/A set, pinned model + temperature 0; README reports the latest scored run.
    Rationale: nondeterministic scores must not red-flag unrelated commits, and
    fork PRs can't access API secrets.

### Observability, demo surface & ops
- OpenTelemetry → Grafana (docker-compose'd Grafana+Prometheus locally; Cloud free
  tier if deployed). Dashboard: sync lag, DLQ depth, dedupe rate, webhook
  failure/retry rates, eval scores, approval rate. One alert rule (DLQ depth).
- **Live URL = read-only demo page:** latest Monday report + system-status panel +
  a rate-limited "trigger a chaos run" button. Sized so a hiring manager sees value
  in 60 seconds unattended. The **demo video carries the burden of proof** (chaos
  run, approval flow, Grafana); the URL is a taste, and what stays up long-term is
  decided by hosting cost at Phase 4.
- Docker Compose for the full stack; GitHub Actions CI (typecheck, unit +
  integration tests, dbt build + tests, action-safety evals).
- Deploy target: Fly.io or Railway (long-running workers). ADR at Phase 4.

## 4. Metrics — honest split

**Simulated scenario (illustrative only, labeled as such in README):** the Monday
revenue-risk report at a company like Meridian is a ~4-hour manual cross-referencing
task; Switchboard generates it automatically. No fabricated before/after deltas.

**Measured engineering results (all genuinely instrumented on this system):**

| Metric | How measured |
|---|---|
| Raw-ingest lag (webhook → raw table) | p50/p95, seconds |
| customer_360 freshness | micro-batch cadence, minutes |
| Duplicate rate: seeded ~8% → post-resolution | dbt test output |
| Chaos-run recovery | ledger reconciliation: 0 lost events at seeded fault plan |
| Agent action safety | 100% out-of-scope writes declined (CI) |
| Agent report quality | latest nightly eval score, pinned model |

## 5. Repo & write-up structure

```
switchboard/
  README.md              ← case study: problem, simulated-customer disclosure, role,
                            architecture diagram, stack, measured-results table,
                            post-launch evolution
  docs/
    discovery-memo.md    ← simulated-engagement discovery artifact
    adr/                 ← build-vs-buy line, orchestration, identity tiers, deploy
    log/                 ← engineering journal: one short entry per phase,
                            planned vs. what actually happened
    superpowers/specs/   ← this spec; later phase plans
  mocks/                 ← Layer 0 harness (3 services + seed + fault plans + ledger)
  ingest/                ← Layer 1 service
  warehouse/             ← Layer 2 dbt project (sidecar)
  agent/                 ← Layer 3 MCP server + host worker + evals
  ops/                   ← docker-compose, grafana dashboards, CI
```

## 6. Phases — walking skeleton first (each = its own TDD plan)

Time budgets are targets for part-time solo work; each phase ends deployable.

- **Phase 0 — Walking skeleton (~2 weekends):** ONE mock system (CRM) with seeded
  data + ledger → naive ingest → one dbt staging model → MCP server with one read
  tool → host worker generating a stub report → one action-safety eval → docker
  compose up. *Exit: end-to-end demo from one command.*
- **Phase 1 — Reliability spine (~2–3 weekends):** faults + fault-plan seeds on the
  mock; idempotency, outbox, cursors, DLQ + replay CLI, quarantine. *Exit: chaos
  reconciliation test passes; DLQ replay works.*
- **Phase 2 — Unification at width (~2 weekends):** add billing + support mocks;
  3-tier identity resolution; customer_360; dbt tests gate CI; micro-batch
  orchestration. *Exit: dupe metric measured; freshness measured.*
- **Phase 3 — Agent depth (~2 weekends):** full read tools; `flag_account_for_review`
  + approval gate + audit log; real Monday report; eval suite split (CI + nightly).
  *Exit: evals green; report demo recorded.*
- **Phase 4 — Ship (~1–2 weekends):** OTel + Grafana + alert; deploy; read-only demo
  page; README case study + discovery memo + demo video; citation re-verification.
  *Exit: live URL + video + final measured-results table.*

**Cut-first list (if time pressure hits, drop in this order):** schema-drift
injection → Grafana alerting (keep dashboard) → third mock system (support) →
nightly LLM evals (keep action-safety CI) → live deployment (video-only proof).

## 7. Explicitly out of scope (YAGNI)

- No real third-party SaaS credentials or OAuth flows (mock harness instead).
- No multi-tenant auth product; bearer-token auth on exposed endpoints only.
- No front-end app beyond the approval view + read-only demo page.
- No Temporal/Airbyte/Nango dependency — comparison points in ADRs, not the
  deliverable (the portfolio must show the reliability layer built, not bought).
- No fuzzy/ML identity matching (three deterministic tiers only).
- No second (health-domain) case study yet — possible follow-on, separate project.

## 8. Defaults chosen (flag if wrong)

1. **Language split:** all-TypeScript incl. MCP server + host; Python only inside
   the dbt sidecar.
2. **LLM:** Claude via Anthropic SDK, prompt caching on, pinned model for evals.
3. **Public repo name:** `switchboard` (rename trivial before publishing).
