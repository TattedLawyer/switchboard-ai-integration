# Known issues

Every project carries debt. This file is the public, curated version of the
internal defect register — what's open, why it's deferred, and where each item
gets paid. If a limitation you hit isn't listed here, that's a bug in this file
too — open an issue.

Severity is about *carrying cost*, not embarrassment: HIGH items can corrupt or
hide state; MED items degrade operations; LOW items are rough edges.

**Provenance note (2a.3):** this register was originally written from a
*reliability* frame. In July 2026 an independent audit (a fresh model session,
read-only, given the code and told to treat this file as claims under audit)
re-read the codebase from *security* and *multi-tenant* frames and found three
serious gaps this file missed entirely — they appear below, marked *(audit)*.
The 2a.3 hardening wave paid the cheap ones and disclosed the rest. A register
is only useful if it's re-read from frames its authors didn't start with.

## Known-failing invariants (deliberately not in the green suite)

The fast-check property suite pins only invariants that hold. One that does
NOT hold yet is excluded on purpose — a green checkmark that hides a known
red would be worse than the bug:

1. **Name-normalization idempotence** — stacked legal suffixes normalize
   differently on repeat application (`"Acme Inc Ltd"` → `"acme inc"` → `"acme"`),
   so `norm(norm(x)) ≠ norm(x)` for some inputs. Latent for the seeded data, but
   NOT dormant as a project risk: `scripts/verify-identity.ts` makes the TS/SQL
   normalizer pair CI-load-bearing the moment any fixture uses `Ltd`/`Corp` —
   it is a tripwire, not background debt. Scheduled with the Phase 2b
   vendor-normalization work, which also aligns the strip sets (SQL strips
   `inc|llc|ltd|corp`, the manifest resolver only `inc|llc`).

*Paid:* the **ledger torn-line crash-safety** invariant formerly listed here
was fixed in 2a.2 (RED tests first, parse-guard in both verifier copies,
truncation-totality property 6 in the green suite).

## Multi-tenancy: the ingest layer is tenant-scoped; the analytics layer is NOT (partially paid)

**Paid (migration 006).** The audit's highest-severity finding was cross-tenant
data *loss*: `raw_events` uniqueness was `(source, event_id)`, so two tenants'
vendors both emitting `evt-1` silently dropped the second and reported it as a
successful de-duplication. That is closed:

- Uniqueness is now `(tenant_id, source, event_id)` — exactly-once is preserved
  *within* a tenant, and the same id from two businesses becomes two rows.
- `tenant_id` is present and indexed on `raw.raw_events`, `ingest.outbox`,
  `ingest.quarantine` and `ingest.cursors`. Cursors are keyed
  `(tenant_id, source)`: a shared cursor would let one tenant's progress skip
  another's events permanently.
- A tenant is **required, never defaulted** — supplying it explicitly-but-empty
  throws rather than silently substituting the default tenant.
- Row-level security is enabled **and forced** on all four tables. Note the
  reason `FORCE` alone was not enough here: PostgreSQL documents that
  *"superusers and roles with the `BYPASSRLS` attribute always bypass the row
  security system"*, and this project's `switchboard` role is a superuser. So
  006 also creates a non-superuser `switchboard_app` role, and the isolation
  test proves the boundary **through that role** — it fails if pointed back at
  the superuser. "We enabled RLS" is not a claim worth making otherwise.

**Still open, and it is the larger half:**

- **The analytics layer has no tenant partition.** Staging models, the identity
  tiers, and `customer_360` are unchanged. Two clients' "Acme Group /
  acme.com" would still merge into one entity — cleanly, with audit evidence,
  and **no ambiguity flag**, because the over-merge guard fires when one key
  maps to *multiple* canonicals and each tenant contributes exactly one. It is
  an over-merge guard, not a boundary guard. `customer_360` would sum both
  clients' revenue. Retrofitting means a partition in every join predicate and
  group-by across ~14 models.
- **The RLS policy permits access when no tenant context is set.** That is what
  keeps migrations, reconcile, dbt and the single-tenant demo working — but it
  means RLS here guards against cross-tenant leaks in tenant-scoped code paths,
  not against an application role that simply declines to set the context.
  Closing it needs a policy with no fallback branch on a dedicated role.
- **One `WEBHOOK_SECRET_<SOURCE>` per source**, so tenant B's secret is tenant
  A's secret. Per-tenant-per-source secrets are the fix.
- **No caller-identity model for the agent** — the read-only role is not
  tenant-scoped, so the report worker sees all tenants.

