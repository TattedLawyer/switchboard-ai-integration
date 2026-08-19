# Known issues

Every project carries debt. This file is the public, curated version of the
internal defect register — what's open, why it's deferred, and where each item
gets paid. If a limitation you hit isn't listed here, that's a bug in this file
too — open an issue.

Severity is about *carrying cost*, not embarrassment: HIGH items can corrupt or
hide state; MED items degrade operations; LOW items are rough edges.

## How this file is organised (restructured at the phase-2b close)

The file previously conflated three different species of entry, which made
healthy disclosure read like rot. They are now separated:

- **[Part I — Design disclosures](#part-i--design-disclosures)** — permanent,
  by-design limits. Vendor retention windows, at-least-once duplicates, paradigm
  loss boundaries, the limits of a synthetic repo. **These will never be
  "fixed"**, because there is nothing to fix: they are properties of the world
  the system integrates with, and hiding them would be the defect. Where an
  entry's behavior is pinned by a test, the test is named.
- **[Part II — Open defects](#part-ii--open-defects)** — real debt. Every entry
  carries an **owner** (a phase, or an explicitly unscheduled trigger) and, where
  one exists, a target.
- **[Part III — Paid](#part-iii--paid)** — the struck history, kept for the
  record. Reading what was wrong, and what fixed it, is the point of keeping it.

### Scoreboard

**Derived from this file, not counted by hand** — `scripts/doc-counts.ts` holds the
derivation, `ingest/test/doc-counts.test.ts` reds when this table and the file
disagree, and `scripts/verify-doc-counts.ts` runs the same check in CI. The numbers
below are true at whatever commit you are reading, because a commit that changes them
without changing this table does not go green.

| | Count | Derivation |
|---|---|---|
| **Open defects** | **38** | Part II top-level bullets that name an `Owner:` and are not struck |
| **Design disclosures** | **45** | Part I top-level bullets |
| **Paid** (struck entries) | **47** | Part III struck bullets, plus the cosmetic/low list |

Why the owner predicate rather than a subtraction: Part II's own entry rule is that
every open entry names an owner, so the four *paid* sub-items of the multi-tenancy
entry (kept in place because the open half is unreadable without them) fall out of the
count on their own. The previous method — "24 top-level bullets − 4 paid sub-items =
20" — was a hand-maintained arithmetic that nothing enforced.

> **Escalation, recorded rather than absorbed (gate-H C1).** The published count was
> **20**; the true count when the derivation was first run was **31**, and it is **40**
> after this gate's own cold pass filed its nine deferrals below. That is a
> rise, and the standing rule below forbids one. It happened because `aef7e10` added
> twelve top-level bullets to Part II in a single commit and did not recount, and
> because the provenance line named commit `f4c2c0f` — which predates the three-part
> restructure entirely (`git show f4c2c0f:KNOWN-ISSUES.md | grep -c "Part II"` → 0), so
> the method could not be reapplied by anyone who tried. The rise is **disclosure, not
> regression**: every one of the added entries is an individually-accurate finding from
> the close waves and the cold passes, and none of them is new breakage. It is recorded
> here by name because absorbing it into a stale headline is precisely the failure this
> file exists to prevent. The same is true of the nine gate-H deferrals: an entry filed
> here is a defect that was FOUND, and a review that finds nine and files nine leaves the
> repo more honest than it was, not less correct. The rule's next test is the phase-3
> close, from a baseline of **40** — and it is now a mechanical test, not a promise.

**Standing rule.** The open count must be **net-lower at each phase close**, and
**any item deferred twice is escalated by name** in the close report rather than
being re-stamped a third time. Three items in Part II carry a re-stamp already
(marked *(re-stamped)*); a further deferral of any of them is an escalation, not
a bookkeeping edit. "Unscheduled" is an honest owner only when the entry names
the **trigger** that would schedule it — an entry that can name neither a phase
nor a trigger does not belong in this file.

**Provenance note (2a.3):** this register was originally written from a
*reliability* frame. In July 2026 an independent audit (a fresh model session,
read-only, given the code and told to treat this file as claims under audit)
re-read the codebase from *security* and *multi-tenant* frames and found three
serious gaps this file missed entirely — they appear below, marked *(audit)*.
The 2a.3 hardening wave paid the cheap ones and disclosed the rest. A register
is only useful if it's re-read from frames its authors didn't start with.

---

# Part I — Design disclosures

Permanent, by-design limits. **Nothing in this part is scheduled to be fixed.**
Each entry is either a property of the vendor paradigm being integrated, a
deliberate conservative choice, or a stated limit of a synthetic repository.
They are listed so that a reader can tell the difference between a system that
does not know its edges and one that publishes them.


## Known-failing invariants (deliberately not in the green suite)


The fast-check property suite pins only invariants that hold. One that does
NOT hold yet is excluded on purpose — a green checkmark that hides a known
red would be worse than the bug:

1. **Name-normalization idempotence** — stacked legal suffixes normalize
   differently on repeat application (`"Acme Inc Ltd"` → `"acme inc"` → `"acme"`),
   so `norm(norm(x)) ≠ norm(x)` for some inputs. Single-strip is DELIBERATE
   (Task F kept it while hardening everything else): looping to a fixpoint
   would eat `"Acme Inc Ltd"` down to `"acme"` — a string no human wrote.
   The Task F normalization work paid the rest of this area: the strip sets
   are now ALIGNED via one shared normalizer pair (TS `normalizeCompanyName`
   in mocks/core; identical SQL in `identity_resolution.sql` — strip set
   `inc|llc|ltd|corp|co|pllc`), vector-pinned in
   `ingest/test/normalizer-vectors.test.ts`, and `scripts/verify-identity.ts`
   keeps the pair CI-load-bearing.

*Paid:* the **ledger torn-line crash-safety** invariant formerly listed here
was fixed in 2a.2 (RED tests first, parse-guard in both verifier copies,
truncation-totality property 6 in the green suite).

## Spreadsheet source (sheets) — dispositions from the A-slice (2b)


The sheet-snapshot connector treats a mutable grid as a CDC source: events are
manufactured from row content, reconcile re-reads the sheet's own truth, and the
push channel is a latency hint only. These are the honest edges of that design.

- **The mock's trigger quota is a lifetime budget, not a daily one.** Real Apps
  Script refreshes its trigger budget on a day boundary; the mock has no day
  rollover, so after `dailyQuota` posts its channel is silent *forever*. This is
  the conservative side — the connector experiences a strictly worse channel than
  reality — and reconcile-first cycles are what carry it. No fix scheduled; the
  pessimism is the point.

- **The trigger channel is lossy by design and blind to API writes** (documented:
  "Script executions and API requests don't cause triggers to run", and Apps
  Script gives no delivery guarantee). Any write from another tool, a future
  integration, or our own scripts is permanently invisible to push. This is a
  documented fact, not debt: **reconcile against the sheet's own rows is the
  correctness guarantee**; the nudge door only shortens latency. Proven by the
  drop-heavy oracle test (85% loss, convergence anyway).

- **Per-sheet secrets are a low-trust model.** `WEBHOOK_SECRET_SHEETS` follows
  the house per-source scheme, but on a real engagement the signer is an
  Apps-Script trigger holding the secret in script properties — readable by every
  editor of the script. The repo models the *shape* (per-source secret, blast
  radius of one source, fail-closed boot); the rotation story and the
  low-trust-holder consequences are engagement-side work. Treat a sheets secret
  as cheap to rotate and worth nothing beyond nudge forgery (a forged nudge can
  only trigger an early read of the sheet's own truth).

- **A still-garbage row re-quarantines every cycle.** The diff re-attempts any
  row whose raw state mismatches the sheet, so a row a human left broken adds one
  quarantine entry per catchUp until the cell is fixed. Quarantine *depth*
  therefore overstates distinct bad rows on this lane — triage by distinct
  `row_key`/`content_hash`, and see the RUNBOOK's fix-the-cell workflow.

- **Blank-row tolerance is CONFIRMED — by the paradigm's own oracle, not by
  demo integration (phase-close D3 decision, executed as researched).** Sheets
  deliberately stays out of `demo.sh` (its anchors are the public front door's
  regression tripwire, declared sacred by an explicit earlier decision; the
  README now points at the one-command sheets oracle run instead). The
  tolerance itself is proven where the paradigm is proven: a blank row ingests
  CLEAN as a field-less upsert — fields absent per the contract's absence
  rule, nothing quarantined (`ingest/test/sheet-oracle.test.ts`, M2) — and
  stages with NULL amount/currency by design, counted and refused-not-summed
  downstream (`ingest/test/sheet-mart-oracle.test.ts`).

- **Closed:** the supersession counter (A4.1) — content-addressed ids made a
  human's *revert* a permanent duplicate (pipeline served B while the sheet said
  A, reconcile stale forever); re-sightings now salt the id with `-r<n>` derived
  statelessly from raw, and the ABA soak pins convergence after every cycle.

## Billing feed source (stripefeed) — the 30-day retention boundary (2b Task B)


The Stripe-style feed retains events for **30 days** (research-verified; the
mock models it with a seeded clock). That window is a *stated data-loss
boundary of the paradigm itself*, not a bug in the connector — the pipeline's
second admitted loss class, reported with bounds rather than papered over.

- **Events that age out before ingestion are permanently unreachable.** If the
  connector's cursor falls more than 30 days behind (long outage, first
  deployment against an old account), the feed answers the documented 400
  `resource_missing` for the cursor. The connector then falls back to the
  earliest retained event, ingests forward (forward progress is never held
  hostage), and reports the unreachable range as an **unclosable gap with
  bounds** — last-ingested event id + its `occurred_at` → earliest-retained
  `created` — via `catchUpWithReport` and the reconcile report (`gaps`,
  `cause: "retention"`). A backfill target older than 30 days is the same
  story: the feed cannot serve it, and no amount of retrying changes that.

- **Gap reports ARE durable (resolved in 2b Task D).** They used to live only in
  the detecting process's memory, which made reconcile-as-gate timing-dependent.
  Migration 010 added `ingest.gap_ledger`; both loss-bearing connectors write it,
  and reconcile reports from the table. A catchUp-then-exit process followed by a
  fresh reconcile process now re-reports the loss. See the casebus section below
  for the acknowledgement workflow that governs both sources.

- **Aged-out raw rows are metabolism, not anomalies.** Reconcile counts raw
  events older than the feed's earliest retained event as `agedOutRaw`
  (ingested, then aged out — the point of ingestion) and reserves `extra` for
  the real anomaly: a raw event *inside* the retained window that the feed no
  longer serves. The two are separable only by that time boundary; an event
  exactly at the boundary second is classified conservatively as `extra`.

- **Behavior change to shipped Task B, disclosed here at phase close (the
  register's owed visibility, F4):** a feed envelope with a malformed
  `created` timestamp used to make reconcile REFUSE the whole window
  (`integrity: not ok` — one poisoned vendor event blinded a thirty-day
  reconcile). Since the Task D review addendum it is treated as bad DATA on a
  readable source, per envelope: the event still counts toward the retained
  window (it really is there), contributes no timestamp, is excluded from the
  aged-out boundary arithmetic and from cursor selection, and on the drain
  side it quarantines at the schema gate while its page siblings land — so it
  surfaces through the `quarantined`/`missing` buckets instead of erasing the
  run. A missing envelope *id* is still genuinely fatal to the window
  (nothing to compare); only the timestamp class was demoted. Pinned in
  `ingest/src/connectors/stripe-feed.ts` (per-envelope handling and its
  tests); this entry exists because the change previously lived only in a
  review-response commit, invisible to a register reader.

## CRM thin-webhook source (hubcrm) — metadata-only push + hydration (2b Task C)


The HubSpot-style source delivers **metadata-only** webhook batches (up to 100
events per request, ordering not guaranteed, 10 retries over 24 hours and then
the delivery is gone — all research-verified) and the full record must be
fetched afterwards. Three stated limits of the paradigm itself:

- **Merge-modeling fidelity note (F-1b decision 1; re-researched on request,
  2026-08-01).** `company.merge` thin events and new-survivor semantics (a NEW
  record id carrying `hs_merged_object_ids`; neither input survives under its
  own id) are research-verified verbatim (`.superpowers/sdd/f2-wire-research.md`
  Q1). The **404-on-consumed-id** model was re-tested against re-opened vendor
  pages and STANDS as the documented-behavior reading: the KB says old ids are
  searchable *via the Merged IDs property* (reference data), and the dev docs
  support old ids *only* on the basic update endpoint ("not supported … batch
  update") — read-by-old-id is stated nowhere, so the mock refuses to invent an
  alias. One remaining inference, still disclosed: a merge event's `objectId`
  carries the **survivor's** id. Design corroboration (digest-level, labeled):
  production ETL vendors handle HubSpot merges the same way this pipeline does
  — secondaries tracked as removed, lineage kept via `hs_merged_object_ids`,
  survivor re-fetched after a merge (Fivetran's HubSpot connector docs/support
  notes) — which is exactly `merge_edges` + `mergedAwayRaw` + hydration via
  the merge event. Reconcile treats merge-explained absence as metabolism
  (`mergedAwayRaw`, beside `tombstonedRaw`).

- **A webhook that exhausts its retries is permanently undeliverable, and this
  source has no feed to re-read.** Unlike stripefeed (whose catchUp re-drains a
  window), a lost hubcrm notification cannot be re-pulled: the vendor's events
  API does not exist in this paradigm's modeled contract. The loss is
  *detected* — reconcile reads the object store's own listings and names the
  classes: `missing` (an object the store has that raw never heard of),
  `drifted` (the store's current state no longer matches the latest hydrated
  snapshot — a mutation whose webhook died), `extra` (raw knows an object the
  store lacks, with no deletion event to explain it) — but it is not
  *recoverable* by the connector. Recovery is an operator decision (vendor-side
  re-send, or accepting the gap); deriving events from the store would be
  fabricating history and is deliberately not done.

- **Hydrated snapshots are FETCH-time state, not notify-time state (D7).** A
  mutation landing between the webhook and the fetch means an event's snapshot
  can be newer than the event itself; two events for the same object can carry
  identical snapshots. This is a fact of the vendor's design, stored honestly
  (`ingest.hydrated_snapshots.fetched_at` says when we looked); sequencing is
  governed by staging's occurred_at-wins ordering, never by snapshot content.

- **The hydration DLQ is terminal until an operator acts.** An event whose
  object fetch exhausts its bounded retries (or whose snapshot fails the field
  contract — quarantined with a named reason, never silently stored) is
  dead-lettered to the pg-boss queue `hydrate-hubcrm-dlq` and never re-fetched
  automatically. It is printed loudly by both CLIs and the service log and
  listed with reasons by reconcile. ~~a replay mechanism (re-arm a DLQ'd event
  for another fetch) is register-owned follow-up~~ *Paid (phase-2b close, D2's
  close half):* the operator path is now the first-class re-arm CLI
  (`npm run hydrate-rearm -w ingest` — tenant-scoped `--list`, re-arm exactly
  one `--id`; RUNBOOK has the workflow). Re-arm consumes the DLQ row (deletion
  is the mechanism — the pump skips whatever the DLQ lists, and pg-boss
  `retry()` is a no-op on this store's `'created'` jobs, demonstrated in the
  CLI suite), and the CLI prints the full consumed entry + counts as the audit
  trace, since the row is destroyed. Pinned end-to-end in
  `ingest/test/hydrate-rearm-cli.test.ts`: a healed vendor object alone
  changes nothing (the terminal premise, kept as the negative control); after
  re-arm the pump really re-fetches and hydrates; bogus ids and cross-tenant
  ids refuse loudly. "Terminal" is retention-backed, not aspirational:
  the queue sets `retentionSeconds` explicitly (~68 years, the longest span
  pg-boss's int4 column can express) because the default is 14 days, after
  which the job is deleted and the event falls back into *no* state — reconcile
  would report it `hydrationPending` again, the pump would re-fetch the same
  broken object, and it would re-quarantine every cycle. The consequence is
  that the DLQ GROWS until an operator clears it, which is deliberate: depth
  is the documented watch surface, and a dead letter that evaporates is a
  silent return to limbo.

## The faithful-source end-state (2b Task F-1c) — what remains 2a, and why


The warehouse now stages **only from the faithful sources**: the CRM arm from
hubcrm hydrated snapshots (merge lineage from `company.merge` events — both
merge inputs map to the NEW survivor, translated into the business-key space
staging resolves in), the billing arm from the stripefeed envelope feed, the
support arm from the casebus wire's supplied-* intake fields, and the sheets
arm unchanged. `scripts/verify-identity.ts` — byte-identical to before the
flip — passes against the re-sourced graph: the 22→20 merge collapse, the
tier partition, deal conservation, and the mart rowcount all hold on the
faithful wire shapes.

Deliberate remainders, each bounded and owned:

- **The 2a support mock remains** and feeds exactly ONE model:
  `stg_support__csat` (`csat.recorded`). Its ticket lifecycle events still
  land in raw but no model consumes them (declared-but-unconsumed is the
  registry's permitted direction).

- **The 2a billing mock remains in the repo but feeds no model and runs in no
  demo/CI composition except chaos**, where it (with support) is the
  ledger-feed paradigm's zero-loss actor — drops recovered by feed backfill,
  the story the faithful window paradigms cannot tell.

- **The `evt-N` sweep is complete on the CRM side** (the minting died with the
  deleted mock) and **bounded on the billing/support side**: `evt-N` ids are
  minted only by `mocks/core/src/source-app.ts` for those two lanes, nothing
  reads them as ordinals anywhere (the ordinal tiebreak retired in Task C),
  and the remainder retires with the mocks themselves.

- **The `crm` Source literal is a registered, mock-less legacy lane**
  (`ingest/src/sources.ts`): no longer default-enabled, nothing serves its
  port; removing the literal is a wider spec change (raw rows under it may
  exist in deployed databases; many door/contract suites exercise the generic
  machinery through it) that rides the full 2a retirement wave.

- **Permanent hubcrm webhook loss remains detected-not-recovered** (see the
  hubcrm section above). The chaos green path therefore drives hubcrm through
  its RECOVERABLE weather (duplicates, holdovers, shuffle, bounded
  redelivery); injected permanent drops belong to the RED mode
  (`CHAOS_SKIP_BACKFILL=1`), where reconcile must name the loss.
  **SPLIT at phase-2b close (D2):** the register line's two halves now have
  separate fates — the operator-invoked DLQ **re-arm** landed at close
  (`hydrate-rearm` CLI; the merge-survivor recovery path below uses it), while
  the **reconcile-driven repair pump** (automated re-arm/repair) stays
  **Phase 3**, deliberately: automated repair wants the approval-queue spine
  (operator-approved actions with audit semantics), not a close-scope daemon.

- **A merge whose survivor snapshot is missing is a RED BUILD, not a repair**
  *(cold review I-3, F-1c fix round)*. `merge_edges` translates through
  snapshots, and the two miss directions are not symmetric: a consumed-side
  miss is harmless (the object never staged, nothing strands), but a
  survivor-side miss — the merge event's own hydration DLQ'd or
  tombstone-only — would drop the merge's edges while both consumed companies
  keep staging as two separate stale canonicals. That shape is now DETECTED
  loudly (`warehouse/tests/assert_merge_survivors_translate.sql` fails the
  dbt build naming the event) and — since the phase-2b close D2 split — its
  recovery has an operator surface: re-arm the merge event's DLQ'd hydration
  with `hydrate-rearm --id <event_id>` and run the pump (RUNBOOK); the
  AUTOMATED half (reconcile-driven repair) remains Phase 3 on the
  approval-queue spine, per the split recorded above. The `merge_edges.sql`
  header states the asymmetry; the shipped fixture/demo pump cadence never
  enters the state.

## Support event-bus source (casebus) — the 72-hour window and the stream reset (2b Task D)


The event-bus paradigm is a stream you **subscribe** to. It retains events for
**72 hours** (research-verified against the vendor's durability docs; the mock
models it with a seeded clock), and that window is a *stated data-loss boundary
of the paradigm itself*. It is the only source here where falling behind is
unrecoverable by construction: a cursor feed can be re-read from its start, a
sheet re-snapshotted, an object store re-listed — a bus has a window, and what
leaves it is gone from the source forever.

- **Cursor invalidation has TWO causes and the vendor tells you neither.** A
  stored replay id can die by aging out of the 72h window, or because "the
  stream of retained events can be reset if the org is moved to a new instance"
  — which can strike a cursor of any age, including one seconds old. The vendor
  publishes ONE error code (`…fetch.replayid.corrupted`) covering both, so the
  connector derives the cause **structurally**: it stores the stream identity
  alongside the cursor (`ingest.cursors.stream_id`, migration 010) and compares
  it at invalidation time. Changed identity ⇒ `reset`; unchanged ⇒ `retention`.
  An **unknown** prior identity (a cursor written by an older build) also yields
  `retention` — the conservative claim, since a reset we cannot evidence would
  be a fabricated diagnosis. Disclosed limit: an org that moves instances and
  keeps the same stream identity would be misreported as `retention`. The
  bounds and the loss itself are unaffected; only the cause label is.

- **Recovery is EARLIEST by default, and that is a deliberate loss-minimizing
  choice.** LATEST would abandon everything still retained but not yet
  ingested, converting an already-permanent bounded loss into a larger one.
  EARLIEST re-reads the retained window (duplicates, which at-least-once
  delivery produces routinely and idempotent ingest absorbs) and yields a
  knowable far edge for the gap. A deployment can configure LATEST; when it
  does, the gap honestly reports a NULL far edge, because "everything up to
  now" has no near bound.

- **At-least-once delivery means duplicates are normal, not faults.** The same
  event arrives more than once, sometimes under the same replay id. It is
  absorbed by `(tenant, source, event_id)` and **counted** in the catch-up
  report and on the backfill log — a redelivery that vanished from the numbers
  would be indistinguishable from a bug.

### The durable gap ledger and the acknowledgement workflow (both loss-bearing sources)


`ingest.gap_ledger` (migration 010) records every admitted permanent loss for
**both** stripefeed and casebus: cause, bounds, detection time, acknowledgement.

- **A gap is never closable.** No retry recovers it, so reconcile cannot simply
  fail forever on it — a permanent red is a red people learn to skip. The
  landed semantics: reconcile **FAILS while a gap is unacknowledged** and
  **PASSES once an operator acknowledges it**, after which the gap is still
  printed on every reconcile as a standing disclosed condition. Acknowledging
  is not closing, hiding, or resolving; it records that a named human saw the
  loss and accepted it. A *new* gap after an acknowledgement reds the run
  again — acknowledging one loss never blanket-silences the next.

- **The operator path is a CLI**, `src/cli/gap-ack.ts` (`--list`, or
  `--source … --id … --by … --note …`), not documented SQL: the act needs an
  operator identity, `acknowledged_by` should not be whatever database role a
  psql session used, and a documented UPDATE invites a WHERE-clause slip that
  acknowledges every open gap at once. The tool cannot express that.

- **One loss is one row**, keyed `(tenant, source, cause, from_event_id)`, so a
  once-a-minute backfill loop re-detecting the same loss does not manufacture a
  row per tick. On re-detection the original row is returned untouched: the far
  edge is not refreshed (that would quietly widen a loss that never grew) and
  an acknowledgement is not cleared.

## Numeric & monetary integrity — by design


- **The ingest contract cannot help rows that never pass a door.** The numeric contract
  (`ingest/src/numeric-contract.ts`) gates all SEVEN doors via the shared event schema —
  the webhook door, quarantine replay, the backfill poll, and the sheet-snapshot,
  stripe-feed, hub-hydrate and bus-replay connectors (gate-H M4: this said "the webhook,
  replay, and backfill paths" long after the four connector doors joined, which is
  precisely the staleness `event-schema.ts:49-51` carries an explicit warning about) — but rows already in `raw` from before the contract, direct inserts,
  and any future historical import are covered only by the staging safe-casts, which degrade
  a bad value to one NULL instead of a dead build. If those casts were ever removed as
  "redundant with the contract", this is what breaks. By design; disclosed so it stays a
  decision rather than becoming an assumption.

- **`plausibleMax` is borrowed from Stripe's 8-digit charge bound.** It is derived for a
  Stripe-shaped processor and arbitrary for anything else, which is why exceeding it
  only ever WARNs and never rejects — a genuine large amount must never fail a build or
  quarantine. Since Wave 5 (Task G) the above-bound rows are also FLAGGED at row grain
  (`is_unlikely_amount` on the payments/invoices staging models — invoices carry the
  bound `invoice.finalized` has declared since Task B), rolled up per entity
  (`unlikely_amount_payment_count` / `unlikely_amount_invoice_count`), and OR'd into
  `has_data_warnings`; the dbt warn surface (`assert_amounts_plausible`) now reads that
  flag. Flagged is still never refused: the amounts stay in every sum.

- **A green `dbt build` in CI means "ERROR=0 and WARN=1", not "no warnings".** The CI
  fixture deliberately seeds one above-bound charge (close F7) so the unlikely-value
  surface is proven to fire end-to-end in the built warehouse rather than passing
  vacuously, so `dbt build` reports `PASS=100 WARN=1 ERROR=0 TOTAL=101` forever, naming
  `assert_amounts_plausible` and row `DEMO-CH-0001`. dbt exits 0 on warnings, so that
  permanent warn could mask a second one — `assert_unusable_amounts_flagged` is also
  warn-severity and currently 0 rows. The criterion is therefore MECHANICAL, not prose:
  `scripts/verify-dbt-warns.ts` runs after the dbt step and set-compares dbt's own
  `run_results.json` warn set and per-test row counts against
  `scripts/dbt-warn-contract.ts`, plus the flagged row's identity against the test's
  stored failures (`store_failures: true`). It fails on an extra warn, a missing
  expected warn (F7 decaying back to vacuous), or a different flagged row. Confirmed
  live: forcing a second warn left `dbt build` at exit 0 and redded the gate. Adding a
  legitimate new warn-severity expectation means editing the contract file — deliberate,
  reviewed, and visible in the diff, which is the point.

- **Currency is now validated at the door (Phase 2b Task A2).** The field contract
  declares `currency` on the four money-bearing types: present-but-malformed quarantines
  the whole event with a reason naming the field (replayable like any quarantined event);
  ABSENT passes untouched — legacy pre-currency events must flow, and refused-at-mart
  semantics for NULL currency are unchanged. The staging guard is thereby demoted to
  containment for doorless rows (direct inserts, pre-contract history).

  *(updated PRE-3 — the allowlist landed.)* The rule is no longer the shape regex
  `^[A-Z]{3}$`, which admitted all 17,576 three-letter uppercase strings and therefore
  plausible fakes like "ABC". It is now MEMBERSHIP in ISO-4217 as published by SIX (the
  standard's maintenance agency). SIX's `list-one.xml` is **not redistributed here** — only
  the artifacts derived from it are; its URL, published date and SHA-256 are recorded at
  `vendor/iso-4217/README.md`, and `scripts/generate-iso4217.ts` renders it into the door's
  allowlist (`ingest/src/iso4217-codes.ts`) *and* the dbt seed `iso_4217_currencies` that
  the three staging models now join. One source, two generated artifacts, drift pinned in
  every direction — the list is never hand-typed and never fetched at build or run time.
  `XXX` ("no currency") and `XTS` ("reserved for testing") are deliberately excluded.
  The quarantine reason names the standard AND the published edition, so a stale list is a
  hypothesis the operator can form rather than an invisible one.

  Disclosed with it, because the fix creates it: **the committed code set ages, and nothing
  automatically detects that it has.** SIX amends `list-one` when currencies are created
  or withdrawn, not on a calendar, so there is no cadence to schedule; refreshing is the
  documented manual procedure in `vendor/iso-4217/README.md`. The consequence of a stale
  list is bounded in the safe direction — a NEWLY created currency is refused at
  the door and shows up as a quarantine row naming the standard and the edition it was
  judged against, never as a wrong total — and a withdrawn one keeps being admitted until
  the next refresh. A build-time fetch would close the gap and was rejected: it makes the
  door's behaviour depend on a vendor's uptime and removes the reviewable diff, which is
  the more expensive failure. Deliberate, and named here so it is not discovered.

- **Legacy rows with NO currency field no longer sum at all.** Any NULL-currency row
  (never carried, or — on doorless rows — malformed and nulled at staging) refuses its
  source's money sums:
  known + unknown is mixed (`has_mixed_currency` true — external review F2), and
  uniformly-unknown also refuses since the L5.1 retraction — an unknown-unit total is not
  money (JD Edwards treats cross-currency grand totals as meaningless "hash totals"; D365
  converts to a known unit or filters to one currency; Stripe balances are strictly
  per-currency) — though it is NOT flagged mixed, since nothing known is contradicted.
  The sums go NULL with the unknown rows visibly counted
  (`null_currency_invoice_count` / `null_currency_deal_count`) and the report renders
  "unknown", never a figure. A future source that legitimately sends no currency should
  get a per-source declared default currency at the connector/config layer, not a lenient
  mart. *Registered follow-up: connector-level `default_currency` config — owner
  stamped at phase-2b close (R11): Phase 4 hardening / the next
  contract-touching slice (dormant until a currencyless source lands;
  previously unowned).*

- **An error-severity numeric test failure halts the mart refresh.** dbt skips downstream
  models when a staging test fails at severity error, so one NULL amount that reaches
  staging stops `customer_360` rebuilding until someone looks. Loud by design — with the
  ingest contract active, a NULL there means enforcement decayed or a doorless row appeared
  — but operationally it is a stop-the-line switch, not a warning light.

- **`pg_input_is_valid` requires PostgreSQL 16+.** Compose, CI, and the docs all pin
  Postgres 16; a deployment on 15 or older fails at `dbt build` with an undefined-function
  error in every staging model that guards a cast.

## Security, tooling and content — standing limits


- **Secrets live in environment variables** — right-sized for this phase, but
  env vars are readable by all of a process's children and can leak into
  dumps; a real deployment should use a secret manager.

- **Profile flavor-word vetting is review-enforced, not machine-enforced** —
  the per-profile hygiene scans catch real email/domain shapes, but a real
  brand name used as a flavor word would pass (plant-verified in the Task E
  review). The limit is stated at the `ProfileContent` comment; content edits
  need human vetting against real-world names. *Standing limit, disclosed —
  no fix scheduled; machine-enforcing "is this a real company" is not
  tractable here.*

- **Version-fragile dependencies are now pinned** *(audit)* — `pg-boss` exact
  at 12.26.1 (four documented behaviors depend on its *internals*, which
  semver does not cover) and the MCP SDK exact (the registration guard casts
  through an untyped seam). `@types/express` was the wrong major (v4 against
  Express 5 — the gating typecheck was validating the Express 4 API); now
  `@types/express@^5`. One correction to the audit: Express 5 does *not* ship
  its own types — deleting the package entirely fails typecheck — so the fix
  is the v5 types line, not removal.

## Process honesty


- **Moving to real runners found three defects a green local suite could not.**
  For most of this project's life the workflows were committed and locally
  verified but had never executed on GitHub, because pushing them required a
  workflow-scoped credential. Once they did run, there were three red runs
  before the first green one, each for a different reason — and each of the
  three was a class of failure that only exists on infrastructure the local
  suite doesn't have:
  - **Run 30157944913 — first `ci` run, red.** The 2a.3 fail-closed secrets work
    blocked its own CI: with no `WEBHOOK_SECRET_*` or `LEDGER_HMAC_KEY` in the
    environment, the pipeline refused to boot, which is exactly what it is
    supposed to do. Fixed by making CI declare the same explicit
    `ALLOW_DEV_SECRETS=1` opt-in the scripts declare, rather than by weakening
    the gate ([`ci.yml`](.github/workflows/ci.yml)).
  - **Run 30158941574 — first `chaos` run, red.** The demo's drain gate waited
    for ledger count == raw count, but those two counters move together (the
    ledger append precedes each delivery), so on a slow runner the equality held
    continuously *during* emission and the gate declared "drained" early. dbt then
    built on a partial raw missing the CRM tail. Fixed by anchoring the gate to
    the expected total instead of to an equality between two moving counters
    ([`demo.sh`](scripts/demo.sh)).
  - **Run 30159422468 — a later `chaos` run, red.** The demo step failed eight
    identity assertions because it was served by a mock process left behind by
    the chaos step in the same job: `npm run` does not reap its grandchild on
    SIGTERM, so the leftover server's event-script cursor had already passed the
    CRM merge slots and those events were never emitted. No pipeline logic was
    wrong; the environment was contaminated. Fixed by splitting chaos and demo
    into separate jobs (a fresh runner each) and by replacing the port-liveness
    readiness probe with an actual freshness assertion, since an open socket
    never proved the server was ours.
  - The through-line: a fail-closed gate can only fail where no secrets exist, a
    race only opens when the machine is slow, and a process-table coupling only
    exists when two scripts share one. A green local suite is not evidence about
    any of them, which is the argument for running the heavy proofs on real
    infrastructure rather than trusting the developer's laptop.
  - An earlier version of this list got two of these wrong. It was corrected
    against the run IDs above, which is what publishing them is for.

- **"Written test-first" is narrated, not provable** for early phases.
  Hardening work since 2a.2 commits the failing test before the fix so git
  history carries the proof (RED→GREEN pairs).

- **The agent's action-safety surface is thin by design at this phase** — one
  read-only tool, protocol-level rejection of everything else, and (2a.3) a
  database role that cannot write. The approval-gated write action and
  behavioral safety evaluation are Phase 3 scope.

- **What the demo does NOT prove:** reconcile proves id-set parity, not
  payload parity (a source that mutated an event's `data` and re-delivered
  under the same id reconciles clean); and in production the vendor is the
  oracle — no vendor hands you a signed, complete enumeration of history
  (see `docs/real-connector-delta.md`).

## What production would require (scoping, not backlog)


Disclosed deliberately: these are *client-blocking*, not blocking for this project's
current scope,
and none is started. Effort classes are estimates by the maintainer.

1. **Tenancy (3–4 weeks, after a 1-week isolation-model decision).** The
   decision comes first — shared-schema-with-RLS (AWS's prescription for
   pooled models; requires `FORCE ROW LEVEL SECURITY` and knowing RLS's
   documented gotchas) vs database-per-tenant (isolation as a deployment fact;
   compliance pressure pushes this way for PII-heavy clients, though no
   authority mandates it). Note the 2a.3 least-privilege work is a
   *prerequisite* either way: RLS is silently inert for table owners and
   superusers, which is exactly what the app role was.

2. **One real vendor connector (6–9 weeks; 2–3 per vendor after).** OAuth2
   token lifecycle, opaque cursors (the bigint watermark doesn't survive
   contact with HubSpot/Stripe/Zendesk pagination), thin-event hydration
   inside the queue worker, per-vendor signature schemes (every real one signs
   a timestamp — the 2a.3 scheme gives that somewhere to land), backoff that
   honors `Retry-After`, and fetch timeouts.

3. **Operations.** ~~Postgres volume + rehearsed restore~~ and ~~migration
   tracking~~ are **paid**: the database now lives in a named volume, and
   `scripts/verify-durability.sh` proves — by executing it — that data survives
   container destruction and that a backup restores to an identical state after
   the schemas are dropped outright. Migrations are recorded with a checksum and
   startup **refuses** to proceed if an applied migration's contents changed.
   One trade-off stated openly: the dump excludes `pgboss` (its partitioned
   tables' inherited primary keys make a full dump un-restorable), so DLQ depth
   does not survive a restore — the events themselves do, via ledger replay.
   **Still open:** service containers + health endpoints, structured logging with
   correlation ids, and metrics + alerts on queue/DLQ/quarantine depth and
   backfill last-success age (the backfill can die permanently while logging a
   reassuring line every 60s).

4. **The automation surface (3–5 weeks + agent loop).** Action/intent objects,
   an approval queue, outbound idempotency keys, an agent-action audit log,
   and injection defense — the OWASP LLM06 architecture. Nothing here exists;
   it is Phase 3 by design, and the current report worker is a summarizer, not
   an agent (the README says so).

5. **End-user surface (4–8 weeks).** Scheduler, delivery channel, auth,
   approval UI. Today's user surface is a Markdown file on the operator's
   disk.

## The agent-source sweep is a legibility control, not a boundary (Phase 3 / A1)


The published claim about the agent's read-only access has three tiers, and the
third — "no module under `agent/src/` constructs a second pool or reads a
full-privilege credential" — is checked by static analysis in CI plus a runtime
observation on one code path. Its ceiling is disclosed here because a reader who
meets only the tier's headline will over-read it.

- **A determined author inside this repository can defeat the sweep, and the size
  of its test corpus is not a claim to the contrary.** It is a TypeScript-AST
  analysis over one directory (`agent/src/**`) plus a patch on
  `pg.Client.prototype.connect` that observes the connections the boot test's
  child process actually opens. It therefore cannot see a transitive npm
  dependency opening its own connection, cannot see code that does not exist at
  build time, and reasons only about the directory it reads. **Four rounds of
  adversarial review each found one further evasion, every time one layer past
  wherever the tests had stopped** — the regex being out-spelled by
  `import { Pool } from "pg"`; the predicate; input selection (a `.mjs` file
  nobody collected, and a relative path reaching into `node_modules`); and finally
  the trust boundary of the entrypoint exemption (a permitted file exporting the
  driver class outward, which every other layer then passed legitimately). Each
  was fixed and each is now a permanent case in a corpus that runs the shipped
  predicate. We stopped there **by decision, not because the bottom was
  demonstrated** — the next layer is whatever the control grants rather than
  checks, and the control is **default-permit by construction**: its rules
  enumerate what is forbidden and permit everything they failed to enumerate,
  which is exactly why each round found one more way. The sweep is **assurance
  evidence, not an enforcement mechanism** — grounds for justified confidence that
  the claim holds, not the thing that makes it hold. What makes it hold is tier 1,
  a **default-deny** database ACL that was untouched through all four rounds and
  that nothing written in `agent/src/` can widen. **No authoritative source sets a
  stopping threshold for iterated adversarial review; we looked and found none, so
  this decision rests on that tiering argument and not on any rule that "four
  rounds is enough."** Full reasoning in `docs/adr/agent-writer-boundary.md`
  ("What this check is, and what it is not"), sourcing in
  `.superpowers/sdd/control-vs-evidence-research.md`. **Nothing in this tier may
  be cited in support of the customer-facing claim, which rests on the database
  role alone.** It is listed as a design disclosure rather than a defect because
  closing it properly means enforcement the code cannot argue with — OS or
  container isolation of the agent process — which this repository does not ship
  and will not claim.

## Agent writer boundary — credential locality, not OS sandboxing (Phase 3 / A1)


Phase 3 needs the agent to *propose* actions, and proposals have to be persisted.
The writer is therefore placed in the client-facing approval service, and the
agent process keeps exactly one database credential: the read-only
`switchboard_agent` role. That is what keeps the published sentence true. It is
not a security sandbox, and the difference is worth stating precisely rather than
letting a reader assume the stronger one.

- **On a single-box self-hosted deployment, the agent host and the approval
  service very likely run as the same OS user.** An attacker with arbitrary code
  execution inside the agent host can therefore read the approval service's
  environment or configuration file and recover its database credential directly.
  Our split is a **credential-locality property, not OS-level sandboxing** —
  Chromium's sandbox design doc is explicit that its own guarantee comes from the
  OS ("Sandbox operates at process-level granularity"), and we take the process
  split without the token/job-object restrictions that make such a split
  enforceable. What the split does buy is real and bounded: the authority a
  compromised agent host holds is *append one schema-validated, human-gated
  proposal* through an authenticated door, not *arbitrary SQL as the migration
  owner*. It cannot rewrite the mart, forge an audit row, or run
  `grant insert … to switchboard_agent` and retire the differentiator itself.

  🚨 **This paragraph used to say "cannot … forge an approval", and for a while that
  was FALSE.** Gate H measured it: the lifecycle trigger was `BEFORE UPDATE` only and
  the role holds table-level INSERT, so an attacker holding this credential could
  `insert … values (…, 'approved')` with zero rows in `approval.decisions` and walk
  the forged row to `executed`. No card ever rendered and no human ever saw it. It is
  closed now — a creation branch in the same trigger refuses any INSERT that is not
  `pending`, and both triggers are `ENABLE ALWAYS` — and the sentence is restored with
  the qualification it always needed: **the approval ROLE cannot forge an approval. The
  table OWNER and a superuser always can**, and nothing in a single-cluster design
  changes that (see the creation-guard disclosure in Part I for exactly which residuals
  those are). The claim is about this credential, which is the credential this entry is
  about.
  The surviving bypass is proposal forgery and flooding, bounded by a unique
  idempotency key and a pending-proposal cap (migration 014, and the door's 429),
  and terminating in a human being shown a bad proposal and rejecting it. This is
  a disclosure rather than a defect because closing it means OS-level isolation
  we do not ship and would not honestly claim in a self-hosted install; it is
  listed here so the published claim is read with it rather than around it.

---

## What the approval queue does NOT attest (Phase 3 / A2)

- **A2 does not attest what the broker's browser painted, and does not bind the
  payload to the outbound message.** What it does attest is narrow and provable:
  the payload she approved **cannot change** (a column-level grant plus a
  `BEFORE UPDATE` trigger, so it holds on paths nobody has written yet), and we
  recorded — *as audit metadata only* — which renderer version showed it to her.
  Three things follow, and each was at some point claimed and then withdrawn:
  we do **not** claim "what you approved is the screen you were shown, byte for
  byte" (a proxied client, a browser extension, a CSS rule or a stale bundle all
  defeat any server-side version of that claim); we do **not** refuse to execute
  against a rendering we no longer produce (`renderer_version` is recorded and is
  never a predicate); and we do **not** bind the canonical payload to the SMTP
  envelope — everything between the two is built by the send executor (C5) and is
  outside anything A2 guarantees. What survives is a CI property, not a runtime
  one: the payload region renders byte-identically across processes, time zones,
  locales and clocks, pinned by `approval/test/render.test.ts`.

- 🚨 **The reliability paradox: as the agent improves, human approval
  provides LESS protection, not more.** This is by-design and permanent, not a defect
  awaiting a fix, and it is the reason no document in this repo presents the
  approval step as the thing that makes the system safe. Mosier & Manzey 2019:
  omission errors rose **32.4% → 48.3% as decision-aid reliability rose .87 →
  .98** (Bailey & Scerbo 2007); back-end aids that recommend one specific action
  are worse than front-end aids; **experts are as susceptible as novices**; and
  externally imposed accountability did not replicate in professionals. Our queue
  is the worst-configured aid in that literature — back-end, one recommendation,
  intended to become highly reliable. Safety therefore rests on the read-only
  credential and the immutability trigger, which hold regardless of whether
  anyone read the card. Better card design, more warning text and accountability
  framing are all ruled out by the same evidence, so be suspicious of any future
  proposal that answers this with UI. Pinned two-directionally by
  `ingest/test/approval-honesty.test.ts`: the demotion must be PRESENT, and no
  document may claim the opposite.

## What the creation guard covers, and the residuals it cannot (Phase 3 / A2)

- **A proposal cannot be CREATED in a decided state — by any caller, through any
  statement type — and here is the exact boundary of that claim.** The lifecycle
  trigger guards creation as well as transitions, and both triggers are
  `ENABLE ALWAYS`. Measured against the shipped schema as `switchboard_approval`:
  `INSERT`, `INSERT … RETURNING`, `INSERT … ON CONFLICT DO UPDATE`, `COPY FROM STDIN`,
  `MERGE` (both the matched and not-matched legs) and `UPDATE … FROM` are **all
  refused**; `DELETE`, `TRUNCATE` and `UPDATE pg_class` are refused by **privilege**;
  and `SET session_replication_role = 'replica'` is refused for that role
  (`permission denied to set parameter`).

  **Three residuals remain, and they are disclosed rather than claimed closed:**
  - **The table owner** can `ALTER TABLE … DISABLE TRIGGER` and then write anything.
    Ownership is demolition rights; no in-database control survives its own owner.
  - **A superuser** can do all of that plus write catalogs directly.
  - **Any role granted `SET ON PARAMETER session_replication_role`** could, before
    `ENABLE ALWAYS`, turn *every* default-configured trigger in the database off for
    its session — measured, and it is an **ordinary grantable privilege** since
    PostgreSQL 15, not a superuser one. `ENABLE ALWAYS` is what closes it: PostgreSQL's
    manual says such triggers "will fire regardless of the current replication role",
    and we measured both directions (with `ENABLE ALWAYS` the guards still raise under
    `replica`; reverted to plain `ENABLE`, a forged INSERT and a bare
    `pending → approved` both succeed). This is not a hypothetical hardening: it closed
    a live hole in the UPDATE guard that had already shipped.

  **`ENABLE ALWAYS` has a cost, and it is stated here so an operator meets it in
  writing rather than in an incident:** these guards also fire when `approval.proposals`
  is a **logical-replication subscriber**. If this table is ever replicated into another
  cluster, apply of a legitimately-approved row will RAISE, because the applying session
  has no decision row in its transaction. Refusing to apply beats silently accepting an
  unguarded row, so the trade is deliberate — but a replication setup here needs a
  design decision, not a retry loop.

  **No cited pattern exists for this.** No standards body or vendor prescribes
  declarative initial-state enforcement in SQL; the literature treats *transitions*, and
  the most-cited SQL state-machine treatment pushes initial-state checking into a stored
  procedure — i.e. it has exactly the gap we shipped. The mechanism here is engineering
  judgment supported by measurement, and the repo should not imply otherwise.

# Part II — Open defects

Real debt. Every entry names an **owner**. Where the owner is *unscheduled*, the
entry names the **trigger** that would schedule it — an unscheduled item with no
trigger is not a disclosure, it is a shrug, and does not belong here.


## Multi-tenancy: the ingest layer is tenant-scoped; the analytics layer is NOT (partially paid)


**Paid (migration 006).** The audit's highest-severity finding was cross-tenant
data *loss*: `raw_events` uniqueness was `(source, event_id)`, so two tenants'
vendors both emitting `evt-1` silently dropped the second and reported it as a
successful de-duplication. That is closed:

- Uniqueness is now `(tenant_id, source, event_id)` — exactly-once is preserved
  *within* a tenant, and the same id from two businesses becomes two rows.

- `tenant_id` is present and indexed on `raw.raw_events`, `ingest.ingest_journal`
  (né `ingest.outbox`, renamed in migration 011), `ingest.quarantine` and
  `ingest.cursors`. Cursors are keyed
  `(tenant_id, source)`: a shared cursor would let one tenant's progress skip
  another's events permanently.

- A tenant is **required, never defaulted** — supplying it explicitly-but-empty
  throws rather than silently substituting the default tenant.

- Row-level security is enabled **and forced** on all six tenant-scoped tables —
  the four above plus `ingest.hydrated_snapshots` (migration 009) and
  `ingest.gap_ledger` (migration 010), each with its own `tenant_isolation`
  policy; `ingest/src/cli/tenant-state.ts` enumerates the same six. (Gate-H M1:
  this said "all four tables" after 009 and 010 had already widened it — the
  register understating its own coverage.) Note the
  reason `FORCE` alone was not enough here: PostgreSQL documents that
  *"superusers and roles with the `BYPASSRLS` attribute always bypass the row
  security system"*, and this project's `switchboard` role is a superuser. So
  006 also creates a non-superuser `switchboard_app` role, and the isolation
  test proves the boundary **through that role** — it fails if pointed back at
  the superuser. "We enabled RLS" is not a claim worth making otherwise.

**Still open, and it is the larger half.** All four sub-items share one owner:

- **The analytics layer has no tenant partition.** Staging models, the identity
  tiers, and `customer_360` are unchanged. Two clients' "Acme Group /
  acme.com" would still merge into one entity — cleanly, with audit evidence,
  and **no ambiguity flag**, because the over-merge guard fires when one key
  maps to *multiple* canonicals and each tenant contributes exactly one. It is
  an over-merge guard, not a boundary guard. `customer_360` would sum both
  clients' revenue. Retrofitting means a partition in every join predicate and
  group-by across ~15 models.

  *Owner: unscheduled — the isolation-model decision in Part I §"What production would require" 1 gates all four. Trigger: the first multi-tenant engagement, or any deployment serving a second business from one instance.*

- **The RLS policy permits access when no tenant context is set.** That is what
  keeps migrations, reconcile, dbt and the single-tenant demo working — but it
  means RLS here guards against cross-tenant leaks in tenant-scoped code paths,
  not against an application role that simply declines to set the context.
  Closing it needs a policy with no fallback branch on a dedicated role.

  *Owner: unscheduled — same decision, same trigger as above.*

- **One `WEBHOOK_SECRET_<SOURCE>` per source**, so tenant B's secret is tenant
  A's secret. Per-tenant-per-source secrets are the fix.

  *Owner: unscheduled — same decision, same trigger as above.*

- **No caller-identity model for the agent** — the read-only role is not
  tenant-scoped, so the report worker sees all tenants.



  *Owner: unscheduled — same decision, same trigger as above.*

The honest one-line version of where this stands, corrected at CLOSE-3 (the
previous wording — "single-tenant with a tenant-safe ingest floor" — read as a
claim about ingress that was false for the two push doors, which carried no
tenant at all, and for the two remediation paths that reassigned tenancy to the
default): **one deployment serves one configured tenant, and the tenant it is
configured with is carried faithfully end to end — on both the push and the
pull halves.** `SWITCHBOARD_TENANT_ID` is resolved once at boot and passed
explicitly from there into: both webhook doors, the queue envelope, the worker,
the store, quarantine replay, DLQ replay, the connector registry, the scheduled
service wiring, the backfill poller, the hydration pump, the connectors'
reconcile paths, the cursors, the gap ledger, and the four operator CLIs'
default scope. Every one of those requires a tenant as an argument, so a
tenant-less write is a compile error rather than a silent write to the nil
tenant, and `connectorFor` refuses an empty one at runtime.

One deliberate exception, which the sentence above used to paper over (gate-H M2):
`unwrapJob` (`ingest/src/queue.ts:101-120`) accepts both a tenant-less job envelope
and a bare pre-2b-D4 event, and falls back to the process's tenant at **runtime**.
That is a rolling-deploy tolerance, not an oversight — a job enqueued by the old
code must still be drainable by the new worker, and the alternative is dropping
in-flight work at deploy time. It is not silent: both fallbacks `console.warn`.
So for the worker and DLQ-replay hops the accurate claim is "loud runtime fallback",
not "compile error"; for every other hop in the list the compile-error claim stands.

The first version of this sentence was wrong and is worth recording as such: the
push half was threaded and the **pull** half was not, which on a deployment that
actually set the variable would have stopped hubcrm hydration entirely and
silently (the pump scanned the nil lane while the door wrote the configured one)
and split every backfill-recovered event into a shadow row, because
`(tenant_id, source, event_id)` uniqueness cannot absorb a duplicate that is in a
different lane. No test could see it, because with the variable unset both halves
are the nil tenant and the behaviour is byte-identical to pre-wave. The pin that
closes it (`ingest/test/pull-tenant.test.ts`) sets a non-default tenant and drives
the real CLI, which is the shape any future tenancy claim here must be tested in.

The analytics layer below is still unpartitioned and will merge two tenants'
*entities* if two tenants' data ever reaches one database.

This is **not** a multi-tenant product and none of the above claims one. The
isolation model — per-client deployment versus multi-tenant SaaS — is an open
product decision; nothing in the code routes, registers or selects between
tenants, and the tenant plumbing exists so that whichever model is chosen starts
from data that is correctly attributed rather than from a nil-tenant pile.

## Security posture — open

- **`switchboard_app` is minted by migration 006 with a password equal to its
  own name** *(panel SEC-I3)* — and holds `select, insert, update, delete` on
  every table in `raw` and `ingest`, plus default privileges for future tables.
  That is a credential which does not vary per installation (CWE-1392), and
  because the RLS policy is permissive when no tenant context is set, the role
  sees every tenant at once. Anyone who can reach the Postgres port with
  `switchboard_app:switchboard_app` has read/write on raw events, raw bodies,
  quarantined payloads, cursors, the gap ledger and hydrated snapshots.
  **Narrowed at CLOSE-3:** `APP_DB_PASSWORD` now overrides it (`migrate.ts`,
  the shape `AGENT_DB_PASSWORD` used to give the agent role, before A1 deleted both
  that variable and the credential derivation it fed — migration 006 is applied
  and immutable, so the override lives in the migrator), the rotation note
  migration 005 carries is written down beside it, and `scripts/restore.sh`
  documents its `if not exists` as a guarantee so recovery cannot reset a
  rotated credential. The literal remains the documented local-dev value; the
  migration is deliberately not fail-closed, because `npm run migrate` is on the
  one-command demo path and breaking it buys nothing in this posture.

  *Still open: narrowing the grant to least privilege. Owner: unscheduled —
  a behaviour-changing privilege edit the isolation test depends on, separable
  from the credential defect, which was the urgent half.*

- **Row level security is inert at runtime** *(panel SEC-I2)* — the policies on
  the tenant-scoped tables are enabled AND forced, and the isolation test proves
  the boundary through `switchboard_app`. But that is a proven capability of the
  schema, not a live control on the running system: **no shipped code path
  connects as `switchboard_app` or sets `switchboard.tenant_id`, so RLS is inert
  at runtime today.** The service, migrations, CLIs, connectors and reconcile all
  connect via `DATABASE_URL` as the `switchboard` superuser, which PostgreSQL
  exempts from RLS regardless of FORCE; the agent connects as a non-superuser but
  never sets the context, so the policy's permissive branch admits every row.

  *Owner: unscheduled — gated by the same isolation-model decision as the
  multi-tenancy entry above (Part I §"What production would require" 1): making RLS
  live means running the service, CLIs and dbt as a non-superuser that sets
  `switchboard.tenant_id` on every connection. Trigger: the first multi-tenant
  engagement, or any deployment that declines to run as the `switchboard` superuser.*

- **The pg-boss schema carries no tenant column and no RLS** *(panel SEC-I1,
  deferred half)* — unlike every other ingest table. The job envelope now carries
  the tenant (CLOSE-3), which closes the reassignment path; the storage-level
  treatment does not follow it.

  *Owner: unscheduled — `pgboss.job` is a library-owned PARTITIONED table whose
  DDL comes from the vendored `plans.js`, and pg-boss ships `detectSchemaDrift()`
  specifically to flag divergence from what the library expects. Our own columns
  or policies there invite drift reports against an exact-pinned dependency.
  Trigger: revisit if pg-boss is replaced or unpinned.*

- **The mock vendors are unauthenticated and bind all interfaces** *(panel
  SEC-M3)* — `/simulate`, `/events` and `/subscribe` on ports 4002-4008 take no
  credential, and each mock `app.listen(port)` binds `0.0.0.0` while holding the
  signing secrets. Anyone on the host network can drive a mock into signing and
  delivering events the ingest door accepts as authentic. Disclosed rather than
  fixed: the mocks run as sibling containers on the compose demo path, where a
  loopback bind is not reachable from the ingest container — changing the bind at
  close would break the one-command demo for a synthetic-data harness.

  *Owner: unscheduled — the fix (loopback bind + a shared-secret header on
  `/simulate`) is a compose-topology change, not a code change, and buys nothing while
  the mocks exist only to feed a synthetic demo. Trigger: any run of the mocks outside
  a private compose network, or a host where the demo shares a network with anything
  else.*

- **Payload custody outside the database is unencrypted and un-tenant-scoped**
  *(panel SEC-M4)* — four surfaces: `out/ledger-*.jsonl` (full event payloads),
  `out/backups` (unencrypted whole-cluster dumps), the quarantine CLI's reason
  printing, and the hydrate-rearm CLI's deliberate full-entry audit print. All
  synthetic today, and `repo-hygiene.test.ts` mechanically enforces that no real
  vendor data enters the repo. On a real engagement these are PII at rest and PII
  on a terminal.

  *Owner: unscheduled — encryption at rest for the ledger and backup artifacts, and a
  redaction mode for the two CLIs, are four separate surfaces with four different right
  answers, and all four are no-ops on synthetic data. Trigger: the first engagement
  that puts real vendor payloads through this pipeline — which is also the trigger for
  the deletion/GDPR design in `docs/gdpr-erasure-design.md`.*

- **Secrets are delivered as environment variables** — OWASP's secrets-management
  guidance is blunt that environment variables are "generally accessible to all
  processes and may be included in logs or system dumps", and recommends against
  them unless other methods are not possible. Stated here rather than
  re-architected at close.

  *Owner: unscheduled — a secrets-manager integration is a deployment-target decision
  (the right client differs per platform) and there is no target to decide against
  while the repo's deployment surface is `docker compose` on a developer host. Trigger:
  a real deployment target, whose platform names the manager.*

- **JSON parsing precedes HMAC verification** *(audit)* — `express.json()`
  runs before the route's signature check, so unauthenticated bytes reach the
  parser (malformed JSON + no signature → 400, not 401). Verification itself
  is byte-correct (the parser's verify hook captures exact bytes). A test
  comment used to claim the opposite ordering; it was corrected and the actual
  order is now pinned by its own test. Moving verification into middleware
  ahead of the parser is the stricter design; deferred as low-priority — the
  parser surface is `express.json` with an explicit 100kb limit.
  *Narrowed (debt-burn B8):* the parser no longer precedes ROUTING — body
  handling is route-scoped with source validation first, so a request to an
  unknown `:source` answers 404 with the parser never run (it previously
  asserted a nonexistent endpoint's opinion of the body: 400/413/415). Only
  requests addressed to a source that exists reach the parser now, with the
  pinned 400/413/415 semantics unchanged for them. The parse-before-AUTH
  half above still stands as stated.

  *Owner: unscheduled — deliberately low priority: the parser surface is `express.json` with an explicit 100kb limit, and the parse-before-ROUTING half was closed in debt-burn B8. Trigger: any change that widens the body-parsing surface, or a real vendor whose signature scheme needs pre-parse access to raw bytes.*

- **The allowlist gates tool NAMES, not behavior** — rewriting the body of the
  one read-only tool would pass every current test. The database role (above)
  is the backstop that makes this bounded. Full behavioral evaluation and the
  approval-gated write action are Phase 3 scope (OWASP LLM06 "complete
  mediation" is the design reference: authorization enforced downstream, never
  by the model's own choices).

  *Owner: Phase 3 — behavioral evaluation lands with the approval-gated write action.*

- **Prompt-injection surface: the INPUT half is closed, the output half is not**
  *(audit; input half paid PRE-3)* — entity names and domains are
  vendor-controlled and flow through staging and identity resolution into the
  report verbatim. **Paid:** the system block now states that everything in the
  user message is data retrieved from a database, never instructions, and names
  summarisation as the only task (`REPORT_SYSTEM_PROMPT`, pinned as the text
  actually sent, not as a constant asserted against itself); and every mart-derived
  free-text field is fenced before it reaches Markdown at all THREE interpolation
  sites — the risk table's cells, the watch list's entries, and the appendix's code
  spans, the last found by sweeping the family rather than fixing the two obvious
  ones. The rule is neutralise, never drop: the words survive, so an adversarial
  entity is still visible to the operator, and only the structure-bearing characters
  are made inert. Pinned by a fixture entity literally named `Ignore previous
  instructions | ## URGENT …`. Zero new dependencies: `hai-guardrails` was read at the
  manifest and REFUSED for this wave — six runtime dependencies plus a
  `@langchain/core` peer, against `config.ts`'s standing zero-new-dependency
  constraint, and its decided scan-at-retrieval architecture has no retrieval
  boundary until Phase 3 builds one.

  **Still open, and stated precisely so the closure is not over-claimed:** (a) the
  MODEL-TIER scanner (heuristic/pattern/LLM classification of retrieved content),
  which belongs at the Phase-3 retrieval boundary where the decided cost architecture
  — deterministic tier first, hash-cached verdicts — actually applies; and (b) the
  OUTPUT-side validation, checking what the model produced before anything acts on
  it, which has no surface to attach to until the approval-gated write action exists.
  System framing raises the cost of an injection; it does not make one impossible.

  *Owner: Phase 3, for the two named halves only — the model-tier scanner at the retrieval boundary, and output-side validation with the approval-gated write action. It is no longer a blocker for Phase 3's start: the input half that had to be closed before any write action is granted landed in PRE-3.*

## Ingestion, operations and architecture — open

- **`DBT_SCHEMA` is a reader-side alias that reads like a deployment knob**
  *(gate-H I10)* — `agent/src/host/schema.ts`, `ingest/src/migrate.ts`,
  `scripts/verify-identity.ts` and the MCP/report SQL all honour it;
  `warehouse/profiles.yml` (`schema: public`) plus `dbt_project.yml`
  (`+schema: analytics`) make dbt build into `public_analytics` unconditionally, dbt
  is never passed the variable, and nothing in CI sets it. Set it to anything else
  and migrate creates and grants on an empty schema while dbt fills the old one and
  every reader queries the empty one. No test can catch it: `db-privileges.test.ts`
  and `mcp.test.ts` set `DBT_SCHEMA` and then create and populate that schema
  themselves, so they pass either way. RUNBOOK now says plainly that dbt does not
  follow it; that is the disclosure, not the fix.

  *Owner: CLOSE-4. Fix: decompose the variable so dbt gets it too — the profile's
  `schema:` and the project's `+schema:` compose into it, so honouring one env var
  end to end means changing both plus every reader's default. Reason for deferral:
  it moves warehouse files, so it cannot land without a dbt live-fire on every
  affected surface, and the failure it prevents is a misconfiguration nobody has
  made.*

- **The hubcrm emission ledger is written by the mock and verified by no shipped
  surface** *(gate-H I9, code half)* — `mocks/hubcrm/src/main.ts` genuinely writes
  the chained emission ledger `LEDGER_PATH_HUBCRM` names, drops included, and
  `verifyLedgerChain` is called from exactly one place (`connectors/ledger-feed.ts`)
  which hubcrm does not route through. So the F-1c artifact exists and nothing reads
  it. RUNBOOK and `.env.example` now say so rather than implying a fail-closed rule
  that does not apply to this source.

  *Owner: unscheduled. Fix: either a hubcrm-side chain verification on the emission
  ledger, or stop writing it. Trigger: any work that gives hub-hydrate a second
  oracle, or a real HubSpot connector, whichever comes first — both decide whether
  the artifact is worth keeping.*

- **The operator scripts hardcode the database while honouring `DATABASE_URL` for
  the app** *(gate-H M5)* — `scripts/check-demo.sh` exports `DATABASE_URL`
  (respecting an override) and then runs `docker compose exec -T postgres psql -U
  switchboard -tAc …` with no `-d`, resolving to the default `switchboard` database
  regardless: the oracle can be evaluated against a different database than the
  pipeline wrote. Same pattern in `demo.sh`, `chaos.sh`, `backup.sh` and
  `verify-durability.sh`, and sharpest in `restore.sh`, which truncates and restores
  the hardcoded database with no reference to `DATABASE_URL` at all.

  *Owner: CLOSE-4. Reason for deferral: `demo.sh` and `chaos.sh` cannot be run under
  the close's hard rules (port conflict with a concurrent session), so a change to
  the scripts' database resolution cannot be verified where it would break — the same
  reason the exit-code scheme is deferred, and the same standard.*

- **The exit-code scheme is not applied** *(panel OPS-I6 + OPS-I2 + OPS-C2's
  config class + OPS-M4)* — every non-zero exit from every CLI is `1`, so a
  transient network partition and a genuine integrity breach are
  indistinguishable to anything that wraps them, and a scheduled reconcile cannot
  be wired to different responses (retry versus page a human). Concretely: a
  reconcile red during a vendor maintenance window carries the same severity as
  permanent data loss, which is precisely how gates get muted — the same hazard
  one layer up from the "a permanent red is a red people learn to skip" reasoning
  `cli/gap-ack.ts` already exists to prevent. Related and unfixed with it:
  `npm run quarantine` (the sweep) exits 0 having recovered nothing while rows
  remain, disagreeing with its own `--replay <id>` sibling; a `LEDGER_PATH_X`
  that is SET but points at a missing file reconciles as a valid empty ledger
  (PASS on a quiet lane, and on a busy one a red labelled "extra (in raw, not in
  ledger)", which reads as phantom ingestion); and a CLI that cannot reach
  Postgres reports a bare `AggregateError [ECONNREFUSED]` without naming the host
  and database it tried.

  *Owner: CLOSE-4, as one wave. Deferred from CLOSE-3 on scope, not on merit. The
  intended scheme is three classes — `1` integrity, `75` `EX_TEMPFAIL`
  unavailable, `78` `EX_CONFIG` misconfigured (sysexits(3)), consumable by
  `systemd.service(5)`'s `RestartForceExitStatus=` / `RestartPreventExitStatus=`
  — applied to every CLI at once plus a RUNBOOK table, because landing it
  piecemeal produces exactly the inconsistency the finding is about. Its
  precondition is a full audit of every script and test asserting a specific exit
  status; that audit was performed and found 53 exit-status assertions across
  seven ingest CLI test files plus a live collision in `scripts/chaos.sh:187-202`,
  which treats backfill's `exit 1` as "resumable, retry up to 3x" and any other
  code as non-resumable and fatal. Changing backfill's unreachable-source exit to
  `75` inverts that retry logic, and `chaos.sh` cannot be run under CLOSE-3's hard
  rules (port conflict with a concurrent session), so the change cannot be
  verified where it would break. The quarantine-sweep half additionally needs the
  "newly still-invalid" refinement — exit non-zero only when newly-still-invalid
  rows exist, since jsonb-unstorable rows are permanently unreplayable by
  construction (RUNBOOK 108-114) and a blanket non-zero would be a permanent red.*

- **The hydration pump has no real liveness probe** *(panel OPS-I5, deferred
  half)* — the cycle now says explicitly when it did not contact the object store,
  which removes the misleading affirmative. It still does not PROVE reachability.

  *Owner: the Phase-4 health/metrics work. Trigger: whenever that lands. Reason
  for deferral: a per-cycle reachability call changes the failure semantics of the
  entire scheduled backfill path, which is not a close-wave change.*

- **README's demo event counts are the last hand-maintained numbers in the docs**
  *(cold review M6)* — `README.md` states "560 events across 4 sources: hubcrm 300 ops,
  stripefeed 100, casebus 80, support 80". Accurate at head, and the only machine-changed
  doc number left without a mechanical check now that the suite count, the dbt totals
  (steps / models / seeds / data tests / PASS / WARN / ERROR), the workspace count, the
  fast-check property count, the staging-view count, the mock-server count and the
  register scoreboard are all derived and CI-gated.

  Two things this entry corrects, because the PRE-3 pass wrote both of them down wrongly
  and a wrong reason is worse than an open item: (a) it claimed `check-demo.sh` validates
  the numbers — it does not. That script asserts `ledger == raw == journal` **per source**
  and non-zero for the pull paradigm; it never compares against an absolute count, so
  every one of these figures could drift while it stayed green. (b) It claimed the
  numbers were ungateable here. They are literals in `demo.sh` (`{"count": 100}`,
  `{"count": 80}`, the `210+20+70` hubcrm chunking), so the same source-grep derivation
  already used for the fast-check property count would reach them without running
  anything.

  *Owner: CLOSE-4. Reason for deferral: the honest gate reads the counts `demo.sh`
  actually POSTs and compares them to what the run ingests, and the hard rules forbid
  running `demo.sh` (port conflict) — so a grep-only gate would pin the literals to each
  other and prove nothing about the pipeline, which is the vacuity class this repo keeps
  paying for. Land it in the wave that can execute the full demo path and show the
  output, alongside the warn-set detector item below, which defers for the same reason.*

- **`scripts/demo.sh` does not run the warn-set detector** *(panel OPS-M5)* —
  `verify-dbt-warns.ts` runs only in `ci.yml`, so the local "run these before
  trusting anything" path ends on a `dbt build` whose green tick explicitly does
  not mean clean. This is disclosed in bold in RUNBOOK with the exact expected
  counts; the gap is that the local gate is a human reading a summary line while
  the script that would mechanize it exists and takes one line to call.

  *Owner: CLOSE-4. Reason for deferral: the one-line fix touches `demo.sh`, and
  neither the research pass nor CLOSE-3 could run `demo.sh` under the hard rules
  (port conflict), so it would land unverified on the researcher's word alone.
  Land it in a wave that can execute the full demo path and show the output.*

- **No connector runs against a real vendor sandbox** *(panel CRED-2)* — every
  source is a mock in this repository, so fidelity to a real vendor's pagination,
  rate limits, error shapes and delivery semantics is asserted by the connectors'
  own research notes rather than demonstrated.

  *Owner: Phase 3 kickoff, and explicitly AFTER SEC-I3 and SEC-I4 have landed
  (they now have). Reason for deferral: it is a phase, not a fix — it needs a real
  Stripe test-mode or HubSpot developer account, a credential-handling story, a
  cassette-replay harness so CI stays hermetic, and a journal page on fidelity
  deltas. Doing it before the credential defects were fixed would have been
  backwards; that ordering is the argument.*

- **`reconcile()` is unbounded in memory** *(audit; text corrected PRE-3)* — the
  text used to say "full event-id set and full parsed ledger". Re-read at head,
  `ingest/src/reconcile.ts` holds **SEVEN** unbounded structures live at peak, before
  the `missing`/`extra`/`crossTenantEventIds` outputs: `ledgerEntries` (the whole
  parsed ledger array), `ledgerIds` (Set), `rawRes.rows` (the whole raw result),
  `rawIds` (a *separate* full array), `rawIdSet` (Set), `seenPerTenant` (a Set of
  `tenant␣id` keys), and `idTenants` — a Map of Set per event id, **the most expensive
  of the lot**, added by the gate-H I8 cross-tenant work. The old sentence described
  the pre-I8 shape and had rotted. The headline reliability proof OOMs before the
  documented ledger ceiling bites. Fine at demo scale; listed in scaling-ceilings.

  *Owner: unscheduled — bounded by the documented ceiling in `docs/scaling-ceilings.md`; harmless at demo scale. Trigger: any lane whose raw volume approaches the ledger ceiling already recorded there, or the first non-demo deployment of reconcile. Fixing it means a server-side cursor for the raw scan, a streaming line reader for the ledger, and a rewrite of the diff into a merge-join — real work with no demo-scale payoff, which is why PRE-3 corrected the TEXT and deliberately deferred the code.*

- ~~Unstorable quarantined rows have no replay path~~ *Partially paid (2a.3):*
  `npm run quarantine` now lists and replays quarantined rows through the
  ingest gate. jsonb-unstorable rows (NUL / lone surrogates / extreme depth)
  still report `still-invalid` by design — the event store is jsonb too;
  `replay --sanitize` (explicit, logged, operator-approved transform) remains
  planned — **re-stamped at phase-2b close (F11): Phase 4** (2b closed without
  it; it rides the same Phase-4 raw-contract step that makes jsonb-unstorable
  rows storable in the first place).

  *Owner: Phase 4 *(re-stamped — was "Phase 2b" until the F11 truth pass)*. It rides the same Phase-4 raw-contract step that makes jsonb-unstorable rows storable in the first place.*

- **Nothing alerts on quarantine depth** — the CLI makes it *visible*
  (`--list`), but nothing pages. *Scheduled: Phase 4 monitoring.*

  *Owner: Phase 4 monitoring.*

- **The raw store is stricter than the wire.** `raw_events.payload` is jsonb,
  which rejects content valid JSON can carry; today's quarantine divert is the
  mitigation. Decided end-state — **re-stamped at phase-2b close (F11)**: the
  2b-D decision took the expand-now arm only, and the raw CONTRACT step
  (**text-first raw** + **claim-check enqueue**, which dissolves this class
  entirely) moved to **Phase 4**; 2b closed without it, and this label
  previously still promised it "Phase 2b".

  *Owner: Phase 4 *(re-stamped — the 2b-D decision took the expand arm only; this label previously still promised "Phase 2b")*.*

- **Column reorder is UNPROVEN against a real sheet.** The connector resolves
  column positions by header *name* on every fetch and never caches them, so a
  reorder is expected-safe by construction — and since PRE-3 that expectation is
  also EXERCISED: the sheets mock models `move_column` (header label and every
  row's cell moving together), and the connector is put through a reorder between
  cycles with three assertions — no spurious events, a clean reconcile, and a real
  edit still landing afterwards. All three passed on the first run, which was the
  predicted outcome; the value is that a future change which starts caching
  positions now reds.
  **The entry is NOT retired, and the supporting sentence it used to carry was
  wrong:** it said "no test can exercise a reorder", which described the mock we
  wrote (`seed.ts`: "Header renames change the header TEXT only"; `editor.ts`:
  "positions never change — only labels") rather than reality, where a human drags
  a column. Proving the connector against our own mock is a weaker oracle than a
  real spreadsheet, so the headline claim stands. Note also what was deliberately
  NOT done: `move_column` is buildable but is in no fault plan's weighted mix, because
  every plan's output is seeded and dozens of soak assertions are pinned to those exact
  sequences — adding an operation to a mix is a spec change about what "a messy human"
  does, arriving bundled with a mass re-pin that would hide whatever else moved.

  *Owner: unscheduled — first real-Sheets engagement. Trigger: pointing the connector at a real spreadsheet; verify before trusting it. What remains unproven is narrower since PRE-3: the connector's name-resolution is exercised against our own mock, never against a real spreadsheet's behaviour.*

- **`deriveState` is O(full history), and history only grows.** Both of its
  queries (latest-per-row and the supersession counts) scan every sheet event
  ever ingested — every edit *and* every revert appends forever, so per-cycle
  cost grows monotonically. Registered as two halves. **(a) The near-term half is
  PAID (PRE-3):** migration `013_sheet_row_key_index.sql` creates
  `idx_raw_events_sheet_row_key on raw.raw_events (tenant_id, source,
  ((payload->'data'->>'row_key')), id desc)` — leading equality predicates, the
  expression as the `DISTINCT ON`/`ORDER BY` key, `id desc` last so the ordered
  walk needs no sort; `event_type` is deliberately left as a filter rather than an
  index column, being a two-value predicate over the whole lane. It is pinned by an
  `EXPLAIN` assertion on the index NAME, run with `enable_seqscan` off, because a
  one-page test table "will nearly always get a sequential scan plan whether indexes
  are available or not" (PostgreSQL docs) and the naive absence-of-Seq-Scan pin would
  false-red a correct index. Note the honest scope, which is asserted rather than
  described: the index serves the latest-per-row query and only PARTLY serves the
  supersession-count query, whose grouping keys include `event_type` and the coalesced
  content hash. **(b) The structural ceiling** (compaction / materialized latest-state)
  is untouched and still belongs to the Phase-4 raw-contract step, not the connector —
  013 makes the scan indexable, it does not stop `deriveState` being O(history).
  Trigger for the remaining half: a sheets lane past ~10⁵ events or measured catchUp
  latency regression.

  *Owner: structural half (compaction / materialized latest-state) Phase 4, with the raw-contract step. The near-term functional index landed in PRE-3 and is pinned by ingest/test/migration-013.test.ts.*

- **Cross-currency refusal is deliberately conservative at the deal grain.** Whether an
  entity's deals "mix currencies" is judged across ALL its deals, while the guarded sum is
  open-deals-only — so a closed EUR deal NULLs an otherwise pure-USD open-pipeline sum.
  Over-refusal only: no cross-currency number can ever be emitted, and all-USD data is
  unaffected. The precise fix (`count(distinct currency) filter (where status = 'open')`)
  is known and written down.

  *(text corrected PRE-3 — the stated TRIGGER was wrong, and it was the flattering kind of
  wrong.)* This entry used to defer on "a real multi-currency source to test against",
  which reads as *untestable* and is not true: the warehouse's seeds and synthetic sources
  already carry a `currency` field, and since #37 landed the door and the three staging
  models judge that field against the published ISO-4217 list, so a mixed-currency
  fixture can be written today out of codes that are genuinely currencies rather than out
  of plausible-looking strings — which is precisely what would have made such a fixture
  worth nothing. Nothing blocks the test. The honest reason to defer is different and
  narrower: loosening a conservative guard without a real multi-currency SOURCE to
  validate the loosened rule against trades a disclosed, bounded over-refusal for a
  possible under-refusal — and an under-refusal here emits a wrong number, which is the
  failure this repo will not take. The cost of waiting is a NULL an operator can see; the
  cost of being wrong is a total nobody can tell is wrong.

  *Owner: unscheduled — the precise fix is known and written down. Trigger: a real multi-currency SOURCE (not a fixture — a fixture is writable today) whose behaviour can validate the loosened rule. Over-refusal only until then; no wrong number can be emitted.*

## Approval queue (Phase 3 / A1) — two open halves shipped with the door

- ~~A1 ships an approval queue nothing can drain — AMENDED AT A2, in three halves~~
  *Paid (A0b, 2026-08-16):* login shipped, so the missing half — a human who can
  actually decide — exists; the entry's body is kept unstruck below because its
  emergency-drain remedy is pinned and still load-bearing.
  As shipped with the door: `switchboard_approval` held `select, insert` and
  deliberately no `UPDATE`, so rows entered `pending` and **could not leave**, and
  once `PENDING_PROPOSAL_CAP` (default 100) accumulated the door answered `429`
  **permanently**, legitimate proposals included.

  **What A2 retired.** The permanent-429 half is gone. Proposals now carry
  `expires_at`, the door's cap count is validity-filtered, a sweeper moves
  `pending → expired` at the TTL, and the queue read hides expired rows — three
  independent enforcement points, so a dead burst releases its budget even with
  no process running. The same numeral now counts a different quantity: unexpired
  pending rows.

  **What A2 changed about the remedy, and this is a correction rather than an
  addition.** This entry used to publish `update approval.proposals set state =
  'rejected' where …` as the manual drain. **A2's trigger makes that statement
  raise** — a `rejected` transition requires a decision row of the matching kind
  naming an approver, written in the same transaction, because a rejection is a
  human decision. The correct emergency statement is `update approval.proposals
  set state = 'expired' where state = 'pending'` as the migration owner:
  *expired*, not *rejected*, because nobody decided. A published remedy that has
  silently become a failing statement is worse than no remedy.

  **CLOSED by A0b (2026-08-16), kept for the emergency remedy above.** A0b shipped
  magic-link login, a database-backed session and the authenticated `/queue` +
  `/decide` pages (migration 019, `approval/src/human.ts`), so a signed-in approver
  can now deliberately reach `approved` and `rejected`; the queue drains by
  decision, by expiry, or — in an emergency — by the `expired` statement above,
  which remains the ONLY correct manual drain because an operator draining a
  wedged queue is still not deciding anything.

  *Owner: closed by A0b. The emergency-drain paragraph stays load-bearing and pinned (`ingest/test/approval-honesty.test.ts`).*

- 🚨 **A0b's login is a magic link, and a magic link is a bearer token in an
  inbox — whoever controls the approver's MAILBOX can approve.** Stated here
  because the ADR (`docs/adr/approver-identity.md`) requires this honesty line in
  terms rather than as a placeholder. What the mechanism IS: a CSPRNG token,
  hashed at rest, single-use by atomic compare-and-set, 15-minute expiry,
  rate-limited per account, session regenerated at login, one append-only audit
  row per login, CSRF defended twice (synchronizer token + Sec-Fetch-Site with an
  Origin fallback that refuses when both are absent). What it is NOT: proof of
  the person. It authenticates *reach into a mailbox*, so mailbox compromise is
  approval compromise, and no property of this repo changes that. Sub-limits that
  travel with it, disclosed rather than discovered:
    · **email resolution is exact byte equality** (015's `lower(email)` index is
      storage hygiene, never a predicate), so the address typed at login must
      match the seeded address exactly — a case-variant silently does not log in,
      by design, and the operator hears about it as "no email arrived";
    · **the outbound allowlist gates sign-in mail too** — the composition root
      (`scripts/approval-service.ts`) sends through the same `smtpSender`, so an
      approver whose address is not on `SWITCHBOARD_EMAIL_ALLOWLIST` cannot
      receive a link (a loud 503, not a silent drop);
    · **the `__Host-`/Secure cookie does not exist over plain http on a LAN
      address** — the documented dev path is `APPROVAL_COOKIE_INSECURE=1`
      (banner-logged, renamed cookie), and the production cookie is never
      weakened;
    · **auth availability is coupled to email deliverability** — the ADR's own
      caveat: if her domain's mail breaks, she cannot log in *and* the system
      cannot send;
    · **timing leaks approver-list membership** — the request path renders one
      identical page for every outcome, but an active approver's request awaits
      the real SMTP send before answering while an unknown address returns after
      one SELECT, so a caller timing `POST /login/request` can tell a registered
      address from a stranger's — a disclosed deviation from OWASP's "avoid
      timing discrepancies between valid and invalid cases". Weighed and kept in
      `approval/src/login.ts`: the send stays on the response path so a failed
      send earns the requester a loud 503 instead of wearing the
      anti-enumeration page (respond-before-send would close the timing oracle
      by opening a silent never-sent path), and padding to equalise a variable
      SMTP round trip is a guessed bound that leaks when exceeded. The leak is
      membership only, each probe of a real address mails that mailbox visibly,
      a relay-outage 503 leaks the same membership more loudly (same terms), and
      the bind is loopback today. Trigger for the respond-before-send shape plus
      operator alerting: this surface facing a network strangers can time.

  *Owner: A0b, shipped 2026-08-16. Trigger for revisiting: a second approver class, a non-loopback bind without TLS, or evidence of mailbox-compromise risk the customer cannot accept — the ADR names a password fallback as an explicit decision, never a reach-for.*

- **No per-window rate limit on the proposal door.** A1 shipped the two flood
  controls that were free while the table was being created — a unique
  `(tenant_id, idempotency_key)` making replay a database-level no-op, and a
  pending-row cap — and the queue is genuinely bounded by them: a compromised
  agent host holding the bearer token cannot drown the approver. The third
  control from the A1 review was not built, and the residual is real rather than
  theoretical: **every POST costs a `count(*)` round trip regardless of outcome**,
  so a caller sitting at the cap can pin the approval service's database
  connection indefinitely. That is a denial of service on the *door*, not on the
  queue. Mitigated today by loopback binding (`APPROVAL_BIND_HOST` defaults to
  `127.0.0.1`) and by there being exactly one legitimate caller, which is why it
  is low severity rather than absent. Recorded rather than argued away: it was an
  explicit item in the review's correction list and it did not ship.

  **A2 did NOT fix this, and made its cost slightly worse — stated plainly rather
  than claimed as a fix.** A2 added `PROPOSAL_ACTION_RATE_LIMIT` (default 20 per
  action type per rolling hour), which is a real volume control and is ranked
  above the static cap. But it is implemented as a second `count(*)` **in front
  of** the pending count, so a caller sitting at either limit now costs the
  database *two* round trips per refused POST instead of one. The residual named
  above — a denial of service on the *door*, not on the queue — is therefore
  unchanged in kind and marginally larger in degree. The known fix shape is
  unchanged and now covers both counts.

  🚨 **A related change deviates from the only published precedent, and we say so
  rather than implying we follow one.** The door now short-circuits an exact-fingerprint
  replay of an already-recorded proposal *before* the cap and rate counters, so a caller
  retrying after a lost response gets its answer instead of a `429`. **Stripe documents
  the opposite in terms** — "rate limiters run before the API's idempotency layer" — and
  the IETF idempotency draft is silent on the question, so this is our judgment and not
  standard practice. Two differences justify it: our `429` was being returned for an ask
  that was **already recorded and queued**, which is not what RFC 6585 §4 describes; and
  Stripe's client-side remedy for a 4xx — "always generate a new idempotency key" — is
  **actively harmful here**, because a new key produces a second row and a second card
  for the same ask, the exact duplicate the suppression design exists to prevent. The
  exemption is bounded where bounding is possible: it requires an already-existing row
  under that key, and **a new key at the limit still `429`s** — which is the boundary
  that matters, because a new key is the only thing that can create a row.

  🚨 **A mismatched fingerprint is ALSO exempt from both counters, and an earlier version
  of this entry said the opposite.** The code always behaved this way; the sentence was
  wrong. Measured at a limit of 6, with the budget filled and a fresh ask correctly
  `429`ing, five mismatched POSTs on an existing key returned `[422,422,422,422,422]` —
  unbounded. Corrected here rather than in the code, because on the merits the exemption
  is right: **an application-level counter cannot bound request volume, only row
  creation**, so counting mismatches would convert unbounded `422`s into unbounded
  `429`s and remove nothing (the cheapest unbounded path is a wrong bearer token, which
  costs zero queries). It would also make the residual **worse** — a refused request
  costs one indexed lookup today and would cost three — and it would let a client-side
  payload bug consume the budget that protects the human's queue, when the IETF model
  treats a mismatch as an error the client must CORRECT rather than a production event to
  meter. **JUDGMENT**, and explicitly not settled by research: Stripe documents
  limiter-before-idempotency only in general, and the IETF draft mentions rate limits
  nowhere at all.

  **The residual this leaves, stated plainly:** an attacker holding the bearer token can
  send unbounded `422`s against one known key, each costing a single indexed lookup and
  writing nothing. That is the same defect this entry already names — *a refused request
  costs a query* — reachable by one more path, and the fix shape below (a token bucket in
  FRONT of every count) is the only thing that closes it, because it is the only control
  that bounds requests rather than rows.

  *Owner: A0b/A5 — whichever first puts a second caller or a non-loopback bind in front of this door, since both remove the mitigations. Trigger: `APPROVAL_BIND_HOST` set to anything but loopback in a real deployment, or a second authenticated caller. Fix shape is known: a token-bucket per bearer identity in front of BOTH counts, so a refused request costs no query.*

- **`scripts/demo.sh` does not start the approval service, so the one-command
  demo never exercises the proposal door.** The README's verification promise is
  "one command runs the entire system"; after A1 that is true of everything except
  the newest and most claim-relevant component. The boundary is covered by tests —
  including a live round trip where the agent's own role gets `42501` attempting
  the insert the door just performed — but the demo is the artifact a skeptic
  actually runs, and a reviewer who reads only `demo.sh` sees no approval service
  at all. Not fixed in A1 for a stated reason rather than an omission: the change
  is a service start plus a readiness wait plus a proposal step, and the
  implementer could not execute `demo.sh` to verify it (the environment forbids
  running it — port conflicts with a live stack). A blind edit to the headline
  verification script that adds an unverified `wait_for` fails by *hanging* rather
  than by erroring, which is worse than the gap it closes.

  *Owner: A0b — it adds the approval page the demo would need anyway, and it is the first task after this one that can run `demo.sh` end to end. Trigger: any change to `demo.sh` for another reason; do not land this one without executing the script. Fix shape: start `npm run start -w approval` on 4009 after ingest, `wait_for 4009`, then `npm run propose -w agent` and print the resulting pending row.*

- 🚨 **An approved proposal that expires is a destroyed human decision, and A2
  ships no way to get it back.** An approval carries its own 72-hour validity
  window — OWASP puts expiry in the approval record, and an approval that never
  lapses is a standing authorisation by another name — so `approved → expired` is
  a real, terminal transition. But re-proposal belongs to A5, which is not built,
  and A2 ships no executor either, so **every** approved row currently meets this
  timer. 🚨 **A0b HAS NOW SHIPPED LOGIN (2026-08-16) AND A5 HAS NOT SHIPPED
  RE-PROPOSAL, so this is a LIVE defect, exactly as this entry predicted**: a real
  person can approve, and her decision can evaporate unexecuted with no trace of
  a remedy. The executor loop narrows the practical window (it polls approved
  rows every minute), but "narrow" is not "closed" — an executor outage longer
  than the TTL still destroys decisions.
  The 72 hours is itself a JUDGMENT with no source; it is named in
  `approval/src/config.ts` rather than buried. For scale: RFC 6749 RECOMMENDs **10
  minutes** for a consent artifact and RFC 7519/9068 permit clock leeway of "no more
  than a few minutes", so 72 hours is three orders of magnitude longer than the closest
  standardised analogue. A human approval queue is not an OAuth redirect, so that is not
  necessarily wrong — but the sources justify *having* a window, never *this* window.

  🚨 **This entry got WORSE, deliberately, and the trade is the right one.** Expiry is
  now enforced at the point of use on both the decision path and the execution path, not
  only by a sweeper. Before that, a just-expired approval quietly went through: unsafe,
  but the human's decision survived. Now it hard-refuses — so **fixing the safety hole
  increases the number of destroyed decisions** until a re-proposal path exists. The
  sourced mitigation is Stripe's shape for the same problem: act **before** expiry (warn
  on the card and in the queue read as the window closes), never with post-expiry grace.
  That is A0b/A5 work; A2 records it rather than building it.

  *Owner: A5 — it owns TTL values, re-validation of underlying facts at execution, and re-proposal after expiry. Trigger: A0b shipping login, which is what makes approved rows exist at all. Fix shape: a re-proposal path that mints a NEW proposal (new key, new hash) rather than resurrecting a terminal row, since terminal must stay terminal.*

- 🚨 **`executing` is a permanently non-terminal row class with no owner inside
  A2.** A proposal whose executor dies mid-send stays `executing` forever: the
  sweeper deliberately will not move it, `executing → approved` is correctly
  forbidden (that is the retry loop that double-sends), and only a live executor
  writes `executed` / `execution_failed` — which "A5 decides what to do" cannot
  deliver if A5 *is* the process that died. **A2 deliberately builds no
  auto-reaper**, because a timer that adjudicates a live in-flight send as
  `failed` is worse than a stuck row: the human authorised ONE send, and a
  mistaken `failed` invites a second. So A2 does three things and stops — it
  records the start time, it makes the class queryable by age
  (`findStuckExecutions`), and it hands the adjudication contract onward. This is
  **not** a cap wedge (`executing` rows sit outside the pending count), but if
  nobody writes that contract these rows accumulate silently.

  *Owner: A5 — it is the task that will know the vendor's delivery semantics, which is the only knowledge that can turn "this might have died" into "this failed". Trigger: the first real sending stack (C5). Fix shape: a reaper contract stating, per vendor, the age past which a `started` row with no terminal sibling may be adjudicated, and what it may be adjudicated AS.*

- **Amendment (Phase 3 / A2 §3.10) shipped as SCHEMA ONLY — no code can create one.**
  `approval.proposals` carries `supersedes`, `authored_by` and
  `authored_by_user_id`, with the foreign key and the both-ways CHECK that make a
  human-authored amendment attributable. **Nothing in the shipped code writes
  them.** There is no amend endpoint, no amend function and no amend CLI; the
  door's INSERT never sets `supersedes` or `authored_by_user_id`, and the only
  writer of the `superseded` state is duplicate collapse, which is a different
  thing entirely. A2's scope section assigns amendment to A2, and A2's own task
  breakdown (T1–T11) never tasked it — so this is a gap between two halves of the
  plan rather than a decision anyone made, which is exactly why it is written down
  here instead of being left to be rediscovered.

  It was briefly worse than a gap: the RUNBOOK published amendment as one of three
  live ways to drain a wedged queue, which would have cost an operator time at the
  moment when being wrong is most expensive. That sentence is corrected, and the
  honesty test now pins the absence in **both** directions — if someone builds
  amendment without updating these documents, it reds.

  Note the schema half is not wasted and must not be "cleaned up": `supersedes` is
  in the trigger's frozen-column list, and removing it would delete one of the
  eight columns the immutability guarantee is made of.

  *Owner: A2's follow-on (or A0b, whichever first needs the client to change an ask rather than reject it) — the schema is complete, so the work is an endpoint plus a card action. Trigger: the first request to edit a proposal instead of rejecting and re-proposing it. Fix shape is fixed by the schema: INSERT a NEW proposal carrying `supersedes = original.id` (the link is writable at insert and ONLY at insert), then move the original `pending → superseded`. Two rows, two acts; no path straight to `approved`.*

## Open halves of entries that live in Part I

These four are open work whose *context* is a design disclosure, so the full
explanation stays where it belongs in Part I and only the open half is counted
here. They are listed by name so the scoreboard is countable without reading the
whole file.

- **Reconcile-driven hydration repair pump** (automated re-arm/repair for
  DLQ'd hubcrm hydrations). The operator-invoked half shipped at the 2b close as
  the `hydrate-rearm` CLI; the automated half was deliberately split off,
  because automated repair wants the approval-queue spine rather than a
  close-scope daemon. Context: Part I, faithful-source end-state.

  *Owner: Phase 3 — on the approval-queue spine.*
- **Connector-level `default_currency` config.** A source that legitimately
  sends no currency should get a per-source declared default at the
  connector/config layer, not a lenient mart. Context: Part I, numeric &
  monetary integrity.

  *Owner: Phase 4 hardening / the next contract-touching slice (R11). Dormant
  until a currencyless source lands.*
- **Shared HMAC/ledger package.** *(text corrected PRE-3 — the duplication is WIDER
  than this entry disclosed.)* `ingest/src/hmac.ts` and `mocks/core/src/hmac.ts` both
  live at head — but the title has always said "HMAC/**ledger**" while the body cited
  only `hmac.ts`. The ledger half is real and is duplicated in three places:
  `ingest/src/reconcile.ts` carries explicit "intentionally duplicated … keep both
  copies in sync" notes against `mocks/core/src/ledger.ts` for
  `DEFAULT_LEDGER_HMAC_KEY`, for `ledgerHmacKey()`, and for the canonical chain hash.
  The cross-compat tests (which import the REAL mock functions) are what hold all of it
  together until consolidation. The duplication is DELIBERATE — it honours the rule that
  ingest's `src` must not depend on a test-only mock service package — so the fix is a
  new shared workspace package plus build/tsconfig wiring plus moving the cross-compat
  tests onto it, which is why PRE-3 corrected the text and deferred the work. Context:
  Part III, architecture.

  *Owner: Phase 4 *(re-stamped — the shared package did not land in 2b)*.*

## Cosmetic residues that are still genuinely open

- **Migration 001-recreate / 003-drop churn at startup.** Cosmetic noise on every
  boot; nothing depends on it.

  *Owner: unscheduled. Trigger: the Phase-4 raw-contract step, which rewrites
  this area anyway.*

- **`stripe-feed-oracle.test.ts`'s shuffled-page invariance can flake on a
  wall-clock second boundary** *(observed PRE-3; not caused by it)* — the oracle
  builds the same universe in two databases and deep-equals the resulting raw
  rows, including `occurred_at`, which the mock mints per run at SECOND
  granularity. When the two builds straddle a second boundary the identical run
  produces `…:02Z` in one and `…:03Z` in the other and the deep-equal reds,
  naming a timestamp difference that means nothing about ordering — which is the
  property the test exists to prove. Observed once in the PRE-3 wave's full-suite
  runs; it did not reproduce in that wave's other runs or in the review's. Low
  frequency by construction: it needs the boundary to fall inside a window of a
  few hundred milliseconds.

  *Owner: unscheduled — the next stripefeed-test slice, else phase close. Fix
  candidate: compare on a normalised or injected clock rather than deep-equalling
  minted timestamps (exclude `occurred_at` from the comparison and assert it
  separately as "within tolerance", or thread a fixed clock into both builds).
  Deliberately NOT fixed in PRE-3: it changes an ORACLE's comparison semantics,
  and weakening what an oracle compares is not drive-by work — it needs its own
  reasoning about what the relaxed comparison can no longer catch.*
---

# Part III — Paid

The struck history, kept for the record. Each entry keeps its original wording
and its *Paid (…)* provenance, because what was wrong — and what actually fixed
it — is the part worth reading.

## Identity resolution


- ~~`occurred_at` ordered as text and unvalidated at ingest~~ *Paid (2a.2):*
  ISO-8601 gate at both raw doors, `timestamptz` ordering. *Extended (2a.3):*
  the gate now also bounds occurred_at to **[now-30d, now+5m]** — a
  well-formed-but-absurd timestamp (`9999-12-31`, vendor clock bugs) previously
  pinned an entity's latest-state forever, undislodgeable by any later correct
  event *(audit)*. Out-of-window events quarantine, never drop.

- ~~Multi-tuple entities can straddle ambiguity guards~~ *Paid (2b Task F):*
  every tier's over-merge guard now groups by **entity** (source,
  source_entity_id) across ALL of the entity's evidence — never by (entity,
  evidence-key) — so a requester whose tickets carry two clean tuples matching
  two different canonicals demotes to manual review exactly like a single
  ambiguous tuple always did, at both tiers. The live-reproduced 2026-07-31
  shapes (tier-2 two-clean-tuples; tier-1 different-emails bypassing
  `tier1_ambiguous`) are pinned as plain green tests in
  `ingest/test/identity-straddle.test.ts`, shown red against the pre-fix SQL;
  boundary companions pin that corroborating evidence (multiple tuples, one
  canonical) still resolves at its tier. Evidence strings for the new
  cross-group case name the count of conflicting tuples/emails.

- ~~Tier 2 is unsafe on free-email domains~~ *(audit)* *Paid (2b Task F):*
  the free-email blocklist (dbt seed `free_email_domains`, provenance on the
  seed schema) now demotes any tier-2 match whose domain evidence is a free
  provider to manual review with the provider named — never a silent merge of
  two unrelated gmail businesses, and never a bare `unmatched` that hides
  that a match occurred. Free evidence is no-signal: it neither resolves nor
  conflicts (corporate evidence beside it still resolves); exact-address
  tier-1 evidence stays provider-blind. The sheets arm's orphan-derived
  domains run through the same gate. The normalizer legal-name variants
  (trailing comma, `Co`/`PLLC`, `&`/`and`, double spaces) are fixed in the
  shared normalizer pair, vector-pinned. *(F-1)* The list is now VENDORED —
  13k+ domains from the exact-pinned `free-email-domains` npm package (MIT,
  NOTICE) via a committed generator (`scripts/generate-free-email-seed.ts`)
  that validates shape and refuses example-universe entries; the committed
  CSV's content is pinned (canonical-provider sentinels, well-formedness) and
  the demotion is exercised through the REAL list, closing the F-core
  review's vacuity finding. Upstream includes disposable/webmail hosts —
  deliberately kept: neither category identifies a company, and a listed-
  domain match demotes to a human, never drops data.

- ~~A merge event targeting a nonexistent company mints a phantom canonical~~
  *Paid (2a.2):* `assert_canonical_targets_exist` dbt test + unit test proving
  the detection fires.

- ~~`crm_emails` reads full raw history~~ *Paid (2a.2):* latest-state only.

- ~~Unicode confusables under-merge silently~~ *Paid (2b Task F):* the pinned
  normalizer now NFC-normalizes, deletes zero-width characters, and reads NBSP
  as a space — in BOTH languages (shared `normalizeCompanyName` in mocks/core;
  identical SQL expression in `identity_resolution.sql`), vector-pinned in
  `ingest/test/normalizer-vectors.test.ts`.

- ~~Email evidence is byte-exact, and the arms disagree on even that~~ *(cold
  review M-3)* *Paid (phase-2b close, F15 — the promised identity-quality
  pass):* one shared rule at every email evidence edge —
  `nullif(lower(trim(email)), '')` in `identity_resolution.sql` (crm_emails +
  billing/support source_entities arms; sheets always had it) with the TS half
  `normalizeEmail` in mocks/core — vector-pinned like the name normalizer
  (`EMAIL_NORMALIZATION_VECTORS`, end-to-end tier-1 per vector in BOTH join
  directions, RED shown first: mixed-case under-merged on the shipped SQL).
  Deliberate scope: lower-trim only — SMTP's case-sensitive-local-part edge is
  accepted (a collision routes to manual-review tiers, never a silent merge,
  and the pre-fix under-merge of ordinary mixed-case mail was the larger real
  error); no plus-tag/dot aliasing rules, which are provider-specific and
  would manufacture false merges.

- ~~TS↔SQL normalizer divergence outside the pinned vectors~~ *(cold review
  M-4)* *Paid (phase-2b close, F16 — vectors first, then the truth):* both
  suspected classes are now vector-pinned (em-space U+2003; non-ASCII
  uppercase "CAFÉ"), and the RED run refuted the suspicion on the pinned
  stack — postgres:16-alpine runs en_US.utf8 (compose AND CI), where PG's
  regex space class matches U+2003 and `lower()` agrees with `.toLowerCase()`
  on the accented class, so the vectors pin AGREEMENT. The C-locale tripwire
  covers ONE of the two classes, measured not assumed (close review, C-locale
  scratch db): the accented vector genuinely diverges there (SQL `cafÉ group`
  vs the TS oracle's `café group`) and reds the SQL-side suite loudly, while
  the em-space vector collapses identically under BOTH locales — that vector
  fixes its class as agreement but buys no locale coverage, and is annotated
  as such at the vector. One residual divergence found and documented AT the vector
  (mocks/core `normalize.ts`): Turkish İ (U+0130) lowers to 2 code points in
  JS, 1 in PG — locale-honest, surfaces as a loud verify-identity tier
  mismatch, deliberately not special-cased.

## Security posture


- ~~Every secret fell back silently to a constant published in this repo~~
  *Paid (2a.3)* *(audit — critical):* `secretForSource` and the ledger HMAC
  key now **fail closed** with an actionable error; the demo defaults exist
  only behind an explicit `ALLOW_DEV_SECRETS=1`, and the ingest service
  asserts all required secrets at boot (one aggregated error). Git history
  was checked clean of real secrets.

- ~~No replay protection~~ *Paid (2a.3):* signatures are now
  `t=<seconds>,sha256=<hmac over t.body>` with a ±300s window (the
  Stripe/Slack/HubSpot consensus). The timestamp is signed material —
  re-stamping a captured header fails. Within-window replays are absorbed by
  `(source, event_id)` idempotent dedup.

- ~~"Read-only agent" was a naming convention~~ *Paid (2a.3):* the report/MCP
  pool connects as `switchboard_agent`, a role Postgres limits to SELECT on
  the analytics schema — no raw/ingest access at all. Pinned by tests that
  assert the *database* refuses writes (42501). Previously the pool was the
  app superuser and the `READ_TOOLS` allowlist was the only barrier *(audit)*.

## Ingestion & reliability


- ~~The demo/chaos scripts leak their mock server processes~~ *Paid (debt-burn
  B2); CI-confirmed 2026-08-01 — the chaos workflow ran green with the new
  group-kill traps on the wave head.* The cleanup traps used to `kill` the
  `npm` process they started, but `npm run` spawns through a shell and does not
  reap its grandchild on SIGTERM ([npm/cli#6684](https://github.com/npm/cli/issues/6684)),
  so a `node` listener could outlive the script and hold its port — what
  contaminated the first CI chaos run. Both scripts now enable job control
  (`set -m`: every backgrounded pipeline becomes its own process group) and the
  traps kill the GROUP (`kill -- -PGID`), reaping the npm→sh→node chain —
  mechanism live-verified on macOS with a grandchild chain. The entry's
  original fix suggestion was itself refuted by research: `setsid` does not
  exist on macOS and `pkill -P` matches direct children only. The freshness/
  instance guards stay as the second line of defense (their `lsof` guidance
  remains the stale-state recovery path), and chaos+demo remain separate CI
  jobs. Final confirmation is the next CI chaos run — the scripts must not run
  in shared local environments.

- ~~`alter default privileges` in the migrations is not scoped `FOR ROLE`~~ *Paid in
  full (2b migration 007 + debt-burn B9):* the static grants for the default
  `public_analytics` schema were `FOR ROLE`-scoped in 007 (catalog-proven under a
  split-role migrator), and the *runtime* grant in `migrate.ts` (`grantAgentReadOnly`,
  which handles `DBT_SCHEMA` overrides) is now scoped too — `FOR ROLE $DBT_ROLE`, a
  new identifier-gated env var naming the role dbt connects as, with the docs'
  membership precondition surfaced as a clear error and role existence checked
  (pinned in `grant-role-scope.test.ts`, membership case under a non-superuser
  migrator). `DBT_ROLE` unset preserves the old unscoped behavior for existing
  deployments and logs the limitation at migrate time (wording pinned). Also note:
  007's scoped grant requires the migrator to be a member of `switchboard` — a
  missing membership fails loudly at migrate time.

- ~~`replayAllQuarantined` records no attempt~~ *Paid (2b, migration 007):* quarantine rows
  now carry `attempts` and `last_attempt_at`, recorded on every replay attempt (recorded
  *before* the outcome on purpose: a crash can overcount attempts, never undercount — the
  forever-crashing rows this feature exists to expose are exactly the ones that must never
  show zero). The original text for the record: a permanently-unreplayable row was retried
  forever and quarantine depth could never drop, and an operator could not answer the
  question dead-letter handling exists to answer: *has this been tried, and can it safely
  be replayed?* Still open alongside it: nothing alerts on quarantine depth (listed under
  operations below).

- ~~`/simulate` has no explicit start index, so which events a mock emits depends
  on a process-lifetime counter rather than on the request~~ *Paid (debt-burn
  B3):* `/simulate` now takes an optional `start_index` (0-based script index
  of the batch's first event), making emission a pure function of the request
  — identical explicit-index requests emit the same events **by identity**
  (seq/id/type/data) across a server restart (pinned in
  `mocks/core/test/source-app.test.ts`; `occurred_at` and hashes stay
  wall-clock, so the guarantee is event-identity purity, not byte purity —
  the pin says exactly this). The explicit-index
  arm was chosen over `/reset` because a reset reintroduces exactly the shared
  mutable state being removed (research §B3). Default no-index behavior is
  byte-identical to before, and the process counter never rewinds below its
  high-water mark, so a shared ledger file keeps the chain verifier's
  strictly-increasing `seq` — a guarantee that is serial-only: a concurrent
  explicit-index request racing the counter could mint colliding seqs, which
  the ledger verifier's uniqueness predicate now catches loudly downstream
  (cold-pass note; the mocks are driven serially everywhere in this repo).
  The freshness assertions in demo.sh/chaos.sh
  remain as the second line of defense.

- ~~The backfill poll path still trusts the feed's cursor~~ *Paid (debt-burn
  A9):* the cursor now advances only to the max seq ACTUALLY processed from
  the page (ingested, duplicate, or quarantined — never the feed-supplied
  `last_seq`, with a monotonic no-rewind guard), so an overstating feed's gap
  is re-polled instead of silently skipped; and the fetch carries the sibling
  connectors' per-attempt `AbortSignal.timeout` (L1-G4), so a black-holed feed
  is a bounded named failure with the cursor untouched. Pinned in
  `backfill.test.ts` (lying feed recovered in full; 300ms bounded timeout).

- ~~The ledger hash chain doesn't enforce `seq` monotonicity or event-id
  uniqueness — a restarted mock forks the logical stream and still
  verifies~~ (that fork now breaks the chain at its line). *Paid in full
  (debt-burn A6, to the Task D report's spec):* both
  `verifyLedgerChain` copies now enforce `seq` strictly increasing and
  `event_id` unique with `{ ok: false, brokenAt }`, the cross-copy drift test
  runs both copies over identical predicate fixtures, and `reconcile()` counts
  `ledgerDuplicates` instead of collapsing them in the Set (printed and gated
  by the CLI). Details of the original entry kept below for the record.
  - **Paid in Task D, for the bus source only:** the casebus stream's replay-id
    position is monotone **across resets** (a reset clears retained events but
    never rewinds the position counter), so a pre-reset cursor can never be
    silently revalidated by a later event; replay ids are unique by
    construction; and at-least-once duplicate delivery is pinned as
    absorbed-and-counted end to end (`bus-replay-oracle.test.ts` oracle 2).
    That removes the "replay makes duplicate seq real" hazard *for that
    source* — it does not touch the ledger verifier.
  - ~~Still outstanding: the verifier half (both copies, cross-copy drift
    coverage, and the `ledgerIds` Set collapse in `reconcile()`)~~ *Paid
    (debt-burn A6)* — see above; nothing of this entry remains with Task F.

- **Three connector-layer Minors were deliberately deferred at 2b Task D's
  review, and are recorded here rather than only in a task report** (which is
  the failure mode the L1-G7 entry above exists to correct). The review
  endorsed each skip; what follows is the decision, not a rediscovery list.
  *Owner: phase-2b close.*
  - ~~`BusReplayConnector.catchUp` has no `has_more`-with-empty-batch structural
    check, though its own `reconcile` does one screen away~~ *Paid (debt-burn
    A4, with its own RED as demanded):* catchUp now fails immediately and by
    name on an empty batch carrying `has_more:true` (no cursor progress ⇒
    structurally unterminating), instead of spinning to a `maxRounds`
    exhaustion misdiagnosed as depth; the maxRounds pin itself now runs against
    an honestly-deep stream.
  - ~~`StripeFeedReconcileReport.gaps` is still populated (from the ledger) but no
    longer read by the reconcile CLI~~ *Paid (debt-burn A3):* the remove arm was
    eliminated (AIP-180 — removing a public field is a breaking change, and the
    Task B oracle reads it); the CLI now consumes `gaps` (stripefeed AND bus) as
    a cross-check against the ledger rows it prints — agreement printed even at
    zero, disagreement a named red + nonzero exit (`cli/gap-crosscheck.ts`).
  - ~~`gap-ack --list` without `--source` iterates `enabledSources()`, so a gap
    recorded against a source not currently in `INGEST_SOURCES` is invisible~~
    *Paid (debt-burn A5, in the one considered pass this entry asked for):*
    `--list` now defaults to ALL recorded gap state for the tenant, rows tagged
    with their source and not-currently-enabled sources flagged (disclosure,
    not noise); `--source` narrows; `--tenant` landed on both CLIs in the same
    pass (see the tenancy entry below).

- ~~The door-enumeration comment in `ingest/src/event-schema.ts` is stale~~
  *Paid (debt-burn, B12 rider + review fix):* the bus-replay door joined the
  enumeration as this entry asked — and the review's grep of
  `eventSchema.safeParse` call sites then found **hub-hydrate** (Task C's
  door) also missing, now added. The enumeration matches the grep at head:
  seven doors (webhook, quarantine replay, backfill poll, sheet-snapshot,
  stripe-feed, hub-hydrate, bus-replay).

- ~~`ingest.outbox` has no consumer *(audit)* — written in the hot ingest
  transaction, `processed_at` never set, grows one row per event forever,
  *named* for a transactional-outbox pattern the system doesn't implement~~
  *Paid (debt-burn B10, rename+cap arm):* the implement arm was eliminated —
  the pattern's authority (microservices.io) requires a message relay
  publishing to a broker with consumers, and none of those exists here (dbt
  reads `raw` directly; durability is pg-boss's), so a relay would publish to
  nobody. Migration 011 renames the table to what it is —
  `ingest.ingest_journal`, an in-transaction ingest audit row and the demo's
  equality counter — drops the never-set `processed_at` (the relay's column),
  and bounds growth with a 30-day TTL enforced by an on-insert trigger (TTL
  over a size cap: a row cap would silently shorten the equality window under
  load; reasoning in the migration). Pinned in `ingest-journal.test.ts`; the
  migration comment records that a real outbox becomes warranted only when a
  downstream consumer exists (Phase 3/4).

- ~~Oversized bodies return 500, not 413~~ *Paid (2a.3):* 413 with an explicit
  100kb limit; non-JSON content types now 415 instead of a downstream 500.
  (Upgraded from "cosmetic": to a real vendor, 500 means *retry me* — Stripe
  retries up to 3 days, HubSpot 10 times over 24h — so the wrong status turns
  one bad payload into a sustained retry storm.)

- ~~No migration tracking table — every start re-runs all migration files~~
  *Struck as stale (debt-burn B11/V2) — the tracking half was already paid and
  this entry contradicted the "What production would require" §3, which
  records it as paid:* `ingest.schema_migrations` exists with per-file sha256
  checksums (`migrate.ts:92-97` DDL, `:105` hashing), an applied-unchanged
  file is skipped (`:119`), a changed applied file **throws** naming the file
  (`:109-118` — refuse-on-drift), and a file is recorded only after success
  (`:125-129`), so a mid-file failure retries instead of being assumed done.
  (Gate-H M3: every line citation here was dead — F14, inside this same range,
  moved the body into `runMigrationsOn` and did not restamp the entry it edited.)
  ~~Narrowed entry — the advisory-lock half~~ *Paid (phase-2b close, F14, with
  the owed researched RED):* `runMigrations` now serializes concurrent boots
  with a session-level `pg_advisory_lock` taken on ONE dedicated checked-out
  client and held for the entire guarded section — the research's key finding
  was that the old `pool.query`-per-statement runner made a naive pool-level
  lock a silent no-op (the lock binds to whichever pooled connection served
  that one call). Session-level over `pg_advisory_xact_lock` deliberately:
  per-file record-after-success retry semantics are preserved. try/finally
  unlock; an unconfirmable unlock destroys the client so session end releases
  the lock (no pooled-but-locked connection can deadlock the next boot).
  Pinned in `migration-tracking.test.ts` (a second boot BLOCKS while the lock
  is held and proceeds on release — RED shown first against the lockless
  runner; release pinned on success AND failure). Disclosed caveat, unchanged:
  a transaction-pooling proxy (PgBouncer marks session advisory locks "Never"
  compatible with transaction pooling) would silently disable this lock —
  nothing in this stack runs one today; revisit the mechanism if one appears.

- ~~Env parsing foot-guns *(audit)* — `PORT`/`BACKFILL_INTERVAL_MS` go
  through bare `Number()` (a typo yields `NaN`, and `setInterval(fn, NaN)`
  fires every ~1ms), and an unrecognized `INGEST_ROLE` silently means "do
  nothing"~~ *Paid (debt-burn B1):* boot config now goes through a strict
  hand-rolled parser (`ingest/src/config.ts`, envalid semantics without the
  dependency): integer + range for `PORT` (1–65535) and
  `BACKFILL_INTERVAL_MS` (1–2147483647, setInterval's documented clamp
  boundary), whitelist for `INGEST_ROLE` — any invalid value is a boot
  refusal naming the variable, the rejected value, and what is accepted
  (wording pinned in `config.test.ts`; a typo can no longer become a ~1ms
  hot loop or a role that silently does nothing).

## Spreadsheet source (sheets)


- ~~The long-running service's backfill loop is still feed-shaped~~ *Paid (A7):*
  the interval runner now routes every enabled source through
  `connectorFor(source).catchUp` — the feed trio's behavior is pinned unchanged
  (regression tests in `service-wiring.test.ts`), and an opted-in sheets source
  runs snapshot catchUp cycles instead of 404ing `/events` once a minute.

- ~~No process hosts the nudge door yet~~ *Paid (A7, with the loop above — the
  deliberate sequencing this bullet promised):* `main.ts` now wires the sheets
  interval runner into `createIngestApp` as the nudge hook whenever sheets is
  enabled in a worker/all-role process, so a signed nudge runs an early catchUp
  through the same overlap guard as the loop (a nudge during a running cycle
  coalesces — skipped, never queued: the stateless connector's next cycle reads
  a fresh snapshot anyway). Receiver-only processes still host no runner and
  answer the honest 503; `WEBHOOK_SECRET_SHEETS` stays boot-asserted exactly
  when sheets ∈ `INGEST_SOURCES`.

## Support event-bus source (casebus), the gap ledger, and the Task D review minors


- ~~Disclosed limit — tenancy on the operator surfaces~~ *Paid (debt-burn A5):*
  both CLIs now take `--tenant` — gap-ack scopes its listing and its
  acknowledgement, reconcile constructs every tenant-capable connector scoped
  to the named tenant and reads/gates that tenant's gap ledger — with the
  default-tenant behavior unchanged when the flag is absent (pinned with a
  non-default tenant in `bus-cli.test.ts`). One honest residue: the
  ledger-feed paradigm's reconcile compares a whole raw lane against one
  ledger file and is **not** tenant-scoped, so reconcile `--tenant` refuses
  ledger-feed sources by name rather than answering cross-tenant.

- ~~The reconcile integrity probe can throw instead of judging~~ *Paid (debt-burn
  A1):* `replayIdIsServed` is now classified AWS-SDK-style — only the vendor's
  documented corrupted-cursor rejection is a verdict (gap path unchanged); any
  other probe failure is transient transport and becomes
  `integrity: { ok: false }` for that source only, with its own wording, **no
  gap row filed**, standing-loss disclosure and later sources intact (pinned
  both directions in `bus-replay.test.ts` and `bus-cli.test.ts`).

- ~~A status frame that omits `stream_id` can bind a new cursor to the old
  stream identity~~ *Paid (2b Task F):* the mock gained its honest knob
  (`omitStreamIdInStatusFrames`, budget consumed only by frames actually
  rendered), and the simulated RED corrected this entry's own direction claim
  (the standing simulate-don't-reason rule): the coalesce resurrected a
  PREVIOUS stream's identity, so the next ordinary age-out compared stale-old
  vs current and mislabeled **retention as `reset`** — not reset as retention
  (that direction is the separate, documented conservative unknown-identity
  path). Fix: `setCursor` writes the identity verbatim (NULL = "unobserved"),
  and the connector binds only identity observed DURING THE RUN (a mid-run
  omitting frame keeps the run's carry; a blind run binds NULL). Pinned both
  directions plus the boundary in `bus-replay.test.ts`; reconcile's mid-scan
  carry matches.

- ~~A ledger-insert failure in the corrupted-cursor path now fails the
  backfill — an unremarked failure-mode change with no test naming it~~ *Paid
  (debt-burn A2):* research (WAL record-before-act) resolved the open
  loud-vs-forward decision to **fail loud, on purpose** — the accidental
  behavior was the correct behavior. Now remarked at both `recordGap` sites in
  `bus-replay.ts` and pinned in `bus-replay.test.ts`: insert fails ⇒ run
  fails, cursor not advanced, no gap row; the next healthy run re-detects.

- ~~A2 residue — the RECONCILE-path `recordGap` throw still suppresses later
  sources' disclosures~~ *Paid (phase-2b close, F13):* A1's per-source
  containment shape now wraps `connector.reconcile()` in the CLI — a throw
  (deliberately including the fail-loud gap INSERT failure, A2's verdict kept:
  the connector never reports a loss it could not record) is contained to its
  source, which still discloses its standing ledger record (an INSERT failure
  is not an outage of the SELECTs), voids its live read with a named FAIL, and
  lets every later source print. The disclosure block was hoisted into one
  helper used by both the normal path and the catch, so the two outputs cannot
  drift. Pinned both directions in `bus-cli.test.ts` (trigger-forced INSERT
  failure: standing loss + named FAIL + later source's PASS all print, exit 1,
  no report lines for the thrown source, no gap row written; RED shown first —
  the shipped CLI died at its top-level catch with later sources silent).

## Debt-burn cold pass and Task E minors


- ~~The service log sits outside the compile-time consumption contract~~
  *Paid (2b Task F):* `createBackfillRunner` in `main.ts` now carries the
  same per-kind rest-destructure wall as the two CLIs (`satisfies
  Record<string, never>` over the base plus all four widened catch-up
  shapes), so checklist line 1's THIRD surface is compile-enforced — a
  phantom field planted on `StripeFeedCatchUpReport` errors in both
  `cli/backfill.ts` AND `main.ts` (demonstrated in the Task F report). The
  wall also surfaced two genuine service-log gaps it exists to catch: sheets
  `degradations` and hub `hydrated`/`tombstoned` were consumed by the old
  base-shape read and printed nowhere — both now print (loud channel for
  degradations; quiet-when-zero work line for hydration counts).

- ~~The profile seam reaches the three 2a mocks only; the four 2b mocks are
  deaf to it~~ *Paid (2b Task F-1):* sheets (`seed.ts`/`sheet.ts`/
  `editor.ts`), stripefeed (`feed.ts`), hubcrm (`store.ts`), and casebus
  (`stream.ts`) now accept `profile` through the same seam as the 2a mocks
  — one optional option, threaded to `generateManifest`, generic by default,
  refusing unknown names at construction with the valid set — so a profiled
  full stack keeps cross-system domain correlation coherent. Pinned per mock
  (content IS the profile's manifest; refusal is loud) in
  `ingest/test/profile-threading.test.ts`. Profile selection is still
  programmatic only (no script/env threads one) — unchanged, and now safe
  either way.

- ~~The bus arm of the gaps-vs-ledger cross-check printed a claim it could not
  discriminate~~ *Paid (phase-2b close, F10, claim-narrowing arm):* the bus
  arm's PASS line now says what it is — "gap cross-check (structural): the bus
  report's gaps are the ledger's own rows — self-consistency, not an
  independent derivation" — while the stripefeed arm keeps the real
  "report agrees with the durable gap ledger" claim (its report derives gaps
  independently). The comparison still runs on both arms as defense in depth;
  an independent bus derivation remains real design work, deliberately not
  done at close (nothing now overclaims while it doesn't exist). Pinned in
  `bus-cli.test.ts` (structural wording positive, independent-claim wording
  negative, both zero-gap and gap-bearing runs).

- ~~A gap recorded on a source later removed from the SOURCES registry is
  listable but unacknowledgeable~~ *Paid (phase-2b close, F9):* the `isSource`
  gate in `gap-ack` now falls back to the RECORDED ledger — a `--source` with
  gap rows for the tenant is a source of record whatever the registry says
  today, so the loss can be listed under its name AND accepted; only a source
  unknown to BOTH the registry and the ledger refuses as a typo. Pinned in
  `bus-cli.test.ts` (removed-source gap acknowledged end to end; typo still
  refused; RED shown first).

- ~~A well-formed but unknown `--tenant` UUID silently PASSes~~ *Paid (phase-2b
  close, F8):* an EXPLICITLY named tenant with zero rows across every
  tenant-scoped table now refuses on both CLIs with shared wording — "no
  recorded state for tenant …" (`cli/tenant-state.ts`), exit 1 — instead of a
  clean reconcile PASS / healthy-looking empty gap listing. Flag-absent
  default-tenant runs are untouched (a fresh deployment legitimately starts
  empty). Pinned in `bus-cli.test.ts` (unknown-tenant red on both CLIs, RED
  shown first; sibling refusal wordings excluded per checklist line 5).

## Numeric & monetary integrity


- ~~Numeric bounds exist twice: TypeScript contract and dbt test SQL~~ *Paid (2b Task
  G):* the contract's quantitative bounds are now EMITTED to dbt as the
  `numeric_bounds` seed (`scripts/generate-numeric-bounds-seed.ts`, committed generated
  file per the free-email-seed precedent), the staging flag and both invariant-reading
  tests join the seed instead of re-typing values, and the consistency pins in
  `ingest/test/numeric-bounds-seed.test.ts` mechanically red the suite on any
  contract⇄seed drift (row-wise both directions, plus byte-wise against the emitter).
  `assert_csat_in_scale` got a loud-when-bound-missing shape so a vanished seed row can
  never turn the invariant vacuous.

## Architecture


- ~~Mirrored SQL in tests is synced by discipline~~ *Paid (2a.3), with a
  correction:* this file previously said a mechanical CI diff was "in
  progress". That check **did not exist**, and could never have worked — the
  mirrors were deliberately non-identical (ref→fixture substitutions). Worse,
  the audit found one mirror had **already drifted** (`like 'company.%'` vs
  the model's `= 'company.updated'`, under a comment claiming to be "the
  exact" query), so three ordering invariants were being proven against a
  query not in production. The fix is stronger than detection: all four
  mirrored SQL strings were deleted and the tests now **load the real model
  text from disk** (`loadModel`, refs → fixtures) — drift is structurally
  impossible, and re-introducing the audit's exact drift turns the suite red
  (demonstrated in the 2a.3 commit).

- ~~HMAC/ledger helpers duplicated across workspaces, cross-compat "by
  construction"~~ *Corrected and paid (2a.3):* the previous wording here
  overstated what the tests proved — the "cross-compat" tests wrote with a
  *third, test-local copy* of the algorithm and never imported the mock, so
  the mock-side copies could drift with every test green (only the nightly
  chaos workflow would have caught it). The
  tests now import the REAL mock functions; mutating the mock's hashing turns
  7 tests red (demonstrated). The `src` copies remain intentionally duplicated
  — **re-stamped at phase-2b close (F11): the shared package did not land in
  2b** (`ingest/src/hmac.ts` and `mocks/core/src/hmac.ts` both live at head);
  it is **Phase 4** consolidation work, and the cross-compat tests above are
  what hold the pair together until then.

## Pre-Phase-3 cleanup wave (PRE-3)

- ~~**`INGEST_SOURCES` typos and empty values are silent** *(gate-H M10)* —
  `sources.ts` uses `?? DEFAULT`, which fires only on `undefined`, then
  `.filter(isSource)`, which drops unknown entries. `INGEST_SOURCES=hubcrm,stripfeed`
  runs one source; `INGEST_SOURCES=` runs zero — no runners, no reconcile coverage,
  no error — while the doors stay open.~~ *Paid (PRE-3, batch A):* `enabledSources()`
  now obeys `config.ts`'s recorded doctrine — unknown token, blank entry and empty
  value are each a boot refusal that names the variable, echoes the rejected value and
  lists what would be accepted. Resolved at `main.ts` module top level alongside
  `PORT`/`INGEST_ROLE`, so the refusal is a *boot* refusal rather than a smaller
  pipeline discovered later. Empty deliberately diverges from the scalar parsers'
  "empty means default" (the two readings — "explicitly zero sources" and "forgot to
  set it" — are indistinguishable, and the wrong guess ingests nothing forever); the
  error says to unset the variable to ask for the default. The `sources.test.ts` pin
  that *blessed* the tolerance was flipped in its own RED, with the doctrine quoted as
  the reasoning. Landed **before** the disabled-source door fix, deliberately: a door
  mounted over an `enabledSources()` that can silently return `[]` is worse than the
  open door it replaces.

- ~~**`INGEST_ROLE=worker` demands door secrets it can never use** *(gate-H M9)* —
  `main.ts` runs `assertWebhookSecrets(enabledSources())` before the role split, so a
  worker-only process — no `app`, no `/webhooks/*` — refuses to boot without
  `WEBHOOK_SECRET_*`.~~ *Paid (PRE-3, batch A):* `assertRoleSecrets(role, sources)`
  scopes the assertion to the roles that mount a door. Confirmed before relaxing:
  `secretForSource` is reached from exactly two call sites, both door handlers in
  `server.ts` (the event door and the sheets nudge door), so a worker loses nothing.
  The dangerous direction is pinned in the same RED — `receiver` **and** `all` still
  fail closed with the aggregated error naming every missing variable.

- ~~**A disabled source's webhook door stays armed** *(gate-H I11)* —
  `server.ts` admits any source in the registry (`isSource`), and `queue.ts`
  registers workers and scans DLQs over `SOURCES`, not `enabledSources()`;
  `enabledSources()` gates only backfill/hydration and reconcile. On any non-default
  `INGEST_SOURCES` that gives two conditions. With the secret still configured,
  `/webhooks/<disabled-source>` keeps accepting and ingesting into a lane **no
  backfill and no reconcile covers** — ingest with no zero-loss surface behind it.
  With the secret absent, `secretForSource` throws inside the handler, the catch-all
  answers 500 and logs server-side on **every anonymous POST** — the prober-noise
  class the sheets nudge door was fixed for, whose fix comment asserts "the event
  doors never had this shape because their secrets are boot-asserted exactly when
  their source is enabled", which is false for a *disabled* source's still-mounted
  door.~~
  *Paid (PRE-3):* both push doors are now mounted over the deployment's served set. A
  registered-but-disabled source answers **404** with its own sentence ("source not
  served by this deployment"), distinguishable in text from the unregistered-source 404
  that is unchanged. 404 rather than 410/503/403 on the specification: RFC 9110 sanctions
  404 for a server "unwilling to disclose that [a representation] exists", while 410
  falsely claims permanence about a reversible env setting, 503 falsely claims a
  self-clearing condition, and 403 carries the spec's own instruction to use 404 instead
  when hiding existence. Retry hazard cleared against real vendors before choosing —
  Stripe bounds retries at three days and lists 404 among them, GitHub does not retry at
  all, and the one non-retried code (2xx) would be a lie. The check runs before the
  signature and before the parser, so the 500 + server-side log on an anonymous POST is
  gone. **Family sweep:** `server.ts` mounts exactly two push doors and the second one —
  the sheets nudge — had the same hole wearing a different mask, since its existing 404
  answers "no secret resolvable" rather than "sheets is not enabled here"; both are fixed
  and both are pinned. `queue.ts`'s four `SOURCES` loops deliberately do **not** follow,
  and that decision is now recorded in `queue.ts` and pinned: a source disabled after
  events dead-lettered still has a DLQ that must be drainable. Landed after the batch-A
  boot refusal, without which a typo'd `INGEST_SOURCES` would have made every door
  vanish silently.

- ~~**`reconcile --tenant <the deployment's own tenant>` is refused while a bare
  `reconcile` of identical scope is not** *(CLOSE-3 close-out)* — the ledger-feed
  refusal keys on whether the `--tenant` flag was passed, not on the value, so an
  operator who names the tenant the deployment is already configured for gets a
  refusal for a run that would have been correct.~~ *Paid (PRE-3, batch B):* the gate
  keys on "an explicit tenant OTHER than this deployment's". All three cases are pinned
  in `pull-tenant.test.ts` — bare allowed, `--tenant <own>` allowed, `--tenant <other>`
  still refused, which is the cross-tenant answer the gate exists for. The fix carried a
  finding the entry did not: the comment at `cli/reconcile.ts:115` claimed this gate was
  "matching `connectorForTenant`'s gate below, which is the same rule and must not be
  able to disagree with this one", while `:65` compared against `DEFAULT_TENANT_ID` — a
  narrower and genuinely different rule, making the comment false at head. Both gates
  moved to the same sentence in the same commit, because fixing only `main()` would have
  created a NEW disagreement pointing the other way (with `SWITCHBOARD_TENANT_ID` set,
  `main()` would allow `--tenant <own>` while the backstop still threw). `:65` was
  corrected rather than deleted: it is unreachable from the CLI but reachable from direct
  callers including `reconcile-tenant-drift.test.ts`, so it is real defence-in-depth and
  only its comment was wrong.

- ~~**`scripts/verify-dbt-warns.ts` cannot follow `DBT_DBNAME`/`DBT_HOST`** *(gate-H
  M8)* — it reads stored failures over `DATABASE_URL` from a literal
  `public_dbt_test__audit`, while dbt wrote via the `DBT_*` profile. If the two
  disagree, the gate inspects a database dbt never touched and reports the absence as
  "store_failures must stay on" — a correct-shaped failure pointing at the wrong
  cause.~~ *Paid (PRE-3, batch B):* the gate resolves its connection from
  `DBT_HOST`/`DBT_PORT`/`DBT_USER`/`DBT_PASSWORD`/`DBT_DBNAME` with `profiles.yml`'s own
  defaults, so it reads the database dbt wrote to. When the two endpoints disagree the
  failure names both — `looked in <db>@<host>:<port> ... while DATABASE_URL names
  <db>@<host>:<port>` — and the `store_failures` sentence is kept for the one case where
  it is still the honest remaining suspect: the endpoints agreeing. The audit-schema
  literal is NOT config and was deliberately left alone; it is derived from
  `profiles.yml`'s `schema: public`, and the defect was the pool, not the name.

- ~~**Ephemeral test databases leak with no sweeper** *(gate-H M11, hygiene)* —
  `ingest/test/helpers/testdb.ts` has a careful, idempotent, termination-proof
  `cleanup()`, but nothing reclaims `switchboard_test_*` databases from a run that
  was SIGKILLed, and a review found three standing on the dev instance.~~
  *Paid (PRE-3, batch F):* a best-effort sweeper in vitest's `globalSetup`
  (`test/helpers/global-setup.ts`), delegating to a predicate
  (`test/helpers/sweep-test-dbs.ts`) written to be wrong in only one direction. The
  entry's own caution — "a sweeper that drops databases has its own foot-gun" — is
  answered by a CONJUNCTION, not a prefix match: the name must match the exact shape
  `freshTestDb` mints, anchored at both ends, AND the timestamp embedded in that name
  must be more than an hour old. Age is read from the name rather than the catalog
  precisely because the only databases it may touch are the ones whose names already
  carry `Date.now()`, so a name whose timestamp will not parse is proof it was not
  minted here and is refused rather than guessed at; a future timestamp is a clock
  anomaly and is also refused. The named `switchboard` database, scratch databases and
  every adjacent-looking name (`switchboard_test`, `switchboard_testing`, a minted name
  missing its suffix, an unanchored match) are pinned as refusals. The hook can log and
  cannot fail a run — a sweeper that reddens a green suite would be a worse trade than
  the leak. Verified live: three abandoned databases standing on the dev instance at the
  start of this wave were reclaimed, and a deliberately-young sibling created alongside
  an old one was left in place.

- ~~**No dependency audit or update automation in CI** *(panel SEC-M5)* — no
  `npm audit` step, no Dependabot/Renovate config. Builds are reproducible
  (`package-lock.json` committed, CI uses `npm ci`, pg-boss and the MCP SDK
  exact-pinned), so this is a monitoring gap rather than a drift gap.~~
  *Paid (PRE-3, batch F):* `npm audit --audit-level=high || true` runs in `ci.yml`
  before typecheck. The entry's refusal of the blocking form is honoured and PINNED —
  `ci-dependency-audit.test.ts` asserts both that the step exists and that its failure is
  swallowed, because the second half is what a future "let's make this strict" edit would
  quietly remove, and the workflow comment states the reason where that person will read
  it: an advisory in a transitive dev dependency this repo neither fixes nor ships would
  pin CI red forever, and a permanently red gate is a gate everyone ignores.

- ~~**A sheets mapped column that disappears is invisible to the gate surface**
  *(gate-H I5)* — a mapped column vanishing from the sheet header produces a
  degradation entry on the **catch-up** report (printed by `backfill` on stderr,
  which exits 0) and nothing at all on the reconcile report, which has no
  degradation channel: `SheetReconcileReport` carries `stale`, `degradations`
  exists on `SheetCatchUpReport` only. After one catchUp cycle the new events carry
  the truncated content and reconcile recomputes hashes through the SAME truncated
  mapping, so both sides agree and it prints `PASS: raw latest-state matches the
  sheet exactly`. Permanent field loss, gate green.~~ *Paid (PRE-3):*
  `SheetReconcileReport` carries `degradations: string[]` — the SAME field name, type
  and sentence as the catch-up surface, from the SAME `mapping.missing` derivation, so
  an operator greps one phrase across both instead of learning two vocabularies for one
  condition. It is consumed by the reconcile CLI's exhaustive destructure (the
  compile-time consumption wall meant the field could not be added without a decided
  operator surface) and printed even at ZERO, because a category inferred from silence
  is a category nobody looks for. Its line carries its OWN wording — a mapping failure,
  not "content differs" — so it cannot send the operator to the cell-level triage
  `stale` implies (operator-surface checklist line 5). The verdict routes through the
  existing `standingConditionsNote` rather than a fourth convention and does NOT hard-red
  the run, on the stripefeed-quarantine precedent: a disclosed, permanent,
  operator-actionable condition must not red every reconcile forever. So the gate can
  still be green; it can no longer be green and silent. Landed after the sheets-mock
  column work (#33), per the ordering note.

- ~~**ISO-4217 currency allowlist at the door** *(R11)* — the field contract's
  `^[A-Z]{3}$` gate is a SHAPE check standing in for a vocabulary: it admits all 17,576
  three-letter uppercase strings, of which roughly 176 are currencies. So `"ABC"`,
  `"ZZZ"`, `"BTC"` and `"XXX"` (which the standard publishes as *no currency*) pass the
  door, land in raw, stage as a currency, and become a value the mart groups by and
  refuses sums across — indistinguishable downstream from `"USD"`. The same regex was
  hand-written independently in three staging models, so four copies of one rule existed
  with nothing mechanically diffing them.~~ *Paid (PRE-3):* the rule is now MEMBERSHIP,
  and the list is generated, never typed. SIX is the ISO-4217 maintenance agency; its
  published `list-one.xml` (`Pblshd="2026-01-01"`) is the source, and
  `scripts/generate-iso4217.ts` renders it into TWO committed
  artifacts — `ingest/src/iso4217-codes.ts` for the door and
  `warehouse/seeds/iso_4217_currencies.csv` for dbt, which the three staging models now
  JOIN instead of describing. This is the `numeric_bounds.csv` precedent applied exactly:
  committed generated file, shipped renderer, generator script, and pins that red in every
  drift direction (revert-checked: neutering the membership branch reds 6 tests, a
  hand-edited module 5, a hand-edited seed 2). A fourth revert-check — moving the source
  file under stale artifacts, which red 3 — was performed when the file was in the tree and
  is **no longer performable**: the file is gone (see the amendment below), and the pins it
  exercised went with it. Standing in its place, and revert-checked at head: mutating BOTH
  committed artifacts CONSISTENTLY — the mutation the retired stale-source check could not
  see and the mutual module/seed tripwire passes — reds **6** tests in
  `ingest/test/iso4217.test.ts`, on the two golden-byte hashes, the spot-code list and the
  three door assertions. Door and warehouse are two renderings of one source, so they cannot
  disagree about what a currency is. `XXX` and `XTS` are excluded deliberately, named in
  three places. Operator surface: a shape-valid non-currency quarantines with a reason
  naming the standard AND the published edition it was judged against — so "our list is
  stale" is a hypothesis a human can form — and excluding the sibling shape-failure
  wording, so the two causes never wear each other's explanation. The list is live rather
  than remembered, and there is a pin that says so: `BGN` is REFUSED, because the
  source amendment is the one that withdrew it for Bulgaria's euro adoption. A
  hand-typed list would still be admitting it, and nothing would have said so.

  *(amended after the licensing review — the source file is no longer in this repo at all.)*
  SIX publishes `list-one.xml` for free download but attaches **no redistribution grant**,
  and the only express term reachable from the download page is a site-wide terms-of-use
  asserting copyright in "the entire content" and limiting use to "personal use". Shipping
  the file rested on the argument that a currency table is uncopyrightable fact —
  defensible, and what several comparable projects do, but an argument rather than a
  permission. So the repo now ships **only the derived artifacts**, matching the dominant
  ecosystem pattern (Debian `iso-codes`, `pycountry`, Datahub all publish derivations).
  Provenance — URL, published date, SHA-256 of the exact bytes — is recorded in
  `vendor/iso-4217/README.md`, and the generator takes a locally-fetched path as an
  argument.

  That trade has a cost, and naming it is the point: **nothing in the repo can recompute
  the artifacts from the source any more**, so the old byte-identity pins against the XML
  are gone and the recorded SHA-256 is documentary, not a check. The mutual "module and
  seed agree" pin would have been a tautology on its own — it passes for any consistent
  pair, including one with a code dropped from both. The guard is therefore CONTENT-based:
  a golden SHA-256 of each committed artifact as a literal in the test, the exact admitted
  count (176), fifteen named codes asserted present, both exclusions asserted absent, and
  the generator exercised against a hand-authored SYNTHETIC fixture rather than an excerpt
  of the real table. Changing an artifact now requires a matching visible edit to the pin.

- ~~**Agent test files assign `DBT_SCHEMA` at module top-level and share one
  database** — order-dependent by construction, benign today *(audit)*.~~
  *Paid (PRE-3, batch F), and the text OVER-STATED it:* the three schemas are already
  distinct (`agent_priv_test`, `mcp_test_analytics`, `host_test_analytics`), so the
  collision "share one database" implies was absent. The residual hazard was narrower
  and real — a module-top-level `process.env` assignment is a side effect of IMPORT, so
  it escapes the file that wrote it the moment these suites share a process, which is
  the parallelisation trigger this entry itself named. All three now use `vi.stubEnv` in
  a `beforeAll` with `vi.unstubAllEnvs` after, and the rule is pinned as a GREP over the
  whole agent test directory rather than as three edits, so the fourth such file nobody
  has written yet is covered. Repo-wide check at the same time: no test file anywhere
  else assigns `process.env` at module scope.

## Cosmetic / low


~~`fetchDlq`/`replayDlq` cap at 10 per invocation~~ *Paid (debt-burn A7):*
both drain the full queue in one invocation (drain-by-default per the AWS-CLI
pagination contract; pinned with a 12-deep DLQ in `queue.test.ts`) ·
~~reconcile skips a source whose ledger-path env var is unset (scripts pin all
three)~~ *Paid (debt-burn A8):* an enabled ledger-feed source with no
`LEDGER_PATH_<S>` now FAILS the reconcile naming the missing variable
(fail-closed config validation); the literal value `skip` is the explicit
opt-out · ~~the repo-wide hygiene test lives inside the CRM mock's workspace, so
its scope and its home disagree (relocate in 2b)~~ *Paid (debt-burn B6):*
relocated to `mocks/core/test/repo-hygiene.test.ts` — the workspace every
mock depends on and where the shared synthetic-data machinery lives; the
honest-home reasoning (and why a root-level test workspace was rejected) is
in the file's own header · ~~some log lines lack the
`[source]` prefix~~ *Paid (debt-burn B4):* the skip-tick, round-failed, and
resume-cursor lines now carry their source (pinned); the remaining
unprefixed lines are genuinely global-scope (CLI flag errors, whole-queue
depth counts), not per-source · migration
001-recreate/003-drop churn at startup · ~~CI installs dbt via bare pip (no
setup-python pin) and double-runs on PR branches (no concurrency group)~~
*Paid in full (debt-burn B7 + Task G second attempt; cross-event double-run
CONFIRMED-FIXED at phase-2b close, F2):* `setup-python@v7` pinned to 3.13 with
a pip cache keyed on the workflow file (where the pinned dbt version lives),
and a `concurrency` group normalized to the BARE branch name on both event
types (`github.head_ref || github.ref_name`, commit `a2d4b2e`) with
`cancel-in-progress` conditional off `main`. The earlier ref-keyed group's
push-vs-PR double-run limit no longer exists: attempt 2 was observed live on
the Task G push — one surviving CI run, its sibling cancelled. chaos.yml
still needs no group — its triggers (schedule / dispatch / PR label) have no
push+PR double-run pair ·
~~agent test files assign `DBT_SCHEMA` at module top-level and share one DB —
order-dependent by construction, benign today *(audit)*~~ *Paid (PRE-3, batch F),
and the text was OVER-STATED:* the three schemas are already distinct
(`agent_priv_test`, `mcp_test_analytics`, `host_test_analytics`), so the collision
"share one DB" implies was absent — the residual hazard was narrower and real, that a
module-top-level `process.env` assignment is a side effect of IMPORT and so escapes
the file that wrote it the moment these suites share a process, which is the
parallelisation trigger the entry itself named. All three now use `vi.stubEnv` in a
`beforeAll` with `vi.unstubAllEnvs` after, and the rule is pinned as a GREP over the
whole agent test directory rather than as three edits, so the fourth such file nobody
has written yet is covered too · assorted items
tracked in review ledgers.

## Follow-up loop (core loop, Wave 1) — disclosed weaknesses

- 🚨 **Summary, transcript and email are NOT built in Wave 1.** T17 (summary) and T18
  (transcript email) are Wave 2. The `crm.touches` summary column + CHECK and the
  `transcript_delivery` status exist in migration 016, but no code writes them: every
  completed call leaves `transcript_delivery = 'pending'` because that is the call-start
  value and nothing moves it. The three weaknesses below describe the *designed* Wave-2
  behaviour and are recorded now so the tradeoffs are on the record before the mechanism
  lands — they are **not** live defects today.
- *(Wave 2)* **If the transcript email fails, the transcript is gone.** No copy, no audio, no
  reconstruct path. Will surface as `transcript_delivery = 'failed'`.
- *(Wave 2)* **A crash between storing the summary and sending the transcript loses the
  verbatim record.** Mitigated only into VISIBILITY, by the `transcript_delivery = 'pending'`
  written at call start; the reconcile listing shows it. **Not recoverable.**
- *(Wave 2)* **The summary will be generated, not verbatim, and there is no stored source to
  check it against.** Its pointer to the email holding the real record is the only bridge,
  and that pointer is un-retrofittable.
- *(Wave 2)* **The system will store conversation content** — the summary. Less sensitive
  than a transcript, still her client's words about their circumstances.
- **Two contacts sharing a number are never merged, and there is no per-number cooldown.**
  Two contacts on one household line, both due the same day, can produce two calls. Accepted
  because the agent identifies itself and asks for a named person, so a second call is
  comprehensible. Re-add trigger: if she reports a household called twice in a day, the
  cooldown returns as a per-number execution-time gate — no migration needed. It must come
  back as a CLAIM, not a check, and its pin must be concurrent.
- **Identity is established by asking, not by data.** If the person who answers says they
  are the contact and is not, nothing here can know. No schema fixes that.
- **Nameless calls produce answers attributable only to a NUMBER.** Labelled
  (`identity_unverified`), never withheld, never silently mixed with verified answers.
- **A crash between the claim and the door POST self-heals within the claim lease.** Before
  the follow-up row is inserted, the next claim (15 min) re-drives it. After the row is
  inserted (the orphan), the date-aware open-guard resumes the same-date row on the next
  cycle — so it self-heals too, through pure production code. (This was a second C1-shaped
  hole: until the fix, a crash *after* the insert left an actionless open row that silenced
  the contact permanently and was invisible to reconcile item 1, and the plan's
  "self-heals in 15 minutes" was false for that window.)
- **Rejection = STOP AND SURFACE (owner decision made, and it corrects a false earlier
  note).** When she rejects a card, the owner-run close pass (beside reconcile) closes the
  follow-up row and sets `next_due_at = NULL`, so the loop does **not** auto-serve the card
  she declined, and the lead appears on the reconcile **"passed-on leads"** listing (the
  fifth) with her stated rejection reason. A rejection is a decision to respect, not a
  failure to retry (SOURCED: Odoo `unlink`s a cancelled activity — no successor, no snooze).
  She revisits a passed-on lead by re-setting it due. **`expired` and `execution_failed` are
  NOT rejections** — nobody chose — so the same close pass re-proposes them at the start of
  the next day in her timezone.
  · *Correction of the prior note (both clauses were false and are retracted):* it claimed
  "the row closes and re-asks tomorrow." Before this fix **nothing closed the row on
  rejection**, and the next Manila day the date-aware guard **silenced** the contact
  permanently and invisibly — not re-asked. That was the "half a fix" C1 defect the gate
  review caught.
  · Whether "no" should ever mean a *back-off re-ask* rather than a full stop remains a
  future owner knob (the required rejection `reason` is the hook), but the shipped default is
  stop-and-surface, not silence.
- **AMD reliability on Philippine carriers is unknown.** `unknown_answer` exists because of
  that, and it is deliberately not `answered`.
- **The permanent-silence class is closed BY CONSTRUCTION (V3, Option B).** The proposer
  opens the `crm.follow_ups` row only once ≥1 leg is buildable. A contact with nothing
  buildable — `call`/`both` with no phone number, or no active question set — is recorded as
  a BLOCKED follow-up (`no_phone_number` per-contact, `no_question_set` tenant-global and
  aggregated on the surface) instead of an open, action-less row. Blocked rows are surfaced
  on `blockedFollowUps`, excluded from the open-guard, and recover via the shipped upsert when
  the data arrives, so such a contact is never silenced. The earlier bug — three recurrences
  of the same class — was that the row opened before we knew there was work.
- **The CROSS-MIDNIGHT crash orphan is healed by freezing the door key (Family 3).** The
  door's idempotency key is `followup:{contact}:{dueDate}:{channel}`, and `dueDate` used to be
  derived from the claim's returned `next_due_at` — which on a RETRY is the 15-minute LEASE
  value. A cycle crashing after the follow-up row is opened but at/before the door POST at,
  say, 23:56 Manila therefore re-derived the NEXT day's date on retry, rolling the key while
  the date-aware guard counted the day-D orphan and suppressed the contact **permanently**.
  (Same Manila day this always self-healed; across midnight it never did.) The proposer now
  reads the frozen date back off the contact's open, unblocked, **zero-action** follow-up row
  and adopts it, so the retry re-derives the byte-identical key and the door replays. A row
  that already HAS an action is a live prior cycle and is never adopted — the guard keeps
  suppressing it — and blocked rows are never adopted either. No migration and no new grant:
  the date was already on disk.
- **Disclosed minor (verified INERT, and pre-existing): a `both`-channel contact that crashes
  mid-cycle across midnight is suppressed rather than re-driving its EMAIL leg.** Once the
  call leg has recorded its action the row is has-action, so the cross-midnight adoption above
  correctly declines to adopt it. ⚠️ **2026-08-19: THE BASIS FOR CALLING THIS INERT IS GONE.**
  This entry said "no email executor exists" — one does now (`executeEmail`, and it has sent
  real mail), so the argument that nobody is silenced no longer holds on its own terms. The
  call leg still carries the follow-up and the row still closes when the call leg resolves,
  so the practical exposure may be unchanged — but that has NOT been re-verified since the
  executor shipped. Re-assess before relying on this entry. Per-leg completion tracking is
  still deferred.
- **Disclosed minor: a contact blocked across MULTIPLE Manila days accretes one blocked row
  per day.** Same-day re-blocks are idempotent (one row), but after the lease crosses midnight
  the claimed due-date advances and a new date's blocked row is written while the prior day's
  stays blocked. All are surfaced (never silencing) and recovery clears the current day's row;
  a future close/dedup can tidy the stale ones. Not a silence.
- **`channel = 'both'` with no email address BUT a phone number proceeds on the call arm**
  (P4a): ≥1 action (the call), the email arm skipped as a data-completeness item, not a
  block. `both` with neither address nor number (nor set) is BLOCKED (`no_phone_number`
  primary), surfaced, never silenced.
- **The CRM↔approval link is by id and is not an enforced foreign key.** Deliberate: a
  cross-schema foreign key would require a reference privilege on the approval tables. A
  dangling link is detected by reconcile.
