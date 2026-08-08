# Phase 2b journal — vendor fidelity

**Planned:** prove the *paradigm range* of the connector seam. Four genuinely
different vendor integration contracts — spreadsheet snapshot-diff, cursor-paged
feed, thin webhook + hydration, subscribe/replay event stream — landing on one
unchanged reliability spine, each mock faithful to a real vendor's *documented*
behavior (full primary-source reads, 2026-07-27/29). Seven tasks: A Sheets
(carrying the shared migration), B billing feed, C CRM webhooks + hydration,
D support bus, E vertical seed profiles, F old-CRM retirement, G the Wave-5
numeric remainder, then close. Two data-loss boundaries were to be *built and
admitted*, not papered over: the bus's 72h replay window and the feed's 30-day
retention. The spec's effort estimate was 3–4 weekends; the plan's own risk
section said to treat that as a floor. It was.

**The result (all numbers from live runs at close, HEAD `7d22c2e`):**

- 218 commits on `phase2b-connectors` off `main` @ `b6d1de3`, RED→GREEN pairs
  preserved, no squash.
- Node suite **857 tests across 9 workspace blocks** (ingest 647 · sheets 40 ·
  agent 35 · hubcrm 27 · casebus 26 · stripefeed 19 · core 59 · billing 2 ·
  support 2), from a 282 baseline. Typecheck clean; repo hygiene 6/6.
- dbt live-fire on a scratch stack: **PASS=97 WARN=1 ERROR=0** over 98 nodes
  (15 models, 81 data tests, 2 seeds), from a 79 baseline. The one warn is
  deliberate — see below. `verify-identity.ts` PASS; the 22→20 merge collapse
  holds on the flipped, faithful universe.
- KNOWN-ISSUES at close: 20 open defects (Phase 3: 3 · Phase 4: 7 ·
  unscheduled: 10), 46 design disclosures, 38 paid.

**What actually happened, beyond the plan:**

- **Task A became seven slices, and its own review rewrote the plan.** The A4
  review found the content-addressed sheet event id Critical: a human undo
  A→B→A re-derives the original id, dedups at ingest, never lands, and reconcile
  reads permanently stale — ABA revert blindness, and the defect was in the
  *plan*, inherited from the controller, not in the implementation. Fixed with a
  stateless supersession counter derived from `raw` at diff time. The same
  review split the sheet oracle in two: A5 proves sheet ⇄ raw convergence under
  every fault plan; A6, separately gated, extends it to the mart — because A6
  touches the hardened identity layer, and bundled reviews are where
  Critical-per-slice streaks go to die.
- **A debt-burn wave was inserted mid-phase, before Task E.** KNOWN-ISSUES had
  accumulated open items that nothing actually blocked, so they were burned in
  three researched slices (52 commits, 22 primary sources read in full,
  refute-first): connector/CLI semantics, ops/config hygiene, warehouse minors.
  Two lessons came out of it. One item on the burn list was already fixed
  pre-wave — burn lists need a stale-check pass at assembly. And a fix's own
  research overturned the fix: the advisory-lock item's pool-level
  implementation would have been a silent no-op, caught by reading Postgres's
  docs rather than pattern-matching.
- **The recurring defect class of this phase was state that existed but reached
  no operator.** Task B's headline deliverable — the unreachable-range gap
  report — was unreachable from every shipped operator surface, and the RUNBOOK
  said otherwise. The reconcile CLI printed "ledger hash chain: ok" for a
  paradigm that has no ledger. A report field named `gaps` was populated and
  read by nobody. Each was found by a cold review, not by the tests. The
  response is now a standing checklist line: *your new result fields must be
  consumed and printed by the operator surfaces, and the integrity line must
  match your paradigm.*
- **A fix wave introduced its own silent-loss path.** Task C's per-element
  try/catch made batch-fatal failures impossible by construction — and then
  returned 202 with `failed > 0`. HubSpot retries only on non-2xx, so an element
  that reached no bucket was acknowledged and survived as a log line. The
  re-review caught it; the status code became 500.
