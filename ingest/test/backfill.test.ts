import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { createBillingApp } from "../../mocks/billing/src/server.js";
import { freshTestDb } from "./helpers/testdb.js";
import { pollOnce, catchUp } from "../src/backfill.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let dir: string;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
  dir = mkdtempSync(join(tmpdir(), "backfill-"));
});
afterEach(async () => {
  await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

describe("backfill", () => {
  it("catchUp recovers all events dropped by webhook delivery, idempotently on rerun", async () => {
    // webhookUrl points at a dead port; combined with dropRate: 1, every push delivery is
    // skipped entirely (never attempted), so all 30 events land only in the ledger and poll
    // is the only recovery path.
    const feed = createBillingApp({ webhookUrl: "http://127.0.0.1:1", ledgerPath: join(dir, "l.jsonl") });
    const srv: Server = await listenLoopback(feed);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 30,
        fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 },
      }),
    });

    const total = await catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID });
    expect(total).toBe(30);

    const raw = await pool.query("select count(*)::int as n from raw.raw_events where source = 'billing'");
    expect(raw.rows[0].n).toBe(30);

    // Poll-path stored payloads must match push-path payloads byte-for-byte: none of the
    // ledger feed's pagination/chain fields (seq, prev_hash, hash) should leak into the stored
    // payload, since those are ledger transport metadata, not part of the CRM event itself.
    const payloads = await pool.query("select payload from raw.raw_events where source = 'billing' order by event_id");
    for (const row of payloads.rows) {
      const payload = row.payload;
      expect(payload).not.toHaveProperty("seq");
      expect(payload).not.toHaveProperty("prev_hash");
      expect(payload).not.toHaveProperty("hash");
    }

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      ["billing"],
    );
    expect(cursor.rows[0].last_seq).toBe("30");

    const second = await catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID });
    expect(second).toBe(0);

    const rawAfter = await pool.query("select count(*)::int as n from raw.raw_events where source = 'billing'");
    expect(rawAfter.rows[0].n).toBe(30);

    srv.close();
  });

  it("pollOnce throws on non-2xx and leaves cursor untouched", async () => {
    const feed = createBillingApp({
      webhookUrl: "http://127.0.0.1:1",
      ledgerPath: join(dir, "l2.jsonl"),
    });
    const srv: Server = await listenLoopback(feed);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: 5, fault_plan: { seed: 1, dropRate: 0, dupRate: 0, apiErrorRate: 1 } }),
    });

    await expect(pollOnce(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID })).rejects.toThrow();

    const cursor = await pool.query(
      "select last_seq from ingest.cursors where source = $1",
      ["billing"],
    );
    expect(cursor.rowCount).toBe(0);

    srv.close();
  });

  it("overlap guard prevents concurrent backfill runs", async () => {
    const { createBackfillRunner } = await import("../src/main.js");

    const feed = createBillingApp({
      webhookUrl: "http://127.0.0.1:1",
      ledgerPath: join(dir, "l3.jsonl"),
    });
    const srv: Server = await listenLoopback(feed);
    const port = (srv.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    await fetch(`${baseUrl}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        count: 10,
        fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 },
      }),
    });

    // Capture logs to verify skip message
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: string, ...args: unknown[]) => {
      logs.push(msg);
      originalLog(msg, ...args);
    };

    try {
      const runBackfill = createBackfillRunner(pool, "billing", baseUrl, DEFAULT_TENANT_ID);

      // First call should run (no guard triggered)
      const p1 = runBackfill();

      // Immediately call again while first is still in-flight
      const p2 = runBackfill();

      // Wait for both to complete
      await p1;
      await p2;

      // Check that second invocation was skipped
      // B4: the skip line carries its source — an operator tailing a multi-source
      // service log must know WHICH source's tick coalesced.
      const skipLog = logs.find((log) => log.includes("[billing] backfill still running, skipping tick"));
      expect(skipLog).toBeTruthy();
    } finally {
      console.log = originalLog;
      srv.close();
    }
  });
});

// Debt-burn A9 — the poll path's two audit findings, highest stakes in the wave: the
// cursor advanced to a FEED-SUPPLIED last_seq (a feed that overstates it permanently and
// silently skips the gap — unbounded data loss with no trace), and the fetch had no
// timeout (a black-holed feed wedged the loop; every sibling connector has carried
// per-attempt AbortSignal.timeout since L1-G4).
describe("the cursor is OURS on the poll path too (debt-burn A9)", () => {
  const goodEvent = (id: string, seq: number) => ({
    event_id: id, event_type: "company.updated", occurred_at: new Date().toISOString(),
    data: { id: "DEMO-C-0001", name: "Demo", domain: "demo.example.com" }, seq,
  });

  it("a feed that OVERSTATES last_seq cannot bury the gap: the cursor advances only to the max seq actually processed, and the next polls recover the rest", async () => {
    // The lie: the first page carries seqs 1..3 but claims last_seq=13. The truth
    // (4..13) is only ever served when asked `after=3` — so trusting the claim makes
    // ten events permanently unreachable, silently.
    const all = Array.from({ length: 13 }, (_, i) => goodEvent(`evt-a9-${String(i + 1).padStart(2, "0")}`, i + 1));
    const app = express();
    app.get("/events", (req, res) => {
      const after = Number(req.query.after);
      const events = after === 0 ? all.slice(0, 3) : all.filter((e) => e.seq > after);
      res.json({ events, last_seq: 13 });
    });
    const srv: Server = await listenLoopback(app);
    const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    const first = await pollOnce(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID });
    expect(first.ingested).toBe(3);
    // The mechanism under pin: the persisted position is the max seq this process
    // VERIFIED — processed from the page — never the feed's own claim about itself.
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'billing'");
    expect(Number(cur.rows[0].last_seq)).toBe(3);
    expect(first.last_seq).toBe(3);

    // And because the cursor told the truth, the drain recovers everything.
    await catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID });
    const raw = await pool.query("select count(*)::int as n from raw.raw_events where source = 'billing'");
    expect(raw.rows[0].n).toBe(13);
    srv.close();
  });

  it("a black-holed feed is a bounded loud failure, never a wedge: per-attempt timeout with the cursor untouched (the sibling connectors' L1-G4 shape)", async () => {
    const app = express();
    app.get("/events", () => {
      /* never responds */
    });
    const srv: Server = await listenLoopback(app);
    const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    await expect(pollOnce(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID, timeoutMs: 300 })).rejects.toThrow(/timed out after 300ms/);
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'billing'");
    expect(cur.rowCount).toBe(0);
    srv.close();
  });
});

// The poll path is a THIRD door into raw.raw_events, alongside the webhook and the quarantine
// replay. Two load-bearing comments assert there are only two and that both are gated:
// quarantine.ts calls its predicate "the single definition used by BOTH doors into raw", and
// stg_crm__companies.sql:14-17 justifies its `(occurred_at)::timestamptz` cast as "acceptable
// ONLY because the ingest gate ... rejects non-ISO-8601 occurred_at before anything reaches
// raw". pollOnce handed feed events straight to ingestEvent, which validates nothing — so a
// feed could put a value in raw that fails the staging cast (taking down the whole dbt build
// and every model downstream of it), or a well-formed "9999-12-31" that wins every
// latest-state sort forever. Neither is recoverable: the quarantine CLI only reads
// ingest.quarantine, and nothing deletes from raw.
describe("backfill occurred_at gate (the third door)", () => {
  const feedWith = (events: unknown[]) => {
    const app = express();
    app.get("/events", (_req, res) => res.json({ events, last_seq: events.length }));
    return app;
  };

  const goodEvent = (id: string) => ({
    event_id: id, event_type: "company.updated", occurred_at: new Date().toISOString(),
    data: { id: "DEMO-C-0001", name: "Demo", domain: "demo.example.com" }, seq: 1,
  });

  it("quarantines a feed event whose occurred_at would throw the staging cast", async () => {
    const bad = { ...goodEvent("evt-bad"), occurred_at: "2026-13-45", seq: 1 };
    const srv: Server = await listenLoopback(feedWith([bad]));
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "billing", `http://127.0.0.1:${port}`, { tenantId: DEFAULT_TENANT_ID });
    srv.close();

    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0);
    const q = await pool.query("select source, reason from ingest.quarantine");
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].source).toBe("billing");
  });

  it("quarantines a well-formed but out-of-window occurred_at that would pin state forever", async () => {
    const bad = { ...goodEvent("evt-9999"), occurred_at: "9999-12-31T00:00:00Z", seq: 1 };
    const srv: Server = await listenLoopback(feedWith([bad]));
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "billing", `http://127.0.0.1:${port}`, { tenantId: DEFAULT_TENANT_ID });
    srv.close();

    const raw = await pool.query("select count(*)::int as n from raw.raw_events");
    expect(raw.rows[0].n).toBe(0);
    expect((await pool.query("select 1 from ingest.quarantine")).rowCount).toBe(1);
  });

  // Claim-pin for "a poison feed event cannot wedge the poll loop" (security review M1).
  // A declared numeric field nested past V8's JSON.stringify cliff (~6.6k) used to throw
  // inside the contract's reason rendering, propagate through safeParse (zod v3 does not
  // catch refinement throws), crash pollOnce, burn catchUp's retries on the same page, and
  // stall the cursor forever. The fix mirrors the webhook door: jsonbUnstorableReason
  // diverts the event to quarantine BEFORE the schema ever sees it.
  it("a 7000-deep amount_cents in a feed page cannot wedge the loop: neighbors ingest, poison quarantines with a 'poll:' reason, cursor advances", async () => {
    // The page must be hand-assembled as TEXT: JSON.stringify (and express res.json)
    // RangeError on the deep value, while JSON.parse handles it fine — exactly the
    // asymmetry under test.
    const deep = "[".repeat(7000) + "0" + "]".repeat(7000);
    const iso = new Date().toISOString();
    const poison =
      `{"event_id":"evt-deep","event_type":"deal.updated","occurred_at":"${iso}",` +
      `"data":{"id":"DEMO-D-0001","amount_cents":${deep}},"seq":2}`;
    const pageText =
      `{"events":[${JSON.stringify({ ...goodEvent("evt-a"), seq: 1 })},${poison},` +
      `${JSON.stringify({ ...goodEvent("evt-c"), seq: 3 })}],"last_seq":3}`;

    const app = express();
    app.get("/events", (_req, res) => res.type("application/json").send(pageText));
    const srv: Server = await listenLoopback(app);
    const port = (srv.address() as { port: number }).port;

    const result = await pollOnce(pool, "billing", `http://127.0.0.1:${port}`, { tenantId: DEFAULT_TENANT_ID });
    srv.close();

    expect(result.ingested).toBe(2);
    expect(result.quarantined).toBe(1);

    const raw = await pool.query("select event_id from raw.raw_events order by event_id");
    expect(raw.rows.map((r) => r.event_id)).toEqual(["evt-a", "evt-c"]);

    const q = await pool.query("select reason, raw_body, payload from ingest.quarantine");
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toContain("poll:");
    // Depth-diverted payloads cannot live in jsonb; the wire text of the page is the only
    // in-process representation that survives — it must be preserved as raw_body.
    expect(q.rows[0].payload).toBeNull();
    expect(q.rows[0].raw_body).toBe(pageText);

    // The poison event must not stall the cursor — that would re-poll it forever.
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'billing'");
    expect(Number(cur.rows[0].last_seq)).toBe(3);
  });

  it("still ingests valid feed events, and advances the cursor past a quarantined one", async () => {
    const events = [goodEvent("evt-1"), { ...goodEvent("evt-2"), occurred_at: "nope", seq: 2 },
                    { ...goodEvent("evt-3"), seq: 3 }];
    const srv: Server = await listenLoopback(feedWith(events));
    const port = (srv.address() as { port: number }).port;

    await pollOnce(pool, "billing", `http://127.0.0.1:${port}`, { tenantId: DEFAULT_TENANT_ID });
    srv.close();

    const raw = await pool.query("select event_id from raw.raw_events order by event_id");
    expect(raw.rows.map((r) => r.event_id)).toEqual(["evt-1", "evt-3"]);
    expect((await pool.query("select 1 from ingest.quarantine")).rowCount).toBe(1);
    // A poison event must not stall the cursor — that would re-poll it forever.
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'billing'");
    expect(Number(cur.rows[0].last_seq)).toBe(3);
  });
});

