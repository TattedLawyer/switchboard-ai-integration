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
  The per-key guards don't compose per-entity. *Scheduled: Phase 2b identity
  work.* Since 2a.3 the unit tests run the REAL model SQL (loaded from disk,
  unions intact), so this failure mode is now *expressible* in a test — the
  fix will land with a RED test first.
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
- **`alter default privileges` in the migrations is not scoped `FOR ROLE`** *(phase-close
  review)* — so it only governs objects created by the role that ran the migration. A
  deployment where `DBT_USER` differs from the migrating role gets marts the agent role
  cannot `SELECT`, presenting as a bare `permission denied for table` (42501) with nothing
  in the migration to point at. Cannot be reached as shipped — nothing in this repo or CI
  uses a split role — but it is a supported configuration, so it is a trap rather than a
  bug today. Confirmed against the PostgreSQL `ALTER DEFAULT PRIVILEGES` documentation,
  which states the target-role scoping explicitly. *Scheduled: 2b, with the split-role
  deploy path it belongs to.*
- **`replayAllQuarantined` records no attempt** *(phase-close review)* — no `attempts` or
  `last_attempt_at` column, so a permanently-unreplayable row is retried forever and
  quarantine depth can never drop. Beyond the churn, this is what stops an operator
  answering the question dead-letter handling exists to answer: *has this been tried, and
  can it safely be replayed?* Deferred because the fix is a schema migration, not a code
  change. Compounding it, nothing alerts on quarantine depth (listed under operations
  below). *Scheduled: 2b, with the migration.*
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
  *Scheduled: Phase 2b.*
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
3. **Operations (5–7 weeks).** Postgres volume + rehearsed restore (today
   `docker compose down` destroys the database; the runbook's pg_dump path is
   design, not implementation), service containers + health endpoints,
   structured logging with correlation ids, metrics + alerts on queue/DLQ/
   quarantine depth and backfill last-success age (the backfill can die
   permanently while logging a reassuring line every 60s), migration tracking.
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
