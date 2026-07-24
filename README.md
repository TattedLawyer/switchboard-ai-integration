# Switchboard

![ci](https://github.com/TattedLawyer/switchboard-ai-integration/actions/workflows/ci.yml/badge.svg)
![chaos](https://github.com/TattedLawyer/switchboard-ai-integration/actions/workflows/chaos.yml/badge.svg)

**Connects business systems that don't talk to each other, cleans up their combined
data, and puts a supervised AI assistant on top.**

## The problem, in plain English

Most companies run separate software for sales, billing, and customer support. Those
systems don't share information. So every week, someone spends hours copying data
between screens to answer basic questions like *"which customers are we about to
lose?"* — and the answer is stale by the time it's assembled.

Switchboard is a working demonstration of the fix, built end-to-end by one engineer:

1. **Connect** the three systems so information flows automatically instead of by hand.
2. **Clean and combine** the data so there's one trustworthy record per customer —
   even when the same company appears under different names and IDs in each system.
3. **Put an AI assistant on top** that writes the weekly revenue-risk report
   automatically — designed so any action beyond reading requires human approval.
   Today that means the assistant's server registers exactly one read-only tool —
   so anything else is rejected by the protocol layer, and a test pins that;
   the approval-gated action itself and richer behavioral safety testing are being
   built in Phase 3.

Anyone can verify the claims: one command (`./scripts/demo.sh`) runs the entire
system and produces the report. No accounts, no API keys, nothing to sign up for.

**Note for reviewers:** the "customer" is a fictional company and all data is
synthetic (the data generators are covered by automated hygiene checks — no real names, emails, or records
anywhere). Real client work can't be published, so this project shows the same
engineering on data you can inspect freely.

## What's built and working today (Phases 0–2a)

- **Three simulated business systems** — CRM, billing, support — each streaming
  signed events and each keeping an **HMAC-keyed, hash-chained, append-only log**
  of everything it sends: the tamper-evident measuring stick the reliability tests
  reconcile against. All three share one mock core with on-demand fault injection
  (dropped, duplicated, out-of-order deliveries and API errors, deterministic from
  a seed), and all three are generated from **one correlated seed manifest**, so
  the same fictional companies deliberately appear across systems under mismatched
  names, domains, and IDs — including seeded duplicates and planned near-misses
  the identity layer must get right. The log chain is keyed (`LEDGER_HMAC_KEY`,
  demo default documented like the webhook secrets) so tamper-evidence holds
  against anyone who can write the file but doesn't hold the key; a dedicated
  adversarial test proves a forger without the key is caught.
- **An ingestion service built for failure, now source-agnostic:** one
  `/webhooks/:source` endpoint with a **per-source HMAC secret**
  (`WEBHOOK_SECRET_CRM|_BILLING|_SUPPORT` — a billing event signed with the CRM
  secret is rejected, by test), a single raw event store with `(source, event_id)`
  exactly-once storage, **per-source retry queues with per-source dead-letter
  lanes** and a replay tool, a quarantine for malformed data (nothing delivered is
  ever dropped), and per-source cursor backfill that catches anything webhooks lose.
- **A zero-data-loss proof you can run:** `./scripts/chaos.sh` fires 600 events —
  200 per source, all three under injected failures simultaneously — and proves,
  by reconciling each source against its tamper-evident log, that every event
  landed exactly once (typically ~20 seconds; the settle wait is backoff-aware
  and bounded at 240s so retry-backoff spikes finish instead of flaking).
- **Identity resolution** (dbt): three deterministic tiers — exact email match,
  then normalized domain + company name, then a `manual_review` queue (never a
  silent guess) — with **every resolved link recording which tier matched and the
  evidence**, so resolution is auditable, not a black box. CRM merge events
  collapse duplicate companies and re-point their history (recursive
  follow-to-terminal with a cycle guard; dbt tests assert no cycles and all
  chains terminate). Design rationale: [identity-resolution ADR](docs/adr/identity-resolution.md).
- **A unified `customer_360` mart:** one row per resolved entity joining deals,
  invoices, payments, tickets, SLA breaches, and CSAT across all three systems.
  Entities visible only in billing or support still get a row, **flagged
  incomplete** — more useful than hiding them.
- **An identity-correctness oracle:** the seed manifest plans, per entity, exactly
  which tier must match; `scripts/verify-identity.ts` checks the entire assignment
  (tier partition, merge collapse, deal conservation, mart rowcount, cross-system
  joins) on every demo run and CI build.
- An AI-tool server (Model Context Protocol — the open standard for connecting AI
  assistants to business data) exposing exactly **one read-only tool**, with an
  automated safety test proving undeclared tools are rejected.
- A worker that generates the Monday revenue-risk report — with a timeout and
  fallback so the report generates even when the AI service is down, and per-call
  cost logging.
- **CI:** the `ci` workflow runs on every push — typecheck, all 130 tests, the
  dbt build (14 models + 46 data tests), the agent action-safety eval, and the
  identity oracle, against a real Postgres service container
  ([`ci.yml`](.github/workflows/ci.yml)). The heavier chaos + demo proof runs on
  a nightly schedule and manual dispatch, with the fault seed as a workflow input
  so any red run is reproducible by re-entering its seed
  ([`chaos.yml`](.github/workflows/chaos.yml)). The badges above track those
  workflows — they show "no runs" until the first GitHub run, which is pending
  (pushing the workflow files requires a workflow-scoped credential).
- 130 automated tests, written test-first, all green locally — including a
  seeded property-based suite (fast-check) that generatively attacks the ingest
  boundary, dedup, HMAC, and batch-failure isolation; the whole pipeline
  runs from one command; operational docs included ([runbook](RUNBOOK.md),
  [identity ADR](docs/adr/identity-resolution.md),
  [scaling ceilings](docs/scaling-ceilings.md),
  [real-vendor delta](docs/real-connector-delta.md),
  [deletion/GDPR design](docs/gdpr-erasure-design.md),
  and a public [known-issues ledger](KNOWN-ISSUES.md) — the open defects,
  deferred debt, and known-failing invariants, with where each gets paid).

### Measured results (every number is a script output, reproducible)

| Claim | Evidence | Result |
|---|---|---|
| Zero lost events under faults | `./scripts/chaos.sh` (600 events, 20% drops / 15% dups / 20% API errors) | per source: 158 arrive by push, backfill recovers exactly the 42 dropped; 3× exact ledger reconciliation, 0 duplicates, quarantine 0, DLQ 0 |
| Loss *detection* has teeth | `CHAOS_SKIP_BACKFILL=1 ./scripts/chaos.sh` | correctly FAILS, listing the 42 missing events per source |
| End-to-end pipeline equality | `./scripts/demo.sh` (288 events across 3 sources) | ledger = raw = outbox at 288/288/288, report generated |
| Seeded duplicates collapse | dbt build (`assert_*` + oracle) | 22 staged companies → 20 canonical entities; merged-away ids absent from the mart, their deals re-pointed |
| Identity tiers match the plan | `scripts/verify-identity.ts` | 30 external entities: 19 tier-1, 5 tier-2, 6 manual-review — exact set equality per source, including both planned near-misses |
| Unified mart is conservative | dbt + oracle | `customer_360` = 26 rows (20 canonical + 6 incomplete-flagged); 8 companies joined across all three systems |
| Suite | `npm test` + dbt | 130 tests green (incl. 5 seeded fast-check properties); 46/46 dbt data tests (60 build steps incl. 14 models) |

## What's coming (built in phases, in public)

- **Phase 2b — Vendor fidelity:** vendor-faithful mock API shapes (HubSpot-style
  thin events + hydration, Stripe-style payloads), an event-bus-paradigm source
  (subscribe + replay-cursor instead of webhooks), and vertical demo datasets.
- **Phase 3 — Agent depth:** one carefully-bounded write action behind human
  approval with a full audit trail, plus an evaluation suite for report quality.
- **Phase 4 — Operations:** monitoring dashboards, alerting, a live deployment,
  and a demo video.

## For engineers

**Architecture (current):** three chaos-oracle mock sources (shared
`@switchboard/mock-core`: PRNG faults, HMAC signing, keyed hash-chain ledger,
correlated seed manifest) → Express 5/TypeScript ingest (`/webhooks/:source`,
per-source HMAC verify, per-source pg-boss queues + DLQs, per-source cursors) →
single `raw.raw_events` (`(source, event_id)` unique) → dbt: 8 staging views
(`distinct on` latest-state, event-time ordered) → identity layer (`merge_edges` →
recursive canonical walk → 3-tier `identity_resolution` with provenance →
`manual_review` incremental) → `customer_360` mart → MCP server (official TS SDK,
`READ_TOOLS` allowlist + rejection-text eval) → report worker (scripted MCP client
calls + LLM narrative — true agentic tool selection lands in Phase 3;
deterministic template fallback when `ANTHROPIC_API_KEY` is unset).

**Read the engineering trail** — the process is part of the artifact:

- [Design spec (rev 2)](docs/superpowers/specs/2026-07-21-switchboard-design.md) —
  architecture, build-vs-buy decisions, what was deliberately cut, revised after a
  12-finding adversarial review
- [Phase 2 amendment](docs/superpowers/specs/2026-07-22-phase2-amendment.md) —
  the 13 locked design decisions behind the width work (single raw table,
  per-source secrets, merge semantics, CI split)
- [Identity-resolution ADR](docs/adr/identity-resolution.md) — why deterministic
  tiers and not ML, and how merges collapse without rewriting raw
- Journals — what was planned vs. what actually happened, including the misses:
  [Phase 0](docs/log/phase0.md) · [Phase 1](docs/log/phase1.md) ·
  [Phase 2a](docs/log/phase2a.md)

**Prerequisites:** Docker (for Postgres) and Node.js ≥ 22.

**Run it:**

```bash
npm install
./scripts/demo.sh        # end-to-end: 288 events, 3 sources → oracle-equality + identity checks → report (~20s)
./scripts/chaos.sh       # 600 events under injected faults → zero-loss proof (~20s typical, bounded at 240s)
```

Tests require the install above and the database up:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test
```

**Stack:** TypeScript / Node 22 · Express 5 · Postgres 16 · dbt · pg-boss · MCP
TypeScript SDK · Anthropic SDK · Docker Compose · GitHub Actions. Planned in later
phases: OpenTelemetry + Grafana (Phase 4).
