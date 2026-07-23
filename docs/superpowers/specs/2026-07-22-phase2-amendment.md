# Switchboard Phase 2 — Spec Amendment: Width + Vendor Fidelity

**Date:** 2026-07-22
**Status:** Draft — awaiting Michael's review before any implementation
**Amends:** `2026-07-21-switchboard-design.md` §6 (Phase 2) and §7 (out-of-scope)
**Decision on record:** Michael chose the *expanded* Phase 2 scope (2026-07-22) — the
original "width" work plus the parked vendor-fidelity ideas.

## 1. Why this amendment exists

The original spec's Phase 2 was lean: add billing + support systems, resolve
identities across them, build `customer_360`, add CI. That still holds — it's
**Phase 2a** below. The expansion (**Phase 2b**) addresses the single sharpest
criticism the deployment-readiness review raised: *everything is mock-shaped, and
the mocks are vendor-flavored, not vendor-faithful.* Making the mocks speak real
vendors' actual integration contracts — and adding a source that uses a
fundamentally different paradigm (subscribe/replay, not webhooks) — converts "it's
all mocks" from a weakness into demonstrated range across the integration patterns
enterprises actually run.

**All vendor API shapes below are grounded in current vendor docs (cited), not
invented. Exact field-level schemas are re-verified against vendor docs at
implementation time — the spec commits to the *paradigm*, not to a frozen schema.**

### 1a. Positioning (narrative only — NOT an architecture change)

Decision (Michael, 2026-07-22): Switchboard stays an **integration + unification +
agent layer over existing systems** — it does *not* become a CRM/Salesforce
replacement (that would be a product build and a weaker FDE signal). The sharpened
story: the unified customer view + AI workflows Switchboard delivers are the slice
of a heavyweight CRM that most small/mid businesses actually use and over-pay for,
so the artifact can honestly carry a "reduces platform dependence / lowers cost"
message **without building a system of record.** This is a README/framing sharpening
applied at Phase 4 write-up time; it changes no code and no scope here. The
event-bus source below is therefore about *integrating an enterprise paradigm*, not
about imitating Salesforce as a product.

## 2. Decomposition — two reviewable sub-phases

The expanded scope roughly doubles Phase 2, so it splits into two sub-phases, each
with its own implementation plan, TDD, review gates, and verification panel (per
the project's [[switchboard-verification-gates]]). 2a ships and merges before 2b
starts; 2b is independently valuable and can be deferred without stranding 2a.

### Phase 2a — Width (the original spec §6 Phase 2)
Billing + support systems as additional sources, identity resolution, the unified
model, and CI. Nothing vendor-faithful yet — 2a reuses the current webhook+ledger
mock shape for the new systems so the *unification and CI* work isn't blocked on
the vendor-fidelity rework.

### Phase 2b — Vendor fidelity
Rework the mocks to real vendor contracts, add the event-bus source, add per-system
connector agents, add vertical seed profiles. This is where the three paradigms and
the specialized-agent architecture land.

---

## 3. Phase 2a — Width (detailed scope)

**New source systems (mock, current webhook+ledger shape):**
- **Billing** (Stripe-shaped at the data level for 2a): customers, invoices,
  payments, credit notes. Events: `invoice.created/paid/voided`, `payment.succeeded/failed`.
- **Support** (Zendesk-shaped): tickets, satisfaction ratings, SLA timers. Events:
  `ticket.created/updated/solved`, `csat.recorded`.
- Each reuses Phase 1's reliability spine unchanged (HMAC, idempotent ingest,
  outbox, DLQ, backfill, quarantine, hash-chained ledger) — proving the spine is
  source-agnostic, which is itself a design win to document.

**Identity resolution (the hard core of 2a) — three deterministic tiers, no ML:**
1. Exact email match across systems.
2. Normalized domain + company-name match.
3. Unmatched → a `manual_review` table (never silently guessed).
Plus **merge handling**: real CRMs merge duplicate records; a `company.merged` event
(fromId → toId) must collapse identities downstream and re-point history. This is
new vs. the original spec and directly answers an audit finding.

**Unified model:** `customer_360` mart joining CRM + billing + support into one
record per resolved entity (health signals, revenue, open tickets, SLA breaches) —
the data the Monday report and future agents read.

**CI (GitHub Actions):** typecheck + all workspace suites + `dbt build`/tests +
the action-safety eval on every push; the chaos + demo scripts on a nightly or
manual trigger (too heavy/flaky-prone for per-push per the Phase 0 eval-split
rationale). This finally makes the repo's green checks *visible on GitHub* to
reviewers — a real portfolio upgrade. Fork-PR secret handling per the existing
split (deterministic checks gate; anything needing a key runs on label/nightly).

**Identity-resolution provenance:** every resolved link records which tier matched
and the evidence, so the resolution is auditable (a real FDE deliverable, not a
black box).

---

## 4. Phase 2b — Vendor fidelity (detailed scope)

### 4.1 Three integration paradigms, three faithful mocks

