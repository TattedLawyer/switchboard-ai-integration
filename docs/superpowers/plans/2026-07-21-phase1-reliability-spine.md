# Switchboard Phase 1 — Reliability Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under a seeded fault plan (dropped webhooks, duplicate deliveries, API 429s), the pipeline loses zero events — proven by a reconciliation test (`./scripts/chaos.sh`) that compares the mock's append-only ledger against the raw tables, with an empty DLQ and empty quarantine at the end.

**Architecture (the zero-loss story):** the webhook **push path** is best-effort (pg-boss queue with retries → DLQ); the cursor-driven **poll path** (`GET /events` backfill) guarantees recovery of anything the push path lost; **idempotency** (unique event_id + ON CONFLICT DO NOTHING, outbox written in the same transaction) makes the two paths safely overlap; **quarantine** preserves unparseable payloads instead of dropping them. The ledger stays the oracle: written before any delivery attempt, never faulted.

**Tech Stack additions:** pg-boss (Postgres-backed queue — provides scheduling/retry/backoff/DLQ mechanics per the spec's build-vs-buy line; idempotency/outbox/cursors/replay-CLI/quarantine stay hand-built).

## Global Constraints

- **TDD mandatory** for production code; config/migrations SQL are TDD-exempt but their *behavior* is asserted by integration tests.
- **The ledger is never faulted.** Fault injection applies to delivery and API responses only; `appendToLedger` before delivery attempt stays inviolate (it is the oracle).
- **Determinism:** all fault decisions come from `mulberry32(plan.seed)` (reuse the exported `prng` from `mocks/crm/src/seed.ts` — export it if not already). Same plan → same faults.
- **Test isolation (standing convention from Phase 0 final review):** DB-touching ingest tests use a dedicated **database** `switchboard_test` (created fresh per test file via the Task 3 helper), NOT the dev `switchboard` DB, and NOT `truncate` on shared tables. Agent tests keep their dedicated-schema pattern.
- Postgres on host port 5433; `DATABASE_URL=postgres://switchboard:switchboard@localhost:5433/switchboard`. Docker via colima is available in implementer sandboxes.
- Express 5, vitest 4, zod 3 — match existing workspace majors. New dep pg-boss: run `npm view pg-boss version` and skim its README after install; the plan's pg-boss calls are an **authorized adaptation zone** (API names move between majors) — the BEHAVIORAL contracts in tests are fixed.
- Commit after every green cycle, only the files each task lists; nothing under `.superpowers/`; no secrets.
- **No scope creep** (Michael's directive: stick to the plan): no vendor-faithful API rework, no seed profiles, no observability — those are later phases/amendments.

## File Structure

```
mocks/crm/src/faults.ts        ← fault-plan module (Task 2)
mocks/crm/src/ledger.ts        ← MODIFY: entries gain seq (Task 1)
mocks/crm/src/server.ts        ← MODIFY: GET /events (Task 1); fault-aware /simulate + /events (Task 2)
ingest/migrations/002_reliability.sql  ← unique event_id, outbox, cursors, quarantine (Task 3)
ingest/test/helpers/testdb.ts  ← fresh switchboard_test DB helper (Task 3)
ingest/src/ingest-event.ts     ← idempotent tx: raw + outbox (Task 3)
ingest/src/quarantine.ts       ← quarantine insert + replay fn (Task 4)
ingest/src/server.ts           ← MODIFY: validate → enqueue | quarantine (Task 4/5)
ingest/src/queue.ts            ← pg-boss wiring: queues, worker, DLQ (Task 5)
ingest/src/backfill.ts         ← pollOnce + catch-up loop (Task 6)
ingest/src/cli/replay.ts       ← DLQ list/retry/purge CLI (Task 7)
ingest/src/cli/reconcile.ts    ← ledger vs raw comparison, exit code (Task 8)
ingest/src/main.ts             ← MODIFY: start worker + scheduled backfill (Task 5/6)
scripts/chaos.sh               ← chaos run + reconciliation exit criterion (Task 8)
```

---

### Task 1: Mock events feed (the poll path's source)

**Files:**
- Modify: `mocks/crm/src/ledger.ts`, `mocks/crm/src/server.ts`
- Test: `mocks/crm/test/events-feed.test.ts`

**Interfaces:**
- `LedgerEntry` gains `seq: number` (monotonic, 1-based, assigned at append). `appendToLedger(path, entry)` unchanged signature — caller supplies seq (server owns the counter it already has).
- New endpoint `GET /events?after=<seq>&limit=<n>` → `{ events: LedgerEntry[], last_seq: number }` — events with `seq > after`, ordered by seq, max `limit` (default 50, clamp 1..200); `last_seq` = highest seq in the returned page (or `after` when empty). Source: the ledger file (the mock's own source of truth).

- [ ] **Step 1: Write the failing test**

`mocks/crm/test/events-feed.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import { createCrmApp } from "../src/server.js";

let dir: string; let sink: Server; let sinkUrl: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "crm-feed-"));
  const app = express(); app.use(express.json());
  app.post("/hook", (_req, res) => res.sendStatus(200));
  await new Promise<void>((r) => { sink = app.listen(0, () => r()); });
  sinkUrl = `http://127.0.0.1:${(sink.address() as { port: number }).port}/hook`;
});
afterEach(() => { sink.close(); rmSync(dir, { recursive: true, force: true }); });

describe("GET /events", () => {
  it("pages ledgered events by seq cursor", async () => {
    const crm = createCrmApp({ webhookUrl: sinkUrl, ledgerPath: join(dir, "l.jsonl") });
    const srv = crm.listen(0);
    const port = (srv.address() as { port: number }).port;
    await fetch(`http://127.0.0.1:${port}/simulate`, { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 12 }) });
    const p1 = await (await fetch(`http://127.0.0.1:${port}/events?after=0&limit=5`)).json();
    expect(p1.events).toHaveLength(5);
    expect(p1.events[0].seq).toBe(1);
    expect(p1.last_seq).toBe(5);
    const p2 = await (await fetch(`http://127.0.0.1:${port}/events?after=${p1.last_seq}&limit=50`)).json();
    expect(p2.events).toHaveLength(7);
    expect(p2.events.map((e: { seq: number }) => e.seq)).toEqual([6,7,8,9,10,11,12]);
    expect(p2.last_seq).toBe(12);
    const p3 = await (await fetch(`http://127.0.0.1:${port}/events?after=12`)).json();
    expect(p3.events).toHaveLength(0);
    expect(p3.last_seq).toBe(12);
    srv.close();
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -w mocks/crm` → FAIL (`seq` undefined / 404 on /events).
- [ ] **Step 3: Implement** — in `ledger.ts` add `seq: number` to `LedgerEntry`. In `server.ts`: include `seq: ++seq`-style value in each emitted entry (reuse the existing counter so event_id `evt-N` and seq N stay aligned), and add:
```ts
app.get("/events", (req, res) => {
  const after = Math.max(0, Number(req.query.after ?? 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(req.query.limit ?? 50) || 50));
  const all = readLedger(opts.ledgerPath);
  const events = all.filter((e) => e.seq > after).slice(0, limit);
  const last_seq = events.length ? events[events.length - 1].seq : after;
  res.json({ events, last_seq });
});
```
- [ ] **Step 4: Verify pass** — full mocks/crm suite green (existing ledger-ordering test updated only if seq addition broke equality assertions — adjust minimally).
- [ ] **Step 5: Commit** — `git add mocks/crm && git commit -m "feat: seq-cursored GET /events feed backed by ledger"`

---

### Task 2: Deterministic fault injection

**Files:**
- Create: `mocks/crm/src/faults.ts`
- Modify: `mocks/crm/src/server.ts`, `mocks/crm/src/seed.ts` (export `prng` if not exported)
- Test: `mocks/crm/test/faults.test.ts`

**Interfaces:**
```ts
export type FaultPlan = { seed: number; dropRate: number; dupRate: number; apiErrorRate: number };
export type DeliveryFate = "deliver" | "drop" | "duplicate";
export function createFaultInjector(plan?: FaultPlan): {
  deliveryFate(): DeliveryFate;   // no plan → always "deliver"
  apiShouldFail(): boolean;       // no plan → always false
}
```
- `POST /simulate` body gains optional `fault_plan: FaultPlan` (zod: seed int, rates 0..1). A new injector is created per simulate call. Fates: roll r = rand(); r < dropRate → drop; else r < dropRate+dupRate → duplicate; else deliver.
- Semantics in the emit loop: **ledger append always happens first, regardless of fate.** drop → skip delivery entirely (no fetch, still counts in ledger, NOT in `emitted`); duplicate → deliver twice (emitted counts 1); deliver → once. Response gains `{ emitted, dropped, duplicated }`.
- `GET /events` consults a **server-level injector** set by the most recent `/simulate` with a plan: `apiShouldFail()` → respond `429 { error: "rate limited" }`. No plan → never fails.

- [ ] **Step 1: Failing tests**

`mocks/crm/test/faults.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { createFaultInjector } from "../src/faults.js";

describe("fault injector", () => {
  it("is deterministic for the same seed", () => {
    const a = createFaultInjector({ seed: 7, dropRate: 0.3, dupRate: 0.2, apiErrorRate: 0.5 });
    const b = createFaultInjector({ seed: 7, dropRate: 0.3, dupRate: 0.2, apiErrorRate: 0.5 });
    const fatesA = Array.from({ length: 50 }, () => a.deliveryFate());
    const fatesB = Array.from({ length: 50 }, () => b.deliveryFate());
    expect(fatesA).toEqual(fatesB);
    expect(new Set(fatesA)).toEqual(new Set(["deliver", "drop", "duplicate"]));
  });
  it("without a plan never faults", () => {
    const inj = createFaultInjector();
    expect(Array.from({ length: 20 }, () => inj.deliveryFate()).every((f) => f === "deliver")).toBe(true);
    expect(inj.apiShouldFail()).toBe(false);
  });
});
```
Plus an integration test in the same file (uses the sink harness pattern from Task 1's test): simulate `{count: 40, fault_plan: {seed: 7, dropRate: 0.25, dupRate: 0.25, apiErrorRate: 0}}` and assert: ledger has exactly 40 entries; received-webhook count = body.emitted + body.duplicated (dupes delivered twice); body.dropped > 0; body.emitted + body.dropped = 40; and received event_ids are a strict subset of ledger event_ids.

- [ ] **Step 2: Verify failure** → module not found.
- [ ] **Step 3: Implement** `faults.ts` (use exported `prng`); wire into `server.ts` per Interfaces. Keep the Phase 0 502-on-delivery-failure path: a *fetch rejection* is still a 502; a planned *drop* is not a failure.
- [ ] **Step 4: Verify pass** — full mocks/crm suite green, pristine.
- [ ] **Step 5: Commit** — `git commit -m "feat: seeded fault injection (drop/duplicate/429) in mock CRM"`

---

### Task 3: Idempotent ingest core + reliability schema + test-DB helper

**Files:**
- Create: `ingest/migrations/002_reliability.sql`, `ingest/src/ingest-event.ts`, `ingest/test/helpers/testdb.ts`
- Test: `ingest/test/ingest-event.test.ts`

**Interfaces:**
- Migration 002 (idempotent, safe on dirty Phase 0 data):
```sql
delete from raw.raw_crm_events a using raw.raw_crm_events b
  where a.event_id = b.event_id and a.id > b.id;
create unique index if not exists uq_raw_crm_events_event_id on raw.raw_crm_events (event_id);
create schema if not exists ingest;
create table if not exists ingest.outbox (
  id bigserial primary key, event_id text not null,
  created_at timestamptz not null default now(), processed_at timestamptz);
create table if not exists ingest.cursors (
  source text primary key, last_seq bigint not null default 0,
  updated_at timestamptz not null default now());
create table if not exists ingest.quarantine (
  id bigserial primary key, payload jsonb not null, reason text not null,
  received_at timestamptz not null default now(), replayed_at timestamptz);
```
- `ingestEvent(pool: pg.Pool, event: CrmEvent): Promise<"inserted" | "duplicate">` — one transaction: insert raw ON CONFLICT (event_id) DO NOTHING; iff inserted, insert outbox row; commit. On any error: rollback + rethrow. (`CrmEvent` = the zod-parsed shape from server.ts — export the type.)
- `freshTestDb(): Promise<pg.Pool>` in testdb.ts — connects to the `postgres` admin DB on :5433, `drop database if exists switchboard_test with (force)`, `create database switchboard_test`, returns a pool on `switchboard_test` with migrations run. Standing convention: every ingest DB test file uses this; never touch the dev DB.

- [ ] **Step 1: Failing tests**

`ingest/test/ingest-event.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { ingestEvent } from "../src/ingest-event.js";

let pool: pg.Pool;
beforeAll(async () => { pool = await freshTestDb(); });
afterAll(async () => { await pool.end(); });

const ev = (id: string) => ({ event_id: id, event_type: "company.updated",
  occurred_at: new Date().toISOString(), data: { id: "DEMO-C-0001", name: "DEMO X", domain: "x.example.com" } });

describe("ingestEvent", () => {
  it("inserts once and writes exactly one outbox row", async () => {
    expect(await ingestEvent(pool, ev("evt-1"))).toBe("inserted");
    expect(await ingestEvent(pool, ev("evt-1"))).toBe("duplicate");
    const raw = await pool.query("select count(*)::int as n from raw.raw_crm_events where event_id='evt-1'");
    const ob = await pool.query("select count(*)::int as n from ingest.outbox where event_id='evt-1'");
    expect(raw.rows[0].n).toBe(1);
    expect(ob.rows[0].n).toBe(1);
  });
  it("survives concurrent duplicate ingestion", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestEvent(pool, ev("evt-2"))));
    expect(results.filter((r) => r === "inserted")).toHaveLength(1);
    const raw = await pool.query("select count(*)::int as n from raw.raw_crm_events where event_id='evt-2'");
    expect(raw.rows[0].n).toBe(1);
  });
});
```

- [ ] **Step 2: Verify failure** → module not found.
- [ ] **Step 3: Implement** migration, testdb helper (admin URL derived from DATABASE_URL by swapping the db name), ingest-event.ts per Interfaces.
- [ ] **Step 4: Verify pass** — `DATABASE_URL=... npm test -w ingest` green (old integration test untouched for now; Task 4 migrates it).
- [ ] **Step 5: Commit** — `git commit -m "feat: idempotent ingestEvent with outbox; reliability schema; isolated test DB helper"`

---

### Task 4: Quarantine + receiver rewire (and migrate the old test off the dev DB)

**Files:**
- Create: `ingest/src/quarantine.ts`
- Modify: `ingest/src/server.ts`, `ingest/test/ingest.integration.test.ts`
- Test: `ingest/test/quarantine.test.ts`

**Interfaces:**
- `quarantineEvent(pool, payload: unknown, reason: string): Promise<void>` — inserts into ingest.quarantine.
- `replayQuarantined(pool, id: number, ingest: typeof ingestEvent): Promise<"replayed" | "still-invalid">` — re-validates the stored payload with the zod schema; valid → ingestEvent + set replayed_at; invalid → "still-invalid" (row untouched). This is the schema-drift recovery path: quarantine now, replay after a mapping fix.
- `createIngestApp(pool, opts?: { enqueue?: (event: CrmEvent) => Promise<void> })`:
  - invalid body → `quarantineEvent(..., "schema validation failed")` → **202** `{ quarantined: true }` (changed from Phase 0's 400 — never drop data; the sender did deliver it).
  - valid body → `opts.enqueue` if provided (Task 5 wires pg-boss), else direct `ingestEvent` → 202 `{ stored: true }`.
- Migrate `ingest.integration.test.ts` to `freshTestDb()` (remove the shared-DB truncate — Phase 0 final-review debt), and update its invalid-payload expectation to the new 202-quarantine contract if it asserted 400.

- [ ] **Step 1: Failing tests** — `quarantine.test.ts` (freshTestDb): POST an invalid body `{bogus: true}` to the app → expect 202 `{quarantined: true}`, quarantine row with reason; then `replayQuarantined` on it → "still-invalid"; insert a *valid-shaped* payload via `quarantineEvent` directly, replay → "replayed", raw row exists, replayed_at set.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify pass** — whole ingest suite green on isolated DBs (`grep -r "truncate raw" ingest/test` returns nothing).
- [ ] **Step 5: Commit** — `git commit -m "feat: quarantine with replay for invalid payloads; receiver never drops; tests off shared DB"`

---

### Task 5: pg-boss pipeline (push path: enqueue → worker → retry → DLQ)

**Files:**
- Create: `ingest/src/queue.ts`
- Modify: `ingest/package.json` (add pg-boss), `ingest/src/server.ts` main wiring in `ingest/src/main.ts`
- Test: `ingest/test/queue.test.ts`

**Interfaces (authorized adaptation zone — verify against installed pg-boss major; behavioral contract fixed):**
```ts
export const INGEST_QUEUE = "ingest-event";
export const INGEST_DLQ = "ingest-event-dlq";
export function createQueue(connectionString: string): Promise<PgBoss>          // started instance, queues created w/ DLQ relationship
export function enqueueEvent(boss: PgBoss, event: CrmEvent): Promise<void>      // retryLimit 5, exponential backoff (fast overrides injectable for tests)
export function startWorker(boss: PgBoss, pool: pg.Pool): Promise<void>        // work(INGEST_QUEUE) → ingestEvent; throw on failure so pg-boss retries
export function fetchDlq(boss: PgBoss, limit?: number): Promise<{ id: string; data: CrmEvent }[]>
```
Behavioral contract (what the tests pin): a job whose handler succeeds results in the raw row; a job whose handler always throws ends up fetchable from the DLQ after its retries are exhausted; retry options are injectable so tests run in seconds.

- [ ] **Step 1: Version check** — `npm view pg-boss version`, install, skim README for: constructor, `start`, queue creation + dead-letter option, `send` retry options, `work`, and how to read a queue without executing (fetch). Record findings in the report.
- [ ] **Step 2: Failing tests** — `queue.test.ts` (freshTestDb; pg-boss pointed at the same switchboard_test DB): (a) enqueue a valid event → startWorker → poll until raw row exists (bounded 10s) → assert row + outbox; (b) startWorker with a poisoned pool (a stub whose `connect` rejects) and tiny retry options → enqueue → poll until the job appears via `fetchDlq` (bounded 15s) → assert its `data.event_id` matches; assert raw table does NOT contain it.
- [ ] **Step 3: Verify failure.**
- [ ] **Step 4: Implement queue.ts; wire main.ts:** receiver constructs boss once, `createIngestApp(pool, { enqueue })`; worker started alongside. Keep a `--no-worker` env (`INGEST_ROLE=receiver|worker|all`, default `all`) so chaos scenarios can isolate roles later without new code.
- [ ] **Step 5: Verify pass** — ingest suite green, pristine (pg-boss logs silenced or asserted quiet).
- [ ] **Step 6: Commit** — `git commit -m "feat: pg-boss push pipeline with retry/backoff and dead-letter queue"`

---

### Task 6: Cursor backfill (poll path — the loss-recovery guarantee)

**Files:**
- Create: `ingest/src/backfill.ts`, `ingest/src/cli/backfill.ts`
- Modify: `ingest/src/main.ts` (scheduled backfill via pg-boss cron or interval — pick per installed pg-boss capability, record choice)
- Test: `ingest/test/backfill.test.ts`

**Interfaces:**
```ts
export const CRM_SOURCE = "crm";
export function pollOnce(pool: pg.Pool, baseUrl: string, opts?: { limit?: number }): Promise<{ ingested: number; duplicates: number; last_seq: number }>
// reads cursor row for CRM_SOURCE (0 if absent) → GET {baseUrl}/events?after=<cursor>&limit
// → ingestEvent each in order → advance cursor to last_seq ONLY after every event in the page ingested
// non-2xx (e.g. injected 429) → throw; cursor untouched
export function catchUp(pool: pg.Pool, baseUrl: string, opts?: { maxRounds?: number }): Promise<number>
// loops pollOnce (retrying thrown 429s with short backoff) until two consecutive empty pages; returns total ingested
```
CLI `ingest/src/cli/backfill.ts`: runs `catchUp` against `CRM_BASE_URL` env (default http://localhost:4001), prints summary, exits 0/1. package.json script: `"backfill": "tsx src/cli/backfill.ts"`.

- [ ] **Step 1: Failing tests** — `backfill.test.ts`: spin the real mock app (no sink needed — point its webhookUrl at a dead port so ALL push deliveries fail; faults optional) with `/simulate {count: 30}`; freshTestDb; `catchUp(pool, mockUrl)` → 30 ingested; raw count 30; cursor last_seq 30; run `catchUp` again → 0 new, all duplicates skipped idempotently. Second test: mock with `apiErrorRate: 1` for a single-round `pollOnce` → expect throw, cursor still 0.
- [ ] **Step 2: Verify failure.** — module not found.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify pass** — suite green.
- [ ] **Step 5: Commit** — `git commit -m "feat: cursor-driven backfill poller recovers dropped webhooks"`

---

### Task 7: DLQ replay CLI

**Files:**
- Create: `ingest/src/cli/replay.ts`
- Test: `ingest/test/replay.test.ts`

**Interfaces:**
- Core function (tested directly): `replayDlq(boss: PgBoss, pool: pg.Pool): Promise<{ replayed: number; failed: number }>` — fetch DLQ jobs, run each through `ingestEvent` (idempotent — safe if the job actually succeeded earlier), mark/complete the DLQ job on success.
- CLI: `npm run replay -w ingest` → prints DLQ depth, replays, prints result, exit 0 (or 1 if any failed). `npm run replay -w ingest -- --list` only lists.

- [ ] **Step 1: Failing test** — seed a DLQ job (reuse Task 5's poisoned-pool path or insert directly via pg-boss API), then `replayDlq` with a HEALTHY pool → `{replayed: 1, failed: 0}`; raw row now exists; DLQ empty on re-fetch.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3–4: Implement; verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat: DLQ replay CLI"`

