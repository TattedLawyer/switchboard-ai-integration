# Switchboard Phase 2a — Width Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the Phase 1 single-source reliability spine to N sources (one `raw.raw_events` table, per-source HMAC/queues/cursors/ledgers), add billing + support mock sources fed by one correlated cross-system seed manifest, resolve identities across the three systems with three deterministic tiers + merge handling (auditable provenance, cycle-guarded), ship a `customer_360` mart where billing/support-only entities appear flagged `incomplete`, and make it all visible on GitHub via per-push CI + nightly chaos/demo workflows.

**Architecture:** The spine generalization comes FIRST (amendment §8 D1): migration 003 collapses `raw.raw_crm_events` into a single `raw.raw_events(source, event_id, …)` table with a `(source, event_id)` unique index (D2), and ingest/reconcile/queues/backfill/HMAC are parametrized by `source` — with the Phase 1 chaos reconciliation test kept green at every task boundary as the regression guard. Only then are the new mocks wired: a shared `mocks/core` package (ledger/faults/HMAC/generic source app) plus one master seed manifest (D4) that plants the identity-resolution test matrix (overlap, ~8% dupes, near-misses, unmatchables, merge pairs). Identity resolution and merge collapse are computed at dbt build time only — raw stays append-only; `merge_edges` is derived from `company.merged` events and resolution follows edges to terminal with a cycle guard (D5). `customer_360` keys on the resolved entity (D6). CI runs the deterministic suite per push and chaos/demo nightly/manual (D11).

**Tech Stack additions:** none at runtime. New dev-infra only: GitHub Actions (`ubuntu-latest`, Postgres 16 service container, `dbt-postgres==1.11.0` — same pin as `warehouse/Dockerfile`). New workspaces: `mocks/core`, `mocks/billing`, `mocks/support` (Express 5 + zod 3, same majors as `mocks/crm`).

## Global Constraints

