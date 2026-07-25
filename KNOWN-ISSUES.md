# Known issues

Every project carries debt. This file is the public, curated version of the
internal defect register — what's open, why it's deferred, and where each item
gets paid. If a limitation you hit isn't listed here, that's a bug in this file
too — open an issue.

Severity is about *carrying cost*, not embarrassment: HIGH items can corrupt or
hide state; MED items degrade operations; LOW items are rough edges.

## Known-failing invariants (deliberately not in the green suite)

The fast-check property suite pins only invariants that hold. One that does
NOT hold yet is excluded on purpose — a green checkmark that hides a known
red would be worse than the bug:

1. **Name-normalization idempotence** — stacked legal suffixes normalize
   differently on repeat application (`"Acme Inc Ltd"` → `"acme inc"` → `"acme"`),
   so `norm(norm(x)) ≠ norm(x)` for some inputs. Latent (the seeded data never
   stacks suffixes); scheduled with the Phase 2b vendor-normalization work,
   which also aligns the TypeScript and SQL normalizers (their legal-suffix
   strip sets currently differ: SQL strips `inc|llc|ltd|corp`, the manifest
   resolver only `inc|llc`).

*Paid:* the **ledger torn-line crash-safety** invariant formerly listed here
(partial final line made the chain verifier throw instead of returning
`{ok:false, brokenAt}`) was fixed in the 2a.2 hardening wave — RED tests
committed first, then a parse-guard in both verifier copies, and the
truncation-totality property now runs in the green suite (property 6).

## Identity resolution (HIGH interest)

- ~~`occurred_at` ordered as text and unvalidated at ingest~~ *Paid (2a.2):*
  ISO-8601 gate at both raw doors (webhook + backfill; garbage quarantines,
  never stored), staging + `merge_edges` order event time as `timestamptz`.
- **Multi-tuple entities can straddle ambiguity guards.** A support requester
  whose tickets carry different (domain, name) or email values produces
  multiple candidate rows; two clean groups matching different canonicals pick
  a plan-dependent winner, and a clean group can outrank an ambiguity flag.
  The per-key guards (tier 1 and tier 2) don't compose per-entity. *Scheduled:
  Phase 2b identity work (fix sketch: per-entity ambiguity check across groups
  + deterministic same-tier tiebreak).*
- ~~A merge event targeting a nonexistent company mints a phantom canonical~~
  *Paid (2a.2):* `assert_canonical_targets_exist` dbt test, plus a mirrored
  unit test proving the detection SQL fires on a seeded phantom merge.
- ~~`crm_emails` reads full raw history, not latest state~~ *Paid (2a.2):*
  `owner_email` is now a latest-state column of `stg_crm__companies`; no
  identity input bypasses the staging layer.
- **Unicode confusables under-merge silently.** Zero-width spaces and NFC/NFD
  variants make visually identical names normalize differently → false manual
  review that renders identically in every UI. *Scheduled: Phase 2b
  normalization hardening (ZWSP/NBSP strip + NFC).*

## Ingestion & reliability (MED)

- **The backfill poll path trusts the feed.** No schema validation (one
  malformed entry wedges the cursor's page forever) and no fetch timeout (a
  hung socket silently stops backfill, with the overlap guard reporting
  "still running" indefinitely). *Scheduled: Phase 2b connector work, where
  the poll path is the subject.*
- **The ledger hash chain doesn't enforce `seq` monotonicity or event-id
  uniqueness** — a mock restarted against an existing ledger file forks the
  logical stream and still verifies. *Scheduled: Phase 2b.*
- **Backfill cursor can regress across processes** (unconditional upsert, no
  `greatest()`); dedup absorbs it — cost is redundant fetches, not data loss.
- **Unstorable quarantined rows have no replay path** — rows preserved in
  `raw_body` (NUL / lone surrogate / extreme depth) report `still-invalid`
  forever, since the event store is jsonb too. *Planned: `replay --sanitize`,
  an explicit, logged, operator-approved transform at replay time — never
  automatic at the trust boundary.*
- **Nothing alerts on quarantine depth** — a growing quarantine is visible
  only if someone looks. *Scheduled: Phase 4 monitoring.*
- **Oversized bodies (>100 KB) return 500, not 413** — the JSON error
  middleware only maps `SyntaxError`; `PayloadTooLargeError` falls through.
- **No migration tracking table** — every start re-runs all migration files;
  correctness depends on each being hand-proven idempotent (they are, with
  tests, including the documented 001-recreates/003-drops legacy dance — but
  it's a standing foot-gun as migrations accumulate). *Scheduled: Phase 2b.*

## Architecture (decided, scheduled)

- **The raw store is stricter than the wire.** `raw_events.payload` is jsonb,
  which rejects content valid JSON can carry (NUL escapes, lone surrogates,
  extreme nesting); today's quarantine divert is the mitigation. The decided
  end-state (Phase 2b): **text-first raw** — exact wire bytes stored for every
  event, jsonb as a nullable derived parse — plus **claim-check enqueue**
  (queue carries ids, not payloads), which dissolves this class entirely.
- **Mirrored SQL in tests is synced by discipline.** The identity-resolution
  tests embed a copy of the model SQL (temp-table substitutions for dbt refs),
  kept identical by convention and review. *Fix in progress (hardening wave):
  a CI check that mechanically diffs the mirrored region.*
- **HMAC helpers are duplicated across workspaces** (ingest + mocks). All
  three duplicated helpers (ledger hash, signBody, secretForSource) now carry
  by-construction cross-compat tests (2a.2); the structural fix — a shared
  package — lands with Phase 2b.

## Process honesty

- **CI has never run on GitHub.** The workflows are committed and locally
  verified, but pushing them requires a workflow-scoped credential; the badges
  show "no runs" until then. No green is claimed anywhere it hasn't been
  watched happening.
- **"Written test-first" is narrated, not provable.** Journals record the
  RED→GREEN cycles, but bundled test+implementation commits can't prove
  ordering retroactively. Going forward, hardening work commits the failing
  test before the fix so git history carries the proof.
- **The agent's action-safety surface is thin by design at this phase** — one
  read-only tool registered, protocol-level rejection of everything else,
  pinned by tests. The approval-gated write action and behavioral safety
  evaluation are Phase 3 scope; until they land, don't read more into the
  word "safety" than this file states.

## Cosmetic / low

DLQ depth display caps at 10 · reconcile skips a source whose ledger-path env
var is unset (scripts pin all three) · some log lines lack the `[source]`
prefix · `occurred_at` text-sort note above also applies to `merge_edges`
ordering · migration 001-recreate/003-drop churn at startup · CI installs dbt
via bare pip (no setup-python pin) and double-runs on PR branches (no
concurrency group) · assorted items tracked in review ledgers.
