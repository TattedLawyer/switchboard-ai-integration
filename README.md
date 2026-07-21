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

## What's built and working today (Phase 0)

- A simulated company's CRM that streams events and keeps an append-only log of
  everything it sends — the measuring stick later phases test against.
- An ingestion service that receives those events into a database (deliberately
  simple at this stage; the industrial-strength reliability layer is Phase 1).
- A data-transformation step (dbt) that produces a clean, tested view of the data.
- An AI-tool server (Model Context Protocol — the open standard for connecting AI
  assistants to business data) exposing exactly **one read-only tool**, with an
  automated safety test proving undeclared tools are rejected.
- A worker that generates the Monday revenue-risk report from the unified data.
- 16 automated tests, written test-first, all green; the whole pipeline runs from
  one command.

## What's coming (built in phases, in public)

- **Phase 1 — Reliability:** fault injection (dropped/duplicate/out-of-order
  events), exactly-once-style processing (idempotency keys, transactional outbox,
  dead-letter queue with replay), and a reconciliation test that proves zero events
  are lost under injected failures.
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

**Run it:**

```bash
npm install
./scripts/demo.sh        # full pipeline: postgres → migrate → services → 50 events → dbt → report
cat out/monday-report.md
```

Tests require the database up:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test
```

**Stack:** TypeScript / Node 22 · Express 5 · Postgres 16 · dbt · MCP TypeScript
SDK · Anthropic SDK · Docker Compose. Planned in later phases: pg-boss (Phase 1),
GitHub Actions CI (Phase 2), OpenTelemetry + Grafana (Phase 4).