// Sweep item 3 (slice-1 review): catchUp exited its rounds budget with a SILENT
// `return totalIngested` — a partial drain reported as a finished one, the exact
// dishonesty the sibling connectors refuse by name ("refusing to report a drain it did
// not finish"). A9 made the budget MORE reachable: events with no usable seq advance no
// cursor, so a page of them re-serves forever and used to burn 10,000 quiet rounds
// before lying. The A4 treatment: the structural shape fails immediately by name; a
// genuinely deep feed that outlives the budget fails loudly naming the resumable cursor.
describe("catchUp: the rounds budget is loud, and no-progress is structural (the A4 treatment)", () => {
  const goodEvent = (id: string, seq: number) => ({
    event_id: id, event_type: "company.updated", occurred_at: new Date().toISOString(),
    data: { id: "DEMO-C-0001", name: "Demo", domain: "demo.example.com" }, seq,
  });

  it("a non-empty round with no cursor progress fails immediately by NAME — never a slow, misdiagnosed budget burn", async () => {
    // Events with NO seq: every one processes (ingest, then duplicate-absorb on the
    // re-serve) but contributes no position — the cursor stays put and `after=0`
    // re-serves the same page forever. Structurally unterminating.
    const app = express();
    app.get("/events", (_req, res) => {
      res.json({
        events: [{ event_id: "evt-noseq-1", event_type: "company.updated", occurred_at: new Date().toISOString(), data: { id: "DEMO-C-0001" } }],
        last_seq: 0,
      });
    });
    const srv: Server = await listenLoopback(app);
    const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    // maxRounds generous on purpose: the structural check must fire LONG before the
    // budget — a budget-shaped error here would be exactly the misdiagnosis A4 bans.
    await expect(catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID, maxRounds: 30 })).rejects.toThrow(
      /billing catchUp made no cursor progress across a non-empty round/,
    );
    srv.close();
  });

  it("budget exhaustion WITH progress is a loud bounded failure naming the resumable cursor — never a silent partial drain", async () => {
    // A genuinely bottomless feed: every request serves the next seq. Real progress,
    // no structural fault — only the budget can stop it, and it must say so.
    const app = express();
    app.get("/events", (req, res) => {
      const after = Number(req.query.after ?? 0) || 0;
      res.json({ events: [goodEvent(`evt-deep-${after + 1}`, after + 1)], last_seq: after + 1 });
    });
    const srv: Server = await listenLoopback(app);
    const baseUrl = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;

    await expect(catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID, maxRounds: 3 })).rejects.toThrow(
      /billing catchUp exceeded maxRounds=3 .*refusing to report a drain it did not finish; state is consistent, re-run to resume from cursor 3/,
    );
    // The named cursor is REAL persisted state: a re-run resumes from it.
    const cur = await pool.query("select last_seq from ingest.cursors where source = 'billing'");
    expect(Number(cur.rows[0].last_seq)).toBe(3);
    srv.close();
  });
});
