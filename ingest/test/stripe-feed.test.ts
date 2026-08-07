import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { StripeFeedConnector, type StripeFeedGap } from "../src/connectors/stripe-feed.js";
import { numericContractViolation } from "../src/numeric-contract.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

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
async function scriptedFeed(pages: ((req: express.Request, res: express.Response) => void)[]): Promise<{
  baseUrl: Promise<string>;
  urls: string[];
}> {
  const urls: string[] = [];
  let i = 0;
  const app = express();
  app.get("/v1/events", (req, res) => {
    urls.push(req.url);
    const handler = pages[Math.min(i, pages.length - 1)];
    i++;
    handler(req, res);
  });
  srv = await listenLoopback(app);
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
    const { baseUrl, urls } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_a1", t), evt("evt_a2", t)], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    expect(await c.catchUp(pool)).toBe(2);
    expect(urls).toHaveLength(1);
  });

  it("an EMPTY page with has_more=true CONTINUES — emptiness is not done-ness (the f1e7ac4 class, killed by mechanism)", async () => {
    const t = NOW_S() - 60;
    const { baseUrl, urls } = await scriptedFeed([
      (_req, res) => res.json(pageBody([], true)),
      (_req, res) => res.json(pageBody([evt("evt_b1", t)], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    expect(await c.catchUp(pool)).toBe(1);
    expect(urls).toHaveLength(2);
    expect(await rawIds()).toEqual(["evt_b1"]);
  });

  it("a SHORT page (fewer events than limit) with has_more=true continues — count never infers done-ness", async () => {
    const t = NOW_S() - 60;
    const { baseUrl, urls } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_c1", t)], true)),
      (_req, res) => res.json(pageBody([evt("evt_c2", t + 1)], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, pageLimit: 100 });
    expect(await c.catchUp(pool)).toBe(2);
    expect(urls).toHaveLength(2);
  });

  it("an endless empty-but-has_more feed is a BOUNDED failure, not a wedge: maxRounds stops it loudly", async () => {
    const { baseUrl } = await scriptedFeed([(_req, res) => res.json(pageBody([], true))]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    await expect(c.catchUp(pool, { maxRounds: 5 })).rejects.toThrow(/maxRounds|rounds/i);
    expect(await storedCursor()).toBeNull(); // nothing processed, nothing advanced
  });
});

describe("cursor discipline — ours, never the feed's", () => {
  it("persists the id of an event WE processed (max created, id tiebreak) and IGNORES any feed-supplied resume hint", async () => {
    const t = NOW_S() - 60;
    const { baseUrl } = await scriptedFeed([
      // Response position deliberately disagrees with created order, and the body dangles
      // a skip-forward bait the connector must never touch.
      (_req, res) =>
        res.json({ ...pageBody([evt("evt_d3", t + 2), evt("evt_d1", t)], false), next_cursor: "evt_evil" }),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    await c.catchUp(pool);
    expect(await storedCursor()).toBe("evt_d3"); // max created — not response-last, not the bait
  });

  it("orders ingestion by created (id tiebreak), never by response position", async () => {
    const t = NOW_S() - 60;
    const { baseUrl } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_e2", t + 5), evt("evt_e1", t), evt("evt_e0", t)], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    await c.catchUp(pool);
    // raw's bigserial order = processing order: created asc, then id asc on the tie.
    expect(await rawIds()).toEqual(["evt_e0", "evt_e1", "evt_e2"]);
  });

  it("a mid-drain failure leaves the cursor at the last fully-processed page; the re-run resumes with no loss and no duplicates", async () => {
    const t = NOW_S() - 60;
    let phase2 = false;
    const { baseUrl } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_f1", t), evt("evt_f2", t + 1)], true)),
      (req, res) => {
        if (!phase2) return res.status(500).json({ error: { type: "api_error", message: "boom" } });
        // Resumed run: verify it resumes FROM our cursor, then close the feed.
        expect(req.query.starting_after).toBe("evt_f2");
        res.json(pageBody([evt("evt_f3", t + 2)], false));
      },
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
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
    const { baseUrl } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_g1", t), bad], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
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
    const { baseUrl } = await scriptedFeed([
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
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(2); // forward progress
    expect(await storedCursor()).toBe("evt_h3");
    const gap: StripeFeedGap = report.gaps[0];
    expect(gap).toMatchObject({ fromEventId: "evt_h1", cause: "retention" });
    expect(gap.fromOccurredAt).toBe(new Date(tOld * 1000).toISOString());
    expect(gap.toOccurredAt).toBe(new Date(tNew * 1000).toISOString()); // earliest retained
  });

  it("a 400 that is NOT the aged-cursor shape stays a loud failure — never silently treated as retention", async () => {
    const { baseUrl } = await scriptedFeed([
      (_req, res) =>
        res.status(400).json({ error: { type: "invalid_request_error", param: "limit", message: "Invalid integer" } }),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
    await expect(c.catchUp(pool)).rejects.toThrow(/400/);
  });
});

describe("fetch discipline (register L1-G4 paid here)", () => {
  it("a black-holed feed is a BOUNDED loud failure via AbortSignal.timeout — never a wedge; cursor intact", async () => {
    const { baseUrl } = await scriptedFeed([(_req, _res) => void 0 /* never responds */]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, timeoutMs: 150 });
    const t0 = Date.now();
    await expect(c.catchUp(pool)).rejects.toThrow(/timed out/i);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await storedCursor()).toBeNull();
  });

  it("429s retry with bounded deterministic backoff, then succeed", async () => {
    const t = NOW_S() - 60;
    let calls = 0;
    const { baseUrl, urls } = await scriptedFeed([
      (_req, res) => {
        calls++;
        if (calls <= 2) {
          return res.status(429).json({ error: { type: "rate_limit_error", message: "slow down" } });
        }
        res.json(pageBody([evt("evt_i1", t)], false));
      },
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, backoff: { baseMs: 5, capMs: 20, maxAttempts: 4 } });
    expect(await c.catchUp(pool)).toBe(1);
    expect(urls.length).toBe(3);
  });

  it("reconcile against an unreachable feed reports integrity failure with NO report — never a confident diff against nothing", async () => {
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: "http://127.0.0.1:1", timeoutMs: 200 });
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
    const { baseUrl } = await scriptedFeed([(_req, res) => res.json(page)]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl });
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

// ── Task D review addendum (adjudication i) ───────────────────────────────────────────
//
// The defect the bus oracle found, confirmed in the OLDER paradigm and worse there: one
// envelope whose `created` is not a number made stripefeed's reconcile return
// integrity:false with NO report, blinding the comparison across the feed's whole
// THIRTY-DAY window — ten times the bus's blast radius. The connector's own two halves
// disagreed about it: the drain quarantines that same envelope (occurred_at fails the
// schema gate) and keeps going, while reconcile treated it as an unreadable source.
//
// The rule these pins establish, matching what landed on the bus side: a missing
// IDENTITY is still fatal (there is nothing to compare against raw), but a bad TIMESTAMP
// is bad DATA — the event counts toward the retained window, contributes no timestamp,
// and is excluded from the aged-out boundary arithmetic rather than poisoning it.
describe("addendum — one malformed `created` must not blind a thirty-day window", () => {
  it("a retained window containing ONE non-numeric `created` still reconciles; the rest of the window is compared normally", async () => {
    const now = NOW_S();
    const good = [evt("evt_a", now - 100), evt("evt_b", now - 90)];
    const malformed = { ...evt("evt_bad", now - 95), created: "2026-07-30T00:00:00Z" as unknown as number };

    const { baseUrl } = await scriptedFeed([
      (_req, res) => res.json(pageBody([...good, malformed] as StubEvent[], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, pageLimit: 100 });

    const result = await c.reconcile(pool);
    // Before the fix: integrity false, report undefined — the whole window unreadable.
    expect(result.integrity.ok).toBe(true);
    expect(result.report).toBeDefined();
    // The malformed event is really THERE, so it counts toward the window…
    expect(result.report!.ledger).toBe(3);
    // …and it is reported as missing-from-raw like any other un-ingested event, which is
    // the honest classification: nothing was ingested here at all.
    expect(result.report!.missing).toEqual(["evt_a", "evt_b", "evt_bad"]);
  });

  it("TRAP A — one NaN in the retained set must not EMPTY the `extra` bucket: a raw row inside the window is still flagged", async () => {
    // Direction matters, and the first version of this pin got it backwards while
    // claiming to prove it. With NaN in the retained set, `Math.min` yields NaN,
    // `occurredMs >= NaN` is FALSE for every row, and every unretained raw row therefore
    // falls to the `else` branch — so the bug SUPPRESSES `extra` entirely. It is a false
    // NEGATIVE: the real-anomaly bucket silently empties. (The superseded pin placed its
    // raw row OUTSIDE the window, where both versions answer {extra: 0, aged: 1}, so it
    // passed with and without the fix — it survived its own revert and proved nothing.)
    const now = NOW_S();

    // Inside the window: NEWER than the earliest well-formed retained event, and no
    // longer served by the feed. That combination cannot be an age-out, so it is exactly
    // the real anomaly `extra` exists to report.
    await pool.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ('stripefeed', 'evt_vanished', 'charge.succeeded', $1)`,
      [JSON.stringify({ event_id: "evt_vanished", event_type: "charge.succeeded", occurred_at: new Date((now - 50) * 1000).toISOString(), data: {} })],
    );
    // And one genuinely aged-out row, so the two buckets are told apart rather than
    // merely counted.
    await pool.query(
      `insert into raw.raw_events (source, event_id, event_type, payload)
       values ('stripefeed', 'evt_old', 'charge.succeeded', $1)`,
      [JSON.stringify({ event_id: "evt_old", event_type: "charge.succeeded", occurred_at: new Date((now - 10_000) * 1000).toISOString(), data: {} })],
    );

    const malformed = { ...evt("evt_bad", now - 95), created: null as unknown as number };
    const { baseUrl } = await scriptedFeed([
      (_req, res) => res.json(pageBody([evt("evt_a", now - 100), malformed] as StubEvent[], false)),
    ]);
    const c = new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, pageLimit: 100 });

    const result = await c.reconcile(pool);
    expect(result.integrity.ok).toBe(true);
    // THE discriminating assertion: buggy ⇒ [] (bucket emptied), fixed ⇒ ["evt_vanished"].
    expect(result.report!.extra).toEqual(["evt_vanished"]);
    // …and the genuine age-out is still classified as metabolism, not swept up with it.
    expect(result.report!.agedOutRaw).toBe(1);
  });

  it("TRAP B — cursor selection is ORDER-INVARIANT: a timestamp-less envelope cannot win the paging cursor by arriving first", async () => {
    // The trap: `deepest === null` accepts the first candidate unconditionally, and every
    // later comparison against a NaN `created` is false — so a malformed envelope taken
    // first can never be displaced, and the paging cursor becomes a function of ARRIVAL
    // ORDER. That is precisely the response-position dependence this connector exists to
    // refuse (the feed's ordering is undocumented and the mock shuffles).
    const now = NOW_S();
    const a = evt("evt_a", now - 100);
    const b = evt("evt_b", now - 90);
    const bad = { ...evt("evt_bad", now - 95), created: undefined as unknown as number } as StubEvent;

    // Same candidate SET, two arrival orders — malformed last, then malformed first.
    const cursorFor = async (page1: StubEvent[]): Promise<string | undefined> => {
      const { baseUrl, urls } = await scriptedFeed([
        (_req, res) => res.json(pageBody(page1, true)),
        (_req, res) => res.json(pageBody([], false)),
      ]);
      const result = await new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, pageLimit: 100 }).reconcile(pool);
      expect(result.integrity.ok).toBe(true);
      srv?.close();
      srv = undefined;
      // The cursor the connector chose is observable as the second request's parameter.
      return new URL(`http://x${urls[1]}`).searchParams.get("starting_after") ?? undefined;
    };

    const malformedLast = await cursorFor([a, bad, b]);
    const malformedFirst = await cursorFor([bad, a, b]);

    expect(malformedLast).toBe(malformedFirst);
    // And it is the deepest WELL-FORMED envelope — never the one with no timestamp.
    expect(malformedLast).toBe("evt_b");
  });

  it("a missing IDENTITY is still fatal — there is nothing to compare against raw", async () => {
    const now = NOW_S();
    const noId = { ...evt("evt_a", now - 100), id: undefined as unknown as string };
    const { baseUrl } = await scriptedFeed([(_req, res) => res.json(pageBody([noId] as StubEvent[], false))]);

    const result = await new StripeFeedConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl: await baseUrl, pageLimit: 100 }).reconcile(pool);
    expect(result.integrity.ok).toBe(false);
    expect(result.report).toBeUndefined();
    expect(result.integrity.detail).toMatch(/id/);
  });
});
