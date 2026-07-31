import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { createStripeFeedApp, type StripeFeedApp } from "../../mocks/stripefeed/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { StripeFeedConnector, type StripeFeedReconcileReport } from "../src/connectors/stripe-feed.js";

// Gate-H cold review, Task B range — C1 + I1 + I2 + I3: the connector↔OPERATOR seam.
//
// The oracle proved the connector detects and bounds its losses; the cold review proved
// (live, on scratch DBs) that NO SHIPPED SURFACE ever showed them: cli/backfill and the
// service loop called number-only catchUp, and cli/reconcile dropped gaps/agedOutRaw on
// the floor and printed "ledger hash chain: ok" for a paradigm that has neither. These
// tests run the REAL CLI entrypoints as child processes — the exact surfaces the RUNBOOK
// documents — reproducing the reviewer's transcript and pinning its inversion:
// a permanent loss must be LOUD on every door an operator actually uses.

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
let srv: Server | undefined;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  vi.restoreAllMocks();
  await cleanup();
});

function listen(app: express.Express): string {
  srv = app.listen(0);
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

/** Runs a REAL CLI entrypoint as a child process. Non-zero exit is a result, not an error. */
function runCli(
  script: "src/cli/backfill.ts" | "src/cli/reconcile.ts",
  baseUrl: string,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script],
      {
        cwd: INGEST_DIR,
        timeout: 25_000,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          INGEST_SOURCES: "stripefeed",
          STRIPEFEED_BASE_URL: baseUrl,
          ALLOW_DEV_SECRETS: "1",
        },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        // Assertions run over BOTH streams: loud loss reporting may reasonably live on
        // stderr; what matters is that the operator's terminal shows it.
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** The reviewer's reproduction, chapter 1: history ingested while retrievable. */
async function agedScenario(): Promise<{ mock: StripeFeedApp; baseUrl: string; cursorId: string }> {
  const mock = createStripeFeedApp({ seed: 42 });
  const baseUrl = listen(mock.app);
  const batch1 = mock.feed.emit(8, { ageS: 26 * 86_400 });
  const c = new StripeFeedConnector({ baseUrl });
  await c.catchUp(pool);
  // Same-second batch → the connector's cursor is the id-tiebreak max of batch1.
  const cursorId = [...batch1].sort((a, b) => a.created - b.created || (a.id > b.id ? 1 : -1)).at(-1)!.id;
  return { mock, baseUrl, cursorId };
}

describe("C1 — the reviewer's reproduction, inverted: permanent loss is LOUD on every shipped surface", () => {
  it("backfill CLI: the aged-cursor fallback run prints the unclosable gap with bounds — never just 'ingested 6 event(s)'", async () => {
    const { mock, baseUrl, cursorId } = await agedScenario();
    mock.feed.emit(6); // fresh events
    mock.feed.advance(5 * 86_400); // batch1 (and the cursor) age out; the 6 stay retained

    const res = await runCli("src/cli/backfill.ts", baseUrl);
    expect(res.out).toMatch(/ingested 6 event\(s\)/); // forward progress still reported
    // The inversion of the cold-review transcript: the loss is now on the run log.
    expect(res.out).toMatch(/PERMANENT DATA LOSS/i);
    expect(res.out).toMatch(/unclosable gap/i);
    expect(res.out).toContain(cursorId); // the near bound is named
    expect(res.out).toMatch(/retention/);
    // Deliberate semantics (disclosed): backfill exits 0 — the drain itself succeeded
    // and forward progress is real; reconcile is the gate that turns a gap into a red.
    expect(res.code).toBe(0);
  });

  it("service loop: createBackfillRunner surfaces the gap in the service log, not just the return value", async () => {
    const { mock, baseUrl, cursorId } = await agedScenario();
    mock.feed.emit(6);
    mock.feed.advance(5 * 86_400);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createBackfillRunner } = await import("../src/main.js");
    const run = createBackfillRunner(pool, "stripefeed", baseUrl);
    await run();
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/unclosable gap/i);
    expect(logged).toContain(cursorId);
  });

  it("reconcile CLI: a live gap FAILS the run and is printed with bounds, even when every other bucket balances (empty-feed case)", async () => {
    const { mock, baseUrl, cursorId } = await agedScenario();
    mock.feed.advance(5 * 86_400); // EVERYTHING ages out: missing/extra all empty, gap live

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).toMatch(/unclosable gap/i);
    expect(res.out).toContain(cursorId);
    expect(res.out).toMatch(/aged out of window[^:]*: 8/); // agedOutRaw printed, expected-not-flagged
    expect(res.out).toMatch(/FAIL/);
    // Deliberate gate semantics (disclosed): a gap is never a PASS-silently condition —
    // exit nonzero the first time it appears. The acknowledged-gap workflow (so a known,
    // accepted loss stops redding future runs) is register follow-up shared with the
    // durable-gap-ledger item; today's per-process detection means a fresh process after
    // the fallback no longer sees the gap anyway (KNOWN-ISSUES), so v1 gating cannot
    // produce a permanent red.
    expect(res.code).toBe(1);
  });
});

