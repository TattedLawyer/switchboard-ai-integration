import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { createSheetsApp } from "../../mocks/sheets/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { signBody, assertWebhookSecrets } from "../src/hmac.js";
import { enabledSources, type Source } from "../src/sources.js";
import { createBackfillRunner } from "../src/main.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Task A7 — service wiring: the long-running service's interval loop routes through the
// connector seam, and the nudge door gets a real host. One RED→GREEN pair, four
// obligations:
//   1. regression pins FIRST — the three feed sources' loop behavior is UNCHANGED by the
//      seam routing (same catchUp effects, same skip-tick under overlap, same log shape);
//   2. sheets in the service loop drives snapshot catchUp, never a /events poll;
//   3. the nudge door hosted through the SAME wiring main() uses — signed nudge runs the
//      early catchUp, a nudge during a running cycle coalesces (skipped, never queued);
//   4. boot assertion — sheets ∈ INGEST_SOURCES makes WEBHOOK_SECRET_SHEETS a boot
//      requirement through the exact aggregated assert main() runs.
// L1-G12 discipline: importing main.ts must NEVER boot the service — the entrypoint
// guard makes these imports side-effect-free, which is the only reason this file can
// exist. If an import here ever starts pg-boss or binds a port, that guard regressed.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
const servers: Server[] = [];

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  for (const srv of servers.splice(0)) srv.close();
  delete process.env.SHEETS_BASE_URL;
  await cleanup();
});

function listen(app: express.Express): string {
  const srv = app.listen(0);
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
}

/** A minimal cursor-honoring /events feed (backfill.test.ts's pattern, plus `after`
 *  filtering — the runner drives catchUp, whose empty-page stop condition needs the feed
 *  to answer "nothing new" once the cursor passes the tail). Records every request path —
 *  the pins below assert which endpoints the loop actually spoke to. */
function recordedFeed(events: { seq: number }[]): { baseUrl: string; paths: string[] } {
  const paths: string[] = [];
  const app = express();
  app.use((req, _res, next) => {
    paths.push(req.path);
    next();
  });
  app.get("/events", (req, res) => {
    const after = Number(req.query.after ?? 0);
    const page = events.filter((e) => e.seq > after);
    res.json({ events: page, last_seq: page.length > 0 ? page[page.length - 1].seq : after });
  });
  return { baseUrl: listen(app), paths };
}

/** The real sheets mock wrapped in a path recorder, optionally gating /snapshot behind a
 *  latch so a cycle can be held in flight while a nudge arrives. */
function recordedSheet(opts?: { gateSnapshot?: boolean }): {
  baseUrl: string;
  paths: string[];
  /** Resolves once a /snapshot request is actually being held at the gate. */
  held: Promise<void>;
  release: () => void;
} {
  const sheets = createSheetsApp({ seed: 7, rowCount: 6 });
  const paths: string[] = [];
  let releaseGate = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let heldResolve = () => {};
  const held = new Promise<void>((resolve) => {
    heldResolve = resolve;
  });
  const app = express();
  app.use(async (req, _res, next) => {
    paths.push(req.path);
    if (opts?.gateSnapshot && req.path === "/snapshot") {
      heldResolve();
      await gate;
    }
    next();
  });
  app.use(sheets.app);
  return { baseUrl: listen(app), paths, held, release: releaseGate };
}

const feedEvent = (id: string, seq: number) => ({
  event_id: id,
  event_type: "company.updated",
  occurred_at: new Date().toISOString(),
  data: { id: "DEMO-C-0001", name: "Demo", domain: "demo.example.com" },
  seq,
});

async function rawCount(source: string): Promise<number> {
  const res = await pool.query(
    "select count(*)::int as n from raw.raw_events where source = $1",
    [source],
  );
  return res.rows[0].n;
}

function captureLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  console.log = (msg: string, ...args: unknown[]) => {
    logs.push(String(msg));
    original(msg, ...args);
  };
  return { logs, restore: () => (console.log = original) };
}

// ── Obligation 1 — regression pins: the feed trio's loop behavior survives the seam ─────