---

### Task 8: Chaos reconciliation — the Phase 1 exit criterion

**Files:**
- Create: `ingest/src/cli/reconcile.ts`, `scripts/chaos.sh`
- Test: the scripts themselves are the test (RED first, then GREEN), plus `ingest/test/reconcile.test.ts` for the comparison logic

**Interfaces:**
- `reconcile(pool: pg.Pool, ledgerPath: string): Promise<{ ledger: number; raw: number; missing: string[]; extra: string[]; rawDuplicates: number }>` — set-compare distinct ledger event_ids vs raw event_ids.
- CLI `npm run reconcile -w ingest`: prints the report; exit 0 iff missing=[], extra=[], rawDuplicates=0; else exit 1 with the lists.
- `scripts/chaos.sh`: like demo.sh but: truncates raw+ingest state and ledger; starts services; `POST /simulate {count: 200, fault_plan: {seed: 7, dropRate: 0.2, dupRate: 0.15, apiErrorRate: 0.2}}`; waits for push-path settle; runs `npm run backfill -w ingest`; runs `npm run reconcile -w ingest`; also asserts quarantine count = 0 and DLQ depth = 0 (psql + replay --list); prints `PASS: zero lost events under injected faults` on success. Uses the bounded-wait pattern from demo.sh (no unbounded loops, no bare sleeps where a poll is possible).

