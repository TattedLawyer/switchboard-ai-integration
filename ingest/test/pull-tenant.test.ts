// CLOSE-3 fix round — the pull half of ingestion never received the deployment tenant.
//
// The lie this file kills: KNOWN-ISSUES said the configured tenant "is carried faithfully
// end to end", and the wave threaded it through the push doors, the queue envelope, the
// worker, the store and both replay paths — and stopped at the wiring seam. The service
// wiring, the backfill runner, the connector registry and every connector's catchUp fell
// back to DEFAULT_TENANT_ID, and nothing on the pull side read SWITCHBOARD_TENANT_ID at all.
//
// Why no existing test could see it: with the variable UNSET everything is the nil tenant on
// both halves, which is byte-identical to pre-wave behaviour. The defect only exists on a
// deployment that sets the variable the wave shipped and documented — and no test set it.
// So the pin is exactly that: a NON-DEFAULT configured tenant, driven through the REAL CLI
// entrypoints as a deployment would, asserting on STORED tenant_id.
//
// Two consequences it reproduces:
//   1. hubcrm hydration stops entirely and silently — the pump scans
//      `where r.tenant_id = <nil>` while the door writes the configured tenant, so it
//      matches nothing, forever, with no error.
//   2. backfill recovery splits into a second tenant lane — raw_events is unique on
//      (tenant_id, source, event_id), so an event the door stored under tenant X and the
//      poller later recovers under the nil tenant is TWO ROWS, not an absorbed duplicate.
//      The poller is precisely the path that exists to recover what the push path lost.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type express from "express";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { createHubcrmApp } from "../../mocks/hubcrm/src/index.js";
import { createBillingApp } from "../../mocks/billing/src/server.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));
/** A deliberately NON-default tenant: the whole point is that the default hides the defect. */
const TENANT_X = "33333333-3333-3333-3333-333333333333";
const NIL_TENANT = "00000000-0000-0000-0000-000000000000";

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
  dir = mkdtempSync(join(tmpdir(), "pull-tenant-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  await cleanup();
});

