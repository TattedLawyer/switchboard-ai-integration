import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type pg from "pg";
// The REAL mock, in-process — same cross-workspace precedent as sheet-snapshot.test.ts.
import {
  COL,
  GARBAGE_CURRENCIES,
  createSheetsApp,
  type SheetsApp,
  type SheetsAppOptions,
} from "../../mocks/sheets/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { createIngestApp } from "../src/server.js";
import { signBody } from "../src/hmac.js";
import { connectorFor } from "../src/connectors/index.js";
import { SheetSnapshotConnector } from "../src/connectors/sheet-snapshot.js";
import {
  canonicalRowContent,
  contentHash,
  resolveHeaderMapping,
} from "../src/connectors/sheet-canonical.js";

// Task A5 — sheets as a first-class source. Two RED→GREEN pairs, named:
//   pair 1 "registration + nudge": the registry arm + env conventions resolve end-to-end
//                                  (sources.test.ts / connector-seam.test.ts carry the
//                                  spec-changed pins); the nudge door is HMAC-verified,
//                                  thin, and latency-only; the generic event door stays
//                                  CLOSED for sheets; drop-heavy trigger still converges.
//   pair 2 "oracle + docs":        the stage-1 oracle — sheet ⇄ RAW convergence under all
//                                  four seeded fault plans with quarantine-aware
//                                  accounting, the ABA soak, and the 429-heavy seed.
// Warehouse/identity consumption is deliberately absent: that is A6's separately gated
// stage 2. Nothing here reads past raw.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let srv: Server | undefined; // mock sheet server
let ingestSrv: Server | undefined; // ingest HTTP server (nudge-door tests)

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  srv?.close();
  srv = undefined;
  ingestSrv?.close();
  ingestSrv = undefined;
  delete process.env.SHEETS_BASE_URL;
  await cleanup();
});

function startSheet(opts?: Partial<SheetsAppOptions>): { sheets: SheetsApp; baseUrl: string } {
  const sheets = createSheetsApp({ seed: 7, rowCount: 6, ...opts });
  srv = sheets.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  return { sheets, baseUrl: `http://127.0.0.1:${port}` };
}

/** Direct construction for the heavy oracle runs: the registry path is pinned once below
 *  (and in the seam tests); the soaks need the report-widening methods and small backoff
 *  numbers, which the seam's `Connector` deliberately does not expose. */
function mkConnector(baseUrl: string): SheetSnapshotConnector {
  return new SheetSnapshotConnector({
    baseUrl,
    timeoutMs: 3000,
    backoff: { baseMs: 5, capMs: 50, maxAttempts: 6 },
  });
}

function startIngest(app: ReturnType<typeof createIngestApp>): { port: number } {
  ingestSrv = app.listen(0);
  return { port: (ingestSrv.address() as { port: number }).port };
}

