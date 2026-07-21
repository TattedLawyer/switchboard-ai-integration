# Switchboard

**Connects business systems that don't talk to each other, cleans up their combined
data, and puts a supervised AI assistant on top.**

## The problem, in plain English

Most companies run separate software for sales, billing, and customer support. Those
systems don't share information. So every week, someone spends hours copying data
between screens to answer basic questions like *"which customers are we about to
lose?"* — and the answer is stale by the time it's assembled.

Switchboard is a working demonstration of the fix, built end-to-end by one engineer:

1. **Connect** the three systems so information flows automatically instead of by hand.
2. **Clean and combine** the data so there's one trustworthy record per customer.
3. **Put an AI assistant on top** that writes the weekly revenue-risk report
   automatically — designed so any action beyond reading requires human approval.
   Its access is limited to a declared list of tools, enforced by automated tests;
   the approval-gated action itself and richer behavioral safety testing are being
   built in Phase 3.

Anyone can verify the claims: one command (`./scripts/demo.sh`) runs the entire
system and produces the report. No accounts, no API keys, nothing to sign up for.

**Note for reviewers:** the "customer" is a fictional company and all data is
synthetic (enforced by automated checks — no real names, emails, or records
anywhere). Real client work can't be published, so this project shows the same
engineering on data you can inspect freely.

## What's built and working today (Phases 0–1)

- A simulated company's CRM that streams signed events and keeps an **HMAC-keyed,
  hash-chained, append-only log** of everything it sends — the tamper-evident
  measuring stick the reliability tests reconcile against — with on-demand fault
  injection: dropped, duplicated, out-of-order deliveries and API errors, all
  deterministic from a seed. The chain is keyed (`LEDGER_HMAC_KEY`, demo default
  documented like `WEBHOOK_SECRET`) so tamper-evidence holds against anyone who can
  write the ledger file but doesn't hold the key — a plain hash chain doesn't, since
  re-chaining after a mutation needs no secret; a dedicated adversarial test proves a
  forger without the key is caught.
- An ingestion service built for failure: signature verification, exactly-once
  storage (duplicate deliveries can't create duplicate records), a retry queue with
  a dead-letter lane and replay tool, a quarantine for malformed data (nothing
  delivered is ever dropped), and a polling recovery path that catches anything
  webhooks lose.
- **A zero-data-loss proof you can run:** `./scripts/chaos.sh` fires 200 events
  through injected failures and proves — by reconciling against the tamper-evident
  log — that every event landed exactly once (~20 seconds, deterministic).
- A data-transformation step (dbt) producing a clean, tested view ordered by when
  things actually happened, not when they arrived.
- An AI-tool server (Model Context Protocol — the open standard for connecting AI
  assistants to business data) exposing exactly **one read-only tool**, with an
  automated safety test proving undeclared tools are rejected.
- A worker that generates the Monday revenue-risk report — with a timeout and
  fallback so the report generates even when the AI service is down, and per-call
  cost logging.
- 62 automated tests, written test-first, all green; the whole pipeline runs from
  one command; operational docs included ([runbook](RUNBOOK.md),
  [scaling ceilings](docs/scaling-ceilings.md),
  [real-vendor delta](docs/real-connector-delta.md),
  [deletion/GDPR design](docs/gdpr-erasure-design.md)).

## What's coming (built in phases, in public)

- **Phase 2 — Width:** billing + support systems, identity resolution across
  mismatched records, a unified `customer_360` model, automated test gates (CI).
- **Phase 3 — Agent depth:** one carefully-bounded write action behind human
  approval with a full audit trail, plus an evaluation suite for report quality.
- **Phase 4 — Operations:** monitoring dashboards, alerting, a live deployment,
  and a demo video.

## For engineers

**Architecture (current):** chaos-oracle mock CRM (append-only JSONL ledger, written
*before* webhook delivery) → Express 5/TypeScript ingest → Postgres raw events →
dbt staging view (`distinct on` latest-state) → MCP server (official TS SDK,
`READ_TOOLS` allowlist + rejection-text eval) → report worker (scripted MCP client
calls + LLM narrative — true agentic tool selection lands in Phase 3; deterministic
template fallback when `ANTHROPIC_API_KEY` is unset).

**Read the engineering trail** — the process is part of the artifact:

- [Design spec (rev 2)](docs/superpowers/specs/2026-07-21-switchboard-design.md) —
  architecture, build-vs-buy decisions, what was deliberately cut, revised after a
  12-finding adversarial review
- [Phase 0 implementation plan](docs/superpowers/plans/2026-07-21-phase0-walking-skeleton.md) —
  8 TDD tasks
- [Phase 0 journal](docs/log/phase0.md) — what was planned vs. what actually
  happened (toolchain surprises, dependency drift, review findings and fixes)

Tests require the database up:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test
```

**Run it:**

```bash
npm install
./scripts/demo.sh        # end-to-end: 50 events → oracle-equality check → report (~15s)
./scripts/chaos.sh       # 200 events under injected faults → zero-loss proof (~20s)
```

**Stack:** TypeScript / Node 22 · Express 5 · Postgres 16 · dbt · pg-boss · MCP
TypeScript SDK · Anthropic SDK · Docker Compose. Planned in later phases: GitHub
Actions CI (Phase 2), OpenTelemetry + Grafana (Phase 4).