Until the analytics half lands, treat this as **single-tenant with a
tenant-safe ingest floor**: the pipeline will no longer destroy a second
tenant's data, but it will still merge two tenants' *entities* downstream.

## Identity resolution (HIGH interest)

- ~~`occurred_at` ordered as text and unvalidated at ingest~~ *Paid (2a.2):*
  ISO-8601 gate at both raw doors, `timestamptz` ordering. *Extended (2a.3):*
  the gate now also bounds occurred_at to **[now-30d, now+5m]** — a
  well-formed-but-absurd timestamp (`9999-12-31`, vendor clock bugs) previously
  pinned an entity's latest-state forever, undislodgeable by any later correct
  event *(audit)*. Out-of-window events quarantine, never drop.
- **Multi-tuple entities can straddle ambiguity guards.** A support requester
  whose tickets carry different (domain, name) or email values produces
  multiple candidate rows; two clean groups matching different canonicals pick
  a plan-dependent winner, and a clean group can outrank an ambiguity flag.
  The per-key guards don't compose per-entity: each tuple forms its own clean
  count = 1 group, so no guard fires, and the final `DISTINCT ON` orders by
  matched_tier alone. **Reproduced live against the real `identity_resolution`
  SQL on 2026-07-31** — both shapes, not just the tier-2 one: at tier 2, one
  requester with two tickets carrying two clean (domain, name) tuples matching
  different canonicals collapses to a single row with no ambiguity flag; the
  tier-1 shape (different emails across tickets, each matching a different
  canonical) **bypasses `tier1_ambiguous` entirely**, because that guard groups
  per email and each email is unambiguous on its own. Both are pinned at
  `ingest/test/identity-straddle.test.ts` as `it.fails` — they pass only while
  the defect exists and will fail loudly the instant a fix lands, forcing
  promotion to plain `it`. *Owned by Phase 2b Task F (identity/normalization),
  where the fix — per-entity cross-group ambiguity detection, or a
  deterministic same-tier tiebreak plus demotion — can be shaped against that
  task's final source set rather than reshaping guard semantics twice.* Until
  then, a real requester with conflicting clean evidence resolves silently and
  plan-dependently.
- **Tier 2 is unsafe on free-email domains** *(audit)* — there is no
  free-domain blocklist, so for gmail-heavy SMB data the domain half of
  domain+name carries no signal and every duplicate common name merges into
  the first company sharing it, unflagged (count = 1 → guard silent). The
  normalizer also fails on ordinary legal-name variants (verified empirically):
  `"Acme Plumbing, Inc."` → `acme plumbing,` (trailing comma — never matches),
  `Co`/`PLLC` not stripped, `&` vs `and` never match, double spaces preserved.
  *Scheduled: Phase 2b normalization + blocking work, before tier 2 ever runs
  on real data. Do not run tier 2 unsupervised on real SMB data until then.*
- ~~A merge event targeting a nonexistent company mints a phantom canonical~~
  *Paid (2a.2):* `assert_canonical_targets_exist` dbt test + unit test proving
  the detection fires.
- ~~`crm_emails` reads full raw history~~ *Paid (2a.2):* latest-state only.
- **Unicode confusables under-merge silently.** ZWSP/NFC variants make
  visually identical names normalize differently → false manual review.
  *Scheduled: Phase 2b normalization hardening.*