- **A test was written from the narrative instead of the mechanism.** Task D's
  trap-A pin asserted nothing, and the *direction* of the bug was stated
  backwards in three separate artifacts — including a commit body that is now
  immutably wrong (`77276aa`; `12c81da` is the correction of record). The
  implementer's own root cause: "I never checked the test could fail."
  Revert-checking every pin — break the fix, watch the pin go red — became a
  standing step for the rest of the phase.
- **Three real company names shipped as synthetic flavor tokens.** The Task E
  cold review found them in the profile generators; the fix replaced every saas
  token with a web-vetted invention (44 recorded searches). A repo whose entire
  premise is synthetic data had leaked real ones into it.
- **Task F sub-sliced four ways under its own weight.** F-core (straddle fix,
  shared normalizer, free-provider blocklist) → F-1 (riders, blocklist vendored
  to 13,242 rows with its MIT NOTICE, profile-seam threading) → F-1b (faithful
  merge modeling on the wire, with two inferences disclosed rather than
  asserted) → F-1c (the coordinated flip: staging re-sourced to the faithful
  mocks, `mocks/crm` deleted last). The 22→20 identity proof was the
  non-negotiable gate across the flip and came back byte-identical.
- **The CI concurrency group was wrong twice.** `github.ref` alone did not
  dedupe push against pull_request; the second attempt's
  `pull_request.head.ref || github.ref` still did not, because the two events
  spell the same branch two different ways. Only the third — normalizing both
  sides to the bare branch name — collapsed the pair, and that was confirmed by
  watching one run get cancelled as a superseded sibling, not by reading the
  docs harder.
- **An expected warning is a masking channel.** The CI dbt step is green on
  `WARN=1` by design (the fixture seeds one above-bound charge so the
  unlikely-value surface fires end-to-end instead of passing vacuously). The
  close review pointed out that a *second* warn would hide behind the first and
  dbt would still exit 0 — proven by forcing one. `scripts/verify-dbt-warns.ts`
  now pins the warn set as data, by name, count, and flagged-row identity, and
  fails closed if the expected warn ever vanishes. A per-test severity threshold
  could not have fixed this: the hazard is a *different* test hiding.
- **The process broke in three places, none of them silently.** An implementer
  agent died on an API error after its gates were green but before its report —
  recovered by verifying durable state and resuming. A model hit its usage limit
  mid-wave, which is why every later dispatch is a fresh agent with a
  self-contained brief pointing at on-disk artifacts. And a retired agent woke
  on a stale notification and committed into a worktree a successor was actively
  using; both commits were good and were kept, but stand-down orders are now
  explicit at task closure. Arithmetic went wrong too: one cold reviewer
  reported 757 tests where the suite had 820, having summed seven of nine
  workspace blocks — the same miscount class that has now bitten this repo
  twice, which is why the block-by-block numbers are written out above.

**Honest limits shipped with it:** no real vendor auth or OAuth (documented
delta in the connector ADR); the bus is modeled over HTTP/JSON, not the vendor's
native transport; two merge-modeling behaviors are disclosed inferences from
vendor documentation rather than observed wire captures. The two data-loss
boundaries are real and reported with bounds — the pipeline's first admitted
losses.

**Deferred, with owners:** the full 2a retirement wave (the billing and support
mocks, the legacy source lane, residual `evt-N` minting) — Phase 3, since D9
scoped only the CRM; a reconcile-driven hydration repair pump for permanently
lost webhooks (detected today, not recovered) — Phase 3; the text-first
`CONTRACT` step that pays back this phase's `raw_body` expand — Phase 4, named
owner, because the documented failure mode of expand/contract is never
contracting; typechecking test files — Phase 3 entry; the advisory-lock vs
connection-pooler hazard. One deferral is a presentation defect rather than a
mechanism one and should be said plainly: the demo's front door reads badly
because most fixture aggregates refuse on an unknown *deal* currency — the
machinery is correct and the faithful mock is what needs to carry currency the
way the real vendor does. The remaining minors live in the register and in
KNOWN-ISSUES Part II, each with an owner; the standing rule is that the open
count must be net-lower at each phase close, and anything deferred twice gets
escalated by name.