- [ ] **Step 1: Unit-test reconcile()** (freshTestDb + a temp ledger file): ledger {evt-1..evt-5}, raw {evt-1..evt-4} → missing=[evt-5], exit-worthy; equal sets → clean.
- [ ] **Step 2: RED end-to-end proof** — run chaos.sh with the backfill step COMMENTED OUT (or `CHAOS_SKIP_BACKFILL=1` guard): reconcile must FAIL with missing events (proves the detector detects). Record the output in the report.
- [ ] **Step 3: GREEN** — full chaos.sh: PASS line, quarantine 0, DLQ 0. Run it TWICE to confirm repeatability (same seed → deterministic faults).
- [ ] **Step 4: Full repo suite** — `npm test` all workspaces + `npm run typecheck` + `./scripts/demo.sh` still passes (Phase 0 exit criterion must not regress).
- [ ] **Step 5: Commit** — `git commit -m "feat: chaos run with ledger reconciliation proves zero event loss"`

---

### Task 9: Deployment hardening (added 2026-07-21 from the deployment-readiness review — Michael approved "fold the cheap four")

**Files:**
- Modify: `mocks/crm/src/server.ts`, `mocks/crm/src/ledger.ts`, `mocks/crm/src/faults.ts`, `ingest/src/server.ts`, `agent/src/host/llm.ts`, `warehouse/models/staging/stg_crm__companies.sql`
- Test: `mocks/crm/test/hmac.test.ts`, `mocks/crm/test/ledger-chain.test.ts`, additions to `faults.test.ts`, `ingest/test/hmac-verify.test.ts`, `agent/test/llm-fallback.test.ts`