describe("A7 obligation 1 — seam routing is behavior-preserving for the feed sources", () => {
  for (const source of ["crm", "billing", "support"] as const) {
    it(`${source}: the interval runner polls /events, lands every event, advances the cursor, and a rerun ingests nothing — exactly the pre-seam loop`, async () => {
      const { baseUrl, paths } = recordedFeed([
        feedEvent(`${source}-evt-1`, 1),
        feedEvent(`${source}-evt-2`, 2),
        feedEvent(`${source}-evt-3`, 3),
      ]);

      const runBackfill = createBackfillRunner(pool, source, baseUrl);
      await runBackfill();

      expect(await rawCount(source)).toBe(3);
      const cursor = await pool.query(
        "select last_seq from ingest.cursors where source = $1",
        [source],
      );
      expect(Number(cursor.rows[0].last_seq)).toBe(3);
      // Feed-shaped means feed-shaped: the loop spoke to /events and nothing else.
      expect(paths).toContain("/events");
      expect(paths.every((p) => p === "/events")).toBe(true);

      await runBackfill();
      expect(await rawCount(source)).toBe(3); // idempotent rerun, same as before the seam
    });
  }

  it("overlap guard: a tick during a running cycle SKIPS with the exact pre-seam log line, and never queues a second poll", async () => {
    // A feed that answers only when released, so the first tick is provably in flight
    // when the second arrives.
    const paths: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = express();
    app.get("/events", async (req, res) => {
      paths.push("/events");
      await gate;
      const after = Number(req.query.after ?? 0);
      const page = after < 1 ? [feedEvent("support-slow-1", 1)] : [];
      res.json({ events: page, last_seq: page.length > 0 ? 1 : after });
    });
    const baseUrl = listen(app);

    const { logs, restore } = captureLogs();
    try {
      const runBackfill = createBackfillRunner(pool, "support", baseUrl);
      const p1 = runBackfill();
      const p2 = runBackfill(); // arrives while the first cycle holds the gate
      await p2; // must resolve immediately — skipped, not queued behind p1
      expect(logs).toContain("[support] backfill still running, skipping tick");
      release();
      await p1;
    } finally {
      restore();
    }
    // Skip means skip: after both settle, the feed answered exactly the ONE tick's
    // catchUp rounds (1 page + 2 empty confirmations = 3 polls); the skipped tick
    // contributed zero requests — it was dropped, not queued behind the running cycle.
    expect(await rawCount("support")).toBe(1);
    expect(paths.length).toBe(3);
  });
});

// ── Obligation 2 — sheets in the service loop speaks the snapshot paradigm ──────────────

describe("A7 obligation 2 — the service loop routes sheets through the seam", () => {
  it("the sheets runner drives snapshot catchUp — every seeded row lands, and the loop NEVER touches /events on the sheets base URL", async () => {
    const { baseUrl, paths } = recordedSheet();

    const runBackfill = createBackfillRunner(pool, "sheets", baseUrl);
    await runBackfill();

    // The pre-A7 loop 404s /events once a minute here (the KNOWN-ISSUES bullet this
    // slice pays): nothing lands and the noise is the pinned absence below.
    expect(await rawCount("sheets")).toBe(6);
    expect(paths).toContain("/snapshot");
    expect(paths.filter((p) => p.startsWith("/events"))).toEqual([]);
  });
});

// ── Obligation 3 — the nudge door gets a real host ──────────────────────────────────────

/** The wiring shape main() composes its interval loop and nudge hook from. Resolved
 *  DYNAMICALLY (backfill.test.ts precedent — safe because of the L1-G12 entrypoint
 *  guard) so at RED this file still loads and the obligation-1 regression pins run as
 *  the control group; only these tests fail, naming the missing export. */
interface ServiceWiring {
  runners: { source: Source; run: () => Promise<void> }[];
  sheetsNudge?: () => Promise<void>;
}
type CreateServiceWiring = (pgPool: pg.Pool, sources: Source[]) => ServiceWiring;

async function loadCreateServiceWiring(): Promise<CreateServiceWiring> {
  const mod = (await import("../src/main.js")) as Record<string, unknown>;
  expect(
    mod.createServiceWiring,
    "main.ts exports no createServiceWiring — the service composes no nudge host",
  ).toBeTypeOf("function");
  return mod.createServiceWiring as CreateServiceWiring;
}

