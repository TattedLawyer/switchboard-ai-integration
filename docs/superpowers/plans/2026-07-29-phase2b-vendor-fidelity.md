# Phase 2b — Vendor Fidelity: Phase Plan (final, rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. This is the PHASE plan: thesis, research-verified contracts, resolved decisions, and the complete task map. At dispatch, each task receives a writing-plans-grade brief (exact code, bite-sized steps) derived from its section here — the 2a-proven mechanism. An implementer reads its brief, not this whole plan.

**Spec:** `docs/superpowers/specs/2026-07-22-phase2-amendment.md` §4 + Rev-2 decisions D1–D13 (amended by 2b-D3 below).
**Base:** branch `phase2b-connectors` off `main` @ `b6d1de3` — includes the connector seam (Task 1, complete), tenancy migration 006, durability, migration tracking, and the numeric-integrity stack. Baseline: 282 node tests (ingest 199 / agent 31 / mocks 52), dbt 79, typecheck clean, CI + chaos green.
**Gates:** A–H per the project's verification gates — per-task RED→GREEN with evidence, task reviews with dual verdicts, fix+re-review loops, phase-close panel, register sweep, and the cold unframed review before every push. Single-flight: one implementer in the worktree at a time.

---

## 1. Thesis — one horizontal core, many verticals

Switchboard works for multiple businesses because different industries share the same backend practices: client intake, billing, customer service, pipeline. The core is vertical-agnostic **by construction** — the mart models entities/contacts (intake), invoices/payments (billing), tickets/CSAT (service), deals (pipeline); no column is industry-specific; connectors are *paradigm*-specific (webhook, cursor feed, event bus, spreadsheet), never *industry*-specific; vertical profiles swap only vocabulary and scenario content.