**9a — Webhook HMAC signing (finding: webhook spoofing).**
Mock signs every delivery: header `X-Switchboard-Signature: sha256=<hex hmac of raw body>` using shared secret env `WEBHOOK_SECRET` (default `demo-secret` — documented as demo-only). Ingest verifies before accepting: invalid/missing signature → 401 `{error:"invalid signature"}` (NOT quarantined — unauthenticated data is rejected, not preserved). Node `crypto.createHmac("sha256", secret)`; timing-safe compare via `crypto.timingSafeEqual`. Tests: valid signature → 202; tampered body → 401; missing header → 401. Backfill poll path is unaffected (it pulls; authenticity comes from the source URL — note this asymmetry in the code comment).

**9b — Out-of-order fault + event-time ordering (finding: stale-update-wins bug).**
`FaultPlan` gains `shuffleRate: number` (0..1, zod-validated). Events selected for shuffle are delivered AFTER the rest of the batch (delayed to end), so delivery order ≠ emission order; ledger keeps emission order (seq unchanged). Test: seeded plan with shuffleRate 0.5 → received event_id order ≠ ledger seq order; ledger complete.
dbt model ordering fix: latest-state now ordered by event time, not arrival:
```sql
order by payload -> 'data' ->> 'id',
         (payload ->> 'occurred_at') desc,
         (substring(event_id from 5))::bigint desc
```
(the evt-N ordinal is the deterministic tiebreak — also closes the Phase 0 tie-break Minor). dbt tests must still pass; add a dbt test or SQL assertion in the chaos flow proving a late-delivered stale update does NOT win.