async function postNudge(
  port: number,
  body: string,
  signature?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}/connectors/sheets/nudge`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== undefined ? { "x-switchboard-signature": signature } : {}),
    },
    body,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** The thin notification the mock's trigger channel posts — carries NO row values. */
const notification = (sheets: SheetsApp): string =>
  JSON.stringify({
    sheet_id: sheets.sheet.sheetId,
    range: "A2:I2",
    occurred_at: new Date().toISOString(),
  });

async function rawSheetEvents(
  db: pg.Pool,
): Promise<{ event_id: string; event_type: string; payload: Record<string, unknown> }[]> {
  const res = await db.query(
    "select event_id, event_type, payload from raw.raw_events where source = 'sheets' order by id",
  );
  return res.rows;
}

async function quarantineRows(
  db: pg.Pool,
): Promise<{ reason: string; row_key: string | null; hash: string | null }[]> {
  const res = await db.query(
    `select reason,
            payload->'data'->>'row_key' as row_key,
            payload->'data'->>'content_hash' as hash
       from ingest.quarantine order by id`,
  );
  return res.rows;
}

// ── A5 pair 1 — registration + nudge ─────────────────────────────────────────────────────

describe("A5 pair 1 — registration: sheets resolves through the registry and its env conventions", () => {
  it("connectorFor('sheets') is the snapshot connector wired to SHEETS_BASE_URL — catchUp and reconcile work end-to-end through the registry, no direct construction", async () => {
    const { baseUrl } = startSheet();
    process.env.SHEETS_BASE_URL = baseUrl;

    const c = connectorFor("sheets");
    expect(c.kind).toBe("sheet-snapshot");
    expect(c.source).toBe("sheets");

    expect(await c.catchUp(pool)).toBe(6);
    const rec = await c.reconcile(pool);
    expect(rec.skipped).toBeUndefined();
    expect(rec.integrity.ok).toBe(true);
    expect(rec.report).toMatchObject({ ledger: 6, raw: 6, missing: [], extra: [] });
  });
});

describe("A5 pair 1 — nudge door: HMAC-verified, thin, latency-only", () => {
  it("an unsigned (or wrongly-signed) nudge is REJECTED with 401 and never quarantined — unlike the event doors, a nudge carries no data worth preserving", async () => {
    // Contrast with the event doors (server.ts /webhooks/:source): there, an
    // authenticated-but-malformed EVENT is quarantined because the payload itself is the
    // asset — replayable evidence of something a vendor delivered exactly once. A nudge
    // is a thin {sheet_id, range, occurred_at} hint whose only meaning is "read the
    // sheet soon"; the sheet's truth is re-readable at will, so a forged or unsigned
    // nudge preserves nothing and is pure noise. Reject, don't file.
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    const { port } = startIngest(createIngestApp(pool, { sheetsNudge: () => c.nudge(pool) }));
    const body = notification(sheets);

    const unsigned = await postNudge(port, body);
    expect(unsigned.status).toBe(401);
    const wrongSecret = await postNudge(port, body, signBody(body, "demo-secret-crm"));
    expect(wrongSecret.status).toBe(401);

    // Rejected means rejected: no quarantine row, no raw row, no catchUp side effect.
    expect(await quarantineRows(pool)).toHaveLength(0);
    expect(await rawSheetEvents(pool)).toHaveLength(0);
  });

  it("a signed nudge answers 202 and the early catchUp actually RAN — the ingested delta is observable in raw", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    const { port } = startIngest(createIngestApp(pool, { sheetsNudge: () => c.nudge(pool) }));

    const body = notification(sheets);
    const res = await postNudge(port, body, signBody(body, "demo-secret-sheets"));
    expect(res.status).toBe(202);
    // The handler awaits the coalescing nudge() directly (v1, disclosed: the mock is
    // in-process; a scheduler is out of scope), so by the time 202 lands the catchUp ran.
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("a signed nudge in a process with NO sheets runner wired answers 503 — accepting a nudge that can have no effect would be a lie to the channel", async () => {
    const { sheets } = startSheet();
    const { port } = startIngest(createIngestApp(pool)); // no sheetsNudge hook
    const body = notification(sheets);
    const res = await postNudge(port, body, signBody(body, "demo-secret-sheets"));
    expect(res.status).toBe(503);
    expect(await rawSheetEvents(pool)).toHaveLength(0);
  });

  it("POST /webhooks/sheets stays CLOSED (404 pointing at the nudge door) — registration must not open a generic event door into a content-addressed lane", async () => {
    // sheets joined SOURCES for the deployment surface (base URL, secret, port), but its
    // raw lane is connector-born: every event_id is manufactured from row content, and
    // deriveState treats the lane as the connector's own memory. A generic signed event
    // POSTed here would mint a foreign id in that lane and poison every later diff. So
    // the door 404s BY NAME — not the generic "unknown source" fallback — and points at
    // the one push surface sheets actually has.
    const { port } = startIngest(createIngestApp(pool));
    const body = JSON.stringify({
      event_id: "sheet-rk-0001-deadbeefdeadbeef",
      event_type: "sheet.row_upserted",
      occurred_at: new Date().toISOString(),
      data: { row_key: "rk-0001" },
    });
    const res = await fetch(`http://127.0.0.1:${port}/webhooks/sheets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-switchboard-signature": signBody(body, "demo-secret-sheets"),
      },
      body,
    });
    expect(res.status).toBe(404);
    const parsed = (await res.json()) as { error: string };
    expect(parsed.error).toMatch(/nudge/);
    expect(await rawSheetEvents(pool)).toHaveLength(0);
    expect(await quarantineRows(pool)).toHaveLength(0);
  });

  it("drop-heavy trigger (lossiness maxed): most nudges die in flight, some land — and the sheet STILL converges via periodic reconcile-first cycles. Trigger lossiness is irrelevant to correctness", async () => {
    // The paradigm's central claim, end-to-end: push is a latency optimization, reconcile
    // is the guarantee. The trigger channel here loses 85% of notifications (seeded), the
    // survivors arrive as real HTTP posts through the HMAC door, and correctness comes
    // ONLY from the periodic catchUp cycles — which read the sheet's own truth.
    let c!: SheetSnapshotConnector;
    const { port } = startIngest(createIngestApp(pool, { sheetsNudge: () => c.nudge(pool) }));
    const { sheets, baseUrl } = startSheet({
      seed: 21,
      webhookUrl: `http://127.0.0.1:${port}/connectors/sheets/nudge`,
      trigger: { dropRate: 0.85 },
    });
    c = mkConnector(baseUrl);
    await c.catchUp(pool); // baseline

    for (let i = 0; i < 30; i++) {
      sheets.editor.applyStep("calm"); // human path — the only path that fires the trigger
      if (i % 6 === 5) {
        await sheets.trigger!.flush();
        await c.catchUp(pool); // the periodic reconcile-first cycle
      }
    }
    await sheets.trigger!.flush();
    await c.catchUp(pool);

    const stats = sheets.trigger!.stats();
    expect(stats.dropped).toBeGreaterThan(0); // loss really happened (seeded, deterministic)
    expect(stats.posted).toBeGreaterThan(0); // and the surviving nudges were really ACCEPTED
    expect(stats.failed).toBe(0); // none bounced off the door — the wiring is real

    const rec = await c.reconcile(pool);
    expect(rec.integrity.ok).toBe(true);
    expect(rec.report).toMatchObject({ missing: [], stale: [], extra: [] });
    expect(await quarantineRows(pool)).toHaveLength(0); // calm plan: nothing messy
  });
});
