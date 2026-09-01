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
   Today that means two independent layers: the assistant's server registers
   exactly one read-only tool (anything else is rejected by the protocol layer,
   and a test pins that), and the assistant's database connection runs as a
   **read-only Postgres role** — a write is refused by the database itself, also
   pinned by tests. Approval-gated action is built and running — see
   [autonomous outreach](#what-was-built-on-top-of-this-autonomous-outreach).

Anyone can verify the claims: one command (`./scripts/demo.sh`) runs the entire
system and produces the report. No accounts, no API keys, nothing to sign up for.

**Note for reviewers:** the "customer" is a fictional company and all data is
synthetic — and that's enforced, not asserted: automated hygiene checks cover
both the data generators (DEMO-prefixed ids/names, example.com emails only) and
a scan of every tracked file in the repo for real-looking emails or PII-shaped
records. Real client work can't be published, so this project shows the same
engineering on data you can inspect freely.

## Contents

| | |
|---|---|
| [The problem, in plain English](#the-problem-in-plain-english) | Why systems that don't talk cost you deals |
| [One pipeline, many businesses](#the-horizontal-thesis-one-pipeline-many-businesses) | Four integration paradigms, not a hundred bespoke connectors |
| [What's built and working today](#whats-built-and-working-today-phases-02b) | Run it yourself: `./scripts/demo.sh` |
| [Autonomous outreach](#what-was-built-on-top-of-this-autonomous-outreach) | The commercial layer, and the evidence it works |
| [How this was built](#how-this-was-built) | One engineer directing an agent fleet, under an evidence gate |
| [For engineers](#for-engineers) | Architecture, stack, and where the specs live |

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
- **CI:** the `ci` workflow runs on every push — typecheck, all 1041 tests, the
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
- 1041 automated tests, green in CI and locally — including a seeded
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
| Suite | `npm test` + dbt | 1041 tests green across nine workspaces (incl. 6 seeded fast-check properties); 101 dbt build steps (15 models, 3 seeds, 83 data tests) — `PASS=100 WARN=1 ERROR=0`, the one warn deliberate and mechanically pinned (see below) |

## What was built on top of this: autonomous outreach

The pipeline above solves half the problem — getting data out of systems that
don't talk. The other half is doing something with it.

**Proven on a live call, end to end:** the system dialled, ran a ten-question
intake by phone, transcribed the recording, wrote the summary, and delivered it —
on a call that failed mid-way and still produced a complete record. The engine
adds three more workspaces on top of the nine here, taking the suite to 2,416
tests, and went through four independent adversarial design reviews before a line
of it was written.

A broker spends a week meeting people and comes home with a stack of business
cards. The details end up in four places that don't speak to each other: the
cards themselves, her phone's contacts, a spreadsheet, her calendar. Two weeks
later she has called none of them, and half the cards are somewhere in a bag.

So this pipeline now carries an outreach engine. It reaches out to contacts on
its own cadence, runs the intake conversation by phone, writes down what was
said, and drafts the proposal. Every outbound action — every call, every email —
is proposed by the system, approved by a human, and only then executed.

That is the horizontal thesis again, one layer up. The paradigms above cover how
a system tells you something changed; the outreach engine covers what a business
does next, and the answer is the same shape for a broker, a clinic, or a law
firm: reach the person, ask the questions, write down the answers, send the
document.

**This part is not public.** It is built for a live client engagement, the loop is
proven end to end on real calls, and the implementation is a commercial product
rather than a portfolio piece. What follows is what it does and how it was
proven.

### The engineering, in brief

- **Propose → approve → execute.** No autonomous action reaches a real person
  without a human decision in between. The approval record is the audit trail.
- **Boundaries enforced by the database, not by prompts.** What each component
  may write is a Postgres privilege. A component that tries to exceed its remit
  gets a permission error, not a polite refusal — the same doctrine as the
  read-only role above, applied throughout.
- **Append-only records.** Answers and transcripts are INSERT and SELECT only.
  Nothing can rewrite what a caller said.
- **The system states what it doesn't know.** A record names the questions that
  went unanswered rather than filling the gap.

### A defect worth describing

The voice model's live transcription dropped and corrupted answers without
raising an error. On one measured call it delivered no transcript for four of ten
questions, while an independent audio-energy meter recorded 2.4 to 4.0 seconds of
continuous speech in each of those windows. The summary that reached the client
said the caller "did not answer" questions he had answered aloud. On another call
it rendered "30 to 40 million pesos" as "40 million facebooks."

You can spot a missing answer. You cannot spot a wrong one that reads well, which
is why the second failure matters more than the first.

The diagnosis took instrumenting the answer window and reading the vendor's own
issue tracker: it is a known, unfixed defect in streaming transcription, not a
bug in the calling code. The fix was to stop trusting the live stream for the
record — the call is transcribed afterwards, in one batch pass over the audio,
and that transcript becomes the authoritative account. Batch transcription
doesn't hit the defect, and it can be given context the live stream cannot
accept, which is what recovers place names an 8kHz phone line mangles.

### How it was verified before it was built

Four independent adversarial reviews, on two different models, read the design
against the code before a line was written. Between them they found: a migration
missing a column-level grant that would have made the feature write nothing at
all; an idempotency key that would have made it dead code on every call it
existed for; a synchronisation step that didn't synchronise; and a retry loop
with no consumer. Each would have cost a live call to discover.

Every test was checked against a broken build before it was trusted: remove the
guard, watch the test go red, put the guard back. A test that passes whether or
not the code works tells you nothing.

## What's coming

- **Operations:** monitoring dashboards, alerting, a live deployment.

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
calls + LLM narrative — deterministic template fallback when `ANTHROPIC_API_KEY`
is unset).

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