**9c — LLM operational envelope (finding: no timeout/fallback/cost visibility).**
`AnthropicLlm.complete`: 30s timeout (`AbortSignal.timeout`), on ANY failure (timeout, API error) log a structured warning and fall back to `TemplateLlm` output — the Monday report must always generate. Log one structured line per LLM call: `{llm:"anthropic"|"template-fallback", input_tokens, output_tokens, duration_ms}` (usage from the SDK response; zeros for template). Test: stub client that rejects → complete() resolves with template output and logs fallback (inject the anthropic client for testability).

**9d — Ledger hash chain (finding: "tamper-evident" needs earning).**
`LedgerEntry` gains `prev_hash: string; hash: string` — `hash = sha256(prev_hash + canonical JSON of entry sans hash fields)`, genesis prev_hash = "0".repeat(64). `verifyLedgerChain(path): { ok: boolean; brokenAt?: number }` exported; reconcile CLI (Task 8) calls it and fails on a broken chain. Tests: chain verifies on a fresh ledger; manual tamper of line 2 → brokenAt 2. README may then honestly say "hash-chained, append-only" (docs task).

Each sub-feature is its own TDD cycle + commit (4 commits). Sub-features are independent — implement in order a→d.

---

### Task 10 (controller): docs — expanded with the review's docs pack