describe("I1 — paradigm-honest integrity line (the recorded Minor-6 class, extended to the third paradigm)", () => {
  it("reconcile CLI never claims 'ledger hash chain' for stripe-feed and states what was actually verified", async () => {
    const mock = createStripeFeedApp({ seed: 42 });
    const baseUrl = listen(mock.app);
    mock.feed.emit(8);
    await new StripeFeedConnector({ baseUrl }).catchUp(pool);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).not.toMatch(/ledger hash chain/);
    expect(res.out).toMatch(/feed window integrity: ok/);
    // The count label says what the number IS for this paradigm — a 30-day window,
    // not a ledger file.
    expect(res.out).toMatch(/retained window: 8/);
    expect(res.out).toMatch(/PASS/);
    expect(res.code).toBe(0);
  });
});

describe("I2 — quarantined-but-retained events are classified, cross-referenced, and never fail the verdict alone", () => {
  /** A stub feed serving one good and one contract-violating event, every request —
   *  a shape the honest mock refuses to emit, same stub convention as stripe-feed.test.ts. */
  function stubFeedWithPoisonEvent(): string {
    const t = Math.floor(Date.now() / 1000) - 60;
    const app = express();
    app.get("/v1/events", (_req, res) =>
      res.json({
        object: "list",
        url: "/v1/events",
        has_more: false,
        data: [
          { id: "evt_k2poison", object: "event", type: "charge.succeeded", created: t, data: { object: { id: "DEMO-CH-BAD", amount_cents: -5 } } },
          { id: "evt_k1good", object: "event", type: "charge.succeeded", created: t + 1, data: { object: { id: "DEMO-CH-GOOD", amount_cents: 500, currency: "USD" } } },
        ],
      }),
    );
    return listen(app);
  }

  it("connector report: the quarantined event leaves `missing` and appears as quarantined-with-count; CLI prints it and still PASSes", async () => {
    const baseUrl = stubFeedWithPoisonEvent();
    const c = new StripeFeedConnector({ baseUrl });
    const catchUpReport = await c.catchUpWithReport(pool);
    expect(catchUpReport).toMatchObject({ ingested: 1, quarantined: 1 });

    // Connector level: for up to 30 days this event sits retained-but-not-in-raw. That
    // is not ingestion loss — it is preserved in ingest.quarantine, and the report must
    // say so instead of crying "missing" (the sheets quarantined-current precedent).
    const report = (await c.reconcile(pool)).report as StripeFeedReconcileReport;
    expect(report.missing).toEqual([]);
    expect(report.quarantined).toEqual([{ event_id: "evt_k2poison", count: 1 }]);
    expect(report.gaps).toEqual([]);

    // Operator level: named, counted, pointed at quarantine — and NOT a failed verdict.
    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).toMatch(/quarantined/i);
    expect(res.out).toContain("evt_k2poison");
    expect(res.out).toMatch(/PASS/);
    expect(res.code).toBe(0);
  });

  it("a re-served quarantined event accumulates count, still never surfaces as missing", async () => {
    const baseUrl = stubFeedWithPoisonEvent();
    const c = new StripeFeedConnector({ baseUrl });
    await c.catchUp(pool);
    // Second drain from a rolled-back cursor re-serves the page → re-quarantine.
    await pool.query("update ingest.cursors set last_event_id = null where source = 'stripefeed'");
    await c.catchUp(pool);

    const report = (await c.reconcile(pool)).report as StripeFeedReconcileReport;
    expect(report.missing).toEqual([]);
    expect(report.quarantined).toEqual([{ event_id: "evt_k2poison", count: 2 }]);
  });
});

describe("I3 — the failure hint names the REAL cursor for this paradigm", () => {
  it("backfill CLI failure output prints last_event_id, never the ledger-paradigm's pinned last_seq 0", async () => {
    // Seed a real cursor first, against a working stub…
    const t = Math.floor(Date.now() / 1000) - 60;
    const app = express();
    app.get("/v1/events", (_req, res) =>
      res.json({
        object: "list",
        url: "/v1/events",
        has_more: false,
        data: [{ id: "evt_m1resume", object: "event", type: "charge.succeeded", created: t, data: { object: { id: "DEMO-CH-1", amount_cents: 100 } } }],
      }),
    );
    await new StripeFeedConnector({ baseUrl: listen(app) }).catchUp(pool);

    // …then fail against an unreachable feed: the hint must name where we really are.
    const res = await runCli("src/cli/backfill.ts", "http://127.0.0.1:1");
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/resume from cursor evt_m1resume/);
    expect(res.out).not.toMatch(/resume from cursor 0\b/);
  });
});
