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

Switchboard is a working demonstration of the fix (how it was built — one engineer
directing an agent fleet under an evidence-gated process — is described in
[How this was built](#how-this-was-built), because the process is part of the claim):

1. **Connect** the three systems so information flows automatically instead of by hand.
2. **Clean and combine** the data so there's one trustworthy record per customer —
   even when the same company appears under different names and IDs in each system.
3. **Put an AI assistant on top** that writes the weekly revenue-risk report
   automatically — designed so any action beyond reading requires human approval.
   That is enforced at the database: a proposal cannot be *created* in an approved
   state and cannot *transition* to one without a decision row naming a human, written
   in the same transaction — both halves, because for a while only the second was, and
   an INSERT could forge the first (found at the merge gate, closed, and disclosed in
   KNOWN-ISSUES with the owner-level residuals no in-database control can cover).
   Today that means two independent layers: the assistant's server registers
   exactly one read-only tool (anything else is rejected by the protocol layer,
   and a test pins that), and the assistant's database connection runs as a
   **read-only Postgres role** — a write is refused by the database itself, also
   pinned by tests. **No write-capable credential exists anywhere in the agent
   process at all**: when the agent proposes an action it returns a typed object,
   and a separate service — the one the client's approver logs into — validates
   and records it. Stated in the three tiers it is actually enforced at, because
   the differences matter:
   *(a) database-enforced, at runtime, in every deployment* — the agent's
   connection authenticates as a role holding `usage` and `select` and nothing
   else, and INSERT/UPDATE/DELETE/CREATE are refused with SQLSTATE `42501`, proven
   by running those statements against a live database;
   *(b) enforced at process start, in every deployment* — the agent refuses to
   **start** without its own credential, and refuses to start on any connection
   whose `current_user` is not that role. Precisely "start", not "serve every
   call": the check runs once per entrypoint, before any work, on the one pool
   that entrypoint opens — and no other pool may exist, which is what (c) is for;
   *(c) checked in CI, about the code in one directory, and deliberately the
   weakest of the three* — no module under `agent/src/` that the analysis can see
   binds the database driver, constructs a second pool, hands the driver out, or
   reads a full-privilege credential. Read that qualifier as load-bearing: this is
   a static sweep plus a runtime check on one code path, **not** a security
   boundary and not enforcement. It catches ordinary mistakes, which is most of
   them; it cannot see a dependency opening its own connection, and a determined
   author inside the repo can defeat it — four rounds of adversarial review each
   found one more way, and we stopped by decision rather than because the bottom
   was reached (the reasoning is in the ADR). The guarantee is (a), the database.
   Two honest limits, both disclosed in `KNOWN-ISSUES.md`: that ceiling, and — on
   a single-box self-hosted deployment — that both processes likely run as the
   same OS user, making this **credential locality, not OS sandboxing**.
   The approval-gated action and richer behavioral safety testing are being built
   in Phase 3.

Anyone can verify the claims: one command (`./scripts/demo.sh`) runs the entire
system and produces the report. No accounts, no API keys, nothing to sign up for.

**Note for reviewers:** the "customer" is a fictional company and all data is
synthetic — and that's enforced, not asserted: automated hygiene checks cover
both the data generators (DEMO-prefixed ids/names, example.com emails only) and
a scan of every tracked file in the repo for real-looking emails or PII-shaped
records. Real client work can't be published, so this project shows the same
engineering on data you can inspect freely.

## The horizontal thesis: one pipeline, many businesses

Every vendor integration looks bespoke from the outside. It isn't. Strip the
branding away and there are a small number of *paradigms* — ways a system agrees
to tell you that something changed — and each one has its own failure mode.
Switchboard implements four of them against one unchanged reliability spine:

| Paradigm | Modelled on | What it hands you | Its loss boundary |
|---|---|---|---|
| **Spreadsheet snapshot-diff CDC** | Google Sheets + Apps Script | a mutable grid; changes are inferred by re-reading it | the push channel is lossy and blind to API writes — reconcile against the sheet's own rows is the guarantee |
| **Cursor-paged envelope feed** | Stripe `/v1/events` | an opaque cursor over a retained window | 30-day retention: fall further behind and the events are gone from the source |
| **Thin webhook + hydration** | HubSpot | metadata-only batches; the record must be fetched afterwards | a notification that exhausts its retries is unrecoverable — detected, never re-pulled |
| **Subscribe / replay event stream** | Salesforce Pub/Sub | a subscription with a replay cursor | 72-hour window, plus stream resets that can kill a cursor of any age |

(A fifth, the 2a seq-ordered ledger feed, remains in the repo as the chaos
proof's oracle — it is the one paradigm real vendors don't offer, which is why it
is used to *test* the spine rather than to make claims about vendors.)

What that buys a reader in plain language: **the expensive part of an
integration is not the vendor — it's the reliability machinery underneath it,
and that machinery is written once.** Adding a source means writing a connector
that speaks its paradigm; queueing, dead-lettering, quarantine, cursors,
exactly-once storage, reconciliation and identity resolution are already there
and do not change. The same is true vertically: no mart column is
industry-specific, so the same pipeline serves a plumbing contractor, a SaaS
company, or a brokerage — three profiles ship in the repo and are demonstrated
[below](#one-pipeline-three-verticals).

Each paradigm also *admits what it cannot do*. Two of the four can lose data
permanently by the vendor's own design; the pipeline reports those losses with
bounds and refuses to pass until a named human accepts them, rather than
reporting a clean run.

## What's built and working today (Phases 0–2b)

- **Simulated business systems across four integration paradigms** — a
  HubSpot-style thin-webhook CRM (metadata-only batches + a hydration pump), a
  Stripe-style envelope feed for billing, a Salesforce-style subscribe/replay
  event bus for support, a Google-Sheets-style snapshot source, and the original
  ledger-feed mocks — the push sources each keeping an **HMAC-keyed,
  hash-chained, append-only log** of everything they emit: the tamper-evident
  measuring stick the reliability tests reconcile against. All share one mock
  core with on-demand fault injection (dropped, duplicated, out-of-order
  deliveries and API errors, deterministic from a seed), and all are generated
  from **one correlated seed manifest**, so
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
  (`WEBHOOK_SECRET_<SOURCE>`, one per registered source — a billing event signed
  with another source's secret is rejected, by test) and **timestamped signatures with a ±5-minute
  replay window** (the timestamp is signed material, so a captured request can't
  be re-stamped — the same scheme Stripe, Slack, and HubSpot converge on), a
  single raw event store with `(tenant_id, source, event_id)` exactly-once storage,
  **per-source retry queues with per-source dead-letter lanes** and replay tools
  for both the DLQ and the quarantine, a quarantine for malformed data (nothing
  delivered is ever dropped, and event timestamps are bounded to a sanity window
  so a vendor clock bug can't permanently pin an entity's state), and per-source
  cursor backfill that catches anything webhooks lose.
- **A runnable zero-loss check:** `./scripts/chaos.sh` drives all three
  chaos sources under injected failures simultaneously — the thin-webhook CRM
  through its own weather (duplicated requests, cross-batch holdovers,
  within-batch shuffle, a bounded redelivery budget) and the two ledger-feed
  sources through drops/dups/API errors — and proves each source reconciles
  clean under its own paradigm's oracle: object store vs raw thin events vs
  hydrated snapshots for the CRM, tamper-evident log vs raw for the feeds
  (the settle wait is backoff-aware and bounded at 240s so retry-backoff
  spikes finish instead of flaking). It has a negative control that must FAIL —
  `CHAOS_SKIP_BACKFILL=1` is required to red — which is what separates a check
  from a green light. Two limits the headline used to omit, both already in
  KNOWN-ISSUES and now stated where the claim is made: reconcile proves **id-set
  parity, not payload parity**, and the oracle is a ledger written by **this
  codebase**, whereas in production the vendor is the oracle. It was called "a
  zero-data-loss proof" here; a proof's strength is bounded by its oracle, and a
  headline stronger than the register beneath it is the one credibility failure a
  repo whose pitch is disclosure discipline cannot afford.
- **Identity resolution** (dbt): three deterministic tiers — exact email match,
  then normalized domain + company name, then a `manual_review` queue (never a
  silent guess) — with **every resolved link recording which tier matched and the
  evidence**, so resolution is auditable, not a black box. CRM merge events
  collapse duplicate companies and re-point their history (recursive
  follow-to-terminal with a cycle guard; dbt tests assert no cycles and all
  chains terminate). Design rationale: [identity-resolution ADR](docs/adr/identity-resolution.md).
- **A unified `customer_360` mart:** one row per resolved entity joining deals,
  invoices, payments, tickets, SLA breaches, CSAT and spreadsheet rows across all
  four ingest lanes.
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
- An **approval service** that records what the agent proposes. It exists so the
  agent does not have to: the agent posts a validated object to an authenticated,
  loopback-bound door, and this service performs the INSERT as a non-owner role
  holding `select` and `insert` on one table and nothing else — deliberately not
  the migration owner, which could grant privileges back to the agent's role and
  so retire the read-only claim rather than defeat it. Proposals are capped and
  idempotency-keyed, because an approval queue no human can triage disables the
  human-approval constraint rather than merely annoying it. Its client-facing
  login and approval page are real too: magic-link sign-in (one-time links,
  hashed at rest), database-backed sessions, CSRF defence, and every decision
  row naming the signed-in approver's user id.
- **CI:** the `ci` workflow runs on every push — typecheck, all 2226 tests, the
  dbt build — 101 dbt build steps (15 models, 3 seeds, 83 data tests) — the agent
  action-safety eval, and the identity oracle, against a real Postgres service
  container
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
- 2226 automated tests, green in CI and locally — including a seeded
  property-based suite (fast-check) that generatively attacks the ingest
  boundary, dedup, HMAC, batch-failure isolation, and ledger crash-safety under
  arbitrary torn writes. That count is not maintained by hand: CI runs
  [`scripts/verify-doc-counts.ts`](scripts/verify-doc-counts.ts) against the real
  `npm test` log and against the known-issues scoreboard, so a build whose numbers
  drift from this page goes red. Test-first is *sometimes* provable from git history
  for hardening work since 2a.2: in the phase-2b close range four fixes land as
  explicit RED→GREEN commit pairs and eleven bundle their tests into a single
  commit — every one of them test-backed, but only the four provable as pairs from
  `git log` alone. For earlier phases it is narrated, not provable. The whole pipeline
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
| Zero lost events under faults | `./scripts/chaos.sh` (hubcrm 240 ops with dup/holdover/shuffle + bounded redelivery; billing/support 200 events each with 20% drops / 15% dups / 20% API errors) | the exact per-seed split moves with `CHAOS_SEED`; the pass condition does not — every source must reconcile clean under its own paradigm's oracle, with quarantine 0 and DLQ 0 (validated in CI via the chaos workflow) |
| Loss *detection* has teeth | `CHAOS_SKIP_BACKFILL=1 ./scripts/chaos.sh` | correctly FAILS per paradigm: the ledger-feeds list every unrecovered dropped event, and the CRM reds on dropped webhooks (missing/drifted objects) plus un-hydrated events |
| End-to-end pipeline equality | `./scripts/demo.sh` (560 events across 4 sources: hubcrm 300 ops, stripefeed 100, casebus 80, support 80) | ledger = raw = journal where a ledger exists (hubcrm, support); journal = raw plus a four-paradigm `reconcile` pass for the window sources; report generated |
| Seeded duplicates collapse | dbt build (`assert_*` + oracle) | 22 staged companies → 20 canonical entities; merged-away ids absent from the mart, their deals re-pointed |
| Identity tiers match the plan | `scripts/verify-identity.ts` | 30 external entities: 19 tier-1, 5 tier-2, 6 manual-review — exact set equality per source, including both planned near-misses |
| Unified mart is conservative | dbt + oracle | `customer_360` = 26 rows (20 canonical + 6 incomplete-flagged); 8 companies joined across all three systems |
| Suite | `npm test` + dbt | 2226 tests green across twelve workspaces (incl. 6 seeded fast-check properties); 101 dbt build steps (15 models, 3 seeds, 83 data tests) — `PASS=100 WARN=1 ERROR=0`, the one warn deliberate and mechanically pinned (see below) |

## What's coming (built in phases, in public)

- **Phase 3 — Agent depth:** one carefully-bounded write action behind human
  approval with a full audit trail, plus an evaluation suite for report quality.
- **Phase 4 — Operations:** monitoring dashboards, alerting, a live deployment,
  and a demo video.

## How this was built

One engineer, directing a fleet of AI coding agents under an evidence-gated
process. That is worth stating plainly, because "built end-to-end by one
engineer" would be the same species of overstatement this repo's
[known-issues ledger](KNOWN-ISSUES.md) exists to refuse. The engineering claim
here is not that a human typed every line; it is that **nothing was allowed to
land on the strength of an agent's own account of it.**

The loop, per unit of work:

1. **Brief** — a written task brief stating the requirement, the risk rules, and
   what would count as evidence.
2. **Implementer** — an agent builds it and writes a report.
3. **Framed review** — a second agent reviews against the brief and the spec.
4. **Fix loop** — findings answered, with the fix's own evidence.
5. **Cold, unframed review** — before every push, a *fresh* reviewer is given the
   repository and a commit range, **barred from this project's own briefs,
   reports and reviews**, and instructed to attack the claims rather than confirm
   them. All of it is in the repo: `.superpowers/sdd/` carries **33 task briefs,
   52 reports, 24 framed per-task reviews, 11 cold-review documents (10 distinct
   cold reviews plus one fix response), and 79 commit-range diff packages** —
   counted at commit `6a82842`.

Cold review earns its place by what it actually caught. Three findings, none of
which a framed reviewer had produced:

- **A disclosure that died during the exact incident it existed for.** A source
  that was both unreachable *and* carrying an unacknowledged permanent data-loss
  gap printed the unreachable error and nothing else — no loss line, no
  acknowledgement prompt. The exit code still failed, so the *gate* held while the
  *human* got nothing. The implementer's own note on it: "that is the failure
  mode migration 010 exists to prevent, and I had put the read below the two
  `continue`s myself." The class recurred often enough to be named in the
  phase-close sweep as the phase's most-recurring defect species.
- **A fix whose test passed with *and without* the fix.** A pin placed its
  fixture outside the window where the bug lives, so buggy and fixed code both
  answered identically — while the report claimed it "pins exactly this." That
  incident is why every later task brief carries a standing rule to
  **revert-check every new pin**, and why later reports carry an explicit
  "revert-check evidence" table: the fix is reverted and the test must go red.
  Honest limit: that discipline is documented per-pin from the mid-phase A-slice
  onward and comprehensively from Task E; for earlier work it is narrated, not
  proven. Two further vacuous pins were caught the same way, including a CI data
  test that had been passing because no fixture row could ever trip it.
- **Real company names shipped as synthetic data.** The SaaS vertical profile's
  invented "flavor words" included two exact matches for real (defunct)
  companies. The reviewer found them with citations — against a rule the same
  range had written itself two files earlier. Replaced with vetted inventions.

Two other cold reviews reported that a range **broke its own CI gate** (the
reviewer reproduced the CI composition on a scratch database rather than taking
the green local suite's word), and that a task's **headline deliverable was
unreachable from every shipped operator surface** while the runbook claimed it
was reported. Both were true.

Fixes were researched before they were written, not after. Four research
documents in `.superpowers/sdd/` (`close-fix-research.md`,
`debt-burn-research.md`, `f2-wire-research.md`, `market-unification-research.md`)
carry per-claim citations to primary sources actually opened — PostgreSQL,
AWS, GitHub Actions, Stripe, HubSpot and Salesforce developer documentation,
RFCs, and vendor knowledge bases — with a stated adversarial method (each
candidate fix treated as a hypothesis, with a refutation attempted before it was
endorsed) and with failed fetches disclosed inline rather than quietly dropped.

What this does *not* claim: that the process is free of misses. Several of the
findings above were caught late, after the work had already been reported
complete by an agent and accepted by a framed review. The argument for the
process is that they were caught *at all*, in public, and written down — which
is the same argument this repository makes about its data.

## For engineers

**Architecture (current):** six mock source servers across five paradigms (shared
`@switchboard/mock-core`: PRNG faults, HMAC signing, keyed hash-chain ledger,
correlated seed manifest) → Express 5/TypeScript ingest (`/webhooks/:source`,
per-source HMAC verify, per-source pg-boss queues + DLQs, per-source cursors) →
single `raw.raw_events` (`(tenant_id, source, event_id)` unique) → dbt: 9 staging views
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
- [Connector-paradigms ADR](docs/adr/connector-paradigms.md) — the four paradigms,
  why each mock is faithful to a documented vendor behavior, and the honest
  fidelity deltas (no OAuth, HTTP/JSON where the vendor uses gRPC, the two
  disclosed merge-modeling inferences)
- Journals — what was planned vs. what actually happened, including the misses:
  [Phase 0](docs/log/phase0.md) · [Phase 1](docs/log/phase1.md) ·
  [Phase 2a](docs/log/phase2a.md)

**Prerequisites:** Docker (for Postgres) and Node.js ≥ 22.

**Run it:**

```bash
npm install
./scripts/demo.sh        # end-to-end: 560 events, 4 faithful sources → per-paradigm reconcile + identity checks → report
./scripts/chaos.sh       # seeded faults across two paradigms → zero-loss proof
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

The spreadsheet-as-CDC connector is deliberately not in
`demo.sh`; its proof is its own oracle suite (with the database up, as above):
`cd ingest && npx vitest run test/sheet-oracle.test.ts test/sheet-mart-oracle.test.ts`
— drop-heavy convergence, blank-row tolerance, quarantine custody, and the mart joins.

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
company DEMO-C-0001 DEMO Cloudbriar Software 1 · cloudbriar-1.example.com
company DEMO-C-0002 DEMO Datawren Software 2 · datawren-2.example.com
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

## The follow-up loop (core loop, Wave 1)

A broker's leads come from networking events and referrals. She takes a phone number, and
then the follow-up doesn't happen and the lead goes cold. The loop closes that:

```
capture (numbers + provenance + channel)
   → memory (next_due_at; "who is due today")
      → proposal, one per channel, on the approval spine that already exists
         → contact: her question list, delivered by voice
            → answers stored per question
               → clock reset (and the cycle's follow-up closed) → back to memory
```

**The product is step 2.** Everything else feeds or consumes it.

🚨 **WHAT SHIPS TODAY (Wave 1) vs WHAT DOES NOT.** Wave 1 is capture → memory → proposal →
call → **answers stored** → clock reset, and the call leg is REAL (T16 — built):
`livekitPlaceCall` (`crm/src/call-transport.ts`) dispatches an agent worker into a per-call
LiveKit room, dials the callee exactly once through a provisioned outbound SIP trunk
(Zadarma), and a Gemini Live realtime model holds the conversation, with every answer
persisted to `crm.answers` mid-call, per turn. Live calls have been placed and answered.
The **voice vendor is still faked in tests** (`scriptedPlaceCall` — no test opens a
socket), and the executor daemon composes the stub unless the complete LiveKit/model env
is present. **There is no summarisation and no transcript email built** — T17 (summary)
and T18 (transcript email) are Wave 2 and unbuilt. The `crm.touches` columns and CHECK for
a summary and a `transcript_delivery` status exist in migration 016, but **no code writes
them yet**: a call today leaves `transcript_delivery = 'pending'` because that is the value
written at call start and nothing moves it. In the artifacts table below, the answers row
operates today; the two rows marked *(Wave 2)* are designed, not built.

**EMAIL IS WIRED END TO END.** For a contact whose channel is `email` or `both`, the
proposer builds and POSTs a real `send_email` card; she approves it in `/queue`; and
`executeEmail` sends it through the configured relay, recording the submission against the
touch. Bounces are reconciled asynchronously, because a relay that accepts now can refuse
later. Before anything leaves, a send-time recheck reads her live sheet: if the recipient
she approved is no longer the recipient her sheet names, the card is blocked rather than
sent, and if the sheet cannot be trusted (a halted adoption breaker, an open divergence
block) the send WAITS instead of guessing.

🚨 **CALLS ARE WIRED — NOT DEPLOYED, AND NOT DONE.** `place_call` cards are proposed,
rendered and approvable; `executeCall` orchestrates the call lifecycle; and `PlaceCall` has
a production implementation: `livekitPlaceCall` (`crm/src/call-transport.ts`, on
`livekit-server-sdk`) validates its injected config at construction — an empty phone
allowlist refuses to build — dispatches the agent worker before the dial so AMD hears the
first audio, dials the approved number exactly once per touch, and returns the worker's raw
SIP/AMD signals for `disposition.ts` alone to interpret. Two workers exist under
`voice-agent/` (deliberately not a workspace): `worker.ts`, the `@livekit/agents` plugin
path, and `worker-direct.ts`, its successor, which owns a raw Gemini Live socket and
registers under a separate agent name — cutover is pointing `LIVEKIT_AGENT_NAME` at it,
and `worker.ts` is the rollback. What still stands between "wired" and "done": only
numbers on `SWITCHBOARD_PHONE_ALLOWLIST` can ring, checked in the executor and again at
the transport; **nothing is deployed** — the approval service, proposer, executor daemon
and voice worker all run by hand from a developer machine, and the only containers in this
repo are the dev Postgres and a dbt tools image; **neither worker can consult the
knowledge base mid-call** (the plugin path ships zero tools to dodge agents-js #2249, and
the direct worker does not declare tools yet), so a caller's substantive questions cannot
be answered from her knowledge — the authoring surface (`/knowledge`) writes entries the
live call cannot yet reach; and **no consent record or opt-out mechanism exists** for
callees. Enroll call contacts expecting an intake questionnaire with answers stored — not
a finished product.

### What it will store, and what it does not (design)

Three artifacts, three homes, and none is derived from another at read time:

| Artifact | Home | Built? |
|---|---|---|
| Structured **answers** to her questions | Stored, keyed to the question VERSION that was asked | **Wave 1 — built** |
| A short **call summary** | Stored, length-capped by a database CHECK, marked generated | *Wave 2 (T17) — schema only* |
| The full **transcript** | **Emailed to her; never stored** | *Wave 2 (T18) — not built* |

**No audio is ever recorded, and no transcript is ever stored** — by design, in every wave.
There is nothing at rest to retain or erase, so there is no retention machinery and no
erasure machinery.

🚨 **When summarisation ships, the system will store conversation content: the summary.** It
is less sensitive than a transcript and it is still her client's words about their
circumstances. It is generated, not verbatim, and there is no stored source to check it
against — the pointer to the email that will hold the real record is the only bridge. (Today
no summary is written at all.)

🚨 **When transcript email ships, a failed send means the transcript is gone.** No copy, no
audio, no reconstruct path; the design surfaces it as `transcript_delivery = 'failed'` and a
crash between storing the summary and sending as a touch stuck at `'pending'`. Neither
recovers the transcript. Nothing can — this design is not lossless and no document here may
say it is. **None of that surfacing is wired yet** (Wave 2); it is described here so the
tradeoff is on the record before the mechanism lands.

### What it deliberately does NOT do

No inbound calls. No SMS. No reply handling. No email sequences — a single message only. No
open-ended conversation: her question list, in order. No stages, no lead scoring, no
pipeline, no CRM sync. No merging of contacts on a shared number and no identity resolution.
No inferred phone type or validity. No client dashboard — the operator surface under
`harness/` is disposable and mechanically fenced. No high availability: one proposer process
per client host. No retry of a failed call, and no walking the number list within one
follow-up — an approved proposal names exactly one number in an immutable payload.

### How it rides the approval spine

Every call and every email is a **proposal** a human approves, on the spine already
described above. The proposer does **not** insert into `approval.proposals`; it POSTs to the
same door any agent uses. The CRM's link to a proposal is **by id and is not an enforced
foreign key** — a cross-schema foreign key would require a reference privilege on the
approval tables, and keeping that surface narrow is worth more than the referential check. A
dangling link is detected by `npm run reconcile -w @switchboard/crm`, not by the database.