README "What's built" moves Phase 1 bullets to built (present tense only for what exists — include HMAC, hash chain, out-of-order); journal `docs/log/phase1.md`; progress ledger. PLUS the deployment-readiness docs pack:
- `docs/real-connector-delta.md` — what changes per layer against real HubSpot/Stripe/Zendesk (OAuth refresh, signature schemes, modified-since polling instead of the seq feed, rate-limit budgets, opaque cursors); the honest "zero-loss becomes bounded-staleness with detection" framing.
- `docs/gdpr-erasure-design.md` — tombstone events, crypto-shredding/hash-only ledger option, erasure sweep across raw/marts; explicitly a design note (not implemented; synthetic-only enforced by hygiene tests).
- `docs/scaling-ceilings.md` — where the architecture breaks (per-account LLM loop → SQL-side top-N; full dbt rebuild → incremental; single Postgres → partition/replica) with the build-vs-buy escalation (Temporal, warehouse-native).
- `RUNBOOK.md` — env vars, start/stop, backup (pg_dump + ledger), restore-by-replay (the ledger replay story the architecture already supports), DLQ replay, quarantine replay, common failures.

## Self-Review Notes

- Spec §6 Phase 1 coverage: faults+fault-plan seeds (T2), idempotency (T3), outbox (T3), cursors (T6), DLQ+replay (T5/T7), quarantine (T4), chaos reconciliation exit (T8). Backfill/events feed (T1/T6) is the mechanism that makes "zero lost events" achievable — implied by the spec's exit test.
- Deliberate contract change vs Phase 0: invalid webhook now 202+quarantine (was 400) — reviewers will flag it; it is intentional (never drop delivered data) and documented in T4.
- pg-boss API calls are an adaptation zone with a version-check step (same pattern that worked for the MCP SDK task).
- Type consistency: `CrmEvent` exported once (T3/T4), consumed by queue/backfill/replay; `LedgerEntry.seq` (T1) consumed by T6/T8.