function listen(app: express.Express): string {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

/** Runs the REAL CLI as a deployment would: SWITCHBOARD_TENANT_ID set, nothing else special. */
function runBackfill(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli/backfill.ts"],
      {
        cwd: INGEST_DIR,
        timeout: 60_000,
        env: { ...process.env, DATABASE_URL: dbUrl, ALLOW_DEV_SECRETS: "1", ...env },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("the configured deployment tenant reaches the PULL half", () => {
  it("hubcrm: the hydration pump processes the rows the door wrote — it does not scan an empty nil-tenant lane", async () => {
    const hub = createHubcrmApp({ seed: 91 });
    const hubUrl = listen(hub.app);
    hub.store.simulate(6);

    // The door is configured for TENANT_X, exactly as a deployment with
    // SWITCHBOARD_TENANT_ID set would build it. Thin events land under TENANT_X.
    // The served set is DECLARED, not inherited from the workspace's INGEST_SOURCES
    // (cold review M2): this test is about hubcrm's tenant routing, so hubcrm is the
    // deployment, and a future narrowing of the workspace default cannot silently
    // change what this exercises.
    const doorUrl = listen(createIngestApp(pool, TENANT_X, { enabledSources: ["hubcrm"] }));
    const stats = await hub.store.deliver({ webhookUrl: `${doorUrl}/webhooks/hubcrm` });
    expect(stats.failedBatches).toBe(0);

    const thin = await pool.query(
      "select count(*)::int as n from raw.raw_events where source = 'hubcrm' and tenant_id = $1",
      [TENANT_X],
    );
    expect(thin.rows[0].n, "precondition: the door stored thin events under TENANT_X").toBeGreaterThan(0);

    // Now the pump, as the scheduled service and the CLI run it.
    const res = await runBackfill({
      SWITCHBOARD_TENANT_ID: TENANT_X,
      INGEST_SOURCES: "hubcrm",
      HUBCRM_BASE_URL: hubUrl,
    });
    expect(res.code, res.out).toBe(0);

    // THE ASSERTION. Before the fix this is 0: the pump scanned the nil tenant, found
    // nothing to hydrate, and reported a clean cycle.
    const hydrated = await pool.query(
      "select count(*)::int as n from ingest.hydrated_snapshots where tenant_id = $1",
      [TENANT_X],
    );
    expect(hydrated.rows[0].n, `pump hydrated nothing under TENANT_X. CLI said:\n${res.out}`).toBeGreaterThan(0);

    // And it must not have written a shadow lane under the nil tenant either.
    const shadow = await pool.query(
      "select count(*)::int as n from ingest.hydrated_snapshots where tenant_id = $1",
      [NIL_TENANT],
    );
    expect(shadow.rows[0].n).toBe(0);
  }, 90_000);

  it("ledger-feed: an event the door stored and the poller re-fetches is ONE row, not a second-lane duplicate", async () => {
    const ledgerPath = join(dir, "ledger-billing.jsonl");
    // The mock delivers to a black hole, so the push path is ours to drive by hand and the
    // pull path sees every event as un-ingested — the recovery shape this test is about.
    const billing = createBillingApp({ ledgerPath, webhookUrl: "http://127.0.0.1:1" });
    const billingUrl = listen(billing);
    await fetch(`${billingUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5 }),
    });

    // The door — configured for TENANT_X — stores the feed's events first, standing in for
    // the webhook deliveries a real vendor would have pushed.
    const feed = await (await fetch(`${billingUrl}/events?after=0&limit=50`)).json();
    const events = (feed.events ?? feed) as { event_id: string }[];
    expect(events.length).toBeGreaterThan(0);
    const { ingestEvent } = await import("../src/ingest-event.js");
    for (const e of events) {
      await ingestEvent(pool, "billing", e as never, { tenantId: TENANT_X });
    }

    const before = await pool.query(
      "select count(*)::int as n from raw.raw_events where source = 'billing'",
    );
    expect(before.rows[0].n).toBe(events.length);

    // The poller now recovers the same events. Under one configured tenant this must be a
    // no-op absorbed by (tenant_id, source, event_id) idempotency.
    const res = await runBackfill({
      SWITCHBOARD_TENANT_ID: TENANT_X,
      INGEST_SOURCES: "billing",
      BILLING_BASE_URL: billingUrl,
    });
    expect(res.code, res.out).toBe(0);

    // THE ASSERTION. Before the fix the poller wrote under the nil tenant, so every event
    // became a SECOND row — the uniqueness key is per tenant, so nothing collided.
    const after = await pool.query(
      "select tenant_id, count(*)::int as n from raw.raw_events where source = 'billing' group by 1 order by 1",
    );
    expect(
      after.rows,
      `raw.raw_events split across tenant lanes. CLI said:\n${res.out}`,
    ).toEqual([{ tenant_id: TENANT_X, n: events.length }]);

    // The cursor the poller advanced belongs to the same lane, or the next run re-splits.
    const cursor = await pool.query(
      "select tenant_id from ingest.cursors where source = 'billing'",
    );
    expect(cursor.rows.map((r) => r.tenant_id)).toEqual([TENANT_X]);
  }, 90_000);
});

// CLOSE-3 close-out — the regression the fix round introduced.
//
// The fix round re-keyed connectorForTenant's ledger-feed refusal on the --tenant FLAG
// (correctly: the refusal is about the multi-tenant question, not about the value). It
// left main()'s own copy of that gate keyed on the tenant VALUE. So on a deployment with
// SWITCHBOARD_TENANT_ID set, a bare `npm run reconcile` refuses and exits 1, quoting a
// --tenant flag the operator never passed.
//
// Blast radius is the reason this is not cosmetic: DEFAULT_ENABLED is ["billing",
// "support"], demo.sh enables support, chaos.sh enables billing,support — every one a
// ledger-feed source. The zero-loss surface is therefore DISABLED on exactly the
// deployments the tenant fix exists to serve.
describe("a configured deployment can still run its own reconcile", () => {
  function runReconcile(env: Record<string, string>): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "src/cli/reconcile.ts", ...(env.__args ? env.__args.split(" ") : [])],
        {
          cwd: INGEST_DIR,
          timeout: 60_000,
          env: { ...process.env, DATABASE_URL: dbUrl, ALLOW_DEV_SECRETS: "1", ...env, __args: undefined } as NodeJS.ProcessEnv,
        },
        (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(err);
          resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("bare reconcile on a deployment with SWITCHBOARD_TENANT_ID set is NOT refused as though --tenant had been passed", async () => {
    const ledgerPath = join(dir, "ledger-support.jsonl");
    const support = createBillingApp({ ledgerPath, webhookUrl: "http://127.0.0.1:1" });
    const supportUrl = listen(support);
    await fetch(`${supportUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 3 }),
    });

    const res = await runReconcile({
      SWITCHBOARD_TENANT_ID: TENANT_X,
      INGEST_SOURCES: "support",
      SUPPORT_BASE_URL: supportUrl,
      LEDGER_PATH_SUPPORT: ledgerPath,
    });

    // The refusal names a flag the operator never typed. That is the regression.
    expect(res.out, "bare reconcile refused a --tenant that was never passed").not.toContain(
      "--tenant is not supported for ledger-feed source",
    );
    // And it must actually reconcile rather than bailing before it starts.
    expect(res.out).toContain("[support]");
  }, 90_000);

  // PRE-3 / #24. The third case, and the one the gate got wrong: `--tenant <the
  // deployment's own tenant>` names EXACTLY the scope a bare run already has, and was
  // refused anyway — because the gate keyed on `has("tenant")` alone rather than on
  // whether the named tenant differs from this deployment's. An operator who spells out
  // what they are checking (a habit worth encouraging, and one a runbook or a wrapper
  // script naturally produces) got a refusal quoting a cross-tenant hazard that the flag
  // value proves is absent. Conservative-and-loud was the right holding position; it is
  // not the right rule.
  it("PRE-3 #24 · an EXPLICIT --tenant naming THIS deployment's own tenant is allowed — identical scope to a bare run must get an identical answer", async () => {
    const ledgerPath = join(dir, "ledger-support.jsonl");
    const support = createBillingApp({ ledgerPath, webhookUrl: "http://127.0.0.1:1" });
    const supportUrl = listen(support);
    await fetch(`${supportUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 3 }),
    });
    // The explicit-tenant run also passes through the F8 "must have recorded state"
    // gate, so give the lane state the same way the bare-run case above does.
    const feed = await (await fetch(`${supportUrl}/events?after=0&limit=50`)).json();
    const events = (feed.events ?? feed) as { event_id: string }[];
    const { ingestEvent } = await import("../src/ingest-event.js");
    for (const e of events) await ingestEvent(pool, "support", e as never, { tenantId: TENANT_X });

    const res = await runReconcile({
      SWITCHBOARD_TENANT_ID: TENANT_X,
      INGEST_SOURCES: "support",
      SUPPORT_BASE_URL: supportUrl,
      LEDGER_PATH_SUPPORT: ledgerPath,
      __args: `--tenant ${TENANT_X}`,
    });

    expect(
      res.out,
      "--tenant naming the deployment's OWN tenant was refused as a cross-tenant request",
    ).not.toContain("--tenant is not supported for ledger-feed source");
    expect(res.out).toContain("[support]");
  }, 90_000);

  it("an EXPLICIT --tenant naming a different tenant is still refused for a ledger-feed source", async () => {
    const ledgerPath = join(dir, "ledger-support.jsonl");
    const support = createBillingApp({ ledgerPath, webhookUrl: "http://127.0.0.1:1" });
    const supportUrl = listen(support);

    const res = await runReconcile({
      SWITCHBOARD_TENANT_ID: TENANT_X,
      INGEST_SOURCES: "support",
      SUPPORT_BASE_URL: supportUrl,
      LEDGER_PATH_SUPPORT: ledgerPath,
      __args: "--tenant 44444444-4444-4444-4444-444444444444",
    });

    // The rule the gate exists for survives: a ledger file has no tenant in it, so
    // answering "for tenant Y" from it would be a cross-tenant answer dressed as a
    // per-tenant one.
    expect(res.code).toBe(1);
    expect(res.out).toContain("--tenant is not supported for ledger-feed source");
  }, 90_000);
});
