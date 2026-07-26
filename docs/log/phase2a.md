# Phase 2a journal — width

**Planned:** generalize the single-source reliability spine to N sources (one
`raw.raw_events` table with a `source` column, per-source HMAC secrets, per-source
queues/DLQs/cursors/backfill/reconcile), extract a shared mock core and stand up
billing + support mocks off one correlated seed manifest, then build the unification
layer on top: three-tier deterministic identity resolution with merge collapse,
a `customer_360` mart with incomplete-flagging, an identity-correctness oracle, and
GitHub Actions CI. Twelve tasks, estimated 3–4 weekends (the amendment's own
correction of an earlier "2–3, spine unchanged" estimate — the spine was *not*
unchanged; parametrizing it was Task 1 and touched the hardened path).

**The regression guard did its job.** Because Task 1 rewired the hardened Phase 1
path (migrating `raw.raw_crm_events` → `raw.raw_events`), the chaos reconciliation
test was run as the gate at the Task 1 and Task 3 boundaries — *before any new
source existed* — proving the single-source guarantees survived the generalization:
chaos GREEN, and the RED mode (`CHAOS_SKIP_BACKFILL=1`) still failing with exactly
the dropped events listed. Only then were billing and support added.

**The Task 1 migration decision:** copy-then-drop, with `CASCADE`. The old
`raw.raw_crm_events` rows are copied into `raw.raw_events` (ordered by id so
relative arrival order survives into the new bigserial) and the old table is then
dropped so no stale shadow copy can drift. The drop cascades through the one
dependent dbt view — a derived artifact the next `dbt build` recreates — which
creates a brief viewless window between migrate and build (documented in the
RUNBOOK: order is migrate → `dbt build`). A compatibility view was considered and
rejected: it preserves a name that nothing should be reading anymore.

**The result (all numbers from live runs at phase close):**

- `./scripts/chaos.sh`: 600 events (200 per source × 3) under seeded faults
  (20% drops, 15% duplicates, 20% API errors) — per source, 158 arrive via push and
  the cursor backfill recovers exactly the 42 dropped; all three ledgers reconcile
  exactly against raw with zero duplicates; quarantine and DLQ empty. The RED mode
  still fails per-source with the 42 missing events listed.
- `./scripts/demo.sh`: 288 events across three sources (crm 108, billing 100,
  support 80), ledger=raw=outbox equality 288/288/288, dbt build green (13 models +
  41 data tests at phase close; the post-close hardening pass grew this to 14
  models + 46 data tests, 60/60 build steps), the identity oracle PASS, and the
  Monday report generated.
- Identity: 22 staged companies collapse to 20 canonical entities (merged-away ids
  absent from the mart, their deals re-pointed — conservation asserted); 30
  external entities resolve 19 tier-1 / 5 tier-2 / 6 manual-review, exactly the
  manifest's planned matrix; `customer_360` = 26 rows (20 canonical + 6
  incomplete-flagged); 8 companies verified present in all three systems.
- 101 tests green at phase close (106 after the post-close hardening pass; a
  later edge-case hardening wave — three claim-breaker fixes, first-run UX, and
  a fast-check property suite — grew this to 130),
  typecheck clean.

**What actually happened, beyond the plan:**

- **A data-coverage landmine was caught at the Task 8/9 boundary, not in
  production.** The demo simulated 80 CRM events, but the support tier-1
  expectations key on CRM contact emails that only stage from event 106 onward —
  so identity verification would have failed for a *coverage* reason
  masquerading as a logic bug. The staging-task review computed the exact
  arithmetic and handed it to the identity task, which bumped the demo to 108 CRM
  events (a whole emission cycle). The lesson: when an oracle spans two layers,
  check that the lower layer actually feeds the upper one every entity the oracle
  expects.
- **The oracle was hardened by its own review.** The first identity oracle
  sampled manual-review membership and could miss a tier-3 entity silently
  vanishing from the mart; review forced full-membership iteration plus a
  total-rowcount conservation check (rows = canonical + tier-3, exactly), and both
  strengthenings were proven RED first against deliberately broken states.
- **Deterministic tiers held up against planned near-misses.** The seed manifest
  deliberately includes a name-matches/domain-doesn't billing customer and a
  domain-matches/name-doesn't support requester; both land in manual review
  because tier 2 is conjunctive — asserted per-entity, so the tiers demonstrably
  fail for the right reasons.
- **CI shipped, but its first GitHub run is still pending.** `ci.yml` (per-push:
  typecheck → migrate → full suite → action-safety eval → dbt build + data tests →
  identity oracle, on a Postgres service container) and `chaos.yml` (nightly +
  manual dispatch with the fault seed as an input, so red runs are reproducible)
  are committed and locally verified — but the push of the workflow files was
  blocked by a credential missing the `workflow` scope. Until they're pushed and a
  run is observed, the badges honestly show no runs; no green is claimed anywhere
  that hasn't been watched happening.
- **One cosmetic break with Phase 1:** the CRM ledger moved to
  `out/ledger-crm.jsonl` for per-source symmetry; all scripts swept in the same
  commit.

**Deferred, tracked for whole-branch triage:** migration-runner churn (001
recreates / 003 re-drops the legacy table each startup — candidate "004 retire
legacy DDL"); `fetchDlq` display depth caps at 10; reconcile skips sources with no
ledger path set (future: require all enabled sources); CI first-run friction
(`pip install dbt-postgres` without a pinned setup-python) and a concurrency group
to avoid push+PR double-runs; assorted cosmetic minors in the review ledger.
