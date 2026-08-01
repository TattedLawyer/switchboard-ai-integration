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
   Today that means two independent layers: the assistant's server registers
   exactly one read-only tool (anything else is rejected by the protocol layer,
   and a test pins that), and the assistant's database connection runs as a
   **read-only Postgres role** — a write is refused by the database itself, also
   pinned by tests. The approval-gated action and richer behavioral safety
   testing are being built in Phase 3.

Anyone can verify the claims: one command (`./scripts/demo.sh`) runs the entire
system and produces the report. No accounts, no API keys, nothing to sign up for.

**Note for reviewers:** the "customer" is a fictional company and all data is
synthetic — and that's enforced, not asserted: automated hygiene checks cover
both the data generators (DEMO-prefixed ids/names, example.com emails only) and
a scan of every tracked file in the repo for real-looking emails or PII-shaped
records. Real client work can't be published, so this project shows the same
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
  the identity layer must get right. The log chain is keyed (`LEDGER_HMAC_KEY`)
  so tamper-evidence holds against anyone who can write the file but doesn't
  hold the key; a dedicated adversarial test proves a forger without the key is
  caught. Secrets **fail closed**: there are demo defaults, but they only
  activate behind an explicit `ALLOW_DEV_SECRETS=1` — a production deploy that
  forgets an env var refuses to run instead of silently authenticating against
  a value published in this repo.
