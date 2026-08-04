# Switchboard runbook

Operational procedures for the demo stack. Everything here is runnable on a clean
clone with Docker (colima or Docker Desktop) and Node ≥22.

Two conventions used throughout: `npm run <x> -w ingest` runs from the **repo
root**, while the `node --import tsx src/cli/<x>.ts` form (used for `gap-ack`,
which is the one operator CLI with no npm script) runs from **`ingest/`** — which
is also the form `gap-ack` prints when reconcile tells you to run it.

## Environment

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | no code default — export it (scripts set it for you) | ingest, agent, CLIs |
| `WEBHOOK_SECRET_CRM` / `_BILLING` / `_SUPPORT` / `_SHEETS` / `_STRIPEFEED` / `_HUBCRM` / `_CASEBUS` | **required — fails closed.** No env var means the process throws at boot/first use; there is no silent fallback (the demo values are published in this repo). One secret **per source**, so a leaked secret compromises one source, not all. `_SHEETS` guards only the nudge door (see Sheets source operations); `_STRIPEFEED` and `_CASEBUS` each guard a door their pull-only paradigms never use (see those sources' operations sections); `_HUBCRM` is genuinely load-bearing — that source really does push signed batches; each is asserted at boot only when its source is in `INGEST_SOURCES` | mock signing, ingest verification |
| `LEDGER_HMAC_KEY` | **required — fails closed** (same rule as webhook secrets) | ledger writers (mocks), reconcile chain verification |
| `ALLOW_DEV_SECRETS` | unset. `1` opts in to the published demo secrets (`demo-secret-<source>`, `demo-ledger-key`) — local demo/test use ONLY; demo.sh/chaos.sh and the vitest configs set it. Never set it in a real deployment | everything above |
| `AGENT_DATABASE_URL` | derived: `DATABASE_URL` with user/password swapped to `switchboard_agent` (dev password `switchboard_agent`; override with `AGENT_DB_PASSWORD`). The agent/report pool runs as this **database-enforced read-only role** — set explicitly in production | agent report/MCP pool |
| `INGEST_INSTANCE_ID` | unset → `/status` reports `instance_id: null` and nothing checks it. demo.sh/chaos.sh mint one per run and refuse to proceed unless `:4002/status` echoes it back, proving they are driving the ingest they just started and not one stranded by an earlier run | ingest `/status`, demo.sh, chaos.sh |
| `LEDGER_PATH` | no code default — export it (scripts set it for you) | each mock process (its own ledger file) |
| `LEDGER_PATH_HUBCRM` / `_BILLING` / `_SUPPORT` | unset → reconcile FAILS naming the missing var (fail-closed); the literal `skip` opts the source out explicitly. `_HUBCRM` names the F-1c emission-side ledger (every event the store emits, chained — drops included); the 2a billing/support feed ledgers are unchanged | reconcile CLI (per-source ledger lookup) |
| `INGEST_SOURCES` | `billing,support` (F-1c: `crm` left the default — its mock is retired and nothing serves port 4001). `sheets`, `stripefeed`, `hubcrm` and `casebus` are registered but **opt-in**; set them explicitly for anything real — in particular `hubcrm` MUST be enabled on the service that should run its hydration pump, or webhooks land with no snapshots and the warehouse CRM arm stays empty. Every script pins this variable explicitly | which sources ingest polls/reconciles (scripts pin it explicitly) |
| `CRM_BASE_URL` / `BILLING_BASE_URL` / `SUPPORT_BASE_URL` / `SHEETS_BASE_URL` / `STRIPEFEED_BASE_URL` / `HUBCRM_BASE_URL` / `CASEBUS_BASE_URL` | `http://localhost:4001` / `4003` / `4004` / `4005` / `4006` / `4007` / `4008` (`crm` is the retired mock's legacy lane — nothing serves 4001; see KNOWN-ISSUES' end-state note) | backfill CLI (sheets: the snapshot API; stripefeed: the `/v1/events` cursor feed; hubcrm: the object store; casebus: the `/subscribe` event stream) |
| `SWITCHBOARD_TENANT_ID` | unset → the default tenant `00000000-…-0000`. The ONE tenant this deployment's webhook doors, queue envelope and worker write under, resolved once at boot; a non-uuid refuses boot naming the variable. One deployment serves one configured tenant — this is not a tenant selector and nothing routes on it | ingest doors, queue envelope, worker, DLQ replay |
| `INGEST_ROLE` | `all` (`receiver` \| `worker` \| `all`; anything else refuses boot naming the variable — same for a non-integer `PORT`/`BACKFILL_INTERVAL_MS`) | ingest main |
| `CHAOS_SEED` | `7` | chaos.sh fault-plan seed (CI feeds it as a workflow input; reproduce a red run by re-entering its seed) |
| `ANTHROPIC_API_KEY` | unset → deterministic report (risk table + watch list; a one-line notice replaces the AI narrative) | agent report |
| `DBT_SCHEMA` | `public_analytics` | agent, report worker |
| `DBT_ROLE` | unset → migrate keeps the unscoped default-privilege grant (bound to the migrator's own role) and logs the limitation. Set it to the role dbt connects as and migrate scopes the agent grant `FOR ROLE` — required whenever dbt and the migrator use different roles, or dbt's rebuilt tables silently lose the agent's SELECT. The migrator must be a member of the role (checked, clear error otherwise) | ingest migrate (`grantAgentReadOnly`) |
| `DBT_PORT` | `5432` (CI sets `5433`) | dbt profile (host port of Postgres) |
| `DBT_HOST` / `DBT_USER` / `DBT_PASSWORD` / `DBT_DBNAME` | `localhost` / `switchboard` / `switchboard` / `switchboard` (`warehouse/profiles.yml`) — the dev defaults are the compose container's; set them for anything real | dbt profile |
| `BACKFILL_INTERVAL_MS` | `60000`. Range-checked 1–2147483647 (`setInterval`'s documented clamp boundary); a non-integer or out-of-range value refuses boot naming the variable | ingest scheduled backfill/hydration-pump loop |

## Start / stop

```bash
export DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard
# LOCAL DEMO ONLY. Secrets fail closed, so without either this or a real
# WEBHOOK_SECRET_HUBCRM/_STRIPEFEED/_CASEBUS/_SUPPORT the next command's service
# refuses to boot naming every missing one. Exported here, deliberately and visibly,
# rather than shipped pre-set in .env.example — that is what keeps README's
# "a production deploy that forgets to set them refuses to start" true.
export ALLOW_DEV_SECRETS=1
docker compose up -d postgres            # DB (host port 5433)
npm run migrate -w ingest                # idempotent
# INGEST_SOURCES pinned explicitly: the code default is billing,support only (F-1c),
# which would leave stripefeed/casebus never polled and hubcrm webhooks never hydrated.
INGEST_SOURCES=hubcrm,stripefeed,casebus,support PORT=4002 npm run start -w ingest   # receiver+worker+scheduled backfill/pump
PORT=4007 WEBHOOK_URL=http://localhost:4002/webhooks/hubcrm  LEDGER_PATH=./out/ledger-hubcrm.jsonl  npm run start -w mocks/hubcrm
PORT=4006 npm run start -w mocks/stripefeed   # pull-only: the /v1/events feed is the interface
PORT=4008 npm run start -w mocks/casebus      # pull-only: the /subscribe stream is the interface
PORT=4003 WEBHOOK_URL=http://localhost:4002/webhooks/billing LEDGER_PATH=./out/ledger-billing.jsonl npm run start -w mocks/billing
PORT=4004 WEBHOOK_URL=http://localhost:4002/webhooks/support LEDGER_PATH=./out/ledger-support.jsonl npm run start -w mocks/support
```
All mocks must share the same manifest seed (default 42) — divergent seeds break
cross-system identity correlation. Stop with SIGTERM — ingest drains gracefully
(HTTP closed, queues stopped, backfill interval cleared). `npm` may print a
cosmetic `npm error 143` on SIGTERM; harmless.

**Migration ordering note (viewless deploy window):** migration `003` CASCADE-drops
the legacy `raw.raw_crm_events` table *and* any dbt view still reading it. Between
`npm run migrate -w ingest` and the next `dbt build` those staging views don't
exist — always run migrate first, then build (the scripts already do). The views
are derived artifacts; the build recreates them.

## Proofs (run these before trusting anything)

```bash
./scripts/demo.sh    # end-to-end on the faithful stack: hubcrm 300 ops + stripefeed 100 + casebus 80 + support 80 → four-paradigm reconcile → identity oracle → report
./scripts/chaos.sh   # hubcrm 240 ops + billing/support 200 events under seeded faults → per-paradigm reconciliation
```
Both are self-cleaning at start and fail loudly with counts on any mismatch.
`demo.sh` also runs `scripts/verify-identity.ts`, which set-compares the dbt
identity layer and `customer_360` against the seed manifest's planned match matrix.

**A green `dbt build` here is `ERROR=0, WARN=1` — not "no warnings".** The fixture
universe permanently trips one warn-severity test on purpose (`assert_amounts_plausible`,
row `DEMO-CH-0001`) so that surface is proven to fire instead of passing vacuously; the
expected total is `PASS=97 WARN=1 ERROR=0 TOTAL=98`. Because dbt exits 0 on warnings, do
NOT read the step's green tick as "clean" — CI runs `scripts/verify-dbt-warns.ts` right
after `dbt build`, which fails if the warn set is anything other than exactly that test
and exactly that row (extra warn, missing warn, or different row). If you see a second
warning locally, that is a real signal; the gate will red on it in CI.

Contributors: any change to a connector, CLI, or the service log is bound by the
seven-line standing checklist in
[docs/operator-surface-checklist.md](docs/operator-surface-checklist.md).

## Recovery procedures

- **Webhook outage / dropped events:** nothing to do — the scheduled backfill
  poller recovers via per-source cursors. Manual catch-up:
  `npm run backfill -w ingest` — iterates every source in `INGEST_SOURCES`,
  printing `backfill[<source>]: ingested N event(s)` per source (exit 1 = one or
  more sources aborted after repeated upstream errors; state is consistent, the
  output names the resumable cursor; re-run to resume).
- **Poisoned/failed jobs:** each source has its own DLQ (`ingest-<source>-dlq`).
  `npm run replay -w ingest -- --list` prints total depth and, per job,
  `source=... event_id=... age=... retries=... — DLQ reason: <reason>` across all
  source DLQs. The reason is the failure message the worker recorded on the job
  itself, and the age is the ORIGINAL job's age (pg-boss preserves it across the
  move to the DLQ), so a dead letter now answers "why" and "since when" without
  reading `pgboss.job` by hand — at parity with `hydrate-rearm --list`, which has
  printed its reason all along. `npm run replay -w ingest` re-ingests
  (idempotent) and consumes; **replay can fail**, and each failure prints
  `id=... source=... event_id=... replay failed: <message>` rather than being
  swallowed into the `failed:` count. Both drain
  the FULL queue in one invocation (aggregated across all source DLQs) — the
  depth printed is the whole queue, never a capped page.
- **Malformed payloads:** rows sit in `ingest.quarantine` with reasons and their
  `source`. Operator CLI (2a.3): `npm run quarantine -w ingest -- --list` shows
  pending rows; `npm run quarantine -w ingest -- --replay <id>` replays one;
  `npm run quarantine -w ingest` sweeps everything pending (each row re-validates
  through the same ingest gate — unfixable rows stay put and are counted).
  **Tenant scoping (CLOSE-3):** `--list` and the sweep take an optional
  `[--tenant <uuid>]` and default to the default tenant, exactly like `gap-ack`,
  `hydrate-rearm` and `reconcile` — a bare `--tenant` refuses, and a named tenant
  with no recorded state anywhere refuses rather than reporting a clean zero. The
  depth line names the tenant it counted. `--replay <id>` takes no `--tenant`:
  the row carries its own `tenant_id` and replay re-ingests under it, so neither
  the sweep nor a single replay can relocate a payload into another tenant's lane
  (they both could before). Note:
  *unsigned* requests are rejected 401, never quarantined. Since the
  numeric-integrity wave, schema-failure reasons name the offending field (e.g.
  `schema validation failed: data.amount_cents — amount_cents must be a storable
  integer, got "abc"`); numeric rules per event type live in
  `ingest/src/numeric-contract.ts` — a source legitimately changing shape means
  updating that table, not relaxing the gate.
- **jsonb-unstorable payloads** (NUL escapes, lone UTF-16 surrogates, nesting
  depth > 1000): quarantined with `payload` null and the byte-exact wire text in
  `raw_body`. These are preserved-for-inspection — `replayQuarantined` reports
  them `still-invalid` by design (the event store is jsonb too). Check depth
  periodically: `select reason, count(*) from ingest.quarantine group by 1;` —
  nothing alerts on this table yet (tracked debt), so a growing count is only
  visible if someone looks.
- **Integrity doubt:** `npm run reconcile -w ingest` — routes **every** source in
  `INGEST_SOURCES` through its own paradigm's connector, so what it verifies
  differs per source and each report says which:
  - *ledger-feed* (`billing`, `support`, and the F-1c hubcrm emission ledger):
    verifies that ledger's hash chain, then set-compares ledger vs
    `raw.raw_events where source = ...` and reports missing/extra/duplicates. An
    enabled ledger-feed source with no `LEDGER_PATH_<SOURCE>` **FAILS** naming
    the missing variable; the literal `skip` is the explicit opt-out.
  - *the four faithful paradigms*: no ledger file and no hash chain — the
    source's own current truth (sheet rows, retained feed window, object store,
    retained bus window) is compared against raw. See each source's section
    below for how to read its report.

  Exit is nonzero if **any** reconciled source has discrepancies. A throw from
  one source is contained to that source: it prints a named FAIL and its standing
  gap disclosures, and every later source still reports (close F13). Note that
  reconcile **writes** for the two loss-bearing sources — see *Admitted permanent
  losses* below.
- **`manual_review` triage** (identity layer): rows in
  `public_analytics.manual_review` are external entities (billing customers,
  support requesters) that matched no CRM company — each row carries its
  `source`, `source_entity_id`, evidence, and `first_seen_at`. Flow: inspect the
  row and the source record → either fix the underlying data/mapping (e.g.
  correct a domain in the source system; the next dbt build re-resolves it and it
  stops being re-inserted) → or accept it as genuinely CRM-absent (it stays, and
  `customer_360` carries it flagged `is_complete = false`, never hidden).
  Disposition workflow (assign/resolve/dismiss) is a future-phase feature; the
  table is Switchboard operational state, not a system of record.

## Sheets source operations (snapshot paradigm, A5)

The sheets source has no event feed and no ledger file: the connector reads the
whole grid per cycle in one combined `GET /snapshot` (values + row metadata from
a single consistent grid state — atomic, so a mid-read edit can never pair a
row key with another row's content), diffs it against raw-derived state, and
the sheet's own current rows are the reconciliation truth.

```bash
PORT=4005 npm run start -w mocks/sheets    # snapshot API (WEBHOOK_URL optional — see the nudge-door note below)
INGEST_SOURCES=sheets npm run backfill  -w ingest   # catchUp: full-grid diff → delta through the standard door
INGEST_SOURCES=sheets npm run reconcile -w ingest   # compare the sheet's rows against raw (read-only)
```

The CLIs and the long-running service both route every enabled source through
the connector seam (A7): adding `sheets` to the service's `INGEST_SOURCES`
gives it interval snapshot catchUp cycles — the same full-grid diff the
backfill CLI runs — not the `/events` 404 noise the pre-A7 feed-shaped loop
produced. Enabling sheets on the service also makes `WEBHOOK_SECRET_SHEETS` a
boot requirement (one aggregated error names anything missing).

**Reading a sheets reconcile report.** Field semantics differ from the ledger
sources: `ledger` = rows in the sheet *right now* (the sheet is its own ledger),
`raw` = live rows the pipeline believes exist, `stale` = present on both sides
but content differs, `missing` = in the sheet but never landed, `extra` = gone
from the sheet but no tombstone yet. All four buckets gate the exit code — a
non-empty `stale` is a FAIL naming the drifted row_keys (listing capped at 20),
exactly like `missing`/`extra`. **Check quarantine before suspecting
loss:** a row whose current cells fail the numeric contract (garbage currency,
unparseable amount) is *supposed* to appear under `stale`/`missing` — its
accounting home is `ingest.quarantine`, where the entry's reason names the
failing field. The oracle's invariant: sheet rows = converged raw rows +
quarantined-current rows, and `extra` empties on the next catchUp.

**The nudge door** (`POST /connectors/sheets/nudge`) is the sheets paradigm's
only push surface: a thin, HMAC-signed "read the sheet soon" hint
(`WEBHOOK_SECRET_SHEETS`, same timestamped scheme as the event doors). 404 =
this deployment never configured sheets (no secret resolvable — the route is
effectively absent, and an anonymous probe can never mint a 500 here); 401 =
signature invalid (rejected outright — nudges carry no data worth quarantining);
503 = this process hosts no sheets connector (the hint could have no effect);
202 = accepted and an early catchUp was attempted (a failed attempt still answers 202 —
the periodic reconcile is the guarantee, the nudge is only latency). Losing nudges costs latency, never
correctness — periodic reconcile-first cycles are the guarantee, and
`/webhooks/sheets` deliberately answers 404 (a sheet has no event push).

**Hosting truth (A7):** the service hosts the door. When `sheets` is in the
service's `INGEST_SOURCES` (worker or all role), `main.ts` wires the sheets
interval runner into `createIngestApp` as the nudge hook, so a signed nudge
runs an early catchUp through the **same overlap guard as the interval loop**:
a nudge that arrives while a cycle is running is coalesced — skipped, never
queued — because the stateless connector's next cycle reads a fresh snapshot
and re-diffs from scratch anyway. The trigger channel may now point at the
live service; its target is the nudge route itself:

```bash
INGEST_SOURCES=hubcrm,stripefeed,casebus,support,sheets PORT=4002 npm run start -w ingest
PORT=4005 WEBHOOK_URL=http://localhost:4002/connectors/sheets/nudge npm run start -w mocks/sheets
```

A receiver-only process (`INGEST_ROLE=receiver`) still hosts no runner —
backfill belongs with the roles that own event ingestion — so its door keeps
answering the honest 503. Latency is all a nudge ever buys: reconcile-first
cycles (the service interval, or the CLIs above) remain the correctness
guarantee.

**Quarantine-and-fix-the-cell (the everyday flow).** When reconcile names a row
and `npm run quarantine -w ingest -- --list` shows e.g. `data.currency` for it:
**fix the cell in the sheet**, don't replay. The quarantined event is a snapshot
of the garbage — replaying it re-fails by design. Once the cell is corrected,
the next catchUp ingests the fixed row automatically and reconcile goes clean;
the old quarantine entries remain as history (a row can be clean *now* without
its past being scrubbed). Expect one quarantine entry per cycle per still-broken
row until someone fixes the cell — depth on this lane measures patience, not
distinct rows.

## Stripefeed source operations (opaque-cursor feed paradigm, Task B)

The stripefeed source is the Stripe-STYLE envelope feed: **pull-only** (no
webhook push, no ledger file — `GET /v1/events` *is* the interface, and the
feed's currently retained event set is the reconciliation truth). It lands
*alongside* the 2a billing mock; nothing consumes it in the warehouse until
Task F flips the switch.

```bash
PORT=4006 npm run start -w mocks/stripefeed          # the feed (shuffle ON: ordering is undocumented)
INGEST_SOURCES=stripefeed npm run backfill  -w ingest  # drain via starting_after + has_more
INGEST_SOURCES=stripefeed npm run reconcile -w ingest  # full retained-window drain vs raw (WRITES: records newly-observed gaps)
```

Operational notes:

- **The cursor is ours, not the feed's**: `ingest.cursors.last_event_id` holds
  the id of the last event the connector *processed* (quarantined events
  included — they are preserved and replayable, so advancing past them is not a
  drop). Never hand-edit it to "skip ahead"; events between the cursor and the
  feed's head would be silently unreachable until they age out.
- **Re-served pages are normal.** Ids are opaque and response ordering is
  undocumented, so the connector's order-blind cursor can sit mid-window;
  duplicate deliveries are absorbed by `(tenant, source, event_id)` idempotency.
  `duplicates` in a catch-up report measures this, not a fault.
- **A 30-day-stale cursor is a data-loss event, and it is REPORTED on every
  shipped surface** (verified by CLI-path tests that run the real entrypoints):
  the backfill CLI and the service log print `PERMANENT DATA LOSS — unclosable
  gap (retention): …` with bounds (one shared phrasing — grep/alert on
  `PERMANENT DATA LOSS`); the reconcile CLI prints the same line **and exits
  nonzero** — a gap is never a PASS-silently condition. Backfill itself still
  exits 0 on a fallback run (the drain succeeded; a nonzero would teach cron to
  retry a loss no retry can close) — reconcile is the gate. An
  gap is recorded in the **durable gap ledger** (`ingest.gap_ledger`, Task D),
  so it survives the process that found it, and reconcile fails until an
  operator acknowledges it — see *Admitted permanent losses* below.
- **Reading a stripefeed reconcile report**: `retained window` = events the
  feed retains *right now* (its 30-day ledger-equivalent), `raw` = everything
  ever ingested, `aged out of window` = raw rows older than the retained
  window (expected metabolism, not flagged), `extra` = raw rows *inside* the
  window the feed no longer serves (a real anomaly), `missing` = retained but
  never ingested AND not quarantined (real failures), `quarantined` = retained
  events deliberately diverted to `ingest.quarantine` (named with row counts;
  fix upstream or replay — **not** counted as missing and not a FAIL by
  itself). The integrity line reads `feed window integrity: ok …` — this
  paradigm has no ledger file and no hash chain, and the CLI says what it
  actually verified.
- Enabling stripefeed on the long-running service makes
  `WEBHOOK_SECRET_STRIPEFEED` a boot requirement like every registered source,
  even though the paradigm never uses its generic webhook door — an armed door
  with a real secret, not a silent hole. The pull path itself needs no secret.

## Hubcrm source operations (thin-webhook + hydration paradigm, Task C)

The hubcrm source is the HubSpot-STYLE CRM: **push-first** — the vendor POSTs
signed batches of up to 100 *metadata-only* events to
`POST /webhooks/hubcrm` (the request body is a JSON array; a single object is
a 400), and the full record is fetched afterwards through the hydration API.
Since F-1c it IS the warehouse's CRM: the 2a crm mock is retired, and the
staging layer builds companies/contacts/deals from this source's hydrated
snapshots and merge lineage from its `company.merge` events — so the hydration
pump is load-bearing, not optional (an unpumped deployment builds an empty CRM
arm, and a merge whose survivor snapshot is missing reds the dbt build by name:
`assert_merge_survivors_translate`).

```bash
PORT=4007 npm run start -w mocks/hubcrm                # the object store + webhook batches
INGEST_SOURCES=hubcrm npm run backfill  -w ingest      # the HYDRATION PUMP (see below)
INGEST_SOURCES=hubcrm npm run reconcile -w ingest      # object-store truth vs raw + snapshots
```

Operational notes:

- **`backfill` here is a hydration pump, not an ingester.** Thin events only
  arrive by webhook push; the pump scans raw for events without a terminal
  hydration state and fetches each one's object. Its log line says exactly
  that (`hydrated N snapshot(s), M tombstone(s) …`) — an `ingested 0` reading
  would be answering the wrong question. Fetches are rate-budgeted (default
  500/run); spillover prints as `pending hydration` and continues next run.
- **Every thin event ends in exactly one of three states** (the trichotomy,
  test-pinned): a snapshot row in `ingest.hydrated_snapshots`, a tombstone row
  (the object answered 404 — deleted before we fetched), or the hydration DLQ
  (`hydrate-hubcrm-dlq`: fetch retries exhausted, or the snapshot failed the
  field contract — in which case the garbage record is also preserved in
  `ingest.quarantine` with a reason naming the field). Nothing sits in limbo.
- **A DLQ'd hydration is terminal and LOUD but does not red reconcile by
  itself** — one permanently-broken vendor object must not fail every
  reconcile forever (the stripefeed quarantine precedent). It is printed by
  the backfill CLI and service log (`HYDRATION DLQ: …` on stderr) and listed
  with reasons by reconcile. Recovery (phase-2b close): fix the object
  vendor-side, then re-arm the dead letter with the first-class command —
  `npm run hydrate-rearm -w ingest -- --list [--tenant <uuid>]` to see a
  tenant's dead letters, `-- --id <event_id> [--tenant <uuid>]` to re-arm
  exactly one. Re-arming consumes the DLQ row (that is what un-skips the
  event) and the pump re-fetches on its next cycle; the CLI prints the full
  consumed entry (event, object, recorded failure reason) and counts — that
  printed trace is the audit record, since the row itself is destroyed. A
  bogus id or another tenant's id refuses loudly; nothing is ever re-armed
  silently. (Deleting the pg-boss job by hand still works but leaves no
  trace; prefer the command.) The queue's retention is set explicitly
  (~68 years) rather than taking pg-boss's 14-day default, so a dead letter
  never expires out from under you — which also means **the DLQ only shrinks
  when an operator clears it**. Watch its depth
  (`select count(*) from pgboss.job where name = 'hydrate-hubcrm-dlq'`);
  a growing count is a vendor object nobody has fixed yet, not queue lag.
- **Reading a hubcrm reconcile report**: `object store` = live objects right
  now (the paradigm's ledger-equivalent), `raw` = thin events ever ingested,
  `missing` = store objects raw never heard of (lost webhooks — FAILS),
  `drifted` = store moved and no webhook told us (FAILS), `extra` = raw-known
  objects the store lacks with no deletion event (FAILS), `tombstoned` =
  deleted with a deletion event in raw (expected metabolism), `hydration
  pending` = not yet terminal (FAILS if nonzero at reconcile time — run the
  pump). The integrity line reads `object-store integrity: ok …` — this
  paradigm has no ledger file and no hash chain, and the CLI says what it
  actually verified: all three object listings read and compared.
- Enabling hubcrm makes `WEBHOOK_SECRET_HUBCRM` a boot requirement; the mock
  signs its batches with the same house per-source HMAC scheme (signature over
  the whole request body — the batch is the wire unit).

## Support event-bus source (casebus) — subscribe/replay

The casebus source is the event-bus SUBSCRIBE/REPLAY paradigm: **pull-only**
(a subscriber, not a receiver), registered but **opt-in**. It lands alongside
the 2a `support` mock; nothing in that mock changed.

```bash
PORT=4008 npm run start -w mocks/casebus              # the bus (72h window, seeded clock)
INGEST_SOURCES=casebus npm run backfill  -w ingest    # subscribe from the stored replay id
INGEST_SOURCES=casebus npm run reconcile -w ingest    # full retained-window drain vs raw (WRITES: records newly-observed gaps)
```

- **The cursor is a replay id, not a number.** It lives in
  `ingest.cursors.last_event_id` (the opaque-cursor column migration 008 added
  for stripefeed); `last_seq` stays 0 and means nothing here. Replay ids are
  opaque and deliberately non-contiguous — never do arithmetic on one, and do
  not expect them to be comparable across a reset.
- **`stream_id` on the cursor row is the reset detector.** The bus answers the
  same error code whether a replay id aged out or was reset away, so the
  connector compares the stream identity it stored against the one the recovery
  subscription reports. If you are debugging a gap's cause, `GET /status` on the
  mock and `select stream_id from ingest.cursors where source = 'casebus'` are
  the two values that decide it. A NULL `stream_id` means the identity was never
  OBSERVED for that cursor (status frames may omit it) — the connector then
  claims the conservative `retention`, and it never back-fills the column from
  an older run's memory (Task F: remembered identity is not evidence).
- **Duplicates on the backfill log are normal.** At-least-once delivery means
  `N duplicate(s) absorbed by idempotent ingest` is the healthy steady state,
  not an incident. That clause is emitted by the backfill CLI for **any**
  report-bearing connector whose run absorbed duplicates (so a sheets or
  stripefeed line can now carry it too — it is suppressed at zero, so a line
  that never had duplicates is unchanged). It counts idempotent re-ingests, not
  errors.
- **Reading a casebus reconcile report**: `retained window` = events the bus
  retains *right now* (its 72h ledger-equivalent), `raw` = everything ever
  ingested, `aged out of window` = raw rows older than the retained window
  (expected metabolism), `extra` = raw rows *inside* the window the bus no
  longer serves (a real anomaly), `missing` = retained but never ingested AND
  not quarantined, `quarantined` = retained events deliberately diverted (named
  with counts; not counted as missing, not a FAIL by itself). The integrity line
  reads `event stream integrity: ok …` — there is no ledger file and no hash
  chain here, and the CLI says what it actually verified.
- Enabling casebus makes `WEBHOOK_SECRET_CASEBUS` a boot requirement like every
  registered source, even though the paradigm never uses its generic webhook
  door — an armed door with a real secret, not a silent hole.

## Admitted permanent losses — the gap ledger and how to answer one

> **`reconcile` is no longer read-only for the two loss-bearing sources.** Since the
> durable gap ledger landed, `stripefeed` and `casebus` reconcile runs **INSERT** into
> `ingest.gap_ledger` when they observe a gap the ledger does not already hold (that is
> how a loss detected by a process that has since exited still reds the run). Consequence
> for deployment: reconcile for those sources needs a role with `insert` on
> `ingest.gap_ledger` — `switchboard_app` has it — and **cannot** be run against a
> read-only role or a read replica. Every other source's reconcile remains read-only.
> `gap-ack` writes by definition (it `update`s the acknowledgement columns).

Two sources can lose data permanently by the design of the vendor paradigm they
model: stripefeed (30-day feed retention) and casebus (72h bus window, plus
stream resets). Both record every loss in `ingest.gap_ledger` with cause,
bounds, and detection time.

**Symptom:** reconcile exits nonzero and prints, on stderr,

```
[casebus] PERMANENT DATA LOSS — unclosable gap (retention): events after … [gap #3, detected …, UNACKNOWLEDGED]
[casebus] 1 UNACKNOWLEDGED gap(s). No retry can close a gap — once you have accepted the loss, record it:
  node --import tsx src/cli/gap-ack.ts --source casebus --id <n> --by <operator> --note "why"
```

**What it means:** events existed at the source, were never ingested, and the
source no longer serves them. **No retry closes this.** Re-running backfill will
not recover them; it will only re-detect the same gap (which is idempotent — one
loss stays one row).

**What to do:**

1. `node --import tsx src/cli/gap-ack.ts --list` — see every recorded gap, its
   id, cause and bounds. The listing covers ALL recorded gap state for the
   tenant — a loss on a source no longer in `INGEST_SOURCES` stays listed,
   flagged as not currently enabled; `--source <s>` narrows. Both this CLI and
   reconcile take `--tenant <uuid>` for non-default tenants (default-tenant
   behavior is unchanged without it).
2. Investigate by cause. `retention` means we fell behind the window: check for
   an ingest outage or a poll interval longer than the window, and widen or fix
   it so it does not recur. `reset` means the source's retained stream was
   replaced (the vendor documents this for an org moved to a new instance):
   confirm with the source owner; nothing on our side caused it.
3. If the lost range matters, recover it from the source's own system of record
   out of band — the bus cannot re-serve it.
4. Record the decision:
   ```bash
   node --import tsx src/cli/gap-ack.ts --source casebus --id 3 \
     --by "your-name" --note "72h window closed during the 2026-07-30 outage; loss accepted"
   ```

After that, reconcile PASSES again and prints the gap on every run as a standing
disclosed condition. **Acknowledging is not fixing.** It records that a named
human saw the loss and accepted it. A *new* gap reds the run again.

`--by` is required: an anonymous acknowledgement of permanent data loss is
refused; `--note` is optional. Both CLIs take `--tenant <uuid>`; without it they
operate on the default tenant, and an explicitly-named tenant with no recorded
state anywhere refuses rather than reporting a clean empty result (close F8).

## Backup and restore

```bash
./scripts/backup.sh                  # → out/backups/switchboard-<utc-stamp>.dump
./scripts/restore.sh [dump]          # defaults to the most recent dump. DESTRUCTIVE.
./scripts/verify-durability.sh       # proves both, end to end. DESTRUCTIVE.
```

`verify-durability.sh` is the reason this section can be trusted: it seeds a known state,
destroys and recreates the container, asserts the data survived, takes a backup, **drops the
schemas outright**, restores, and asserts the row counts match what it started with. Backup
and restore are exercised, not described.

Notes worth knowing before you need them:

- The database lives in a **named Docker volume** (`pgdata`). `docker compose down` no longer
  destroys it; removing it takes an explicit `docker compose down -v`.
- The dump **excludes the `pgboss` schema**. pg-boss partitions by date and a partition's
  primary key is inherited, which `pg_restore --clean` cannot drop — a full-cluster dump will
  not restore at all. Consequence: **dead-lettered jobs are not in the backup.** They are
  recoverable (every delivered event is in the source ledger, so backfill + reconcile rebuild
  what the DLQ held), but DLQ depth itself does not survive a restore.
- Roles are cluster-level and not in a logical dump; `restore.sh` creates
  `switchboard_agent` / `switchboard_app` first so a restore into a fresh cluster works.
- `pg_restore` needs a **seekable** file, so both scripts copy the dump into the container
  rather than piping it. Piping fails with "did not find magic string in file header" even
  when the archive is perfectly valid.
- Backups land in `out/`, which is git-ignored — dumps must never reach this public repo.

Backup = `pg_dump` of the database + copies of the three ledger files. Within
the demo's ledger-as-oracle model, the restore story is stronger than the
backup: because the ledgers (production analog: the source systems) are the
source of truth and ingestion is idempotent, **restore is replay** — an empty
database rebuilt by the backfill poller converges to the same state, which is
exactly what the chaos test demonstrates on every run.

**Production caveat:** that guarantee leans on a mock affordance — a complete,
replayable event history. Real vendors don't retain unbounded history (see
[real-connector delta](docs/real-connector-delta.md)): modified-since endpoints
have lookback limits, and a multi-year backfill must be scheduled within rate
budgets, not replayed in one pass. Production DR is therefore **pg backup as the
primary restore path, plus bounded vendor replay** to close the gap between the
backup timestamp and now — not unbounded ledger replay from empty.

## Common failures

| Symptom | Cause / fix |
|---|---|
| `docker: command not found` / daemon errors | colima not running: `colima start`; compose plugin registered via `~/.docker/config.json` `cliPluginsExtraDirs` |
| Ports 4002–4008 / 5433 busy | `lsof -ti:4002,4003,4004,4005,4006,4007,4008 \| xargs kill`; another Postgres on 5433 → change compose mapping. (4001 is the retired 2a crm mock's port — nothing should be listening there) |
| demo/chaos FAIL with count mismatch | Worker not draining — run `npm run replay -w ingest -- --queues`, which prints per source `ready` (the true backlog: queued minus deferred), `deferred`, `active`, `dlq` and the age of the oldest pending job, counted live rather than from pg-boss's periodically-cached counters. A non-zero `ready` with a rising `oldest_pending` is a stuck worker; a non-zero `dlq` is a poison payload — `--list` then names its reason. The scripts' bounded waits also print both counts on timeout |
| migration checksum drift (`… has CHANGED since it was applied`) | The database and the repository disagree about what schema exists. Surfaced as an uncaught throw with a stack; the message itself names the file, both checksums and the remedy. Do NOT edit the applied migration — add a new one. If the drift is a local scratch database, drop and re-migrate it |
| 401 on every webhook for one source | `WEBHOOK_SECRET_<SOURCE>` mismatch between that mock and ingest environments (each source verifies with its own secret — check the right one) |
| 401s that appear only under load or across machines | Signature replay window (±300s, 2a.3): the timestamp is signed, so sender/receiver clocks more than 5 minutes apart reject valid traffic — check NTP/clock sync |
| Process throws `... is not set — refusing to fall back` at boot | Fail-closed secrets (2a.3): set the named env var, or `ALLOW_DEV_SECRETS=1` for local demo use only |
| Reconcile reports ledger hash chain broken but nothing was tampered with | `LEDGER_HMAC_KEY` mismatch between the mock (writer) and reconcile (verifier) environments — both must use the same key. There is no default: set `LEDGER_HMAC_KEY` in both environments, or `ALLOW_DEV_SECRETS=1` in both to opt into the published demo key |
| Reconcile prints `[<source>] FAIL: LEDGER_PATH_... is not set` | Export `LEDGER_PATH_<SOURCE>` pointing at that mock's ledger file (see demo.sh for the pattern), or set it to the literal `skip` to opt that source out explicitly |
| Identity oracle FAILs after chaos.sh | Expected: marts are frozen tables over live staging views, and chaos truncates raw — re-run `demo.sh` (which rebuilds) before trusting mart state |
| Relation `stg_crm__companies` does not exist right after migrating | The viewless deploy window (see Start/stop) — run `dbt build` |
| Report generates with template banner | `ANTHROPIC_API_KEY` unset or LLM call failed — check the structured `llm` log line (fallback is by design; the report always generates) |