| Mock | Real vendor shape (sourced) | What it teaches |
|---|---|---|
| CRM | **HubSpot-style thin webhooks**: metadata-only payloads (object id + changed property), batched ≤100/req, 10 retries/24h; consumer must **fetch the full record** via REST after the event ([HubSpot v3](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)) | The "thin event → hydrate" pattern; batch delivery; the fetch-after-notify round trip |
| Billing | **Stripe-style webhooks**: full-object envelope (`data.object`), cursor pagination `starting_after`/`limit` 1..100 ([Stripe events](https://docs.stripe.com/api/events), [pagination](https://docs.stripe.com/api/pagination)) | Opaque-cursor pagination; signed full-payload events; event-type taxonomy |
| Support / enterprise | **Enterprise event-bus paradigm** (Salesforce Pub/Sub is the reference example): no webhooks — subscribe to a replayable stream with a replay cursor (Pub/Sub/CDC model) ([Salesforce Pub/Sub](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/intro.html)) | Subscribe/replay vs. push; the paradigm most webhook-only integrations can't handle. Demonstrates *integrating* an event-bus source, not imitating a specific vendor product |

**Design note:** the thin-webhook CRM breaks a hidden Phase 1 assumption — ingest
currently stores the full pushed payload. The faithful HubSpot mock forces a
**hydration step** (fetch full record on event), which is a real connector
responsibility and a good thing to build. The event-bus source needs a
**subscription connector** holding a replay cursor rather than an HTTP endpoint —
Phase 1's cursor-backfill already models half of this; 2b completes it.

### 4.2 Per-system specialized connector agents

Instead of one generic ingest pipe, each source gets a connector with
system-specific handling, coordinated by the unified layer above:
- **CRM connector:** thin-event hydration, batch unpacking, rate-limit budgeting for
  the hydration fetches.
- **Billing connector:** cursor-paginated backfill, full-payload verification.
- **Event-bus connector:** subscription lifecycle, replay-cursor management,
  at-least-once → idempotent-ingest handoff.
Each is a small, testable unit with its own faults and its own reliability wiring
reused from the spine. This is the "sub-agents for production workflows" deliverable
named in the Anthropic FDE posting, made concrete.

*(Terminology: "connector agent" here = a bounded per-source component, not
necessarily LLM-driven. The LLM-driven agent work stays Phase 3. If any connector
warrants LLM decisioning, that's flagged for Phase 3, not built here.)*

### 4.3 Vertical seed profiles

The seed generator takes a `profile`: `plumbing | clinic | saas` (extensible),
swapping vertical-appropriate synthetic names, deal/invoice types, ticket
categories, and value ranges — so the same one-command demo produces a
*plumbing-business* Monday report or a *clinic* one. Still fully synthetic, still
hygiene-test-enforced. Demonstrates the FDE "make the demo speak the customer's
language on day one" motion. A README screenshot trio (three verticals) is the
visible proof.

## 5. What stays out of scope (unchanged)

- No real vendor credentials/OAuth flows — the mocks model the *contracts*, not live
  auth. (OAuth token-refresh remains a documented real-connector-delta item.)
- No ML/fuzzy identity matching — deterministic tiers only.
- No LLM-driven agentic tool selection — Phase 3.
- No production deployment/observability — Phase 4.
- The event-bus mock models the Pub/Sub *paradigm* (subscribe + replay cursor over
  HTTP/JSON for testability), not literal gRPC/Avro — documented as a deliberate
  fidelity boundary.

## 6. Sequencing & risks

- **2a before 2b.** 2a is the lower-risk, higher-certainty half and makes the repo
  CI-visible fastest. Merge 2a, then start 2b.
- **Biggest 2b risk:** the thin-webhook hydration rework touches the ingest path that
  Phase 1 hardened. Mitigation: the faithful CRM mock is added as a *new* source
  alongside the existing one; the hydration connector is new code; the Phase 1 spine
  and its chaos proof stay green throughout (the chaos test is the regression guard).
- **Effort (rough, part-time):** 2a ≈ 2–3 weekends; 2b ≈ 3–4 weekends. 2b is
  deferrable after 2a without waste.

## 7. Open questions for Michael

1. **Event-bus fidelity boundary:** model the Pub/Sub paradigm over plain HTTP/JSON
   (testable, in-keeping with the other mocks) — confirmed default? Literal gRPC/Avro
   would be high-cost, low-portfolio-marginal-value (my judgment).
2. **CI compute:** GitHub Actions free tier is fine for the deterministic suite;
   the chaos/demo scripts need Docker-in-CI (services) — run those nightly/manual,
   not per-push. Agree?
3. **Vertical profiles:** `plumbing | clinic | saas` the right first three, or swap
   one (e.g. `logistics`)?

---

## 8. Rev 2 — corrections & decisions after Fable-5 spec review (2026-07-22)

The Fable-5 review found a load-bearing error and several gaps. Decisions locked
here (Michael's recommended-default authority; each is reversible design, flagged
for veto). These supersede anything above they conflict with.

**D1 — Spine is single-source hardcoded; generalizing it is 2a Task 1 (not "unchanged").**
Correction to §3: Phase 1's spine pins one source (`raw.raw_crm_events`,
`/webhooks/crm`, `CRM_SOURCE="crm"`, one `ingest-event` queue, single HMAC secret,
`stg_crm__companies.sql`). Adding sources REQUIRES parametrizing ingest, reconcile,
the mock ledger machinery, and the queues — and this happens in **2a**, touching the
hardened path. The **chaos reconciliation test is the regression guard for this
work** (same guard §6 reserved for 2b — it applies in 2a too). Revised 2a estimate:
**3–4 weekends**, not 2–3.

**D2 — Raw storage: ONE table `raw.raw_events` with a `source` column** (not
per-source tables). Uniform reconcile/backfill/DLQ, dbt filters by `source`; unique
index becomes `(source, event_id)`. Drives all staging models.

**D3 — Per-source HMAC secrets** (`WEBHOOK_SECRET_CRM`, `_BILLING`, `_SUPPORT`),
not one shared secret — the security posture a reviewer checks once there are 3
sources.

**D4 — Correlated cross-system seed manifest is a 2a deliverable.** One master seed
deterministically derives all sources' entities with a PLANNED matrix: cross-system
overlap (for tier-1 email match), deliberate ~8% duplicates, near-miss domains
(tier-2), unmatchable rows (tier-3), and merge-candidate pairs. Also: add the
`contacts` entity the original spec §2 listed but the seed never had. Build the
generator to accept a `profile` param NOW (stubbed in 2a); vertical profile *content*
lands in 2b — avoids rebuilding the generator twice.

**D5 — Identity resolution + merge, fully specified.** Three deterministic tiers
(exact email → normalized domain+name → `manual_review` table, a plain Postgres
table/incremental model, NOT a dbt `seed` which is static CSV). Merge: immutable
`merge_edges` table from `company.merged` (fromId→toId); resolution = follow-to-
terminal with a cycle guard, computed **at mart build only — raw is never rewritten**
(preserves append-only). dbt tests assert no cycles + all chains terminate.
Transitive merges (A→B→C) resolve by batch recompute over full history (arrival
order washes out — state this as the design property). **Unmerge: out of scope**
(real CRMs barely support it). Every resolution records matched-tier + evidence +
merge lineage (auditable).

**D6 — customer_360 grain:** an entity present only in billing or support DOES get a
row, flagged `incomplete` (more useful than hiding it); mart uniqueness tests key on
the resolved entity id.

**D7 — Hydration (2b), fully specified so it does NOT threaten the spine:** the thin
HubSpot event is stored in `raw.raw_events` exactly as received (ledger
reconciliation over event_ids is untouched — the spine's "store what you received"
contract never changes). Hydrated full records go in a SEPARATE table keyed
`(event_id, fetched_at)`. Second oracle: every thin event → a hydrated snapshot OR
the DLQ, nothing in limbo (hydration fetches fail independently — 429/5xx/404).
Races handled: deleted-before-fetch → 404 → tombstone; fetch returns *fetch-time*
state while the event carries *notify-time* `occurred_at` → staging occurred_at-wins
logic governs.

**D8 — 2b support source = Salesforce Service Cloud *cases* via the Pub/Sub
paradigm** (not Zendesk-on-a-bus, which is a mash-up). Service Cloud is genuinely a
support product consumed over the event bus → vendor-faithful AND carries the
event-bus paradigm, no fourth system, no product-imitation drift (you integrate
*over* Salesforce — exactly the stated positioning). 2a's support connector is
acknowledged scaffolding that the 2b bus source replaces.

**D9 — Old CRM mock retires at 2b exit**, AFTER the chaos harness (fault plans +
hash-chained ledger) is ported to the faithful HubSpot mock. No "two CRMs forever."

**D10 — Verticals: `plumbing | saas | logistics`** (drop `clinic` — it collides with
the original spec §7 health-domain deferral and invites HIPAA-flavored scrutiny for
zero portfolio gain; logistics matches existing seed sectors and spans trades /
software / enterprise-ops).

**D11 — CI:** per-push = typecheck + unit/integration suites (Postgres as a GitHub
Actions service container, free-tier fine) + `dbt build`/tests + action-safety eval;
chaos + demo = nightly + manual dispatch + on-label, with the chaos fault-plan seed
as a workflow input (reproducible red runs) and the nightly result surfaced in the
README (badge/link) so the most impressive check is visible to a reviewer.

**D12 — Event bus over HTTP/JSON** (not gRPC/Avro): model the load-bearing paradigm
parts — subscribe, per-event `replay_id`, resubscribe-from-replay_id after
disconnect, at-least-once → idempotent-ingest handoff. Document the delta in an ADR
alongside the OAuth delta.

**D13 — Positioning ADR line:** `manual_review` and the approval table are
Switchboard *operational* state, not a system of record; the Phase 4 README line
stays pinned to "reads from, never masters, customer data."