- **An ingestion service built for failure, now source-agnostic:** one
  `/webhooks/:source` endpoint with a **per-source HMAC secret**
  (`WEBHOOK_SECRET_CRM|_BILLING|_SUPPORT` — a billing event signed with the CRM
  secret is rejected, by test) and **timestamped signatures with a ±5-minute
  replay window** (the timestamp is signed material, so a captured request can't
  be re-stamped — the same scheme Stripe, Slack, and HubSpot converge on), a
  single raw event store with `(source, event_id)` exactly-once storage,
  **per-source retry queues with per-source dead-letter lanes** and replay tools
  for both the DLQ and the quarantine, a quarantine for malformed data (nothing
  delivered is ever dropped, and event timestamps are bounded to a sanity window
  so a vendor clock bug can't permanently pin an entity's state), and per-source
  cursor backfill that catches anything webhooks lose.
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
- **CI:** the `ci` workflow runs on every push — typecheck, all 194 tests, the
  dbt build (14 models + 47 data tests), the agent action-safety eval, and the
  identity oracle, against a real Postgres service container
  ([`ci.yml`](.github/workflows/ci.yml)). The heavier chaos + demo proof runs on
  a nightly schedule and manual dispatch, with the fault seed as a workflow input
  so any red run is reproducible by re-entering its seed
  ([`chaos.yml`](.github/workflows/chaos.yml)). The badges above track those
  workflows and report the live state of each. Moving to real runners was worth
  it: there were three red runs before the first green one, each for a different
  reason and none of them findable by a local suite — a fail-closed secrets gate
  that could only fail where no secrets exist, a drain-gate race that only opens
  on a slow machine, and a leftover mock server inherited across steps sharing a
  process table. Each is narrated with its run ID in the
  [known-issues ledger](KNOWN-ISSUES.md#process-honesty).
- 194 automated tests, green in CI and locally — including a seeded
  property-based suite (fast-check) that generatively attacks the ingest
  boundary, dedup, HMAC, batch-failure isolation, and ledger crash-safety under
  arbitrary torn writes. Test-first is provable from git history for hardening
  work since 2a.2, where each fix lands as a RED→GREEN commit pair; for earlier
  phases it is narrated, not provable. The whole pipeline
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
| Zero lost events under faults | `./scripts/chaos.sh` (600 events, 20% drops / 15% dups / 20% API errors) | at the default seed, 158 of 200 per source arrive by push and backfill recovers exactly the 42 dropped. That split moves with `CHAOS_SEED`; the pass condition does not — the script asserts every source's ledger reconciles exactly against its raw rows (3×), with 0 duplicates, quarantine 0, DLQ 0 |
| Loss *detection* has teeth | `CHAOS_SKIP_BACKFILL=1 ./scripts/chaos.sh` | correctly FAILS, listing every unrecovered event per source (42 each at the default seed) |
| End-to-end pipeline equality | `./scripts/demo.sh` (288 events across 3 sources) | ledger = raw = journal at 288/288/288, report generated |
| Seeded duplicates collapse | dbt build (`assert_*` + oracle) | 22 staged companies → 20 canonical entities; merged-away ids absent from the mart, their deals re-pointed |
| Identity tiers match the plan | `scripts/verify-identity.ts` | 30 external entities: 19 tier-1, 5 tier-2, 6 manual-review — exact set equality per source, including both planned near-misses |
| Unified mart is conservative | dbt + oracle | `customer_360` = 26 rows (20 canonical + 6 incomplete-flagged); 8 companies joined across all three systems |
| Suite | `npm test` + dbt | 194 tests green (incl. 6 seeded fast-check properties); 47/47 dbt data tests (61 build steps incl. 14 models) |

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
./scripts/demo.sh        # end-to-end: 288 events, 3 sources → oracle-equality + identity checks → report
./scripts/chaos.sh       # 600 events under injected faults → zero-loss proof
```

The first run also pulls the Postgres image and builds the dbt container, so budget
a few minutes for it. Once those are cached, `demo.sh` takes roughly 20 seconds and
`chaos.sh` roughly 20 seconds typical — the latter bounded at 240s, since it waits
on retry backoff it deliberately induced.

Tests require the install above and the database up:

```bash
docker compose up -d postgres
DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard npm test
```

### One pipeline, three verticals

The core is vertical-agnostic by construction: no mart column is
industry-specific, connectors are paradigm-specific (webhook, cursor feed, event
bus, spreadsheet) — never industry-specific — and a vertical profile swaps only
vocabulary and value ranges. The seed generator ships three vertical profiles
(`plumbing | saas | realestate`, default `generic`) on the same skeleton: same
entity counts, same id schemes, same seeded duplicates and merge pairs, same
tier-1/2/3 identity expectations. Same seed, same pipeline — different business.
Deterministic and reproducible (a test runs these exact commands and diffs the
output against this section):

```bash
PROFILE=plumbing node --import tsx -e 'import("@switchboard/mock-core").then(({generateManifest})=>{const m=generateManifest(42,process.env.PROFILE);for(const c of m.crm.companies.slice(0,2))console.log("company",c.id,c.name,"·",c.domain);const d=m.crm.deals[0];console.log("deal   ",d.id,d.name,"· $"+(d.amount_cents/100).toFixed(2));const t=m.support.tickets[0];console.log("ticket ",t.id,t.subject)})'
```

```text
company DEMO-C-0001 DEMO Rooter Plumbing 1 · rooter-1.example.com
company DEMO-C-0002 DEMO Drainworks Plumbing 2 · drainworks-2.example.com
deal    DEMO-D-0001 DEMO Job 1: Sewer Line Repair · $6807.11
ticket  DEMO-T-0001 DEMO Clogged Drain Call 1
```

```bash
PROFILE=saas node --import tsx -e 'import("@switchboard/mock-core").then(({generateManifest})=>{const m=generateManifest(42,process.env.PROFILE);for(const c of m.crm.companies.slice(0,2))console.log("company",c.id,c.name,"·",c.domain);const d=m.crm.deals[0];console.log("deal   ",d.id,d.name,"· $"+(d.amount_cents/100).toFixed(2));const t=m.support.tickets[0];console.log("ticket ",t.id,t.subject)})'
```

```text
company DEMO-C-0001 DEMO Cloudmetric Software 1 · cloudmetric-1.example.com
company DEMO-C-0002 DEMO Datastack Software 2 · datastack-2.example.com
deal    DEMO-D-0001 DEMO Team Plan Upgrade 1 · $108251.78
ticket  DEMO-T-0001 DEMO API Rate Limit Ticket 1
```

```bash
PROFILE=realestate node --import tsx -e 'import("@switchboard/mock-core").then(({generateManifest})=>{const m=generateManifest(42,process.env.PROFILE);for(const c of m.crm.companies.slice(0,2))console.log("company",c.id,c.name,"·",c.domain);const d=m.crm.deals[0];console.log("deal   ",d.id,d.name,"· $"+(d.amount_cents/100).toFixed(2));const t=m.support.tickets[0];console.log("ticket ",t.id,t.subject)})'
```

```text
company DEMO-C-0001 DEMO Harborview Realty 1 · harborview-1.example.com
company DEMO-C-0002 DEMO Summit Realty 2 · summit-2.example.com
deal    DEMO-D-0001 DEMO Buyer Representation 1 · $337597.19
ticket  DEMO-T-0001 DEMO Escrow Question Request 1
```

The demo scripts and every identity/oracle proof run on `generic`, whose output
is byte-frozen against the pre-profile baseline; all data in every profile is
synthetic (`DEMO` markers, `*.example.com` domains), enforced per profile by the
hygiene tests.

**Stack:** TypeScript / Node 22 · Express 5 · Postgres 16 · dbt · pg-boss · MCP
TypeScript SDK · Anthropic SDK · Docker Compose · GitHub Actions. Planned in later
phases: OpenTelemetry + Grafana (Phase 4).

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright 2026 Michael Christine.

Apache 2.0 rather than MIT for the express patent grant: MIT is silent on
patents, which is the ambiguity counsel tends to flag when a business evaluates
taking a dependency on someone else's code.