describe("A7 obligation 3 — nudge hosting through the service wiring", () => {
  it("createServiceWiring hosts a sheets nudge exactly when sheets is enabled — feed-only wiring hosts none (the 503 posture survives for it)", async () => {
    const createServiceWiring = await loadCreateServiceWiring();
    process.env.SHEETS_BASE_URL = "http://127.0.0.1:1"; // never contacted here
    const feedOnly = createServiceWiring(pool, ["crm", "billing", "support"]);
    expect(feedOnly.runners.map((r) => r.source)).toEqual(["crm", "billing", "support"]);
    expect(feedOnly.sheetsNudge).toBeUndefined();

    const withSheets = createServiceWiring(pool, ["crm", "sheets"]);
    expect(withSheets.runners.map((r) => r.source)).toEqual(["crm", "sheets"]);
    expect(withSheets.sheetsNudge).toBeDefined();
  });

  it("a signed nudge on the wiring-hosted door RUNS the early catchUp (delta observable in raw); unsigned stays 401 with no effect", async () => {
    const createServiceWiring = await loadCreateServiceWiring();
    const { baseUrl } = recordedSheet();
    process.env.SHEETS_BASE_URL = baseUrl;
    const wiring = createServiceWiring(pool, ["sheets"]);
    const ingestUrl = listen(createIngestApp(pool, DEFAULT_TENANT_ID, { sheetsNudge: wiring.sheetsNudge }));
    const body = JSON.stringify({
      sheet_id: "sheet-test",
      range: "A2:I2",
      occurred_at: new Date().toISOString(),
    });

    const unsigned = await fetch(`${ingestUrl}/connectors/sheets/nudge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unsigned.status).toBe(401);
    expect(await rawCount("sheets")).toBe(0);

    const signed = await fetch(`${ingestUrl}/connectors/sheets/nudge`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-switchboard-signature": signBody(body, "demo-secret-sheets"),
      },
      body,
    });
    expect(signed.status).toBe(202);
    expect(await rawCount("sheets")).toBe(6);
  });

  it("a nudge during a running cycle COALESCES — skipped, never queued: one snapshot read total; a later idle nudge reads again", async () => {
    const createServiceWiring = await loadCreateServiceWiring();
    const sheet = recordedSheet({ gateSnapshot: true });
    process.env.SHEETS_BASE_URL = sheet.baseUrl;
    const wiring = createServiceWiring(pool, ["sheets"]);
    const runSheets = wiring.runners.find((r) => r.source === "sheets")!.run;

    const { logs, restore } = captureLogs();
    let cycle: Promise<void>;
    try {
      cycle = runSheets(); // interval-shaped cycle, held at the /snapshot gate
      await sheet.held; // provably in flight
      await wiring.sheetsNudge!(); // must resolve NOW — coalesced onto the running cycle
      expect(logs).toContain("[sheets] backfill still running, skipping tick");
    } finally {
      restore();
    }
    sheet.release();
    await cycle;

    // Skipped means skipped: the nudge queued no second read behind the cycle. The next
    // cycle would read a fresh snapshot anyway (the connector is stateless), so a queued
    // re-run could only repeat the same full diff.
    expect(await rawCount("sheets")).toBe(6);
    expect(sheet.paths.filter((p) => p === "/snapshot")).toHaveLength(1);

    // An idle-time nudge is not a no-op: it really reads.
    await wiring.sheetsNudge!();
    expect(sheet.paths.filter((p) => p === "/snapshot")).toHaveLength(2);
  });
});

// ── Obligation 4 — boot assertion covers the sheets secret when sheets is enabled ───────

describe("A7 obligation 4 — boot assertion", () => {
  it("sheets ∈ INGEST_SOURCES without WEBHOOK_SECRET_SHEETS fails the aggregated boot assert NAMING that variable — exactly the composition main() runs", async () => {
    const saved = {
      allow: process.env.ALLOW_DEV_SECRETS,
      sheets: process.env.WEBHOOK_SECRET_SHEETS,
      crm: process.env.WEBHOOK_SECRET_CRM,
      sources: process.env.INGEST_SOURCES,
    };
    delete process.env.ALLOW_DEV_SECRETS;
    delete process.env.WEBHOOK_SECRET_SHEETS;
    process.env.WEBHOOK_SECRET_CRM = "real-secret-for-this-test";
    process.env.INGEST_SOURCES = "crm,sheets";
    try {
      // main() boots with assertWebhookSecrets(enabledSources()) — same call, same env.
      let message = "";
      try {
        assertWebhookSecrets(enabledSources());
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain("WEBHOOK_SECRET_SHEETS");
      // Aggregated and precise: the one configured secret is NOT in the complaint.
      expect(message).not.toContain("WEBHOOK_SECRET_CRM");
    } finally {
      if (saved.allow !== undefined) process.env.ALLOW_DEV_SECRETS = saved.allow;
      if (saved.sheets !== undefined) process.env.WEBHOOK_SECRET_SHEETS = saved.sheets;
      if (saved.crm !== undefined) process.env.WEBHOOK_SECRET_CRM = saved.crm;
      else delete process.env.WEBHOOK_SECRET_CRM;
      if (saved.sources !== undefined) process.env.INGEST_SOURCES = saved.sources;
      else delete process.env.INGEST_SOURCES;
    }
  });
});
