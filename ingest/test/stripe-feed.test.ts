import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { StripeFeedConnector, type StripeFeedGap } from "../src/connectors/stripe-feed.js";
import { numericContractViolation } from "../src/numeric-contract.js";

// Task B pair 2 — the stripe-feed connector's door discipline, pinned against SCRIPTED
// stub feeds (the real mock drives pair 3's oracle; these stubs let each pin control
// exactly what the feed says, including shapes the honest mock refuses to produce).
//
// The two mechanisms this file exists to kill:
//   - the empty-page-inference bug class (fixed once at f1e7ac4 for the ledger feed):
//     done-ness comes from has_more and NOTHING else — not page emptiness, not count;
//   - the feed-supplied-cursor skip-forward debt: the cursor is the id of an event WE
//     processed, never a value the feed hands us to resume from.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server | undefined;

beforeEach(async () => {
  ({ pool, cleanup } = await freshTestDb());
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  await cleanup();
});

const NOW_S = () => Math.floor(Date.now() / 1000);

interface StubEvent {
  id: string;
  object: "event";
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

const evt = (id: string, created: number, amount = 1000): StubEvent => ({
  id,
  object: "event",
  type: "charge.succeeded",
  created,
  data: { object: { id: `DEMO-CH-${id}`, object: "charge", amount_cents: amount, currency: "USD" } },
});

/** Serve a scripted response per request index; records every /v1/events URL seen. */
function scriptedFeed(pages: ((req: express.Request, res: express.Response) => void)[]): {
  baseUrl: Promise<string>;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const app = express();
  app.get("/v1/events", (req, res) => {
    urls.push(req.url);
    const handler = pages[Math.min(i, pages.length - 1)];
    i++;
    handler(req, res);
  });
  srv = app.listen(0);
  const baseUrl = Promise.resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
  return { baseUrl, urls };
}

const pageBody = (data: StubEvent[], has_more: boolean) => ({ object: "list", url: "/v1/events", has_more, data });

async function rawIds(): Promise<string[]> {
  const res = await pool.query(
    "select event_id from raw.raw_events where source = 'stripefeed' order by id",
  );
  return res.rows.map((r) => r.event_id);
}

async function storedCursor(): Promise<string | null> {
  const res = await pool.query(
    "select last_event_id from ingest.cursors where source = 'stripefeed'",
  );
  return res.rowCount === 0 ? null : res.rows[0].last_event_id;
}

describe("has_more is the ONLY termination signal (both directions pinned)", () => {
  it("a page WITH events but has_more=false ends the drain — no further request is made", async () => {
    const t = NOW_S() - 60;
    const { baseUrl, urls } = scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_a1", t), evt("evt_a2", t)], false)),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    expect(await c.catchUp(pool)).toBe(2);
    expect(urls).toHaveLength(1);
  });

  it("an EMPTY page with has_more=true CONTINUES — emptiness is not done-ness (the f1e7ac4 class, killed by mechanism)", async () => {
    const t = NOW_S() - 60;
    const { baseUrl, urls } = scriptedFeed([
      (_req, res) => res.json(pageBody([], true)),
      (_req, res) => res.json(pageBody([evt("evt_b1", t)], false)),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    expect(await c.catchUp(pool)).toBe(1);
    expect(urls).toHaveLength(2);
    expect(await rawIds()).toEqual(["evt_b1"]);
  });

  it("a SHORT page (fewer events than limit) with has_more=true continues — count never infers done-ness", async () => {
    const t = NOW_S() - 60;
    const { baseUrl, urls } = scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_c1", t)], true)),
      (_req, res) => res.json(pageBody([evt("evt_c2", t + 1)], false)),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl, pageLimit: 100 });
    expect(await c.catchUp(pool)).toBe(2);
    expect(urls).toHaveLength(2);
  });

  it("an endless empty-but-has_more feed is a BOUNDED failure, not a wedge: maxRounds stops it loudly", async () => {
    const { baseUrl } = scriptedFeed([(_req, res) => res.json(pageBody([], true))]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    await expect(c.catchUp(pool, { maxRounds: 5 })).rejects.toThrow(/maxRounds|rounds/i);
    expect(await storedCursor()).toBeNull(); // nothing processed, nothing advanced
  });
});

describe("cursor discipline — ours, never the feed's", () => {
  it("persists the id of an event WE processed (max created, id tiebreak) and IGNORES any feed-supplied resume hint", async () => {
    const t = NOW_S() - 60;
    const { baseUrl } = scriptedFeed([
      // Response position deliberately disagrees with created order, and the body dangles
      // a skip-forward bait the connector must never touch.
      (_req, res) =>
        res.json({ ...pageBody([evt("evt_d3", t + 2), evt("evt_d1", t)], false), next_cursor: "evt_evil" }),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    await c.catchUp(pool);
    expect(await storedCursor()).toBe("evt_d3"); // max created — not response-last, not the bait
  });

  it("orders ingestion by created (id tiebreak), never by response position", async () => {
    const t = NOW_S() - 60;
    const { baseUrl } = scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_e2", t + 5), evt("evt_e1", t), evt("evt_e0", t)], false)),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    await c.catchUp(pool);
    // raw's bigserial order = processing order: created asc, then id asc on the tie.
    expect(await rawIds()).toEqual(["evt_e0", "evt_e1", "evt_e2"]);
  });

  it("a mid-drain failure leaves the cursor at the last fully-processed page; the re-run resumes with no loss and no duplicates", async () => {
    const t = NOW_S() - 60;
    let phase2 = false;
    const { baseUrl } = scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_f1", t), evt("evt_f2", t + 1)], true)),
      (req, res) => {
        if (!phase2) return res.status(500).json({ error: { type: "api_error", message: "boom" } });
        // Resumed run: verify it resumes FROM our cursor, then close the feed.
        expect(req.query.starting_after).toBe("evt_f2");
        res.json(pageBody([evt("evt_f3", t + 2)], false));
      },
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    await expect(c.catchUp(pool)).rejects.toThrow(/500/);
    expect(await storedCursor()).toBe("evt_f2");
    expect(await rawIds()).toEqual(["evt_f1", "evt_f2"]);
    phase2 = true;
    expect(await c.catchUp(pool)).toBe(1);
    expect(await rawIds()).toEqual(["evt_f1", "evt_f2", "evt_f3"]);
  });

  it("a quarantined event is preserved+replayable and the cursor advances past it — batchmates ingest; nothing delivered is dropped", async () => {
    const t = NOW_S() - 60;
    const bad = evt("evt_g2", t + 1, -500); // negative amount: the contract quarantines it
    const { baseUrl } = scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_g1", t), bad], false)),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    const report = await c.catchUpWithReport(pool);
    expect(report).toMatchObject({ ingested: 1, quarantined: 1 });
    expect(await rawIds()).toEqual(["evt_g1"]);
    // Preserved as the quarantine row's jsonb payload (the replayable custody the
    // replay CLI operates on — raw_body is the separate lane for payloads jsonb cannot
    // hold) with a reason naming the field. That preservation is why advancing the
    // cursor is not a drop: refusing to advance would wedge the feed on one poisoned
    // event forever while adding zero custody.
    const q = await pool.query(
      "select reason, payload from ingest.quarantine where payload->>'event_id' = 'evt_g2'",
    );
    expect(q.rowCount).toBe(1);
    expect(q.rows[0].reason).toMatch(/amount_cents/);
    expect(q.rows[0].payload.data.amount_cents).toBe(-500); // full event preserved, replayable
    expect(await storedCursor()).toBe("evt_g2"); // advanced past the quarantined event
  });
});

describe("the retention boundary — the paradigm's honest loss", () => {
  it("aged-out cursor (400 resource_missing) → falls back to earliest retained, ingests forward, reports the unreachable range with bounds", async () => {
    const tOld = NOW_S() - 20 * 86_400;
    const tNew = NOW_S() - 60;
    // The connector previously ingested evt_h1 and holds it as cursor.
    await pool.query(
      `insert into raw.raw_events (tenant_id, source, event_id, event_type, payload)
       values ('00000000-0000-0000-0000-000000000000', 'stripefeed', 'evt_h1', 'charge.succeeded',
               $1::jsonb)`,
      [JSON.stringify({ event_id: "evt_h1", event_type: "charge.succeeded", occurred_at: new Date(tOld * 1000).toISOString(), data: {} })],
    );
    await pool.query(
      `insert into ingest.cursors (tenant_id, source, last_seq, last_event_id)
       values ('00000000-0000-0000-0000-000000000000', 'stripefeed', 0, 'evt_h1')`,
    );
    const { baseUrl } = scriptedFeed([
      (req, res) => {
        if (req.query.starting_after === "evt_h1") {
          return res.status(400).json({
            error: {
              type: "invalid_request_error",
              code: "resource_missing",
              param: "starting_after",
              message: "No such event: 'evt_h1'",
              doc_url: "https://docs.stripe.com/error-codes#resource-missing",
            },
          });
        }
        res.json(pageBody([evt("evt_h2", tNew), evt("evt_h3", tNew + 1)], false));
      },
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(2); // forward progress
    expect(await storedCursor()).toBe("evt_h3");
    const gap: StripeFeedGap = report.gaps[0];
    expect(gap).toMatchObject({ fromEventId: "evt_h1", cause: "retention" });
    expect(gap.fromOccurredAt).toBe(new Date(tOld * 1000).toISOString());
    expect(gap.toOccurredAt).toBe(new Date(tNew * 1000).toISOString()); // earliest retained
  });

  it("a 400 that is NOT the aged-cursor shape stays a loud failure — never silently treated as retention", async () => {
    const { baseUrl } = scriptedFeed([
      (_req, res) =>
        res.status(400).json({ error: { type: "invalid_request_error", param: "limit", message: "Invalid integer" } }),
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    await expect(c.catchUp(pool)).rejects.toThrow(/400/);
  });
});

describe("fetch discipline (register L1-G4 paid here)", () => {
  it("a black-holed feed is a BOUNDED loud failure via AbortSignal.timeout — never a wedge; cursor intact", async () => {
    const { baseUrl } = scriptedFeed([(_req, _res) => void 0 /* never responds */]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl, timeoutMs: 150 });
    const t0 = Date.now();
    await expect(c.catchUp(pool)).rejects.toThrow(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await storedCursor()).toBeNull();
  });

  it("429s retry with bounded deterministic backoff, then succeed", async () => {
    const t = NOW_S() - 60;
    let calls = 0;
    const { baseUrl, urls } = scriptedFeed([
      (_req, res) => {
        calls++;
        if (calls <= 2) {
          return res.status(429).json({ error: { type: "rate_limit_error", message: "slow down" } });
        }
        res.json(pageBody([evt("evt_i1", t)], false));
      },
    ]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl, backoff: { baseMs: 5, capMs: 20, maxAttempts: 4 } });
    expect(await c.catchUp(pool)).toBe(1);
    expect(urls.length).toBe(3);
  });

  it("reconcile against an unreachable feed reports integrity failure with NO report — never a confident diff against nothing", async () => {
    const c = new StripeFeedConnector({ baseUrl: "http://127.0.0.1:1", timeoutMs: 200 });
    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.report).toBeUndefined();
  });

  it("reconcile against a broken feed that RE-SERVES the same non-empty page forever is a bounded integrity failure, not a wedge (review I2)", async () => {
    // catchUp already refuses an endless feed loudly (maxRounds); reconcile's full-window
    // drain must hold the same discipline. A page whose deepest event equals the cursor
    // we just advanced past is proof the feed is not advancing — pages after a cursor
    // can never contain the cursor event itself on an honest feed.
    const t = NOW_S() - 60;
    const page = pageBody([evt("evt_j1", t), evt("evt_j2", t + 1)], true);
    const { baseUrl } = scriptedFeed([(_req, res) => res.json(page)]);
    const c = new StripeFeedConnector({ baseUrl: await baseUrl });
    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.detail).toMatch(/re-serv|not advancing/i);
    expect(result.report).toBeUndefined();
  });
});

describe("numeric contract for the new event types (rejections AND over-rejection guards)", () => {
  it("invoice.finalized: amount_cents required — absent rejects, present-and-sane passes", () => {
    expect(numericContractViolation("invoice.finalized", {})?.field).toBe("amount_cents");
    expect(numericContractViolation("invoice.finalized", { amount_cents: 12_500, currency: "USD" })).toBeNull();
  });

  it("charge.*: negative amounts reject (unsigned surface), non-integers reject", () => {
    expect(numericContractViolation("charge.succeeded", { amount_cents: -1 })?.reason).toMatch(/non-negative/);
    expect(numericContractViolation("charge.failed", { amount_cents: 10.5 })?.reason).toMatch(/integer/);
  });

  it("OVER-REJECTION GUARD: amounts above plausibleMax (8-digit Stripe charge bound) are ACCEPTED — warn-tier, never quarantined", () => {
    expect(numericContractViolation("charge.succeeded", { amount_cents: 100_000_000 })).toBeNull();
    expect(numericContractViolation("invoice.finalized", { amount_cents: 100_000_000 })).toBeNull();
  });

  it("currency: optional (absent passes), present-but-malformed rejects naming the field", () => {
    expect(numericContractViolation("charge.succeeded", { amount_cents: 1 })).toBeNull();
    expect(numericContractViolation("charge.succeeded", { amount_cents: 1, currency: "usd" })?.field).toBe("currency");
  });
});