**Applicability criterion:** any business whose client roster lives in more than one system, that invoices recurringly, fields inbound service requests, and runs a deal or booking pipeline. Industry families that fit (derived from the criterion, not a market claim): trades & field services (plumbing, HVAC, electrical, roofing, landscaping, cleaning, pest control); real estate (brokerages, property management); professional services (law, accounting, consulting, insurance brokerage, financial advisory); agencies (marketing, design, staffing); software/SaaS; logistics & wholesale distribution; auto services; education & training; hospitality & events; fitness & wellness; healthcare-adjacent practices (clinics, dental, therapy) — the last requiring a compliance layer and deliberately not a demo profile (D10's original reasoning). Vertical-specific needs land in profile content or per-engagement configuration, never in core schema — the discipline that keeps vertical N+1 a configuration exercise, not a fork. This section feeds the Phase-4 README positioning (D13).

2b's job under this thesis: prove the *paradigm range* of the connector layer. Four genuinely different integration contracts land on one unchanged spine.

## 2. Research foundation (full primary-source reads, 2026-07-29; Sheets 2026-07-27)

**CRM — HubSpot-style thin webhooks** ([guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)): payloads carry `objectId`, `propertyName`/`propertyValue` ("only sent for property change subscriptions" — sparse by design), `eventId`, `subscriptionType`, `portalId`, `occurredAt` (ms epoch), `attemptNumber` (from 0), `changeSource`; "Each request can contain up to 100 events"; **ordering NOT guaranteed — sequence by `occurredAt`**; retries "up to 10 times… spread out over the next 24 hours", >5s response counts as failure. Auth: mocks keep the repo's per-source timestamped HMAC (D3) — the spec models contracts, not vendor auth; delta goes in the connector ADR.

**Billing — Stripe-style events feed** ([Events](https://docs.stripe.com/api/events), [List](https://docs.stripe.com/api/events/list)): events retrievable "for **30 days**"; `limit` 1–100 (default 10); `starting_after`/`ending_before` object-id cursors; `has_more`; `type`/`types` (≤20) filters. **Response ordering is not documented** — the connector drains by `has_more` and orders downstream, never by response position.

**Support — event-bus subscribe/replay** ([durability](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html)): "Salesforce stores platform events… for **72 hours**"; replay IDs are opaque and "aren't guaranteed to be contiguous"; a stored replay ID resubscribes within the window; **the stream can be reset entirely** ("if the Salesforce org is moved to a new instance") — cursor invalidation has two causes, age-out and reset. EARLIEST/LATEST presets per the Subscribe RPC reference (re-verify enum at implementation). Modeled over HTTP/JSON (D12).

**Spreadsheet — Google Sheets as a source** (verified with full reads 2026-07-27): developer metadata is row-attached, follows rows through insertions, dies with its row ([API reference](https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets.developerMetadata)); 30,000-char caps per sheet AND spreadsheet ([guide](https://developers.google.com/workspace/sheets/api/guides/metadata)); **"Script executions and API requests don't cause triggers to run"** ([installable triggers](https://developers.google.com/apps-script/guides/triggers/installable)) — push is latency-only, reconcile is the guarantee; quotas 300 read/min/project, 60/min/user, 429 + documented backoff ([limits](https://developers.google.com/workspace/sheets/api/limits)); access via service-account share ([gspread](https://docs.gspread.org/en/latest/oauth2.html)); Script Properties readable by any sheet editor ([Workspace DevRel](https://dev.to/googleworkspace/secure-secrets-in-google-apps-script-1dhc)) → per-sheet low-trust secrets. No event_id, no occurred_at, in-place mutation → idempotency is manufactured (row key + content hash), `occurred_at` stamped at detection and flagged derived. Five deliberately-unverified behaviors, each pinned by a test in Task A before the connector shape freezes: real metadata ceiling; metadata across duplication; installable-trigger queue depth under bulk edits; `onEdit` oldValue on multi-cell paste; trigger daily-quota behavior.

## 3. Design consequences

1. **Latest-state tiebreak successor** (register LANDMINE; owned by Task C): no vendor id is ordinal. Successor ordering: `occurred_at desc, received_at desc, event_id desc` with per-source `occurred_at` normalization (HubSpot ms, Stripe s, bus event time, Sheets detection time). The `(substring(event_id from 5))::bigint` cast dies in the same task; a pin proves the successor produces IDENTICAL latest-state on 2a-shaped (evt-N) data before the swap.
2. **Two honest data-loss boundaries, built and chaos-injected**: bus replay-cursor invalid (aged past 72h OR stream reset) → detect → configured fallback (EARLIEST/LATEST) → report an **unclosable gap with bounds**; billing backfill older than 30 days → report the unreachable range. Both in KNOWN-ISSUES as stated limits. The pipeline's first admitted losses — reported, never papered over.
3. **Sparse payloads are the CRM norm**: the numeric contract's `required: false` mechanism (built, unit-pinned) goes live for the faithful CRM source; the contract applies to hydrated snapshots too (hydrated records are still vendor data).
4. **Reconcile-first is uniform**: every paradigm's push/stream channel is lossy on its own terms (triggers blind to API writes; 72h window; 30-day cap; 10-retries-then-gone). Every connector's `reconcile()` is the guarantee; the seam's interface contract already says so.
5. **Raw storage — expand now, contract at Phase 4** (2b-D4): Task A's migration adds `raw_body text NULL` to `raw.raw_events`; every door dual-writes wire bytes where they exist (webhook and poll doors already hold them; the Sheets connector stores the canonical JSON it emits). Claim-check enqueue + nullable `payload` + consumer tolerance = the Phase-4 contract step, register-owned. Rationale (full-read research): preparatory refactoring is unwarranted when the feature "slots naturally into current architecture" ([Fowler](https://martinfowler.com/articles/preparatory-refactoring-example.html)); carrying the current contract is prudent-deliberate debt with small interest ([Fowler](https://martinfowler.com/bliki/TechnicalDebtQuadrant.html)); but pure deferral permanently loses wire bytes for every event ingested meanwhile — the additive expand phase ([Fowler, parallel change](https://martinfowler.com/bliki/ParallelChange.html); [Hodgson](https://blog.thepete.net/blog/2023/12/05/expand/contract-making-a-breaking-change-without-a-big-bang/); [Prisma](https://www.prisma.io/dataguide/types/relational/expand-and-contract-pattern)) captures custody from Task A onward at near-zero risk. Disclosed costs: temporary dual storage; the pattern's documented never-contract failure mode — mitigated by the named Phase-4 owner.

## 4. Decisions (all resolved — nothing open)

| # | Decision | Status |
|---|---|---|
| 2b-D1 | Sequencing: **Sheets connector first** (hardest paradigm stress-tests the seam; real prospect class behind it; most distinctive artifact) | Resolved 2026-07-29 |
| 2b-D2 | **Build** cursor-expiry/data-loss handling (consequence 2) | Resolved 2026-07-29 |
| 2b-D3 | Vertical profiles **`plumbing \| saas \| realestate`** (amends D10: logistics out) | Michael, 2026-07-29 |
| 2b-D4 | Raw storage **expand now / contract Phase 4** (consequence 5) | Michael-directed research, 2026-07-29 |
| 2b-D5 | Horizontal-core thesis is a design CONSTRAINT: nothing industry-specific enters core schema | Michael, 2026-07-29 |
| — | Bus over HTTP/JSON (D12) · hydration separate table (D7) · bus source = Service-Cloud-cases-shaped (D8) · old CRM retires at exit (D9) · positioning (D13) | Locked in spec Rev-2 |
| — | Text-first CONTRACT step, tenancy analytics half, prompt-injection defense (pre-Phase-3 gate) | Explicitly out of 2b |

## 5. Task map

Order: **A → B → C → D → E → F → G → Close.** A is the only task others structurally depend on (its migration carries shared columns); B/C/D are mutually independent but run single-flight; E–G close out. Every task: RED→GREEN commit pairs, task review (spec + quality verdicts), fixes re-reviewed, evidence in reports.

### Task A — Google Sheets source + connector *(the centerpiece; carries the shared migration)*
- **Mock** (`mocks/sheets/`): HTTP service modeling the needed Sheets API subset — values read, developer-metadata row keys, 429 fault injection — plus a **simulated human editor** with seeded fault plans: in-place edits, row insert/delete, header rename, blank rows, free-hand dates, garbage currency, bulk paste. The sheet's row set is the reconciliation truth (this paradigm's ledger-equivalent).
- **Migration** (`ingest/migrations/007_*.sql`): `raw_body text NULL` on `raw.raw_events` (2b-D4 expand) + quarantine `attempts`/`last_attempt_at` (register C4) + `FOR ROLE` fix on default privileges (register C2).
- **Connector** (`ingest/src/connectors/sheet-snapshot.ts`, `kind: "sheet-snapshot"`): snapshot read → row key via metadata → content-hash diff → derived events (`sheet.row_upserted` / `sheet.row_deleted`; event_id = content-addressed hash **plus a stateless supersession counter** — AMENDED after the A4 review found the bare scheme Critical (ABA revert blindness: a human undo A→B→A re-derives the original id, dedups at ingest, never lands, and reads permanently stale in reconcile). A re-occurring (rowKey, content) pair gains `-r<n>`, n = prior ingests of that pair derived from `raw` at diff time; emission only on diff-vs-latest change, so idempotent re-runs still emit nothing and n=0 stays unsuffixed; `occurred_at` = detection time, flagged derived) → ingested through the standard door (contract, quarantine, idempotency, tenancy all apply unchanged). `reconcile()` = full snapshot-diff vs `raw` latest-state — the primary channel.
- **Contract extension** (`ingest/src/numeric-contract.ts` → string rules): `{ pattern, required }` for text fields so garbage cells (currency, dates) quarantine with named reasons at the door. Wave 5's currency-at-door lands here; the count-presence trade is documented from the register; staging's regexp stays as doorless-row containment.
- **Doors dual-write `raw_body`** where wire/canonical text exists (webhook `rawBody`, poll `pageText`, sheet canonical JSON).
- **Test obligations (RED first):** the five unverified Sheets behaviors pinned FIRST (§2); derived-idempotency (same content twice → duplicate; edited cell → new event); diff correctness under each fault plan; reconcile oracle — TWO STAGES (amended at A4 close): stage 1/slice A5 = sheet rows ⇄ RAW latest-state exactly after any fault-plan run, quarantine-aware (every rejected cell has a quarantine row naming the field; the ABA revert soak is a standing scenario); stage 2/slice A6, separately gated = warehouse consumption (staging model, identity resolution as a fourth source, mart integration) extending the oracle to sheet ⇄ mart — split because A6 touches the hardened identity layer with its own landmine list, and bundled reviews are where Critical-per-slice streaks go to die; string-rule door tests incl. over-rejection guards; dual-write presence pins; migration idempotency.
- **Done:** oracle green under all fault plans; full gauntlet green; KNOWN-ISSUES + RUNBOOK entries for the paradigm's limits (quota budget, trigger blindness, per-sheet secrets).

### Task B — Billing: Stripe-faithful feed
- Mock: envelope (`data.object`, `evt_…` opaque ids, `created` s-epoch), `starting_after` cursor, `has_more`, `limit` 1–100.
- Connector: `has_more`-driven termination (kills the empty-page inference class fixed once at `f1e7ac4`); **30-day boundary**: backfill target older than retention → reported unreachable range (consequence 2); order by `created`, never response position.
- Debt: poll fetch timeout (`AbortSignal`, register L1-G4); feed-supplied-cursor skip-forward fix (cursor advances only past verified-ingested events).
- Tests: pagination drain (multi-page, exact-boundary, empty-feed); retention-boundary report pin; timeout wedge pin (black-holed socket → bounded failure, cursor intact); cursor-skip regression pin.

### Task C — CRM: thin webhooks + hydration
- Mock: batched (≤100) sparse property-change events with the §2 field set; out-of-order delivery in fault plans (ordering is explicitly not guaranteed).
- Connector: batch unpacking; hydration fetches with rate budget; D7 snapshot table `(event_id, fetched_at)`; tombstones for deleted-before-fetch (404); hydration DLQ; **second oracle**: every thin event → hydrated snapshot OR DLQ, nothing in limbo.
- **Tiebreak successor lands here** (consequence 1) + evt-N cast removal; `required: false` flips for the sparse source's contract entries.
- Tests: hydration-failure classes (429/5xx/404) each to their path; oracle under chaos; out-of-order occurredAt convergence; the 2a-identical-latest-state pin for the ordering swap; sparse-payload acceptance + hydrated-snapshot contract enforcement.

### Task D — Support: bus subscribe/replay
- Mock: HTTP/JSON stream endpoint with per-event opaque `replay_id` (non-contiguous by design), subscription lifecycle, 72h retention window, **stream-reset fault**.
- Connector: replay-cursor persistence (per tenant/source); cursor-invalid detection (age OR reset) → configured fallback (EARLIEST/LATEST) → **unclosable-gap report with bounds**; at-least-once → idempotent-ingest handoff.
- Debt: ledger seq/uniqueness enforcement (register L1-G7) — replay makes duplicate-seq real.
- Tests: resubscribe-from-cursor exactness; expiry mid-run (chaos fault) → gap reported, pipeline continues; reset → gap reported; duplicate-delivery idempotency; gap-report content pin (bounds, cause).

### Task E — Vertical seed profiles (2b-D3)
- Generator content for `plumbing | saas | realestate` (structure already stubbed per D4-2a): vertical-appropriate names, deal/invoice types, ticket categories, value ranges; still fully synthetic, hygiene-test-enforced; README screenshot trio as the horizontal-thesis proof artifact. Realestate content stays generic vertical language (listings, closings, commissions) — never client data (2b-D5 wall).
- Tests: per-profile determinism; hygiene scan passes on all profiles; identity-oracle expectations hold per profile.

### Task F — Old-CRM retirement (D9)
- Chaos harness (fault plans + hash-chained ledger) ports to the faithful CRM mock; legacy mock + evt-N remnants deleted; free-email blocklist + normalizer hardening (register's before-tier-2-on-real-data gate) land here with the fixture rework.
- Tests: chaos zero-loss green on the faithful mock; normalizer vector pins (trailing comma, Co/PLLC, &/and, double spaces, ZWSP/NFC); blocklist demotes free-domain tier-2 matches to manual review.

### Task G — Wave 5 numeric remainder
- Bound-emission design decision FIRST (contract → dbt: dbt var/seed emitted from `numeric-contract.ts`; never a third hand-copy), then the unlikely-value row flag folded into `has_data_warnings`; declared-absence citations wired (Data Supplied = philosophy; Out-of-Bounds = invariant, citing `assert_csat_in_scale` + `assert_amounts_non_negative`).
- Tests: emitted-bound consistency pin (contract value == dbt value, mechanically); unlikely-value trigger pin (isolating, per the Gate-H lesson); prevalence re-measured.

### Close
Full gauntlet (node + dbt live-fire on isolated stack + demo/chaos via CI label) → three-lens panel → Gate E register sweep (every 2b-owned item resolved or explicitly re-deferred) → **Gate H cold unframed review** → docs pass (README two-layer update incl. thesis + profiles trio, RUNBOOK, KNOWN-ISSUES, connector ADR incl. auth + HTTP/JSON deltas) → PR to `main`, merge commit, Michael merges.

## 6. Debt map (register items → owners)
C4 attempts + C2 FOR ROLE → **A** · currency-at-door + string rules → **A** · L1-G4 fetch timeout + cursor skip-forward → **B** · evt-N/L2-G6 + tiebreak successor + L2-G3 straddle re-check → **C** · L1-G7 ledger seq → **D** · free-email blocklist + normalizer + L2-G4 strip-set alignment → **F** · Wave 5 → **G** · shared crypto package → first of B/C/D to touch both signing copies · text-first CONTRACT step, tenancy analytics, prompt-injection → explicitly out (owners recorded).

## 7. Risks
1. Task C touches the hardened ingest path → new-source-alongside rule; chaos green throughout; nothing rewritten in place.
2. Sheets unknowns may force design adjustment → the five pins run FIRST in Task A, before the connector shape freezes.
3. Effort: spec said 3–4 weekends; 2a precedent says treat as floor — hardening waves are where the quality comes from; budget for them.
4. Engagement scope creep → 2b-D5 wall: repo stays synthetic; the broker's pain-points document (expected this week) maps to horizontal primitives in the plan's terms, feeds profile content only as generic vertical language, and everything client-specific stays engagement-side.

## 8. Out of scope (unchanged from spec §5 + resolutions)
Real vendor auth/OAuth (documented delta) · ML/fuzzy matching · LLM-driven connector decisioning (Phase 3) · production deployment/observability (Phase 4) · gRPC/Avro literalism (D12) · unmerge · text-first contract step (Phase 4, owned) · tenancy analytics half (pre-client, owned) · prompt-injection defense (hard gate before Phase 3).