## Security posture (updated 2a.3)

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
- **JSON parsing precedes HMAC verification** *(audit)* — `express.json()`
  runs before the route's signature check, so unauthenticated bytes reach the
  parser (malformed JSON + no signature → 400, not 401). Verification itself
  is byte-correct (the parser's verify hook captures exact bytes). A test
  comment used to claim the opposite ordering; it was corrected and the actual
  order is now pinned by its own test. Moving verification into middleware
  ahead of the parser is the stricter design; deferred as low-priority — the
  parser surface is `express.json` with an explicit 100kb limit.
- **The allowlist gates tool NAMES, not behavior** — rewriting the body of the
  one read-only tool would pass every current test. The database role (above)
  is the backstop that makes this bounded. Full behavioral evaluation and the
  approval-gated write action are Phase 3 scope (OWASP LLM06 "complete
  mediation" is the design reference: authorization enforced downstream, never
  by the model's own choices).
- **Prompt-injection surface is unmitigated** *(audit)* — entity names/domains
  flow verbatim into the report prompt. Blast radius today is a wrong
  paragraph in a Markdown file (the risk table is computed deterministically
  and sits beside the narrative); this MUST be closed before Phase 3 grants
  any write action.
- **Secrets live in environment variables** — right-sized for this phase, but
  env vars are readable by all of a process's children and can leak into
  dumps; a real deployment should use a secret manager.

## Ingestion & reliability (MED)

- **The demo/chaos scripts leak their mock server processes.** The cleanup traps
  `kill` the `npm` process they started, but `npm run` spawns through a shell and
  does not reap its grandchild on SIGTERM ([npm/cli#6684](https://github.com/npm/cli/issues/6684)),
  so a `node` listener can outlive the script and hold its port. This is what
  contaminated the first CI chaos run. It is now *detected* — both scripts assert
  `GET /status` reports `fresh:true` before driving a mock, and refuse loudly with
  the observed cursor otherwise — and it can no longer couple the two workflows,
  which run as separate jobs on separate runners. The leak itself is unfixed.
  *Scheduled: next CI/ops pass — kill the process group (`setsid` + `kill -- -PGID`,
  or `pkill -P`) rather than the direct child.*
- ~~`alter default privileges` in the migrations is not scoped `FOR ROLE`~~ *Mostly paid
  (2b, migration 007):* the default-privilege grants for the default `public_analytics`
  schema are now `FOR ROLE`-scoped and proven by catalog inspection under a split-role
  migrator. **Residual:** the *runtime* grant in `migrate.ts` (`grantAgentReadOnly`, which
  handles `DBT_SCHEMA` overrides) is still unscoped — reachable only when a deployment BOTH
  overrides `DBT_SCHEMA` AND migrates under a non-`switchboard` role, a combination no
  shipped config uses. Register-owned: the fix lands with the next slice that owns
  `migrate.ts`. Also note: 007's scoped grant requires the migrator to be a member of
  `switchboard` — a missing membership fails loudly at migrate time.
- ~~`replayAllQuarantined` records no attempt~~ *Paid (2b, migration 007):* quarantine rows
  now carry `attempts` and `last_attempt_at`, recorded on every replay attempt (recorded
  *before* the outcome on purpose: a crash can overcount attempts, never undercount — the
  forever-crashing rows this feature exists to expose are exactly the ones that must never
  show zero). The original text for the record: a permanently-unreplayable row was retried
  forever and quarantine depth could never drop, and an operator could not answer the
  question dead-letter handling exists to answer: *has this been tried, and can it safely
  be replayed?* Still open alongside it: nothing alerts on quarantine depth (listed under
  operations below).
- **`/simulate` has no explicit start index**, so which events a mock emits depends
  on a process-lifetime counter rather than on the request. The freshness assertion
  above converts that from a silent wrong-answer into a loud failure, but the
  dependency remains. *Scheduled: Phase 2b — take a start index (or expose `/reset`)
  so emission is a pure function of the request.*
- **The backfill poll path still trusts the feed's cursor.** Schema validation
  is now in place — the poll path runs the same `eventSchema` gate as the
  webhook door and quarantines what fails, closing the third unguarded entry
  into `raw` that an audit found here. What remains: no fetch timeout, and —
  worse than the cursor *regression* previously listed here — the cursor
  advances to a **feed-supplied** `last_seq` rather than the max actually
  ingested, so a feed that overstates it permanently skips the gap: silent,
  unbounded data loss on the poll path *(audit)*. *Scheduled: Phase 2b
  connector work, where the poll path is the subject.*
- **The ledger hash chain doesn't enforce `seq` monotonicity or event-id
  uniqueness** — a restarted mock forks the logical stream and still verifies.
  *Partially paid in 2b Task D; the verifier half is NOT done. Owner: Task F.*
  - **Paid in Task D, for the bus source only:** the casebus stream's replay-id
    position is monotone **across resets** (a reset clears retained events but
    never rewinds the position counter), so a pre-reset cursor can never be
    silently revalidated by a later event; replay ids are unique by
    construction; and at-least-once duplicate delivery is pinned as
    absorbed-and-counted end to end (`bus-replay-oracle.test.ts` oracle 2).
    That removes the "replay makes duplicate seq real" hazard *for that
    source* — it does not touch the ledger verifier.
  - **Still outstanding:** `verifyLedgerChain` validates only the hash chain.
    It needs two more predicates — `seq` strictly increasing, and `event_id`
    unique within the chain — each returning `{ ok: false, brokenAt: <line> }`
    like the existing checks. The function is **duplicated on purpose** in
    `ingest/src/reconcile.ts` and `mocks/core/src/ledger.ts` (separate
    workspaces, no cross-import), so both copies must change together and
    `ingest/test/ledger-verify.test.ts`'s cross-copy drift coverage must be
    extended to the new predicates. Note also that `reconcile()` builds
    `ledgerIds` as a `Set`, which silently collapses a duplicate `event_id`
    into one — so the count comparison cannot see it today.
  - **Why Task D did not finish it:** neither file was in Task D's permitted
    file set. Re-owned by **Task F**, which already retires the old mock and
    touches this ledger machinery.
- **Three connector-layer Minors were deliberately deferred at 2b Task D's
  review, and are recorded here rather than only in a task report** (which is
  the failure mode the L1-G7 entry above exists to correct). The review
  endorsed each skip; what follows is the decision, not a rediscovery list.
  *Owner: phase-2b close.*
  - `BusReplayConnector.catchUp` has no `has_more`-with-empty-batch structural
    check, though its own `reconcile` does one screen away. Not a wedge — the
    `maxRounds` budget already bounds it with a loud failure — but the two
    halves are asymmetric. Deferred because adding a second termination path to
    a drain under fix-round pressure is how a bounded loud failure becomes a
    subtle one; it wants its own RED.
  - `StripeFeedReconcileReport.gaps` is still populated (from the ledger) but no
    longer read by the reconcile CLI, which prints ledger rows directly. A
    report field with no operator surface is the standing checklist inverted.
    Deferred because removing it is a public shape change to a Task B type that
    that task's oracle genuinely uses; decide it together with whether ledger
    rows should replace the field entirely.
  - `gap-ack --list` without `--source` iterates `enabledSources()`, so a gap
    recorded against a source not currently in `INGEST_SOURCES` is invisible to
    the listing that a reconcile failure points operators at. Deferred because
    it changes *which losses an operator sees*, and belongs in one considered
    pass with the `--tenant` flag limitation disclosed above — shipping half
    would leave two inconsistent scoping rules on one tool.
- **The door-enumeration comment in `ingest/src/event-schema.ts` is stale.** It
  claims "the invariant is the enumeration, not a count" and then lists the
  webhook, replay, backfill-poll, sheet-snapshot and stripe-feed doors — but
  not the bus-replay door added in 2b Task D, which applies the same predicate.
  A one-line comment fix; the file was outside Task D's permitted set, and the
  comment's own history is a cold-review finding about exactly this drift, so
  it is recorded here rather than left to be rediscovered. *Owner: Task F.*
- **`ingest.outbox` has no consumer** *(audit)* — written in the hot ingest
  transaction, `processed_at` never set, grows one row per event forever. It
  serves only as the demo's equality counter; it is *named* for a
  transactional-outbox pattern the system doesn't implement (durability
  actually comes from pg-boss). *Scheduled: 2b raw-layer work — either
  implement the pattern or rename and cap it.*
- **`reconcile()` is unbounded in memory** *(audit)* — full event-id set and
  full parsed ledger in memory; the headline reliability proof OOMs before
  the documented ledger ceiling bites. Fine at demo scale; listed in
  scaling-ceilings now.
- ~~Unstorable quarantined rows have no replay path~~ *Partially paid (2a.3):*
  `npm run quarantine` now lists and replays quarantined rows through the
  ingest gate. jsonb-unstorable rows (NUL / lone surrogates / extreme depth)
  still report `still-invalid` by design — the event store is jsonb too;
  `replay --sanitize` (explicit, logged, operator-approved transform) remains
  *Planned: Phase 2b/4.*
- ~~Oversized bodies return 500, not 413~~ *Paid (2a.3):* 413 with an explicit
  100kb limit; non-JSON content types now 415 instead of a downstream 500.
  (Upgraded from "cosmetic": to a real vendor, 500 means *retry me* — Stripe
  retries up to 3 days, HubSpot 10 times over 24h — so the wrong status turns
  one bad payload into a sustained retry storm.)
- **Nothing alerts on quarantine depth** — the CLI makes it *visible*
  (`--list`), but nothing pages. *Scheduled: Phase 4 monitoring.*
- **No migration tracking table** — every start re-runs all migration files;
  correctness depends on each being hand-proven idempotent (they are, with
  tests). Migration 003 executes `drop table ... cascade` on every run —
  concurrent boots of two replicas are a real hazard, not cosmetic churn.
  *Scheduled: Phase 2b (tracking table + advisory lock, with the documented
  PgBouncer caveat on advisory locks).*
- **Env parsing foot-guns** *(audit)* — `PORT`/`BACKFILL_INTERVAL_MS` go
  through bare `Number()` (a typo yields `NaN`, and `setInterval(fn, NaN)`
  fires every ~1ms), and an unrecognized `INGEST_ROLE` silently means "do
  nothing". *Scheduled: 2b config module.*

## Spreadsheet source (sheets) — dispositions from the A-slice (2b)

The sheet-snapshot connector treats a mutable grid as a CDC source: events are
manufactured from row content, reconcile re-reads the sheet's own truth, and the
push channel is a latency hint only. These are the honest edges of that design.

- **Column reorder is UNPROVEN against a real sheet.** The mock models header
  *renames* only — column positions never move — so no test can exercise a
  reorder. The connector is built for it anyway (the carried landmine rule:
  positions are resolved by header *name* on every fetch and never cached), so
  reorder is expected-safe by construction, but that expectation has never met a
  real spreadsheet. *Owner: first real-Sheets engagement; verify before trusting.*
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
- **`deriveState` is O(full history), and history only grows.** Both of its
  queries (latest-per-row and the supersession counts) scan every sheet event
  ever ingested — every edit *and* every revert appends forever, so per-cycle
  cost grows monotonically. Registered: (a) near-term, a functional index on
  `(tenant_id, source, (payload->'data'->>'row_key'), id)` serves both queries;
  (b) the structural ceiling (compaction / materialized latest-state) belongs to
  the Phase-4 raw-contract step, not the connector. Trigger: a sheets lane past
  ~10⁵ events or measured catchUp latency regression.
- **A still-garbage row re-quarantines every cycle.** The diff re-attempts any
  row whose raw state mismatches the sheet, so a row a human left broken adds one
  quarantine entry per catchUp until the cell is fixed. Quarantine *depth*
  therefore overstates distinct bad rows on this lane — triage by distinct
  `row_key`/`content_hash`, and see the RUNBOOK's fix-the-cell workflow.
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

## CRM thin-webhook source (hubcrm) — metadata-only push + hydration (2b Task C)

The HubSpot-style source delivers **metadata-only** webhook batches (up to 100
events per request, ordering not guaranteed, 10 retries over 24 hours and then
the delivery is gone — all research-verified) and the full record must be
fetched afterwards. Three stated limits of the paradigm itself:

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
  listed with reasons by reconcile, but a replay mechanism (re-arm a DLQ'd
  event for another fetch) is register-owned follow-up. Until it lands, the
  operator's path is: fix the vendor-side object, then delete the DLQ job so
  the pump retries (RUNBOOK). "Terminal" is retention-backed, not aspirational:
  the queue sets `retentionSeconds` explicitly (~68 years, the longest span
  pg-boss's int4 column can express) because the default is 14 days, after
  which the job is deleted and the event falls back into *no* state — reconcile
  would report it `hydrationPending` again, the pump would re-fetch the same
  broken object, and it would re-quarantine every cycle. The consequence is
  that the DLQ GROWS until an operator clears it, which is deliberate: depth
  is the documented watch surface, and a dead letter that evaporates is a
  silent return to limbo.

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
- **Disclosed limit — tenancy on the operator surfaces.** The reconcile and
  gap-ack CLIs operate on the default tenant, like every other operator surface
  in this repo. The ledger itself is fully tenant-scoped (two tenants losing the
  same vendor cursor get their own rows, and acknowledging across the tenant
  line is a no-op that says so), but a multi-tenant deployment needs a
  `--tenant` flag before those CLIs are usable for non-default tenants.

### Deferred minors from the Task D review (owners assigned)

- ~~The reconcile integrity probe can throw instead of judging~~ *Paid (debt-burn
  A1):* `replayIdIsServed` is now classified AWS-SDK-style — only the vendor's
  documented corrupted-cursor rejection is a verdict (gap path unchanged); any
  other probe failure is transient transport and becomes
  `integrity: { ok: false }` for that source only, with its own wording, **no
  gap row filed**, standing-loss disclosure and later sources intact (pinned
  both directions in `bus-replay.test.ts` and `bus-cli.test.ts`).
- **A status frame that omits `stream_id` can bind a new cursor to the old
  stream identity** (`setCursor`'s `coalesce`), which would later mislabel a
  reset as `retention`. Unreachable against this mock, which always sends the
  field; the honest fix needs a mock knob that omits it plus its own RED, not
  a defensive coalesce swap. Owner: Task F (mock/fixture rework).
- **A ledger-insert failure in the corrupted-cursor path now fails the
  backfill** (the awaited `recordGap`), where before the run made forward
  progress and exited 0. Loud-over-silent is the house bias, but it is an
  unremarked change to a shipped connector's failure mode with no test naming
  it. Owner: Task F, alongside the fault-injection fixtures it needs.

## Numeric & monetary integrity (added with the numeric-integrity wave)

- **The ingest contract cannot help rows that never pass a door.** The numeric contract
  (`ingest/src/numeric-contract.ts`) gates the webhook, replay, and backfill paths via the
  shared event schema — but rows already in `raw` from before the contract, direct inserts,
  and any future historical import are covered only by the staging safe-casts, which degrade
  a bad value to one NULL instead of a dead build. If those casts were ever removed as
  "redundant with the contract", this is what breaks. By design; disclosed so it stays a
  decision rather than becoming an assumption.
- **`plausibleMax` for payments is borrowed from Stripe's 8-digit charge bound.** It is
  derived for a Stripe-shaped processor and arbitrary for anything else, which is why
  exceeding it only ever WARNs (dbt `assert_amounts_plausible`) and never rejects — a
  genuine large payment must never fail a build or quarantine.
- **Numeric bounds exist twice: TypeScript contract and dbt test SQL.** The contract file is
  the declared source of truth and every SQL test repeating a bound carries a pointer
  comment, but nothing mechanically diffs them. A changed bound updated in one place only
  is detectable by reading, not by CI. *Scheduled: hardening batch.*
- **Cross-currency refusal is deliberately conservative at the deal grain.** Whether an
  entity's deals "mix currencies" is judged across ALL its deals, while the guarded sum is
  open-deals-only — so a closed EUR deal NULLs an otherwise pure-USD open-pipeline sum.
  Over-refusal only: no cross-currency number can ever be emitted, and all-USD data is
  unaffected. The precise fix (`count(distinct currency) filter (where status = 'open')`)
  is known and deferred until a real multi-currency source exists to test against.
- **Currency is now validated at the door (Phase 2b Task A2).** The field contract
  declares `currency` on the four money-bearing types: present-but-malformed quarantines
  the whole event with a reason naming the field (replayable like any quarantined event);
  ABSENT passes untouched — legacy pre-currency events must flow, and refused-at-mart
  semantics for NULL currency are unchanged. The staging `^[A-Z]{3}$`-or-NULL regexp is
  thereby demoted to containment for doorless rows (direct inserts, pre-contract history).
  The pattern admits plausible fakes like "ABC" — the ISO-4217 allowlist stays a
  registered follow-up.
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
  mart. *Registered follow-up: connector-level `default_currency` config.*
- **An error-severity numeric test failure halts the mart refresh.** dbt skips downstream
  models when a staging test fails at severity error, so one NULL amount that reaches
  staging stops `customer_360` rebuilding until someone looks. Loud by design — with the
  ingest contract active, a NULL there means enforcement decayed or a doorless row appeared
  — but operationally it is a stop-the-line switch, not a warning light.
- **`pg_input_is_valid` requires PostgreSQL 16+.** Compose, CI, and the docs all pin
  Postgres 16; a deployment on 15 or older fails at `dbt build` with an undefined-function
  error in every staging model that guards a cast.

## Architecture (decided, scheduled)

- **The raw store is stricter than the wire.** `raw_events.payload` is jsonb,
  which rejects content valid JSON can carry; today's quarantine divert is the
  mitigation. Decided end-state (Phase 2b): **text-first raw** + **claim-check
  enqueue**, which dissolves this class entirely.
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
  until the Phase 2b shared package.
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

## Cosmetic / low

`fetchDlq`/`replayDlq` cap at 10 per invocation — the CLI prints "repeat for
deeper queues", but an operator who doesn't reads a false "done" on an 11+
DLQ (upgraded wording from "display cap"; fix: loop-until-empty in 2b) ·
reconcile skips a source whose ledger-path env var is unset (scripts pin all
three) · the repo-wide hygiene test lives inside the CRM mock's workspace, so
its scope and its home disagree (relocate in 2b) · some log lines lack the
`[source]` prefix · migration
001-recreate/003-drop churn at startup · CI installs dbt via bare pip (no
setup-python pin) and double-runs on PR branches (no concurrency group) ·
agent test files assign `DBT_SCHEMA` at module top-level and share one DB —
order-dependent by construction, benign today *(audit)* · assorted items
tracked in review ledgers.