- **TDD mandatory** for production code; config/migrations/workflow YAML are TDD-exempt but their *behavior* is asserted by integration tests or a scripted RED/GREEN run.
- **Fixture hygiene (hard rule):** synthetic data only — `@example.com` emails only, `DEMO-`/`DEMO ` prefixed ids/names, no SSN/phone-shaped strings. The hygiene test extends to the new manifest and must stay green.
- **Test isolation:** every DB-touching ingest test uses `freshTestDb()` from `ingest/test/helpers/testdb.ts`, which returns `{ pool, cleanup }` for a fresh ephemeral database (unique name, migrations applied, dropped in `cleanup`). Never the dev `switchboard` DB, never `truncate` on shared tables. Agent tests keep their dedicated-schema pattern.
- **The ledger is never faulted.** `appendToLedger` before any delivery attempt stays inviolate in every mock (it is the oracle). Fault injection applies to delivery and API responses only.
- **Determinism:** all randomness (seed data, fault decisions) comes from the exported `mulberry32` `prng(seed)`. Same seed → same data, same faults. No `Math.random()`, no wall-clock-dependent fixtures (event `occurred_at` keeps Phase 1's `new Date().toISOString()` behavior; manifest-embedded timestamps are fixed ISO literals).
- **`./scripts/chaos.sh` and `./scripts/demo.sh` are standing regression guards.** Per D1 the chaos reconciliation test guards the spine-generalization work in 2a (not just 2b). Every task below ends with the full suite + typecheck green, and any task touching ingest/mocks/scripts/warehouse ends with demo and chaos green too.
- Postgres on host port 5433; `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard`. Docker via colima available in implementer sandboxes. dbt runs via `docker compose run --rm dbt build` (schema `public_analytics`; agent reads it via `DBT_SCHEMA ?? "public_analytics"`).
- Express 5, vitest 4, zod 3, pg-boss 12 — match existing workspace majors. No new runtime dependencies.
- Commit after every green cycle, only the files each task lists; nothing under `.superpowers/`; no secrets (per-source webhook secrets are documented demo-only defaults, same posture as Phase 1's `demo-secret`).
- **No scope creep (2b/later):** no vendor-faithful API shapes, no hydration, no event-bus/Service Cloud source, no vertical-profile *content* (only the `profile` parameter seam, stubbed), no OAuth, no observability stack.

## File Structure

```
ingest/migrations/003_multi_source.sql   ← raw.raw_events(source,…), data copy, outbox/quarantine source col (Task 1)
ingest/src/ingest-event.ts               ← MODIFY: ingestEvent(pool, source, event) (Task 1)
ingest/src/reconcile.ts                  ← MODIFY: reconcile(pool, source, ledgerPath) (Task 1)
ingest/src/sources.ts                    ← source registry: SOURCES, baseUrlFor, enabledSources, ledgerPathFor (Task 2)
ingest/src/hmac.ts                       ← MODIFY: secretForSource(source) (Task 2)
ingest/src/server.ts                     ← MODIFY: /webhooks/:source, SourceEvent, per-source HMAC (Task 2)
ingest/src/queue.ts                      ← MODIFY: per-source queues + DLQs (Task 3)
ingest/src/backfill.ts                   ← MODIFY: pollOnce/catchUp per source (Task 1/3)
ingest/src/cli/{backfill,reconcile,replay}.ts ← MODIFY: iterate enabled sources (Task 3)
ingest/src/main.ts                       ← MODIFY: per-source enqueue + backfill loops (Task 2/3)
mocks/core/                              ← NEW workspace @switchboard/mock-core: prng, ledger, faults, hmac,
                                           createSourceApp, manifest (Tasks 4–5)
mocks/crm/src/*                          ← MODIFY: thin wrapper over mock-core (Task 4), manifest-driven script (Task 5)
mocks/billing/                           ← NEW workspace @switchboard/mock-billing (Task 6)
mocks/support/                           ← NEW workspace @switchboard/mock-support (Task 7)
scripts/{demo.sh,chaos.sh,check-demo.sh} ← MODIFY: raw_events, per-source ledgers/env, 3-source chaos (Tasks 1,3,7)
warehouse/models/staging/*.sql           ← stg_crm__contacts, stg_crm__deals, stg_billing__*, stg_support__* (Task 8)
warehouse/models/identity/*.sql          ← merge_edges, int_crm__canonical_companies, identity_resolution,
                                           manual_review (Task 9)
warehouse/models/marts/customer_360.sql  ← the unified mart (Task 10)
warehouse/tests/*.sql                    ← no-cycle / termination / incomplete-flag singular tests (Tasks 9–10)
scripts/verify-identity.ts               ← manifest-expectations oracle, run after dbt in demo + CI (Task 10)
scripts/ci-fixture.ts                    ← faultless in-process pipeline seed for per-push dbt CI (Task 11)
.github/workflows/{ci.yml,chaos.yml}     ← per-push suite + nightly/manual chaos (Task 11)
docs/adr/identity-resolution.md, docs/log/phase2a.md, README.md, RUNBOOK.md (Task 12)
```

**Decision-to-task map:** D1 → Tasks 1–3 (+7 chaos extension) · D2 → Task 1 · D3 → Task 2 · D4 → Task 5 · D5 → Task 9 · D6 → Task 10 · D11 → Task 11 · D13 → Task 12. (D7–D10, D12 are Phase 2b — out of scope here.)

---

### Task 1: Single raw table `raw.raw_events` + `source`-parametrized ingest core (D1, D2) — **RISKIEST TASK #1**

This touches the hardened Phase 1 write path. The strategy: one migration + one signature change (`ingestEvent` gains `source`), then a *mechanical, grep-verified* sweep of every call site and every test, with behavior pinned single-source (`"crm"` literal at the edges). The task is only done when the **unchanged** chaos run passes against the new table.

**Why the chaos proof stays valid across the migration:** `scripts/chaos.sh` truncates all raw/ingest state and the ledger at its clean-state step and re-seeds via `/simulate`, so the proof never depends on pre-migration rows — re-running chaos after this task re-establishes the zero-loss result end-to-end against `raw.raw_events`. Independently, migration 003 still **copies every existing `raw.raw_crm_events` row into `raw.raw_events` (source='crm') before dropping the old table** — a migration must never discard raw data (append-only ethos), and the standing dev DB keeps its history. Both halves are tested below: a data-preservation test proves the copy; the chaos re-run proves the live path.

**Files:**
- Create: `ingest/migrations/003_multi_source.sql`, `ingest/test/migration-003.test.ts`
- Modify: `ingest/src/ingest-event.ts`, `ingest/src/server.ts`, `ingest/src/quarantine.ts`, `ingest/src/queue.ts`, `ingest/src/backfill.ts`, `ingest/src/reconcile.ts`, `ingest/src/cli/backfill.ts`, `ingest/src/cli/reconcile.ts`, `warehouse/models/staging/stg_crm__companies.sql`, `scripts/chaos.sh`, `scripts/demo.sh`, `scripts/check-demo.sh`
- Modify (tests, mechanical): `ingest/test/ingest-event.test.ts`, `ingest/test/quarantine.test.ts`, `ingest/test/queue.test.ts`, `ingest/test/backfill.test.ts`, `ingest/test/reconcile.test.ts`, `ingest/test/replay.test.ts`, `ingest/test/ordering.test.ts`, `ingest/test/ingest.integration.test.ts`

**Interfaces:**
- Migration 003 (idempotent; note `runMigrations` re-runs ALL files every time with no tracking table, so after 003 drops the old table, a re-run of 001 recreates it empty and 003 re-copies 0 rows and re-drops — harmless by construction):
```sql
create table if not exists raw.raw_events (
  id bigserial primary key,
  source text not null,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create unique index if not exists uq_raw_events_source_event_id
  on raw.raw_events (source, event_id);
-- Preserve Phase 1 history: copy-then-drop. Order by id keeps relative arrival order in the
-- new bigserial. Guarded so the script stays idempotent even if 001 ever stops recreating
-- the legacy table.
do $$
begin
  if to_regclass('raw.raw_crm_events') is not null then
    insert into raw.raw_events (source, event_id, event_type, payload, received_at)
      select 'crm', event_id, event_type, payload, received_at
      from raw.raw_crm_events
      order by id
      on conflict (source, event_id) do nothing;
    drop table raw.raw_crm_events;
  end if;
end $$;
alter table ingest.outbox add column if not exists source text not null default 'crm';
alter table ingest.quarantine add column if not exists source text not null default 'crm';
```
- `ingestEvent(pool: pg.Pool, source: string, event: SourceEvent): Promise<"inserted" | "duplicate">` — same single transaction (raw insert `on conflict (source, event_id) do nothing`; iff inserted, outbox row now `(source, event_id)`).
- The event type is **renamed** `CrmEvent` → `SourceEvent` in `ingest/src/server.ts` (zod schema unchanged) and at every ingest-workspace usage — the payload shape is source-agnostic by design (`{event_id, event_type, occurred_at, data}`). Do the rename in this task; `tsc` finds every site.
- `quarantineEvent(pool, source: string, payload, reason)` and `replayQuarantined(pool, id, ingest)` where `ingest: (pool, source, event) => Promise<…>` — replay reads the stored row's `source` column and passes it through.
- `reconcile(pool: pg.Pool, source: string, ledgerPath: string): Promise<ReconcileReport>` — raw query becomes `select event_id from raw.raw_events where source = $1`.
- `pollOnce(pool, source: string, baseUrl, opts?)` / `catchUp(pool, source: string, baseUrl, opts?)` — `source` feeds both the cursor row key and `ingestEvent`. `CRM_SOURCE = "crm"` stays exported from `backfill.ts` for now (Task 3 replaces it with the registry).
- `queue.ts` in this task: worker handler calls `ingestEvent(pool, "crm", job.data as SourceEvent)`; `replayDlq` likewise. Queue names unchanged (Task 3 parametrizes them).
- `server.ts` in this task: route stays `/webhooks/crm`; handler calls `quarantineEvent(pool, "crm", …)` / `ingestEvent(pool, "crm", …)`.
- Scripts: every `raw.raw_crm_events` reference in `chaos.sh` / `demo.sh` / `check-demo.sh` (truncates, `raw_count()` helpers) becomes `raw.raw_events`.
- `stg_crm__companies.sql` line 3 becomes `from raw.raw_events` with `where source = 'crm' and event_type like 'company.%'`.

- [ ] **Step 1: Write the failing data-preservation test**

`ingest/test/migration-003.test.ts` — this one deliberately does NOT use `freshTestDb()` wholesale (it must insert *between* migrations), but it follows the same ephemeral-DB pattern:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

describe("migration 003: raw_crm_events → raw_events(source)", () => {
  it("copies every legacy row with source='crm', preserves payloads, then drops the old table; idempotent on re-run", async () => {
    const originalUrl = process.env.DATABASE_URL!;
    const dbName = `switchboard_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const adminUrl = originalUrl.replace(/\/[^/?]*(\?|$)/, "/postgres$1");
    const admin = new pg.Pool({ connectionString: adminUrl });
    await admin.query(`create database "${dbName}"`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: originalUrl.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`) });
    try {
      // Phase 1 state: run only 001 + 002, then insert a legacy row.
      await pool.query(sql("001_raw_events.sql"));
      await pool.query(sql("002_reliability.sql"));
      await pool.query(
        `insert into raw.raw_crm_events (event_id, event_type, payload)
         values ('evt-1', 'company.updated', '{"event_id":"evt-1","data":{"id":"DEMO-C-0001"}}'::jsonb)`,
      );
      // The migration under test.
      await pool.query(sql("003_multi_source.sql"));
      const migrated = await pool.query(
        "select source, event_id, payload from raw.raw_events order by id",
      );
      expect(migrated.rows).toHaveLength(1);
      expect(migrated.rows[0].source).toBe("crm");
      expect(migrated.rows[0].event_id).toBe("evt-1");
      expect(migrated.rows[0].payload.data.id).toBe("DEMO-C-0001");
      const legacy = await pool.query("select to_regclass('raw.raw_crm_events') as t");
      expect(legacy.rows[0].t).toBeNull();
      // Idempotence: the whole 001→003 sequence again (exactly what runMigrations does).
      await pool.query(sql("001_raw_events.sql"));
      await pool.query(sql("002_reliability.sql"));
      await pool.query(sql("003_multi_source.sql"));
      const after = await pool.query("select count(*)::int as n from raw.raw_events");
      expect(after.rows[0].n).toBe(1);
      // Unique index is now (source, event_id): same event_id under a DIFFERENT source inserts.
      await pool.query(
        `insert into raw.raw_events (source, event_id, event_type, payload)
         values ('billing', 'evt-1', 'invoice.created', '{}'::jsonb)`,
      );
      const both = await pool.query("select count(*)::int as n from raw.raw_events where event_id='evt-1'");
      expect(both.rows[0].n).toBe(2);
    } finally {
      await pool.end();
      const admin2 = new pg.Pool({ connectionString: adminUrl });
      await admin2.query(`drop database if exists "${dbName}" with (force)`);
      await admin2.end();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npm test -w ingest -- migration-003` → FAIL (`003_multi_source.sql` ENOENT).
- [ ] **Step 3: Write migration 003** exactly per Interfaces above.
- [ ] **Step 4: Run the migration test to verify it passes** — `npm test -w ingest -- migration-003` → PASS. (The rest of the ingest suite is now BROKEN-by-design: `raw.raw_crm_events` no longer exists after migrations run. That is the red for the sweep.)
- [ ] **Step 5: Update `ingest-event.ts`** to the new signature:

```ts
import type pg from "pg";
import type { SourceEvent } from "./server.js";

export async function ingestEvent(
  pool: pg.Pool,
  source: string,
  event: SourceEvent,
): Promise<"inserted" | "duplicate"> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const insertResult = await client.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ($1, $2, $3, $4) on conflict (source, event_id) do nothing`,
      [source, event.event_id, event.event_type, JSON.stringify(event)],
    );
    if (insertResult.rowCount === 1) {
      await client.query(
        "insert into ingest.outbox (source, event_id) values ($1, $2)",
        [source, event.event_id],
      );
      await client.query("commit");
      return "inserted";
    } else {
      await client.query("commit");
      return "duplicate";
    }
  } catch (err) {
    try { await client.query("rollback"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 6: Mechanical sweep of the remaining call sites** — with `source` pinned `"crm"` at the edges, `SourceEvent` rename throughout:
  - `server.ts`: `export type SourceEvent = z.infer<typeof eventSchema>;` (delete the `CrmEvent` name); `createIngestApp(pool, opts?: { enqueue?: (event: SourceEvent) => Promise<void> })`; handler calls `quarantineEvent(pool, "crm", req.body, "schema validation failed")` and `ingestEvent(pool, "crm", parsed.data)`.
  - `quarantine.ts`: `quarantineEvent(pool, source, payload, reason)` inserts `(source, payload, reason)`; `replayQuarantined` selects `payload, source` and calls `ingest(pool, row.source, parsed.data)`; its `ingest` param type becomes `(pool: pg.Pool, source: string, event: SourceEvent) => Promise<"inserted" | "duplicate">`.
  - `queue.ts`: `job.data as SourceEvent`; worker + `replayDlq` call `ingestEvent(pool, "crm", …)`; `fetchDlq` return type uses `SourceEvent`.
  - `backfill.ts`: `pollOnce(pool, source, baseUrl, opts?)`, `catchUp(pool, source, baseUrl, opts?)`; both use `source` for the cursor row and `ingestEvent(pool, source, crmEvent as SourceEvent)`; `main.ts`'s `createBackfillRunner` and `cli/backfill.ts` pass `CRM_SOURCE`.
  - `reconcile.ts`: `reconcile(pool, source, ledgerPath)`; raw query `where source = $1`; `cli/reconcile.ts` passes `"crm"`.
  - `main.ts`: replace the inline `boss.send("ingest-event", event)` with `enqueueEvent(boss, event)` (removes a Phase 1 duplication that would otherwise silently diverge in Task 3).
- [ ] **Step 7: Sweep the tests + warehouse + scripts** — in the eight listed test files: every `raw.raw_crm_events` → `raw.raw_events` (SELECTs gain `where source = 'crm'` where they filter; INSERTs — `ordering.test.ts`'s `insertRaw` — gain a `source` column with `'crm'`), every `ingestEvent(pool, ev)` → `ingestEvent(pool, "crm", ev)`, every `pollOnce(pool, url)`/`catchUp(pool, url)` → `…(pool, CRM_SOURCE, url)`, every `reconcile(pool, path)` → `reconcile(pool, "crm", path)`, `CrmEvent` → `SourceEvent`. `ordering.test.ts`'s `LATEST_STATE_SQL` gains `where source = 'crm'` (keep its stg-mirror comment in sync). `stg_crm__companies.sql` per Interfaces. Scripts: `chaos.sh` step 3 truncate + `raw_count()`/`check-demo.sh` counts → `raw.raw_events`.
- [ ] **Step 8: Verify green** — `grep -rn "raw_crm_events" ingest/src ingest/test warehouse/models scripts agent mocks` returns ONLY `ingest/migrations/001_raw_events.sql`, `002_reliability.sql`, `003_multi_source.sql`, and the migration test. Then: `npm test` (all workspaces) + `npm run typecheck` → green.
- [ ] **Step 9: Chaos + demo regression proof** — `./scripts/chaos.sh` → `PASS: zero lost events under injected faults`; run it TWICE (seeded determinism must hold); `./scripts/demo.sh` → `PASS: end-to-end demo produced a valid report …`. Record the PASS lines.
- [ ] **Step 10: Commit**

```bash
git add ingest warehouse/models/staging/stg_crm__companies.sql scripts
git commit -m "feat: single multi-source raw.raw_events table; source-parametrized ingest core (D1/D2)"
```

---

### Task 2: Source registry, `/webhooks/:source`, per-source HMAC secrets (D3)

**Files:**
- Create: `ingest/src/sources.ts`, `ingest/test/sources.test.ts`
- Modify: `ingest/src/hmac.ts`, `ingest/src/server.ts`, `ingest/src/main.ts`, `mocks/crm/src/hmac.ts`, `ingest/test/hmac-verify.test.ts`, `mocks/crm/test/hmac.test.ts`
- Test: `ingest/test/multi-source-server.test.ts`

**Interfaces:**
- `ingest/src/sources.ts` (new — the one registry every later task consumes):
```ts
export const SOURCES = ["crm", "billing", "support"] as const;
export type Source = (typeof SOURCES)[number];

export function isSource(v: string): v is Source {
  return (SOURCES as readonly string[]).includes(v);
}

const DEFAULT_PORTS: Record<Source, number> = { crm: 4001, billing: 4003, support: 4004 };

export function baseUrlFor(source: Source): string {
  return process.env[`${source.toUpperCase()}_BASE_URL`] ?? `http://localhost:${DEFAULT_PORTS[source]}`;
}

// Which sources this deployment actually polls/reconciles. Scripts pin this explicitly;
// code default is all three.
export function enabledSources(): Source[] {
  const raw = process.env.INGEST_SOURCES ?? SOURCES.join(",");
  return raw.split(",").map((s) => s.trim()).filter(isSource);
}

export function ledgerPathFor(source: Source): string | undefined {
  return process.env[`LEDGER_PATH_${source.toUpperCase()}`];
}
```
- `ingest/src/hmac.ts` gains (D3 — per-source secrets, keeping the duplicated-constant convention with the mock side):
```ts
// Per-source webhook secrets (D3): WEBHOOK_SECRET_CRM / _BILLING / _SUPPORT.
// Demo-only defaults, printed in the open — real deployments must set proper secrets.
// NOTE: secretForSource is intentionally duplicated in mocks (separate workspaces,
// must not cross-import). Keep copies in sync.
export function secretForSource(source: string): string {
  return process.env[`WEBHOOK_SECRET_${source.toUpperCase()}`] ?? `demo-secret-${source}`;
}
```
  The old unsuffixed `WEBHOOK_SECRET`/`DEFAULT_WEBHOOK_SECRET` path is removed on the ingest side (`verifySignature(rawBody, header, secret)` keeps its explicit-secret third parameter; callers now always pass `secretForSource(source)`).
- `mocks/crm/src/hmac.ts`: same `secretForSource` copy; `signBody(rawBody, secret = secretForSource("crm"))`. (Task 4 moves this into mock-core.)
- `ingest/src/server.ts`: route becomes `app.post("/webhooks/:source", …)`; first check `isSource(req.params.source)` else `404 { error: "unknown source" }` (before signature check — an unknown path is not an auth failure); then verify HMAC with `secretForSource(source)`; then quarantine/enqueue/ingest with that `source`. `opts.enqueue` becomes `(source: Source, event: SourceEvent) => Promise<void>`.
- `ingest/src/main.ts`: `enqueue = async (source, event) => enqueueEvent(boss, event)` (still single-queue until Task 3 — the `source` flows through the signature now so Task 3 is queue-only).

- [ ] **Step 1: Write the failing tests**

`ingest/test/sources.test.ts`:
```ts
import { afterEach, describe, expect, it } from "vitest";
import { SOURCES, isSource, baseUrlFor, enabledSources, ledgerPathFor } from "../src/sources.js";

afterEach(() => {
  delete process.env.INGEST_SOURCES;
  delete process.env.BILLING_BASE_URL;
  delete process.env.LEDGER_PATH_SUPPORT;
});

describe("source registry", () => {
  it("knows exactly crm, billing, support", () => {
    expect([...SOURCES]).toEqual(["crm", "billing", "support"]);
    expect(isSource("crm")).toBe(true);
    expect(isSource("hubspot")).toBe(false);
  });
  it("defaults base URLs to the documented ports and honors env overrides", () => {
    expect(baseUrlFor("crm")).toBe("http://localhost:4001");
    expect(baseUrlFor("billing")).toBe("http://localhost:4003");
    expect(baseUrlFor("support")).toBe("http://localhost:4004");
    process.env.BILLING_BASE_URL = "http://127.0.0.1:9999";
    expect(baseUrlFor("billing")).toBe("http://127.0.0.1:9999");
  });
  it("INGEST_SOURCES filters to known sources; default is all", () => {
    expect(enabledSources()).toEqual(["crm", "billing", "support"]);
    process.env.INGEST_SOURCES = "crm, bogus ,support";
    expect(enabledSources()).toEqual(["crm", "support"]);
  });
  it("ledgerPathFor reads LEDGER_PATH_<SOURCE>", () => {
    expect(ledgerPathFor("support")).toBeUndefined();
    process.env.LEDGER_PATH_SUPPORT = "/tmp/s.jsonl";
    expect(ledgerPathFor("support")).toBe("/tmp/s.jsonl");
  });
});
```

`ingest/test/multi-source-server.test.ts` (freshTestDb pattern; sign helper local to the test):
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => { ({ pool, cleanup } = await freshTestDb()); });
afterEach(async () => { await cleanup(); });

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

const post = async (app: ReturnType<typeof createIngestApp>, path: string, body: string, secret: string) => {
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-switchboard-signature": sign(body, secret) },
    body,
  });
  srv.close();
  return res;
};

const ev = JSON.stringify({
  event_id: "evt-1", event_type: "invoice.created",
  occurred_at: "2026-07-01T00:00:00.000Z", data: { id: "DEMO-I-0001" },
});

describe("multi-source webhook surface", () => {
  it("accepts a billing event signed with the billing secret and stores it under source='billing'", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-billing");
    expect(res.status).toBe(202);
    const row = await pool.query("select source, event_id from raw.raw_events");
    expect(row.rows).toEqual([{ source: "billing", event_id: "evt-1" }]);
  });
  it("rejects a billing event signed with the CRM secret (per-source secrets, D3)", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-crm");
    expect(res.status).toBe(401);
  });
  it("404s an unknown source before any auth check", async () => {
    const res = await post(createIngestApp(pool), "/webhooks/hubspot", ev, "demo-secret-crm");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown source" });
  });
  it("same event_id under two sources = two rows (uniqueness is (source, event_id))", async () => {
    await post(createIngestApp(pool), "/webhooks/crm", ev, "demo-secret-crm");
    await post(createIngestApp(pool), "/webhooks/billing", ev, "demo-secret-billing");
    const n = await pool.query("select count(*)::int as n from raw.raw_events where event_id='evt-1'");
    expect(n.rows[0].n).toBe(2);
  });
});
```

- [ ] **Step 2: Verify failure** — `npm test -w ingest -- sources multi-source-server` → FAIL (`sources.js` not found; `/webhooks/billing` 404s… note the unknown-source test may pass vacuously — the storing/401 tests are the red).
- [ ] **Step 3: Implement** `sources.ts`, `hmac.ts` `secretForSource`, the `server.ts` route per Interfaces, `main.ts` enqueue signature, and the mock-side default secret change (`demo-secret-crm`).
- [ ] **Step 4: Update the two existing HMAC tests** — `ingest/test/hmac-verify.test.ts` and `mocks/crm/test/hmac.test.ts` now sign/verify with `demo-secret-crm` (via `secretForSource("crm")`); assertions otherwise unchanged.
- [ ] **Step 5: Verify green** — `npm test` + `npm run typecheck` all workspaces; `./scripts/chaos.sh` and `./scripts/demo.sh` still PASS (both sides' defaults moved in lockstep, so no script change is needed here).
- [ ] **Step 6: Commit**

```bash
git add ingest mocks/crm
git commit -m "feat: /webhooks/:source with per-source HMAC secrets and source registry (D3)"
```

---

### Task 3: Per-source queues, backfill, and CLIs — spine generalization complete (D1)

**Files:**
- Modify: `ingest/src/queue.ts`, `ingest/src/main.ts`, `ingest/src/cli/backfill.ts`, `ingest/src/cli/reconcile.ts`, `ingest/src/cli/replay.ts`, `ingest/src/backfill.ts` (remove `CRM_SOURCE`), `ingest/test/queue.test.ts`, `ingest/test/replay.test.ts`, `ingest/test/backfill.test.ts`, `scripts/chaos.sh`, `scripts/demo.sh`
- Test: additions in `ingest/test/queue.test.ts`

**Interfaces:**
- `ingest/src/queue.ts` — queues become per-source (isolation: a poison billing job can never block CRM ingestion, and DLQ depth is inspectable per source):
```ts
import { SOURCES, type Source } from "./sources.js";

export function queueName(source: Source): string { return `ingest-${source}`; }
export function dlqName(source: Source): string { return `ingest-${source}-dlq`; }
```
  - `createQueue(connectionString, retryOpts?)` — unchanged signature; now loops `SOURCES`, doing the existing createQueue+updateQueue upsert dance for each `queueName(s)`/`dlqName(s)` pair (keep the Phase 1 comment explaining WHY updateQueue follows createQueue — it documents a real pg-boss bite).
  - `enqueueEvent(boss, source: Source, event: SourceEvent)` → `boss.send(queueName(source), event)`.
  - `startWorker(boss, pool, workerOpts?): Promise<string[]>` — one `boss.work(queueName(s), options, handler)` per source; each handler calls `ingestEvent(pool, s, job.data as SourceEvent)`. Returns the worker ids.
  - `fetchDlq(boss, limit = 10): Promise<{ source: Source; id: string; data: SourceEvent }[]>` — aggregates `boss.findJobs(dlqName(s))` across `SOURCES`, same `created`/`retry` state filter (keep the Phase 1 empirical-behavior comment).
  - `replayDlq(boss, pool)` — iterates the aggregated fetch; `ingestEvent(pool, job.source, job.data)`; `boss.deleteJob(dlqName(job.source), job.id)` (keep the deleteJob-vs-complete comment).
  - Delete the old `INGEST_QUEUE`/`INGEST_DLQ` constants; `tsc` flags stragglers.
- `ingest/src/main.ts`: `enqueue = (source, event) => enqueueEvent(boss, source, event)`; the backfill block loops `for (const source of enabledSources())`, creating one `createBackfillRunner(pool, source, baseUrlFor(source))` + interval per source (runner factory gains the `source` param and passes it to `catchUp`).
- `cli/backfill.ts`: loops `enabledSources()`; per source prints `backfill[<source>]: ingested N event(s) from <url>`; any failure → resumable-cursor message (existing pattern) and exit 1 after finishing the loop.
- `cli/reconcile.ts`: loops `enabledSources()`; for each source with `ledgerPathFor(source)` set: `verifyLedgerChain(path)` + `reconcile(pool, source, path)`, printing the existing report block prefixed `[<source>]`; sources without a ledger path print `[<source>] skipped (no LEDGER_PATH_<SOURCE>)`. Exit 0 iff every reconciled source is clean AND at least one source was reconciled.
- `cli/replay.ts`: aggregated `fetchDlq`; **keep the exact line format `DLQ depth: <n>`** (total across sources — `chaos.sh` greps it); `--list` lines gain `source=<source>`.
- Scripts: `chaos.sh` and `demo.sh` export `INGEST_SOURCES=crm` and rename `export LEDGER_PATH=…` → `export LEDGER_PATH_CRM="$(pwd)/out/ledger.jsonl"` (the mock's own env stays `LEDGER_PATH` — that is the mock process's file path option, per `mocks/crm/src/main.ts`). `chaos.sh`'s `queue_pending()` becomes `… where name like 'ingest-%' and state in ('created','active','retry')`, and the clean-state step additionally runs `delete from pgboss.job;` so stale jobs from pre-rename runs can never poison the settle-wait.

- [ ] **Step 1: Write the failing tests** — in `ingest/test/queue.test.ts` add (keeping the existing enqueue→worker→raw-row and poisoned-pool→DLQ tests, updated to `enqueueEvent(boss, "crm", ev)`):

```ts
it("routes events to per-source queues and DLQs stay isolated", async () => {
  // healthy pool; enqueue one billing + one crm event
  await enqueueEvent(boss, "billing", ev("evt-b1"));
  await enqueueEvent(boss, "crm", ev("evt-c1"));
  await startWorker(boss, pool);
  await pollUntil(async () => {
    const n = await pool.query("select count(*)::int as n from raw.raw_events");
    return n.rows[0].n === 2;
  }, 10_000);
  const rows = await pool.query("select source, event_id from raw.raw_events order by source");
  expect(rows.rows).toEqual([
    { source: "billing", event_id: "evt-b1" },
    { source: "crm", event_id: "evt-c1" },
  ]);
});
it("fetchDlq reports the source of dead-lettered jobs", async () => {
  // poisoned pool (connect rejects) + tiny retry opts, billing event only
  // → fetchDlq returns [{ source: "billing", … }] and raw stays empty
});
```
  (Write the second test fully using the existing poisoned-pool pattern in this file; `pollUntil` is the file's existing bounded-poll helper — reuse it.)
- [ ] **Step 2: Verify failure** — `npm test -w ingest -- queue` → FAIL (`enqueueEvent` arity / `queueName` missing).
- [ ] **Step 3: Implement** queue.ts + main.ts + CLIs per Interfaces; update `replay.test.ts` (replayDlq path now asserts the row lands with the job's source) and `backfill.test.ts` (import of `CRM_SOURCE` → literal `"crm"`).
- [ ] **Step 4: Verify green** — full `npm test` + `npm run typecheck`.
- [ ] **Step 5: Chaos green against the fully generalized spine** — update the two scripts per Interfaces, then `./scripts/chaos.sh` TWICE → PASS both times, `./scripts/demo.sh` → PASS. **This is the D1 gate: the multi-source spine carries the Phase 1 zero-loss proof before any new source exists.** Record outputs.
- [ ] **Step 6: Commit**

```bash
git add ingest scripts
git commit -m "feat: per-source queues, backfill loops, and CLIs — multi-source spine passes chaos (D1)"
```

---

### Task 4: Extract `mocks/core` — shared ledger/faults/HMAC + generic source app (pure refactor)

The mock machinery (ledger, faults, HMAC, `/simulate`+`/events` server) is about to be needed three times. Extract once, behavior-preserving; the existing `mocks/crm` suite is the regression harness. **No behavior change in this task** — same events, same fates, same signatures.

**Files:**
- Create: `mocks/core/package.json`, `mocks/core/tsconfig.json`, `mocks/core/src/index.ts`, `mocks/core/src/prng.ts`, `mocks/core/src/ledger.ts`, `mocks/core/src/faults.ts`, `mocks/core/src/hmac.ts`, `mocks/core/src/source-app.ts`, `mocks/core/test/source-app.test.ts`
- Modify: root `package.json` (workspaces gains `"mocks/core"` before `"mocks/crm"`), `mocks/crm/package.json` (dependency `"@switchboard/mock-core": "*"`), `mocks/crm/src/{server,seed,ledger,faults,hmac}.ts`

**Interfaces:**
- `mocks/core/package.json`: name `@switchboard/mock-core`, `"type": "module"`, `"main": "src/index.ts"`, same script set/devDeps majors as `mocks/crm` (express + zod deps).
- `src/prng.ts`: the `mulberry32` `prng` function MOVED verbatim from `mocks/crm/src/seed.ts`.
- `src/ledger.ts`, `src/faults.ts`: moved verbatim from `mocks/crm/src` (faults imports prng from `./prng.js`).
- `src/hmac.ts`: `signBody(rawBody, secret)` (secret now REQUIRED — the app passes it) + `secretForSource(source)` (same demo-default scheme as ingest's copy; keep the sync comment pointing at `ingest/src/hmac.ts`).
- `src/source-app.ts` — the generic mock (body is `mocks/crm/src/server.ts`'s current `/simulate` + `/events` + JSON middleware, verbatim except where noted):
```ts
export type SourceEventSpec = { event_type: string; data: Record<string, unknown> };
export type EventScript = (index: number) => SourceEventSpec; // index = seq - 1 (0-based, monotonic per app)

export type SourceAppOptions = {
  source: string;
  webhookUrl: string;
  ledgerPath: string;
  script: EventScript;
  extraRoutes?: (app: express.Express) => void; // e.g. CRM's paginated GET /companies, /deals
};
export function createSourceApp(opts: SourceAppOptions): express.Express;
```
  Differences from the CRM original: `entryInput` comes from `opts.script(seq - 1)` after `++seq` (spreads `{event_id: \`evt-${seq}\`, occurred_at: new Date().toISOString(), seq}` around the spec); the delivery header is `signBody(body, secretForSource(opts.source))`; `opts.extraRoutes?.(app)` is called before returning. Everything else — ledger-append-always-first, fault fates, deferred shuffle delivery, 502-on-fetch-failure, `/events` seq paging + 429 injection, `/simulate` zod schema — is IDENTICAL (copy, don't rewrite).
- `mocks/crm/src/server.ts` shrinks to a wrapper (public signature unchanged):
```ts
import { createSourceApp, type EventScript } from "@switchboard/mock-core";
import { generateSeed } from "./seed.js";
import express from "express";

export function createCrmApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { companies, deals } = generateSeed(opts.seed);
  // Phase 1 behavior preserved exactly: alternate company.updated / deal.updated.
  const script: EventScript = (i) => {
    const useCompany = i % 2 === 0;
    const entityIdx = Math.floor(i / 2);
    return {
      event_type: useCompany ? "company.updated" : "deal.updated",
      data: (useCompany ? companies[entityIdx % companies.length] : deals[entityIdx % deals.length]) as unknown as Record<string, unknown>,
    };
  };
  const paginate = /* move the existing paginate helper here unchanged */;
  return createSourceApp({
    source: "crm", webhookUrl: opts.webhookUrl, ledgerPath: opts.ledgerPath, script,
    extraRoutes: (app) => {
      app.get("/companies", (req, res) => res.json(paginate(companies, req)));
      app.get("/deals", (req, res) => res.json(paginate(deals, req)));
    },
  });
}
```
- `mocks/crm/src/{ledger,faults,hmac}.ts` become re-export shims so every existing test/import keeps working: `export * from "@switchboard/mock-core";` is WRONG (would re-export everything from each) — instead each file re-exports its own named set, e.g. `ledger.ts`: `export { appendToLedger, readLedger, verifyLedgerChain, GENESIS_HASH, DEFAULT_LEDGER_HMAC_KEY, type LedgerEntry, type LedgerEntryInput } from "@switchboard/mock-core";`. `seed.ts` keeps `export { prng } from "@switchboard/mock-core";` plus its own `generateSeed`.

- [ ] **Step 1: Write the failing mock-core test**

`mocks/core/test/source-app.test.ts` (sink harness pattern from `mocks/crm/test/events-feed.test.ts`):
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import { createSourceApp } from "../src/source-app.js";
import { readLedger } from "../src/ledger.js";

let dir: string; let sink: Server; let sinkUrl: string;
let received: { body: unknown; sig: string | undefined }[];
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "core-"));
  received = [];
  const app = express(); app.use(express.json());
  app.post("/hook", (req, res) => {
    received.push({ body: req.body, sig: req.header("x-switchboard-signature") });
    res.sendStatus(200);
  });
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("createSourceApp", () => {
  it("drives events from the script, ledgers first, and signs with the per-source secret", async () => {
    const app = createSourceApp({
      source: "billing", webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl"),
      script: (i) => ({ event_type: i % 2 === 0 ? "invoice.created" : "payment.succeeded", data: { id: `DEMO-I-${i}` } }),
    });
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 4 }),
    });
    const ledger = readLedger(join(dir, "l.jsonl"));
    expect(ledger.map((e) => e.event_type)).toEqual([
      "invoice.created", "payment.succeeded", "invoice.created", "payment.succeeded",
    ]);
    expect(ledger.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(received).toHaveLength(4);
    const body0 = JSON.stringify(ledger[0]);
    const expected = `sha256=${createHmac("sha256", "demo-secret-billing").update(body0, "utf8").digest("hex")}`;
    expect(received[0].sig).toBe(expected);
    srv.close();
  });
});
```
- [ ] **Step 2: Verify failure** — `npm install` (link the new workspace) then `npm test -w mocks/core` → FAIL (module not found).
- [ ] **Step 3: Implement** — create the workspace, MOVE the four modules, write `source-app.ts` by copying `mocks/crm/src/server.ts`'s body per Interfaces, shrink the crm wrapper + shims.
- [ ] **Step 4: Verify green, pristine** — `npm test` (mocks/core AND the untouched-in-assertions mocks/crm suite must both pass — the crm suite is the refactor's oracle) + `npm run typecheck` + `./scripts/demo.sh` + `./scripts/chaos.sh` → all PASS.
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json mocks
git commit -m "refactor: extract @switchboard/mock-core (ledger/faults/hmac/prng + generic source app)"
```

---

### Task 5: Correlated cross-system seed manifest (D4) + CRM contacts, dupes, and merge events

One master seed deterministically derives every source's entities with a PLANNED identity matrix: tier-1 email overlap, tier-2 domain+name matches (including normalization cases), near-misses that must NOT match, unmatchable rows, ~8% duplicate companies, and merge-candidate pairs — plus the `contacts` entity the original spec listed but the seed never had. The `profile` parameter exists NOW but only `"generic"` has content (D4: seam in 2a, content in 2b).

**Files:**
- Create: `mocks/core/src/manifest.ts`, `mocks/core/test/manifest.test.ts`
- Modify: `mocks/core/src/index.ts`, `mocks/crm/src/seed.ts`, `mocks/crm/src/server.ts`, `mocks/crm/test/seed.test.ts`, `mocks/crm/test/server.test.ts`, `mocks/crm/test/hygiene.test.ts`

**Interfaces (`mocks/core/src/manifest.ts` — complete):**
```ts
import { prng } from "./prng.js";

export type Profile = "generic" | "plumbing" | "saas" | "logistics";

export type Company = { id: string; name: string; domain: string; owner_email: string };
export type Contact = { id: string; company_id: string; name: string; email: string };
export type Deal = { id: string; company_id: string; name: string; amount_cents: number; status: "open" | "won" | "lost" };
export type MergePair = { from_id: string; to_id: string };
export type BillingCustomer = { id: string; name: string; domain: string; email: string };
export type Invoice = { id: string; customer_id: string; amount_cents: number; currency: "USD" };
export type SupportRequester = { id: string; name: string; email: string; company_name: string; domain: string };
export type Ticket = {
  id: string; requester_id: string; subject: string; priority: "normal" | "high";
  created_at: string; sla_due_at: string; solved_at: string;
};

export type Manifest = {
  crm: { companies: Company[]; contacts: Contact[]; deals: Deal[]; mergePairs: MergePair[] };
  billing: { customers: BillingCustomer[]; invoices: Invoice[] };
  support: { requesters: SupportRequester[]; tickets: Ticket[] };
  expectations: {
    canonicalCompanyCount: number; // 20: 22 staged companies − 2 merged away
    tier1: { billing: string[]; support: string[] };   // entity ids that MUST resolve tier 1
    tier2: { billing: string[]; support: string[] };   // MUST resolve tier 2
    manualReview: { billing: string[]; support: string[] }; // MUST land in manual_review (tier 3)
    mergePairs: MergePair[];
    crossSystemCompanyIds: string[]; // canonical CRM ids present in all three systems
  };
};

const SECTORS = ["Logistics", "Manufacturing", "Retail", "Consulting", "Media",
  "Freight", "Staffing", "Catering", "Printing", "Security"];
const STATUSES: Deal["status"][] = ["open", "won", "lost"];
const pad = (n: number) => String(n).padStart(4, "0");

export function generateManifest(masterSeed = 42, profile: Profile = "generic"): Manifest {
  if (profile !== "generic") {
    // D4: the parameter seam ships in 2a; vertical CONTENT (plumbing|saas|logistics) is Phase 2b.
    throw new Error(`profile "${profile}" not implemented until Phase 2b (only "generic" in 2a)`);
  }
  const rand = prng(masterSeed);

  // 20 base companies — identical construction to the Phase 0/1 seed (ids/names/domains stable).
  const base: Company[] = Array.from({ length: 20 }, (_, i) => {
    const sector = SECTORS[i % SECTORS.length];
    const slug = `${sector.toLowerCase()}-${i + 1}`;
    return {
      id: `DEMO-C-${pad(i + 1)}`,
      name: `DEMO ${sector} Group ${i + 1}`,
      domain: `${slug}.example.com`,
      owner_email: `owner.${slug}@example.com`,
    };
  });
  // ~8% seeded duplicates (2 of 22): dupes of C-0001/C-0002 — same domain, name variant.
  const dupes: Company[] = [
    { id: "DEMO-C-0021", name: `${base[0].name} Inc`, domain: base[0].domain, owner_email: "owner.logistics-1b@example.com" },
    { id: "DEMO-C-0022", name: base[1].name, domain: base[1].domain, owner_email: "owner.manufacturing-2b@example.com" },
  ];
  const companies = [...base, ...dupes];
  const mergePairs: MergePair[] = [
    { from_id: "DEMO-C-0021", to_id: "DEMO-C-0001" },
    { from_id: "DEMO-C-0022", to_id: "DEMO-C-0002" },
  ];

  // NEW entity (original spec §2, D4): 2 contacts per base company.
  const contacts: Contact[] = base.flatMap((c, i) => {
    const slug = c.domain.replace(".example.com", "");
    return [0, 1].map((k) => ({
      id: `DEMO-P-${pad(i * 2 + k + 1)}`,
      company_id: c.id,
      name: `DEMO Contact ${i * 2 + k + 1}`,
      email: `contact${k + 1}.${slug}@example.com`,
    }));
  });

  // 60 deals: 56 across base companies (same construction as Phase 1), 4 on the dupes so
  // merge collapse demonstrably re-points history (deal rollup moves to the canonical id).
  const deals: Deal[] = [
    ...Array.from({ length: 56 }, (_, i) => ({
      id: `DEMO-D-${pad(i + 1)}`,
      company_id: base[Math.floor(rand() * base.length)].id,
      name: `DEMO Deal ${i + 1}`,
      amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      id: `DEMO-D-${pad(57 + i)}`,
      company_id: dupes[i % 2].id,
      name: `DEMO Deal ${57 + i}`,
      amount_cents: Math.floor(rand() * 5_000_000) + 50_000,
      status: STATUSES[Math.floor(rand() * STATUSES.length)],
    })),
  ];

  // Billing: 16 customers. 1–10 tier-1 (exact contact email); 11–13 tier-2 (domain+name with
  // normalization variants); 14 near-miss (name matches, domain doesn't → manual review);
  // 15–16 unmatchable (billing-only → manual review + incomplete customer_360 rows, D6).
  const bId = (n: number) => `DEMO-B-${pad(n)}`;
  const customers: BillingCustomer[] = [
    ...base.slice(0, 10).map((c, i) => ({
      id: bId(i + 1), name: c.name, domain: c.domain, email: contacts[i * 2].email,
    })),
    { id: bId(11), name: `${base[10].name} Inc`, domain: base[10].domain, email: "billing.media-11@example.com" },
    { id: bId(12), name: base[11].name.toUpperCase(), domain: `WWW.${base[11].domain}`, email: "billing.freight-12@example.com" },
    { id: bId(13), name: base[12].name, domain: base[12].domain, email: "billing.staffing-13@example.com" },
    { id: bId(14), name: base[13].name, domain: "catering-14b.example.com", email: "billing.catering-14b@example.com" },
    { id: bId(15), name: "DEMO Standalone Billing Co 1", domain: "standalone-billing-1.example.com", email: "billing.standalone1@example.com" },
    { id: bId(16), name: "DEMO Standalone Billing Co 2", domain: "standalone-billing-2.example.com", email: "billing.standalone2@example.com" },
  ];
  const invRand = prng(masterSeed + 1);
  const invoices: Invoice[] = Array.from({ length: 40 }, (_, i) => ({
    id: `DEMO-I-${pad(i + 1)}`,
    customer_id: customers[i % customers.length].id,
    amount_cents: Math.floor(invRand() * 2_000_000) + 10_000,
    currency: "USD",
  }));

  // Support: 14 requesters. 1–9 tier-1 (contact emails of companies 6–14 → companies 6–10
  // overlap billing = cross-system entities); 10–11 tier-2 (normalization variants);
  // 12 near-miss (domain matches C-0017, name doesn't); 13–14 unmatchable.
  const sId = (n: number) => `DEMO-S-${pad(n)}`;
  const requesters: SupportRequester[] = [
    ...base.slice(5, 14).map((c, i) => ({
      id: sId(i + 1), name: `DEMO Requester ${i + 1}`, email: contacts[(i + 5) * 2].email,
      company_name: c.name, domain: c.domain,
    })),
    { id: sId(10), name: "DEMO Requester 10", email: "help.security-15@example.com", company_name: `${base[14].name} LLC`, domain: base[14].domain },
    { id: sId(11), name: "DEMO Requester 11", email: "help.freight-16@example.com", company_name: base[15].name, domain: `www.${base[15].domain}` },
    { id: sId(12), name: "DEMO Requester 12", email: "help.printing-17b@example.com", company_name: "DEMO Totally Different Name", domain: base[16].domain },
    { id: sId(13), name: "DEMO Requester 13", email: "help.standalone1@example.com", company_name: "DEMO Standalone Support Co 1", domain: "standalone-support-1.example.com" },
    { id: sId(14), name: "DEMO Requester 14", email: "help.standalone2@example.com", company_name: "DEMO Standalone Support Co 2", domain: "standalone-support-2.example.com" },
  ];
  const BASE_T = Date.parse("2026-07-01T00:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const tickets: Ticket[] = Array.from({ length: 30 }, (_, i) => {
    const priority = i % 3 === 0 ? "high" as const : "normal" as const;
    const created = BASE_T + i * 3_600_000;
    const slaHours = priority === "high" ? 24 : 72;
    const solveHours = (i % 5) * 20; // deterministic: some breach (e.g. high + 80h), some don't
    return {
      id: `DEMO-T-${pad(i + 1)}`,
      requester_id: requesters[i % requesters.length].id,
      subject: `DEMO Ticket ${i + 1}`,
      priority,
      created_at: iso(created),
      sla_due_at: iso(created + slaHours * 3_600_000),
      solved_at: iso(created + solveHours * 3_600_000),
    };
  });

  return {
    crm: { companies, contacts, deals, mergePairs },
    billing: { customers, invoices },
    support: { requesters, tickets },
    expectations: {
      canonicalCompanyCount: 20,
      tier1: {
        billing: customers.slice(0, 10).map((c) => c.id),
        support: requesters.slice(0, 9).map((r) => r.id),
      },
      tier2: { billing: [bId(11), bId(12), bId(13)], support: [sId(10), sId(11)] },
      manualReview: { billing: [bId(14), bId(15), bId(16)], support: [sId(12), sId(13), sId(14)] },
      mergePairs,
      crossSystemCompanyIds: base.slice(5, 10).map((c) => c.id), // C-0006..C-0010
    },
  };
}
```
- `mocks/crm/src/seed.ts` becomes a thin adapter (public signature preserved, now 22 companies):
```ts
import { generateManifest, type Company, type Contact, type Deal } from "@switchboard/mock-core";
export { prng } from "@switchboard/mock-core";
export type { Company, Contact, Deal };
export function generateSeed(seed = 42): { companies: Company[]; contacts: Contact[]; deals: Deal[] } {
  const m = generateManifest(seed);
  return { companies: m.crm.companies, contacts: m.crm.contacts, deals: m.crm.deals };
}
```
- `mocks/crm/src/server.ts` — the CRM event script widens to cover contacts and merges (deterministic, index-pure). Company slots at `i % 4 ∈ {0, 3}` (two per cycle → all 22 covered by index 43); positions 45–46 (which fall on non-company slots) are REPLACED by the two `company.merged` events, so both merge participants have appeared as `company.updated` before their merge is emitted, and the demo's 50-event run includes both merges:
```ts
const { companies, contacts, deals } = generateSeed(opts.seed);
const { mergePairs } = generateManifest(opts.seed ?? 42).crm;
const script: EventScript = (i) => {
  if (i === 45 || i === 46) {
    const p = mergePairs[i - 45];
    return { event_type: "company.merged", data: { from_id: p.from_id, to_id: p.to_id } };
  }
  const slot = i % 4;
  if (slot === 1) return { event_type: "contact.updated", data: contacts[Math.floor(i / 4) % contacts.length] as unknown as Record<string, unknown> };
  if (slot === 2) return { event_type: "deal.updated", data: deals[Math.floor(i / 4) % deals.length] as unknown as Record<string, unknown> };
  const cIdx = (Math.floor(i / 4) * 2 + (slot === 3 ? 1 : 0)) % companies.length;
  return { event_type: "company.updated", data: companies[cIdx] as unknown as Record<string, unknown> };
};
```

- [ ] **Step 1: Write the failing tests**

`mocks/core/test/manifest.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { generateManifest } from "../src/manifest.js";

describe("generateManifest", () => {
  it("is deterministic for the same master seed", () => {
    expect(generateManifest(42)).toEqual(generateManifest(42));
  });
  it("plants the identity matrix: 22 companies (2 dupes ≈ 8%), 40 contacts, 60 deals, merge pairs on the dupes", () => {
    const m = generateManifest();
    expect(m.crm.companies).toHaveLength(22);
    expect(m.crm.contacts).toHaveLength(40);
    expect(m.crm.deals).toHaveLength(60);
    expect(m.crm.mergePairs).toEqual([
      { from_id: "DEMO-C-0021", to_id: "DEMO-C-0001" },
      { from_id: "DEMO-C-0022", to_id: "DEMO-C-0002" },
    ]);
    // dupes share the canonical's domain (that's what makes them dupes)
    const byId = new Map(m.crm.companies.map((c) => [c.id, c]));
    expect(byId.get("DEMO-C-0021")!.domain).toBe(byId.get("DEMO-C-0001")!.domain);
  });
  it("tier-1 rows reuse exact contact emails; manual-review rows share no contact email", () => {
    const m = generateManifest();
    const contactEmails = new Set(m.crm.contacts.map((c) => c.email));
    for (const id of m.expectations.tier1.billing) {
      const cust = m.billing.customers.find((c) => c.id === id)!;
      expect(contactEmails.has(cust.email)).toBe(true);
    }
    for (const id of [...m.expectations.tier2.billing, ...m.expectations.manualReview.billing]) {
      const cust = m.billing.customers.find((c) => c.id === id)!;
      expect(contactEmails.has(cust.email)).toBe(false);
    }
  });
  it("every billing customer and support requester is classified exactly once in expectations", () => {
    const m = generateManifest();
    const b = [...m.expectations.tier1.billing, ...m.expectations.tier2.billing, ...m.expectations.manualReview.billing];
    expect(b.sort()).toEqual(m.billing.customers.map((c) => c.id).sort());
    expect(new Set(b).size).toBe(b.length);
    const s = [...m.expectations.tier1.support, ...m.expectations.tier2.support, ...m.expectations.manualReview.support];
    expect(s.sort()).toEqual(m.support.requesters.map((r) => r.id).sort());
  });
  it("stubs non-generic profiles until 2b (the seam exists, the content does not)", () => {
    expect(() => generateManifest(42, "plumbing")).toThrow(/Phase 2b/);
  });
});
```
Plus extend `mocks/crm/test/hygiene.test.ts` to run its three checks over `JSON.stringify(generateManifest())` (import from `@switchboard/mock-core`) in addition to `generateSeed()` — every email `@example.com`, every id/name `DEMO`-prefixed, no SSN/phone shapes, across ALL sources' entities.
- [ ] **Step 2: Verify failure** — `npm test -w mocks/core -w mocks/crm` → FAIL (manifest module missing).
- [ ] **Step 3: Implement** `manifest.ts` per Interfaces; export from `index.ts`; rewire `seed.ts` + the CRM script.
- [ ] **Step 4: Update pinned expectations** (behavior deliberately changed — update minimally):
  - `mocks/crm/test/seed.test.ts`: 22 companies / 60 deals; add contacts length 40; deal-link test: every `company_id` ∈ the 22 ids.
  - `mocks/crm/test/server.test.ts`: "paginates companies" → `total: 22` (page-2 `DEMO-C-0009` assertion unchanged); "covers all company ids" → simulate `count: 90`, expect `distinctCompanyIds.size` = 22 and additionally `ledger.filter(e => e.event_type === "company.merged")` has length 2 with `data.from_id`/`data.to_id` matching the manifest pairs.
- [ ] **Step 5: Verify green** — full `npm test` + `npm run typecheck`; `./scripts/demo.sh` and `./scripts/chaos.sh` PASS (the ingest spine is payload-agnostic; stg model only reads `company.%` events — `company.merged` rows flow through it, which is fine: its `data` lacks `id` so DISTINCT ON groups them under NULL — verify the dbt uniqueness test still passes in the demo run; if it fails, tighten the stg filter to `event_type in ('company.updated')` as part of this step).
- [ ] **Step 6: Commit**

```bash
git add mocks
git commit -m "feat: correlated cross-system seed manifest with planned identity matrix; CRM contacts + merge events (D4)"
```

---

### Task 6: Billing mock source

**Files:**
- Create: `mocks/billing/package.json`, `mocks/billing/tsconfig.json`, `mocks/billing/src/server.ts`, `mocks/billing/src/main.ts`, `mocks/billing/test/server.test.ts`
- Modify: root `package.json` (workspaces += `"mocks/billing"`)

**Interfaces:**
- `package.json`: name `@switchboard/mock-billing`, same shape as `mocks/crm`'s, plus dependency `"@switchboard/mock-core": "*"`.
- `mocks/billing/src/server.ts`:
```ts
import express from "express";
import { createSourceApp, generateManifest, type EventScript } from "@switchboard/mock-core";

export function createBillingApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number }): express.Express {
  const { customers, invoices } = generateManifest(opts.seed ?? 42).billing;
  // 5-slot cycle: customer.created, invoice.created, payment.succeeded, invoice.paid,
  // then alternating payment.failed / invoice.voided. All 16 customers covered by index 79.
  const script: EventScript = (i) => {
    const n = Math.floor(i / 5);
    const slot = i % 5;
    const inv = invoices[n % invoices.length];
    switch (slot) {
      case 0: return { event_type: "customer.created", data: customers[n % customers.length] as unknown as Record<string, unknown> };
      case 1: return { event_type: "invoice.created", data: { ...inv } };
      case 2: return { event_type: "payment.succeeded", data: { id: `DEMO-PAY-${String(n * 2 + 1).padStart(4, "0")}`, invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents } };
      case 3: return { event_type: "invoice.paid", data: { ...inv } };
      default:
        return n % 2 === 0
          ? { event_type: "payment.failed", data: { id: `DEMO-PAY-${String(n * 2 + 2).padStart(4, "0")}`, invoice_id: inv.id, customer_id: inv.customer_id, amount_cents: inv.amount_cents } }
          : { event_type: "invoice.voided", data: { ...inv } };
    }
  };
  return createSourceApp({
    source: "billing", webhookUrl: opts.webhookUrl, ledgerPath: opts.ledgerPath, script,
    extraRoutes: (app) => {
      app.get("/customers", (_req, res) => res.json({ items: customers, total: customers.length }));
    },
  });
}
```
- `main.ts`: mirror of `mocks/crm/src/main.ts` — port `process.env.PORT ?? 4003`, webhook default `http://localhost:4002/webhooks/billing`, ledger default `./out/ledger-billing.jsonl`.

- [ ] **Step 1: Write the failing test** — `mocks/billing/test/server.test.ts` (sink harness pattern): simulate `{count: 10}` → ledger has 10 entries; event_types are exactly `["customer.created","invoice.created","payment.succeeded","invoice.paid","payment.failed", "customer.created", …]` (first 10 of the cycle); every delivered signature verifies against `demo-secret-billing` (reuse the HMAC assertion from Task 4's core test); simulate with `fault_plan {seed: 7, dropRate: 0.3, dupRate: 0, apiErrorRate: 0}` on a fresh app → `body.emitted + body.dropped === 20` and ledger still has all 20 (ledger-never-faulted, per-source).
- [ ] **Step 2: Verify failure** — module not found.
- [ ] **Step 3: Implement** per Interfaces (plus `npm install` to link).
- [ ] **Step 4: Verify green** — `npm test` + `npm run typecheck` across workspaces.
- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json mocks/billing
git commit -m "feat: billing mock source (webhook+ledger shape) driven by the shared manifest"
```

---

### Task 7: Support mock source + three-source demo/chaos (the source-agnostic-spine proof)

**Files:**
- Create: `mocks/support/package.json`, `mocks/support/tsconfig.json`, `mocks/support/src/server.ts`, `mocks/support/src/main.ts`, `mocks/support/test/server.test.ts`
- Modify: root `package.json` (workspaces += `"mocks/support"`), `scripts/demo.sh`, `scripts/chaos.sh`, `scripts/check-demo.sh`

**Interfaces:**
- `createSupportApp(opts: { webhookUrl: string; ledgerPath: string; seed?: number })` — same shape as billing. 4-slot cycle over `generateManifest(...).support`:
```ts
const { requesters, tickets } = generateManifest(opts.seed ?? 42).support;
const byId = new Map(requesters.map((r) => [r.id, r]));
const script: EventScript = (i) => {
  const n = Math.floor(i / 4);
  const t = tickets[n % tickets.length];
  const r = byId.get(t.requester_id)!;
  const ticketData = { ...t, requester_email: r.email, requester_name: r.name, company_name: r.company_name, domain: r.domain } as unknown as Record<string, unknown>;
  switch (i % 4) {
    case 0: return { event_type: "ticket.created", data: ticketData };
    case 1: return { event_type: "ticket.updated", data: ticketData };
    case 2: return { event_type: "ticket.solved", data: ticketData };
    default: return { event_type: "csat.recorded", data: { id: `DEMO-CS-${String(n + 1).padStart(4, "0")}`, ticket_id: t.id, score: (n % 5) + 1 } };
  }
};
```
  `main.ts`: port default 4004, webhook default `http://localhost:4002/webhooks/support`, ledger default `./out/ledger-support.jsonl`.
- `scripts/demo.sh` changes:
  - env: `export LEDGER_PATH_CRM="$(pwd)/out/ledger-crm.jsonl"`, `_BILLING`, `_SUPPORT` (crm ledger RENAMED from `out/ledger.jsonl` — sweep `check-demo.sh` and `chaos.sh` for the old name); `export INGEST_SOURCES=crm,billing,support`.
  - start all three mocks: crm `PORT=4001 WEBHOOK_URL=http://localhost:4002/webhooks/crm LEDGER_PATH=$LEDGER_PATH_CRM`, billing `PORT=4003 … /webhooks/billing LEDGER_PATH=$LEDGER_PATH_BILLING`, support `PORT=4004 … /webhooks/support LEDGER_PATH=$LEDGER_PATH_SUPPORT`.
  - simulate: crm `{"count": 80}` (covers 22 companies + both merges), billing `{"count": 100}` (covers all 16 customers), support `{"count": 80}` (covers all requesters via the first 14 tickets).
  - drain-wait: total `raw.raw_events` count == sum of the three ledgers' line counts.
- `scripts/check-demo.sh`: raw/outbox counts compare against the SUM of the three ledger files; report checks unchanged.
- `scripts/chaos.sh` changes:
  - same env/start changes; clean step removes all three ledgers;
  - simulate all three sources, each 200 events, `fault_plan {seed: $CHAOS_SEED (default 7), dropRate: 0.2, dupRate: 0.15, apiErrorRate: 0.2}` (`CHAOS_SEED` env introduced here; Task 11's workflow feeds it);
  - settle-wait: raw stable + `queue_pending` (all `ingest-%` queues) zero;
  - backfill/reconcile CLIs already iterate `INGEST_SOURCES` (Task 3) — no CLI change; reconcile now proves ledger↔raw parity per source;
  - final PASS line unchanged.

- [ ] **Step 1: Write the failing test** — `mocks/support/test/server.test.ts` (sink pattern): simulate `{count: 8}` → ledger event_types `["ticket.created","ticket.updated","ticket.solved","csat.recorded","ticket.created","ticket.updated","ticket.solved","csat.recorded"]`; the `ticket.*` events embed `requester_email` ending `@example.com` and a `sla_due_at`; signature verifies against `demo-secret-support`.
- [ ] **Step 2: Verify failure**; **Step 3: Implement**; **Step 4: `npm test` + typecheck green.**
- [ ] **Step 5: Script updates + RED proof** — update the three scripts per Interfaces. First run `CHAOS_SKIP_BACKFILL=1 ./scripts/chaos.sh` → reconcile must FAIL listing missing events for ALL THREE sources (the detector detects per-source). Record the output.
- [ ] **Step 6: GREEN** — `./scripts/chaos.sh` → `PASS: zero lost events under injected faults` with three per-source reconcile blocks; run TWICE (determinism). `./scripts/demo.sh` → PASS.
- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json mocks/support scripts
git commit -m "feat: support mock source; chaos + demo prove the spine is source-agnostic across 3 sources"
```

---

### Task 8: Staging models for all three sources

All staging models follow the `stg_crm__companies` pattern exactly: filter `raw.raw_events` by `source` + `event_type`, DISTINCT ON the entity id, ordered by `occurred_at` desc with the `evt-N` ordinal tiebreak (event ids are per-source ordinals, and every model filters to one source, so the tiebreak stays valid).

**Files:**
- Create: `warehouse/models/staging/stg_crm__contacts.sql`, `stg_crm__deals.sql`, `stg_billing__customers.sql`, `stg_billing__invoices.sql`, `stg_billing__payments.sql`, `stg_support__tickets.sql`, `stg_support__csat.sql`
- Modify: `warehouse/models/staging/schema.yml`, `warehouse/models/staging/stg_crm__companies.sql` (tighten filter to exclude `company.merged` from latest-state if not already done in Task 5 Step 5)

**Interfaces (complete SQL — each file):**

`stg_crm__contacts.sql`:
```sql
with events as (
    select event_id, payload from raw.raw_events
    where source = 'crm' and event_type = 'contact.updated'
),
latest as (
    select distinct on (payload -> 'data' ->> 'id') payload -> 'data' as contact
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    contact ->> 'id'         as contact_id,
    contact ->> 'company_id' as company_id,
    contact ->> 'name'       as name,
    contact ->> 'email'      as email
from latest
```

`stg_crm__deals.sql` — same skeleton, `event_type = 'deal.updated'`, selecting `deal_id, company_id, name, (deal ->> 'amount_cents')::bigint as amount_cents, deal ->> 'status' as status`.

`stg_billing__customers.sql` — `source = 'billing' and event_type = 'customer.created'`, selecting `customer_id, name, domain, email`.

`stg_billing__invoices.sql` — invoice STATUS is the last event's verb:
```sql
with events as (
    select event_id, event_type, payload from raw.raw_events
    where source = 'billing' and event_type in ('invoice.created', 'invoice.paid', 'invoice.voided')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as invoice,
        split_part(event_type, '.', 2) as status
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    invoice ->> 'id'          as invoice_id,
    invoice ->> 'customer_id' as customer_id,
    (invoice ->> 'amount_cents')::bigint as amount_cents,
    status
from latest
```

`stg_billing__payments.sql` — same skeleton over `('payment.succeeded','payment.failed')`, columns `payment_id, invoice_id, customer_id, amount_cents, status` (status = `succeeded|failed`).

`stg_support__tickets.sql` — status open/solved from last verb; identity attributes ride along:
```sql
with events as (
    select event_id, event_type, payload from raw.raw_events
    where source = 'support' and event_type in ('ticket.created', 'ticket.updated', 'ticket.solved')
),
latest as (
    select distinct on (payload -> 'data' ->> 'id')
        payload -> 'data' as ticket,
        case when event_type = 'ticket.solved' then 'solved' else 'open' end as status
    from events
    order by payload -> 'data' ->> 'id',
             (payload ->> 'occurred_at') desc,
             (substring(event_id from 5))::bigint desc
)
select
    ticket ->> 'id'              as ticket_id,
    ticket ->> 'requester_id'    as requester_id,
    ticket ->> 'requester_email' as requester_email,
    ticket ->> 'requester_name'  as requester_name,
    ticket ->> 'company_name'    as company_name,
    ticket ->> 'domain'          as domain,
    ticket ->> 'priority'        as priority,
    (ticket ->> 'created_at')::timestamptz as created_at,
    (ticket ->> 'sla_due_at')::timestamptz as sla_due_at,
    case when status = 'solved' then (ticket ->> 'solved_at')::timestamptz end as solved_at,
    status
from latest
```

`stg_support__csat.sql` — `event_type = 'csat.recorded'`, DISTINCT ON `ticket_id`, columns `csat_id, ticket_id, (… ->> 'score')::int as score`.

`schema.yml` additions — for each model: id column `[unique, not_null]`; `stg_billing__invoices.status` `accepted_values: [created, paid, voided]`; `stg_billing__payments.status` `accepted_values: [succeeded, failed]`; `stg_support__tickets.status` `accepted_values: [open, solved]`.

- [ ] **Step 1 (RED): declare before building** — add all seven models + tests to `schema.yml`, run `./scripts/demo.sh` once if the dev DB has no fresh 3-source data, then `docker compose run --rm dbt build` → FAIL ("depends on a node named … which was not found" / missing model files).
- [ ] **Step 2: Write the seven model files** per Interfaces.
- [ ] **Step 3 (GREEN):** `docker compose run --rm dbt build` → all models + tests PASS (row counts nonzero for every staging model — eyeball the build log; a zero-row staging model means the demo counts don't cover that entity type and the Task 7 counts must be revisited, not the model).
- [ ] **Step 4: Full regression** — `npm test` + `npm run typecheck` + `./scripts/demo.sh` (which runs dbt build inside it) → PASS.
- [ ] **Step 5: Commit**

```bash
git add warehouse/models/staging
git commit -m "feat: staging models for contacts/deals/billing/support across the 3-source raw table"
```

---

### Task 9: Identity resolution + merge collapse (D5) — **RISKIEST TASK #2**

Three deterministic tiers with auditable provenance, merge handling via an immutable derived `merge_edges` model, resolution computed at mart build only (raw never rewritten), cycle-guarded recursive follow-to-terminal, and `manual_review` as an incremental model (NOT a dbt seed). Because the recursion is the highest-risk SQL in the phase, its core is TDD'd in a TS test against a fresh Postgres (the `ordering.test.ts` precedent) with a genuine RED (naive one-hop version) before the recursive version lands, and then copied into the dbt model with a sync comment.

**Files:**
- Create: `warehouse/models/identity/merge_edges.sql`, `warehouse/models/identity/int_crm__canonical_companies.sql`, `warehouse/models/identity/identity_resolution.sql`, `warehouse/models/identity/manual_review.sql`, `warehouse/models/identity/schema.yml`, `warehouse/tests/assert_no_merge_cycles.sql`, `warehouse/tests/assert_merge_chains_terminate.sql`, `ingest/test/merge-resolution.test.ts`
- Modify: `warehouse/dbt_project.yml`

**Interfaces:**

`warehouse/dbt_project.yml` models block gains:
```yaml
    identity:
      +materialized: table
      +schema: analytics
```

`merge_edges.sql` — derived, deterministic, batch-recomputed over full history every build (D5: arrival order washes out — the model is a pure function of the append-only raw set, so transitive merges A→B→C resolve identically regardless of delivery order). One edge per `from_id` (a re-merged source: latest `occurred_at` wins, evt-ordinal tiebreak):
```sql
with merge_events as (
    select
        payload -> 'data' ->> 'from_id' as from_id,
        payload -> 'data' ->> 'to_id'   as to_id,
        payload ->> 'occurred_at'       as occurred_at,
        event_id
    from raw.raw_events
    where source = 'crm' and event_type = 'company.merged'
)
select distinct on (from_id) from_id, to_id, occurred_at
from merge_events
order by from_id, occurred_at desc, (substring(event_id from 5))::bigint desc
```

`int_crm__canonical_companies.sql` — recursive follow-to-terminal with cycle guard (SQL core mirrored in `ingest/test/merge-resolution.test.ts`; keep both in sync — comment in both files):
```sql
with recursive walk as (
    select
        c.company_id            as company_id,
        c.company_id            as current_id,
        0                       as merge_depth,
        array[c.company_id]     as merge_path,
        false                   as is_cycle
    from {{ ref('stg_crm__companies') }} c
    union all
    select
        w.company_id,
        e.to_id,
        w.merge_depth + 1,
        w.merge_path || e.to_id,
        e.to_id = any(w.merge_path)
    from walk w
    join {{ ref('merge_edges') }} e on e.from_id = w.current_id
    where not w.is_cycle and w.merge_depth < 10
)
select distinct on (company_id)
    company_id,
    current_id  as canonical_id,
    merge_depth,
    merge_path,
    is_cycle
from walk
order by company_id, merge_depth desc
```

`identity_resolution.sql` — tiers + provenance for billing and support entities. Normalization is pinned here and ONLY here (evidence strings make the resolution auditable):
```sql
with canonical as (
    select company_id, canonical_id from {{ ref('int_crm__canonical_companies') }}
),
companies as (
    select c.company_id, c.name, c.domain, k.canonical_id
    from {{ ref('stg_crm__companies') }} c
    join canonical k on k.company_id = c.company_id
),
crm_emails as (
    select email, company_id from {{ ref('stg_crm__contacts') }}
    union
    select payload -> 'data' ->> 'owner_email' as email, payload -> 'data' ->> 'id' as company_id
    from raw.raw_events where source = 'crm' and event_type = 'company.updated'
),
norm_companies as (
    select
        canonical_id,
        lower(regexp_replace(domain, '^www\.', '', 'i')) as norm_domain,
        regexp_replace(lower(trim(name)), '\s+(inc|llc|ltd|corp)\.?$', '') as norm_name
    from companies
),
source_entities as (
    select 'billing' as source, customer_id as source_entity_id, email, domain, name
    from {{ ref('stg_billing__customers') }}
    union all
    select distinct 'support', requester_id, requester_email, domain, company_name
    from {{ ref('stg_support__tickets') }}
),
tier1 as (
    select se.source, se.source_entity_id, k.canonical_id,
           1 as matched_tier, 'email=' || se.email as match_evidence
    from source_entities se
    join crm_emails ce on ce.email = se.email
    join canonical k on k.company_id = ce.company_id
),
tier2 as (
    select se.source, se.source_entity_id, nc.canonical_id,
           2 as matched_tier,
           'domain+name=' || nc.norm_domain || '|' || nc.norm_name as match_evidence
    from source_entities se
    join norm_companies nc
      on nc.norm_domain = lower(regexp_replace(se.domain, '^www\.', '', 'i'))
     and nc.norm_name   = regexp_replace(lower(trim(se.name)), '\s+(inc|llc|ltd|corp)\.?$', '')
    where not exists (
        select 1 from tier1 t1
        where t1.source = se.source and t1.source_entity_id = se.source_entity_id
    )
),
matched as (
    select * from tier1 union all select * from tier2
),
tier3 as (
    select se.source, se.source_entity_id,
           se.source || ':' || se.source_entity_id as canonical_id,
           3 as matched_tier, 'unmatched' as match_evidence
    from source_entities se
    where not exists (
        select 1 from matched m
        where m.source = se.source and m.source_entity_id = se.source_entity_id
    )
)
select distinct on (source, source_entity_id)
    source,
    source_entity_id,
    source || ':' || source_entity_id as resolution_key,
    canonical_id as resolved_entity_id,
    matched_tier,
    match_evidence
from (select * from matched union all select * from tier3) u
order by source, source_entity_id, matched_tier
```
(The final DISTINCT ON + `order by … matched_tier` makes tier precedence explicit even if an entity somehow matches multiple tier-1 companies — lowest tier, deterministic. Multiple tier-1 matches to DIFFERENT companies would still be nondeterministic between them; the manifest never plants that, and the mart uniqueness test would catch a collision explosion.)

`manual_review.sql` — plain incremental model (D5 explicitly: not a static-CSV dbt seed; D13: this is Switchboard *operational* state, not a system of record):
```sql
{{ config(materialized='incremental', unique_key='resolution_key') }}
select
    resolution_key,
    source,
    source_entity_id,
    match_evidence,
    current_timestamp as first_seen_at
from {{ ref('identity_resolution') }}
where matched_tier = 3
{% if is_incremental() %}
  and resolution_key not in (select resolution_key from {{ this }})
{% endif %}
```

`warehouse/models/identity/schema.yml`:
```yaml
version: 2
models:
  - name: merge_edges
    columns:
      - name: from_id
        data_tests: [unique, not_null]
      - name: to_id
        data_tests: [not_null]
  - name: int_crm__canonical_companies
    columns:
      - name: company_id
        data_tests: [unique, not_null]
      - name: canonical_id
        data_tests: [not_null]
  - name: identity_resolution
    columns:
      - name: resolution_key
        data_tests: [unique, not_null]
      - name: resolved_entity_id
        data_tests: [not_null]
      - name: matched_tier
        data_tests:
          - not_null
          - accepted_values:
              values: [1, 2, 3]
              quote: false
  - name: manual_review
    columns:
      - name: resolution_key
        data_tests: [unique, not_null]
```

`warehouse/tests/assert_no_merge_cycles.sql` (singular test — rows returned = failure):
```sql
select company_id, merge_path
from {{ ref('int_crm__canonical_companies') }}
where is_cycle
```

`warehouse/tests/assert_merge_chains_terminate.sql` — a canonical id must have no outgoing edge (otherwise the walk stopped at the depth guard, i.e. a chain longer than 10 or an undetected anomaly):
```sql
select k.company_id, k.canonical_id
from {{ ref('int_crm__canonical_companies') }} k
join {{ ref('merge_edges') }} e on e.from_id = k.canonical_id
where not k.is_cycle
```

- [ ] **Step 1: Write the TS resolution-core test (RED by design)**

`ingest/test/merge-resolution.test.ts` — freshTestDb; builds throwaway tables shaped like the dbt inputs; starts with a NAIVE one-hop resolution so the chain case genuinely fails, proving the test detects under-resolution:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
  await pool.query(`
    create table tmp_companies (company_id text primary key);
    create table tmp_merge_edges (from_id text primary key, to_id text not null);
  `);
});
afterEach(async () => { await cleanup(); });

// SYNC NOTE: this SQL mirrors warehouse/models/identity/int_crm__canonical_companies.sql
// (ref()s swapped for the tmp_ tables). Keep both in sync — same walk, same guards.
const RESOLUTION_SQL = `
  with recursive walk as (
      select c.company_id, c.company_id as current_id, 0 as merge_depth,
             array[c.company_id] as merge_path, false as is_cycle
      from tmp_companies c
      union all
      select w.company_id, e.to_id, w.merge_depth + 1,
             w.merge_path || e.to_id, e.to_id = any(w.merge_path)
      from walk w
      join tmp_merge_edges e on e.from_id = w.current_id
      where not w.is_cycle and w.merge_depth < 10
  )
  select distinct on (company_id) company_id, current_id as canonical_id, merge_depth, is_cycle
  from walk
  order by company_id, merge_depth desc
`;

const seed = async (companies: string[], edges: [string, string][]) => {
  for (const c of companies) await pool.query("insert into tmp_companies values ($1)", [c]);
  for (const [f, t] of edges) await pool.query("insert into tmp_merge_edges values ($1, $2)", [f, t]);
};
const resolve = async () => (await pool.query(RESOLUTION_SQL)).rows;

describe("merge resolution walk", () => {
  it("follows transitive chains to the terminal (A→B→C resolves A to C, depth 2)", async () => {
    await seed(["A", "B", "C"], [["A", "B"], ["B", "C"]]);
    const rows = await resolve();
    expect(rows.find((r) => r.company_id === "A")).toMatchObject({ canonical_id: "C", merge_depth: 2, is_cycle: false });
    expect(rows.find((r) => r.company_id === "B")).toMatchObject({ canonical_id: "C", merge_depth: 1 });
    expect(rows.find((r) => r.company_id === "C")).toMatchObject({ canonical_id: "C", merge_depth: 0 });
  });
  it("flags a 2-cycle (A→B, B→A) as is_cycle and TERMINATES (no hang, no error)", async () => {
    await seed(["A", "B"], [["A", "B"], ["B", "A"]]);
    const rows = await resolve();
    expect(rows.find((r) => r.company_id === "A")!.is_cycle).toBe(true);
    expect(rows.find((r) => r.company_id === "B")!.is_cycle).toBe(true);
  });
  it("flags a self-merge (A→A) as a cycle rather than depth-looping", async () => {
    await seed(["A"], [["A", "A"]]);
    const rows = await resolve();
    expect(rows[0].is_cycle).toBe(true);
  });
  it("depth guard: an 11-link chain surfaces as a non-terminated walk (depth capped at 10)", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `N${i}`);
    const edges = ids.slice(0, 11).map((id, i) => [id, ids[i + 1]] as [string, string]);
    await seed(ids, edges);
    const rows = await resolve();
    const n0 = rows.find((r) => r.company_id === "N0")!;
    expect(n0.merge_depth).toBe(10); // stopped by the guard, NOT at the true terminal N11 —
    // exactly the condition assert_merge_chains_terminate.sql catches in dbt (canonical still
    // has an outgoing edge).
  });
});
```
  **RED protocol:** first commit the test with `RESOLUTION_SQL` as the naive one-hop version (`select c.company_id, coalesce(e.to_id, c.company_id) as canonical_id, … left join tmp_merge_edges e on e.from_id = c.company_id`) — run `npm test -w ingest -- merge-resolution` → the transitive-chain test FAILS (A resolves to B, not C). That is the genuine red.
- [ ] **Step 2: Go GREEN** — replace `RESOLUTION_SQL` with the recursive version above; `npm test -w ingest -- merge-resolution` → 4/4 PASS.
- [ ] **Step 3: Write the dbt models + tests** — all files per Interfaces (copying the walk SQL with the sync comment), plus the `dbt_project.yml` block.
- [ ] **Step 4: dbt RED→GREEN** — with demo data present: `docker compose run --rm dbt build` → identity models build, schema + singular tests PASS. Deliberately verify the singular tests can fail: run `docker compose exec -T postgres psql -U switchboard -c "insert into raw.raw_events (source, event_id, event_type, payload) values ('crm','evt-999999','company.merged','{\"occurred_at\":\"2026-07-21T00:00:00Z\",\"data\":{\"from_id\":\"DEMO-C-0001\",\"to_id\":\"DEMO-C-0021\"}}'::jsonb)"` (creates the 0021→0001→0021 cycle), re-run `docker compose run --rm dbt build` → `assert_no_merge_cycles` FAILS. Delete the row (`delete from raw.raw_events where event_id='evt-999999'`), rebuild → PASS. Record both outputs. (This raw-row surgery is on the throwaway dev DB only — never in a test file, never in migrations.)
- [ ] **Step 5: Full regression** — `npm test` + `npm run typecheck` + `./scripts/demo.sh` + `./scripts/chaos.sh` → PASS.
- [ ] **Step 6: Commit**

```bash
git add warehouse ingest/test/merge-resolution.test.ts
git commit -m "feat: 3-tier identity resolution with provenance, cycle-guarded merge collapse, manual_review (D5)"
```

---

### Task 10: `customer_360` mart (D6) + the manifest-expectations oracle

**Files:**
- Create: `warehouse/models/marts/customer_360.sql`, `warehouse/models/marts/schema.yml`, `warehouse/tests/assert_incomplete_rows_flagged.sql`, `scripts/verify-identity.ts`
- Modify: `warehouse/dbt_project.yml` (marts block), `scripts/demo.sh` (verify step)

**Interfaces:**

`dbt_project.yml` models block gains:
```yaml
    marts:
      +materialized: table
      +schema: analytics
```

`customer_360.sql` — one row per resolved entity; billing/support-only entities INCLUDED and flagged (D6); merged companies collapse into their canonical (and their deals roll up — the re-pointed-history proof):
```sql
with canonical as (
    select company_id, canonical_id from {{ ref('int_crm__canonical_companies') }}
),
crm_entities as (
    select distinct on (k.canonical_id)
        k.canonical_id as entity_id, c.name as entity_name, c.domain
    from {{ ref('stg_crm__companies') }} c
    join canonical k on k.company_id = c.company_id
    order by k.canonical_id, (c.company_id = k.canonical_id) desc  -- canonical's own record names the entity
),
resolution as (
    select * from {{ ref('identity_resolution') }}
),
external_only as (
    select r.resolved_entity_id as entity_id,
           max(coalesce(bc.name, st.company_name)) as entity_name,
           max(coalesce(bc.domain, st.domain))     as domain
    from resolution r
    left join {{ ref('stg_billing__customers') }} bc
      on r.source = 'billing' and bc.customer_id = r.source_entity_id
    left join (select distinct requester_id, company_name, domain from {{ ref('stg_support__tickets') }}) st
      on r.source = 'support' and st.requester_id = r.source_entity_id
    where r.matched_tier = 3
    group by r.resolved_entity_id
),
entities as (
    select entity_id, entity_name, domain, true as has_crm from crm_entities
    union all
    select entity_id, entity_name, domain, false from external_only
),
deals as (
    select k.canonical_id as entity_id,
           count(*) filter (where d.status = 'open')                    as open_deal_count,
           coalesce(sum(d.amount_cents) filter (where d.status = 'open'), 0) as open_deal_amount_cents
    from {{ ref('stg_crm__deals') }} d
    join canonical k on k.company_id = d.company_id
    group by k.canonical_id
),
billing_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as customer_id
    from resolution r where r.source = 'billing'
),
billing as (
    select bl.entity_id,
           coalesce(sum(i.amount_cents), 0)                                    as total_invoiced_cents,
           coalesce(sum(i.amount_cents) filter (where i.status = 'paid'), 0)   as total_paid_cents,
           count(distinct i.invoice_id) filter (where i.status = 'created')    as open_invoice_count
    from billing_link bl
    left join {{ ref('stg_billing__invoices') }} i on i.customer_id = bl.customer_id
    group by bl.entity_id
),
payments as (
    select bl.entity_id, count(*) filter (where p.status = 'failed') as failed_payment_count
    from billing_link bl
    join {{ ref('stg_billing__payments') }} p on p.customer_id = bl.customer_id
    group by bl.entity_id
),
support_link as (
    select r.resolved_entity_id as entity_id, r.source_entity_id as requester_id
    from resolution r where r.source = 'support'
),
support as (
    select sl.entity_id,
           count(*) filter (where t.status = 'open')   as open_ticket_count,
           count(*) filter (where t.status = 'solved') as solved_ticket_count,
           count(*) filter (where t.status = 'solved' and t.solved_at > t.sla_due_at) as sla_breach_count
    from support_link sl
    join {{ ref('stg_support__tickets') }} t on t.requester_id = sl.requester_id
    group by sl.entity_id
),
csat as (
    select sl.entity_id, avg(c.score)::numeric(3,2) as avg_csat
    from support_link sl
    join {{ ref('stg_support__tickets') }} t on t.requester_id = sl.requester_id
    join {{ ref('stg_support__csat') }} c on c.ticket_id = t.ticket_id
    group by sl.entity_id
)
select
    e.entity_id,
    e.entity_name,
    e.domain,
    e.has_crm,
    (b.entity_id is not null or p.entity_id is not null) as has_billing,
    (s.entity_id is not null)                            as has_support,
    e.has_crm                                            as is_complete,
    coalesce(d.open_deal_count, 0)         as open_deal_count,
    coalesce(d.open_deal_amount_cents, 0)  as open_deal_amount_cents,
    coalesce(b.total_invoiced_cents, 0)    as total_invoiced_cents,
    coalesce(b.total_paid_cents, 0)        as total_paid_cents,
    coalesce(b.open_invoice_count, 0)      as open_invoice_count,
    coalesce(p.failed_payment_count, 0)    as failed_payment_count,
    coalesce(s.open_ticket_count, 0)       as open_ticket_count,
    coalesce(s.solved_ticket_count, 0)     as solved_ticket_count,
    coalesce(s.sla_breach_count, 0)        as sla_breach_count,
    c.avg_csat
from entities e
left join deals d    on d.entity_id = e.entity_id
left join billing b  on b.entity_id = e.entity_id
left join payments p on p.entity_id = e.entity_id
left join support s  on s.entity_id = e.entity_id
left join csat c     on c.entity_id = e.entity_id
```

`marts/schema.yml`: `entity_id` `[unique, not_null]` (D6: mart uniqueness keys on the resolved entity id); `is_complete` `[not_null]`.

`warehouse/tests/assert_incomplete_rows_flagged.sql`:
```sql
-- D6: an entity with no CRM presence must exist in the mart AND be flagged incomplete.
select entity_id from {{ ref('customer_360') }} where not has_crm and is_complete
union all
select entity_id from {{ ref('customer_360') }} where has_crm and not is_complete
```

`scripts/verify-identity.ts` — the manifest-expectations oracle, run after dbt in demo (and CI, Task 11). Imports use the same relative-path exemption ingest tests use for mock code (script/test code, not shipped src):
```ts
import pg from "pg";
import { generateManifest } from "../mocks/core/src/manifest.js";

const SCHEMA = process.env.DBT_SCHEMA ?? "public_analytics";
const m = generateManifest();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let failures = 0;
const fail = (msg: string) => { failures++; console.error(`FAIL: ${msg}`); };
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

async function main() {
  // 1. Merge collapse: 22 staged companies → 20 canonical entities; merged ids absent from the mart.
  const canon = await pool.query(`select count(distinct canonical_id)::int as n from ${SCHEMA}.int_crm__canonical_companies where not is_cycle`);
  if (canon.rows[0].n !== m.expectations.canonicalCompanyCount)
    fail(`canonical companies: expected ${m.expectations.canonicalCompanyCount}, got ${canon.rows[0].n}`);
  for (const p of m.expectations.mergePairs) {
    const gone = await pool.query(`select 1 from ${SCHEMA}.customer_360 where entity_id = $1`, [p.from_id]);
    if (gone.rowCount !== 0) fail(`merged-away ${p.from_id} still has a mart row`);
    const there = await pool.query(`select 1 from ${SCHEMA}.customer_360 where entity_id = $1`, [p.to_id]);
    if (there.rowCount !== 1) fail(`canonical ${p.to_id} missing from mart`);
  }
  // 2. Re-pointed history: no open deal is lost to the collapse (conservation across the mapping).
  const stagedOpen = await pool.query(`select count(*)::int as n from ${SCHEMA}.stg_crm__deals where status = 'open'`);
  const martOpen = await pool.query(`select coalesce(sum(open_deal_count), 0)::int as n from ${SCHEMA}.customer_360`);
  if (stagedOpen.rows[0].n !== martOpen.rows[0].n)
    fail(`open-deal conservation: staging ${stagedOpen.rows[0].n} != mart ${martOpen.rows[0].n}`);
  // 3. Tier assignments match the planned matrix exactly (per source).
  for (const source of ["billing", "support"] as const) {
    for (const [tier, expected] of [[1, m.expectations.tier1[source]], [2, m.expectations.tier2[source]], [3, m.expectations.manualReview[source]]] as const) {
      const got = await pool.query(
        `select source_entity_id as id from ${SCHEMA}.identity_resolution where source = $1 and matched_tier = $2`,
        [source, tier],
      );
      const gotIds = ids(got.rows); const want = [...expected].sort();
      if (JSON.stringify(gotIds) !== JSON.stringify(want))
        fail(`${source} tier ${tier}: expected ${JSON.stringify(want)}, got ${JSON.stringify(gotIds)}`);
    }
  }
  // 4. manual_review holds exactly the planned tier-3 population.
  const mr = await pool.query(`select source_entity_id as id from ${SCHEMA}.manual_review`);
  const wantMr = [...m.expectations.manualReview.billing, ...m.expectations.manualReview.support].sort();
  if (JSON.stringify(ids(mr.rows)) !== JSON.stringify(wantMr))
    fail(`manual_review: expected ${JSON.stringify(wantMr)}, got ${JSON.stringify(ids(mr.rows))}`);
  // 5. D6: unmatchable billing entities appear in the mart, flagged incomplete.
  for (const id of m.expectations.manualReview.billing.slice(1)) { // B-0015, B-0016 (B-0014 is the near-miss with a CRM-name twin — still tier 3, still incomplete)
    const row = await pool.query(`select is_complete from ${SCHEMA}.customer_360 where entity_id = $1`, [`billing:${id}`]);
    if (row.rowCount !== 1) { fail(`incomplete entity billing:${id} missing from mart`); continue; }
    if (row.rows[0].is_complete !== false) fail(`billing:${id} should be flagged incomplete`);
  }
  // 6. Cross-system entities carry data from all three sources.
  for (const id of m.expectations.crossSystemCompanyIds) {
    const row = await pool.query(`select has_crm, has_billing, has_support from ${SCHEMA}.customer_360 where entity_id = $1`, [id]);
    if (row.rowCount !== 1 || !(row.rows[0].has_crm && row.rows[0].has_billing && row.rows[0].has_support))
      fail(`${id} should be present in all three systems`);
  }
  await pool.end();
  if (failures > 0) { console.error(`verify-identity: ${failures} failure(s)`); process.exit(1); }
  console.log("PASS: identity resolution matches the seeded manifest expectations");
}
main().catch((err) => { console.error(err); process.exit(1); });
```

`demo.sh`: after the `dbt build` step, add:
```bash
echo "5b/6 verify identity resolution against the seed manifest"
npx tsx scripts/verify-identity.ts
```

- [ ] **Step 1 (RED): oracle first** — write `verify-identity.ts` and the mart `schema.yml` + singular test; run `npx tsx scripts/verify-identity.ts` (with Task 9's dbt state in the dev DB) → FAIL (`customer_360` relation does not exist). That's the red.
- [ ] **Step 2: Write `customer_360.sql`** + `dbt_project.yml` marts block.
- [ ] **Step 3 (GREEN):** `docker compose run --rm dbt build` → mart + tests PASS; `npx tsx scripts/verify-identity.ts` → `PASS: identity resolution matches the seeded manifest expectations`. If any tier assertion fails, the bug is in Task 9's SQL or the manifest — fix there, not by loosening the oracle.
- [ ] **Step 4: Full regression** — `npm test` + `npm run typecheck` + `./scripts/demo.sh` (now including the verify step) + `./scripts/chaos.sh` → PASS. This is the amendment §3 exit: dupe metric (22→20) and tier provenance are now *measured* outputs.
- [ ] **Step 5: Commit**

```bash
git add warehouse scripts/verify-identity.ts scripts/demo.sh
git commit -m "feat: customer_360 mart keyed on resolved entities with incomplete flags (D6) + manifest oracle"
```

---

### Task 11: GitHub Actions CI (D11) — per-push suite + nightly/manual chaos

Per-push: typecheck + all workspace suites + dbt build/tests + the action-safety eval, against a Postgres service container. Chaos + demo: nightly + manual dispatch + on-label, with the fault-plan seed as a workflow input, surfaced in the README. The demo needs no API secret: `AnthropicLlm` falls back to `TemplateLlm` (Phase 1 Task 9c), so fork PRs and secretless runs stay green — the existing eval-split rationale holds.

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/chaos.yml`, `scripts/ci-fixture.ts`
- Modify: `warehouse/profiles.yml` (parametrize port), `scripts/chaos.sh` (CHAOS_SEED already added in Task 7 — verify), `README.md` (badges)

**Interfaces:**

`warehouse/profiles.yml` port line becomes (local docker network keeps hitting 5432 by default; CI sets `DBT_PORT=5433` to reach the service container through the host mapping):
```yaml
      port: "{{ env_var('DBT_PORT', '5432') | as_number }}"
```

`scripts/ci-fixture.ts` — a faultless, in-process, docker-free pipeline seed so per-push dbt tests run against REAL pipeline output (not hand-inserted rows). Direct-ingest mode (no pg-boss) keeps it fast and deterministic; the chaos workflow covers the queue path. Same relative-import exemption as `verify-identity.ts`:
```ts
import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";
import { getPool } from "../ingest/src/db.js";
import { runMigrations } from "../ingest/src/migrate.js";
import { createIngestApp } from "../ingest/src/server.js";
import { catchUp } from "../ingest/src/backfill.js";
import { createCrmApp } from "../mocks/crm/src/server.js";
import { createBillingApp } from "../mocks/billing/src/server.js";
import { createSupportApp } from "../mocks/support/src/server.js";

// Counts chosen for full entity coverage (see Task 7's demo rationale):
const COUNTS = { crm: 80, billing: 100, support: 80 } as const;

async function main() {
  const pool = getPool();
  await runMigrations(pool);
  await pool.query("truncate table raw.raw_events, ingest.outbox, ingest.quarantine restart identity");
  await pool.query("delete from ingest.cursors");
  rmSync("out/ci", { recursive: true, force: true });
  mkdirSync("out/ci", { recursive: true });

  const ingestSrv = createIngestApp(pool).listen(0); // no enqueue → direct synchronous ingest
  const ingestPort = (ingestSrv.address() as { port: number }).port;

  const apps = {
    crm: createCrmApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/crm`, ledgerPath: "out/ci/ledger-crm.jsonl" }),
    billing: createBillingApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/billing`, ledgerPath: "out/ci/ledger-billing.jsonl" }),
    support: createSupportApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/support`, ledgerPath: "out/ci/ledger-support.jsonl" }),
  } as const;

  for (const [source, app] of Object.entries(apps)) {
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: COUNTS[source as keyof typeof COUNTS] }),
    });
    if (!res.ok) throw new Error(`simulate ${source} failed: ${res.status}`);
    // Poll path exercised too (idempotent overlap with the push deliveries above):
    await catchUp(pool, source, `http://127.0.0.1:${port}`);
    srv.close();
  }
  ingestSrv.close();

  const n = await pool.query("select source, count(*)::int as n from raw.raw_events group by source order by source");
  const expected = [["billing", COUNTS.billing], ["crm", COUNTS.crm], ["support", COUNTS.support]];
  const got = n.rows.map((r) => [r.source, r.n]);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    throw new Error(`fixture counts mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  await pool.end();
  console.log("PASS: ci fixture seeded", got);
}
main().catch((err) => { console.error(err); process.exit(1); });
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on:
  push:
  pull_request:
jobs:
  suite:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: switchboard
          POSTGRES_PASSWORD: switchboard
          POSTGRES_DB: switchboard
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U switchboard"
          --health-interval 2s --health-timeout 2s --health-retries 15
    env:
      DATABASE_URL: postgres://switchboard:switchboard@localhost:5433/switchboard
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: typecheck
        run: npm run typecheck
      - name: migrate
        run: npm run migrate -w ingest
      - name: workspace test suites
        run: npm test
      - name: action-safety eval (gating, deterministic)
        run: npm test -w agent -- action-safety.eval.test.ts
      - name: seed pipeline fixture for dbt
        run: npx tsx scripts/ci-fixture.ts
      - name: dbt build + data tests
        run: |
          pip install dbt-postgres==1.11.0
          cd warehouse && dbt build --profiles-dir .
        env:
          DBT_HOST: localhost
          DBT_PORT: "5433"
      - name: verify identity resolution against manifest
        run: npx tsx scripts/verify-identity.ts
```

`.github/workflows/chaos.yml`:
```yaml
name: chaos
on:
  schedule:
    - cron: "17 9 * * *"   # nightly
  workflow_dispatch:
    inputs:
      fault_seed:
        description: "mulberry32 fault-plan seed (reproduce a red run by re-entering its seed)"
        default: "7"
        required: false
  pull_request:
    types: [labeled]
jobs:
  chaos-and-demo:
    if: github.event_name != 'pull_request' || github.event.label.name == 'run-chaos'
    runs-on: ubuntu-latest   # docker + compose v2 preinstalled; scripts manage their own postgres
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - name: chaos reconciliation (seeded fault plan)
        run: CHAOS_SEED="${{ github.event.inputs.fault_seed || '7' }}" ./scripts/chaos.sh
      - name: end-to-end demo (template-LLM fallback, no secret needed)
        run: ./scripts/demo.sh
```

`README.md`: badges at the top —
```markdown
![ci](https://github.com/OWNER/switchboard/actions/workflows/ci.yml/badge.svg)
![chaos](https://github.com/OWNER/switchboard/actions/workflows/chaos.yml/badge.svg)
```
plus one sentence under "What's built": "The `chaos` badge is a nightly run of the seeded-fault reconciliation proof (zero lost events across three sources) — red runs are reproducible by re-dispatching the workflow with the failing seed." (`OWNER` = the actual GitHub owner at push time — the implementer substitutes the real remote path from `git remote get-url origin`; this repo may still be local-only, in which case the badges are added with the intended owner and verified at first push.)

**Workflow YAML is TDD-exempt; its behavior is verified by execution:**

- [ ] **Step 1: Local rehearsal of the CI recipe** (catches recipe bugs before YAML): with local Postgres up —
```bash
npm ci && npm run typecheck && npm run migrate -w ingest && npm test \
  && npx tsx scripts/ci-fixture.ts \
  && (cd warehouse && DBT_HOST=localhost DBT_PORT=5433 dbt build --profiles-dir .) \
  && npx tsx scripts/verify-identity.ts
```
  (Install `dbt-postgres==1.11.0` into a throwaway venv for the rehearsal, or substitute `docker compose run --rm dbt build` for the dbt line — the CI YAML itself is verified on GitHub.) Expected: every stage green, fixture prints `PASS: ci fixture seeded …`.
- [ ] **Step 2: Write** `ci-fixture.ts`, both workflows, the profiles.yml port change, README badges.
- [ ] **Step 3: Verify locally** — `npm test` + typecheck still green; `docker compose run --rm dbt build` still green (profiles change must not break the sidecar — its default port stays 5432); `./scripts/chaos.sh` + `./scripts/demo.sh` green.
- [ ] **Step 4 (execution verification, on push):** when the controller pushes the branch, confirm on GitHub: `ci` workflow green end-to-end; `chaos` workflow green via a manual `workflow_dispatch` with `fault_seed=7` AND a second dispatch with a different seed (e.g. 11) to prove the input is live. If the repo is not yet on GitHub, this step is explicitly deferred to the controller with the note recorded in the journal.
- [ ] **Step 5: Commit**

```bash
git add .github scripts/ci-fixture.ts warehouse/profiles.yml README.md
git commit -m "feat: per-push CI (suite+dbt+eval on Postgres service) and nightly/manual chaos workflow (D11)"
```

---

### Task 12 (controller): docs pack

**Files:**
- Create: `docs/adr/identity-resolution.md`, `docs/log/phase2a.md`
- Modify: `README.md`, `RUNBOOK.md`, `docs/real-connector-delta.md`

Content requirements:
- `docs/adr/identity-resolution.md`: the three deterministic tiers and why no ML/fuzzy scoring (record-linkage literature cited as the "at scale" comparison, per the original spec §3 Layer 2); merge design (immutable derived `merge_edges`, mart-time-only resolution, batch-recompute-over-full-history property, cycle guard + termination tests, unmerge explicitly out of scope per D5); provenance columns as the auditability deliverable; **the D13 line verbatim in spirit:** `manual_review` and the (Phase 3) approval table are Switchboard *operational* state, not a system of record — Switchboard reads from, never masters, customer data.
- `README.md` "What's built": present tense only for what now exists — multi-source spine (single `raw.raw_events`, per-source HMAC/queues/cursors/DLQs), three mock sources off one correlated manifest, 3-tier identity resolution with provenance + merge collapse, `customer_360` with incomplete-flagging, CI badges (from Task 11). Measured-results table gains: seeded duplicate rate 22→20 canonical (dbt-verified), identity-tier counts (from `verify-identity.ts` output). No fabricated deltas; every number is a script output.
- `RUNBOOK.md`: new env vars (`WEBHOOK_SECRET_CRM/_BILLING/_SUPPORT`, `INGEST_SOURCES`, `LEDGER_PATH_<SOURCE>`, `CHAOS_SEED`, `DBT_PORT`, ports 4003/4004), per-source DLQ/backfill/reconcile CLI usage, manual_review triage flow (inspect → fix mapping or accept → future phase handles disposition).
- `docs/real-connector-delta.md`: add a short "identity at width" paragraph — real merges arrive via vendor merge webhooks/audit APIs; the delta list gains per-source secret rotation.
- `docs/log/phase2a.md`: planned-vs-actual journal entry (include the Task 1 migration decision and the chaos-guard evidence).

- [ ] Write all five; `npm test` + typecheck + `./scripts/demo.sh` + `./scripts/chaos.sh` one final time; commit:
```bash
git add docs README.md RUNBOOK.md
git commit -m "docs: phase 2a — identity-resolution ADR, README width results, runbook + journal"
```

---

## Self-Review Notes

**Spec coverage (amendment §3 as corrected by §8):**
- Spine generalization (D1): Tasks 1–3; chaos green at Task 1/3 boundaries *before* new sources exist (Task 3 Step 5 is the explicit gate); estimate honesty (3–4 weekends) reflected in 12 tasks.
- Single raw table + `(source, event_id)` uniqueness (D2): Task 1 (migration test asserts cross-source same-event_id coexistence).
- Per-source HMAC secrets (D3): Task 2 (billing-signed-with-crm-secret rejection test).
- Billing + support mocks, current webhook+ledger shape (§3): Tasks 6–7 via the Task 4 shared core; ledger-never-faulted asserted per-source (Task 6 Step 1).
- Correlated seed manifest w/ planned matrix + `contacts` + stubbed `profile` (D4): Task 5 (classification-exhaustiveness test pins every entity to exactly one expectation bucket).
- 3-tier resolution + merge handling + provenance + manual_review-not-a-seed + cycle/termination dbt tests + unmerge out of scope (D5, §3): Task 9; TS RED via naive one-hop; dbt singular-test failure demonstrated with a live cycle injection.
- `customer_360` incomplete-flagged grain (D6, §3): Task 10 (+ singular test both directions of the flag).
- Provenance auditability (§3): `matched_tier` + `match_evidence` + `merge_path` columns, verified by the oracle.
- CI (D11): Task 11 — per-push suite/dbt/eval on a service container; chaos+demo nightly/dispatch/label with seed input; README badge surfacing.
- D13 positioning line: Task 12 ADR.
- Explicitly NOT planned (2b/later per §2/§8): vendor-faithful shapes, hydration (D7), Service Cloud/event bus (D8, D12), CRM-mock retirement (D9), vertical content (D10 — only the seam ships, throwing on non-generic), OAuth.

**Placeholder scan:** no TBDs; the two "same skeleton" staging models (deals/payments/csat) name their exact filters and columns; Task 3's second queue test states its full construction recipe from the named existing pattern in the same file; Task 4's `paginate` is an explicit verbatim move, not an omission.

**Type consistency spot-checks:** `SourceEvent` renamed once (Task 1) and used by Tasks 2–3 signatures; `ingestEvent(pool, source, event)` arity consistent across server/queue/backfill/quarantine/replay; `enqueueEvent(boss, source, event)` (Task 3) matches `main.ts` wiring; `Source`/`SOURCES`/`enabledSources`/`baseUrlFor`/`ledgerPathFor` all from `ingest/src/sources.ts`; mock factories all take `{ webhookUrl, ledgerPath, seed? }`; `resolution_key = source || ':' || source_entity_id` consistent between `identity_resolution`, `manual_review`, and `verify-identity.ts`'s `billing:<id>` lookups; `demo-secret-<source>` convention shared by both `secretForSource` copies (sync comments in both).

**Known deliberate judgment calls (flagged for the controller):**
1. **Copy-then-drop migration** (not a compatibility view, not re-seed-only): chaos re-seeds anyway, but the copy keeps the migration lossless and the dev DB continuous; the old table is dropped to prevent a stale shadow copy. The 001-recreates/003-redrops quirk of the tracking-less migration runner is documented in Task 1 and is idempotent by construction.
2. **Per-source pg-boss queues** (vs one queue with `source` in the payload): chosen for poison isolation and per-source DLQ visibility; costs 6 queue objects and an aggregated `fetchDlq`.
3. **CRM ledger file renamed** to `out/ledger-crm.jsonl` in Task 7 for symmetry — a cosmetic break with Phase 1 paths, swept through all three scripts in the same task.
4. **`company.merged` at fixed script indices 45–46**: guarantees demo coverage but couples the script to the 4-slot cycle; documented inline.

