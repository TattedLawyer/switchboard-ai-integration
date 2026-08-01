# The standing operator-surface checklist

Seven lines, binding on every task that touches a connector, a CLI, or the service
log. Adopted at Phase 2b Task E from the operator-surface plan review
(`docs/superpowers/plans/` lineage; rationale in
`.superpowers/sdd/operator-surface-plan-review.md` while the branch lives), after six
consecutive cold-pass merge-blockers of the same species: the pipeline computes the
right thing and the surface a human reads fails to say it.

**Inclusion rule:** every line traces to an actual shipped failure — that is what
earns a line. Additions require a new failure, named in the provenance note. This
list does not grow on taste.

The known-mode net is this checklist plus the compile-time exhaustive-consumption
contract in `ingest/src/cli/reconcile.ts` / `backfill.ts` and the shared helpers in
`ingest/test/helpers/operator-surface.ts`. The cold pass remains the net for
*unknown*-mode failures — nothing here substitutes for it.

## The checklist

1. Every field a connector's report can carry is consumed and printed by both CLIs and the service log, or explicitly discarded with a comment naming why — pinned by child-process runs of the real entrypoints.
   - *Provenance: Task B shipped `gaps` computed and printed nowhere; the A-slice shipped `stale` in the report that reconcile ignored — a drifted sheet printed PASS.*
2. Every disclosure is asserted on the run that produces it: the test identifies the detecting run and asserts on its output; an assertion on a later run is vacuous.
   - *Provenance: Task D cold pass I2 — the age-out assertion ran on a post-fallback run whose cursor was valid again, so it passed with the disclosure absent.*
3. Every claim in a test's name appears in its body as an assertion; an exit-code-only body cannot carry a wording claim.
   - *Provenance: Task D shipped a test whose name promised bounds-and-cause and whose body asserted `code === 0`, twice.*
4. Every degraded-path exit (skipped / unreachable / integrity-fail) prints standing ledger state before it continues — assert the disclosure with the source down.
   - *Provenance: Task D cold pass I1 — an unreachable bus printed its live failure and nothing about the permanent losses already on its record.*
5. Every failure cause names itself and excludes its siblings: positive match on its own wording, negative match on each other cause's.
   - *Provenance: Task D — a retention gap wearing the reset explanation sends the operator to the wrong investigation (and vice versa).*
6. Records produced by different detection paths for the same condition are equally rich — one test diffs them.
   - *Provenance: Task D cold pass I2 — a gap first seen by reconcile was permanently poorer than the identical gap first seen by catchUp (first-writer-wins enrichment).*
7. Every RUNBOOK/KNOWN-ISSUES sentence this task makes true or false names the test that demonstrates it, in the task report.
   - *Provenance: Task D — RUNBOOK's "(read-only)" claim about reconcile became false when reconcile gained its gap-ledger INSERT, and nothing red.*

## How each line is enforced

- Line 1 is compiled for the two CLIs: `reconcile.ts` rest-destructures all five
  reconcile report shapes (base + sheet/stripe/hub/bus) and `backfill.ts` the base
  `CatchUpReport` plus all four widened per-connector catch-up shapes, each per
  connector kind to an empty remainder (`rest satisfies Record<string, never>`), so
  an unconsumed new field on any of the ten shapes is a `tsc` error before any test
  or reviewer — and a new `ConnectorKind` cannot compile until both switches carry
  its destructure. The SERVICE LOG is not yet under the wall (KNOWN-ISSUES,
  owner Task F): for `main.ts`, line 1 is still enforced by review plus the
  service-log pins in the CLI test files.
- Lines 2 and 5 are structural in the helpers: `captureDetectingRun` hands back only
  the detecting run; `expectGapDisclosure` asserts the named cause's wording and each
  sibling's absence. New CLI tests use the helpers.
- Lines 3, 4, 6 are review-lens questions answered yes/no with a file and line.
- Line 7 binds the task report; for load-bearing doc claims, quote the doc sentence
  inside the pinning test so the change that falsifies the sentence reds a test whose
  failure message points at the doc.
