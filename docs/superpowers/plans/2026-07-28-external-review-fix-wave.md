# External-Review Fix Wave — Implementation Plan (PR #5, branch `numeric-integrity`)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. One implementer at a time; every fix lands RED→GREEN; reviews gate completion.
>
> **Sequencing honesty:** Waves 1–2 below were executed before this document was written (their findings were fixed under the wave's standing review process); they are recorded here with their commits and evidence so the plan is the auditable record of the whole response. Wave 3 was dispatched as this plan was written. Wave 4 is not started.

**Goal:** Close the three findings from the external review of PR #5 ("the mart got honest; the surfaces a human or the LLM reads did not follow"), upgraded and corrected by full-source research, and ship the result on the same PR.

**Research basis (primary sources read in full):**
- JD Edwards multicurrency reports: cross-currency grand totals are "hash totals and are meaningless"; restrict a report to one currency (docs.oracle.com, Multicurrency Reports, EnterpriseOne 9.2).
- Dynamics 365 financial reporting: all amounts summarize in one known accounting currency by default; totaling across transaction currencies is an explicit opt-in documented as "not meaningful" unfiltered; a missing rate is imputed from the closest prior rate — unit-less amounts are never totaled (learn.microsoft.com, financial-reporting-currency-capability).
- Stripe multicurrency settlement: balances accrue and pay out strictly per currency, never merged (docs.stripe.com/payouts/multicurrency-settlement).
- Kimball Group: null measure values are left NULL — aggregates skip them correctly (validates the L3 amounts design); unknown dimension attributes get explicit 'Unknown' labels, never blanks; suspect rows go to a suspense file (Design Tip #43; Nulls in Fact Tables technique page).
- No source directly answers "all rows unknown currency: sum or refuse?" — the Wave 3 decision is an inference from the above (no system read presents an unknown-unit total as money; two unknown rows are not provably one currency).

## Global Constraints

- All commits RED→GREEN pairs on `numeric-integrity`; PR #5 (draft, base `phase2b`) updates in place — no stacked branch, no force-push, Michael merges.
- Node tests: ephemeral `freshTestDb()` only; `DATABASE_URL` on port 5433 with `ALLOW_DEV_SECRETS=1`; NEVER write to the named `switchboard` database (a concurrent session owns it); do NOT run `demo.sh`/`chaos.sh` locally (port conflict) — demo-scale proof rides PR CI + the `run-chaos` label.
- dbt verification runs on an isolated scratch database (create → migrate → `scripts/ci-fixture.ts` → native dbt 1.11.0 venv → drop), mirroring ci.yml.
- Mart sum semantics: 0 = genuinely zero or no rows; NULL = "a single total would be a lie" (mixed or unknown currency). All-USD fixture output stays byte-identical (invariance tests).
- Commit trailer: copy from any recent commit (`git log -1 --format=%B`); not spelled here because the hygiene scan rejects email-shaped strings in tracked files.

---

### Wave 1 — the three review findings ✅ EXECUTED

**F2 (correctness, fixed first):** mixing detection was blind to NULL currency (`count(distinct)` ignores NULLs — verified empirically: `USD 100 + NULL 100 → distinct=1, total 200`). Fixed: per-source `is_single` predicate = one distinct currency AND zero NULL-currency rows among real rows (LEFT-JOIN null-extension guarded via `invoice_id is not null`); mirrored in `assert_no_mixed_currency_totals.sql`.
**F3:** `avg_csat` silently averaged over NULL scores → `null_score_count` exposed; avg stays over usable scores, now disclosed.
**F1 + minor:** the report never read the mart's honesty columns → `flagsFor` reads `has_unusable_amounts` (+ counts) and `null_score_count`; `money()` keys off the NULL itself ("⚠ mixed currency" with the flag, "⚠ unknown" without).

Commits: `8331a4e`/`6692717` (warehouse pair), `f64a925`/`6620f18` (agent pair). Evidence: ingest 186, agent 27, typecheck clean; RED runs captured in the sdd report ("External review fix wave" section).

### Wave 2 — research addendum ✅ EXECUTED

Per Kimball's visible-unknowns practice and survey base-size practice: mart exposes `null_currency_invoice_count`, `null_currency_deal_count`, `csat_score_count`; MCP allowlist + both agent mirror views extended; report flags "N row(s) with unknown currency" and renders `avg (n=X)`.

Commits: `5da3106`/`94ed385`. Evidence: ingest 191, agent 29, typecheck clean; phantom-unknown-row LEFT-JOIN case pinned (C-21).

### Wave 3 — uniformly-unknown currency refuses 🔄 IN FLIGHT

Retract the L5.1 all-NULL-sums leniency (research verdict above; Michael approved the strict reading).

- [ ] RED: flip the L5.1 pin test — an all-NULL-currency entity asserts sums NULL, currency label NULL, `has_mixed_currency` **false** (all-unknown is not mixed; the counts + NULL sums carry the story), `null_currency_*_count = N`. Report fixture asserts the "⚠ unknown" rendering end-to-end.
- [ ] GREEN: tighten `is_single` to `(count(distinct currency) = 1 AND null-currency rows = 0)` — drop the `distinct = 0` branch; update `money()`'s "unreachable today" comment (the branch is now the all-NULL rendering); mirror both having-clauses in the singular test (offender = any non-NULL sum where `distinct > 1 OR null rows > 0`).
- [ ] KNOWN-ISSUES: rewrite the leniency bullet — unknown currency is counted, never totaled; a future source that legitimately sends no currency gets a **per-source declared default currency** at the connector/config layer (the resolve-the-unit-first pattern), not a lenient mart.
- [ ] Verify untouched: all-USD invariance, no-billing-entity zeros, known+unknown refusal, both-mixed case.
- [ ] Commit pair: `test(warehouse): RED — an unknown-unit total is a guess wearing a number's clothes` / `fix(warehouse): GREEN — uniformly-unknown currency refuses like mixed; unknowns are counted, never totaled`.

### Wave 4 — close and ship ⬜ NOT STARTED

- [ ] **Focused re-review** (fresh reviewer, fable): diff `1ee70c8..HEAD` against this plan — all three findings closed as specified, Wave 3 semantics exact, no collateral on Task 5/6 tests, comment honesty, evidence coherent. Any Critical/Important → fix + re-review before proceeding.
- [ ] **dbt live-fire** on a fresh scratch db (`create database fixwave_gauntlet` → migrate → ci-fixture → venv dbt build → drop): expect PASS with the updated singular test and new columns; record counts. (dbt test count will exceed 74 — record the new number, don't assume it.)
- [ ] **Full gauntlet:** root `npm test` + `npm run typecheck` at final HEAD; confirm suite counts against the wave's arithmetic (ingest 191+Wave-3 deltas, agent 29).
- [ ] **Register + memory sync (Gate E/F):** L5.1 entry updated to "retracted by research, strict shipped"; add the per-source-declared-currency follow-up; correct any entry the flip invalidates; fde memory phase-status updated with final commits/counts.
- [ ] **Push** `numeric-integrity` (PR #5 updates in place); post a PR comment summarizing the external-review response (3 findings → 3 waves, research citations, new columns) so the reviewer-facing record lives on the PR.
- [ ] **Watch:** PR CI + `run-chaos` label runs are the demo-scale invariance leg — report their status; if red, diagnose before any further work.

## Decision log

1. **Known + unknown currency refuses** (Wave 1) — supported directly by the research; uncontested.
2. **Uniformly-unknown refuses too** (Wave 3) — inference from research; leniency retracted. Consciously stricter than needed for today's all-USD generators, free at fixture scale, and the correct default for the first real multi-currency source.
3. **`has_mixed_currency` stays false for all-unknown** — "mixed" means provably-differing currencies; unknown is its own condition, carried by counts + NULL sums + "⚠ unknown" rendering.
4. **Deal-grain conservatism unchanged** (closed-deal currency can NULL the open-pipeline sum) — still register-tracked, fix known, deferred until a real multi-currency source exists to test against.
5. **No ISO-4217 `XXX` sentinel** — a sentinel code risks being grouped/summed as if real; NULL + surfaced counts is safer in this stack. (Considered, declined.)
