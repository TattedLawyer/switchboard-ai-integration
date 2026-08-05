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
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

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
  return new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID,
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

    const c = connectorFor("sheets", DEFAULT_TENANT_ID);
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
    const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID, { sheetsNudge: () => c.nudge(pool) }));
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
    const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID, { sheetsNudge: () => c.nudge(pool) }));

    const body = notification(sheets);
    const res = await postNudge(port, body, signBody(body, "demo-secret-sheets"));
    expect(res.status).toBe(202);
    // The handler awaits the coalescing nudge() directly (v1, disclosed: the mock is
    // in-process; a scheduler is out of scope), so by the time 202 lands the catchUp ran.
    expect(await rawSheetEvents(pool)).toHaveLength(6);
  });

  it("a deployment that never configured sheets answers 404 on the nudge door — never the anonymous, repeatable 500 of cold review I3", async () => {
    // I3: the door is mounted unconditionally and resolves the sheets secret per
    // request. On a deploy that never opted into sheets (no WEBHOOK_SECRET_SHEETS, no
    // dev opt-in) that resolution THREW, so any anonymous POST minted a 500 plus a
    // server-side error log, repeatable at will. Fail-closed here means ABSENT: with
    // no secret there is nothing to verify against, so the route is effectively not
    // there — 404 (mirroring the unknown-source shape). 401 stays reserved for the
    // configured-but-badly-signed case pinned above.
    const saved = {
      allow: process.env.ALLOW_DEV_SECRETS,
      secret: process.env.WEBHOOK_SECRET_SHEETS,
    };
    delete process.env.ALLOW_DEV_SECRETS;
    delete process.env.WEBHOOK_SECRET_SHEETS;
    try {
      const { sheets } = startSheet();
      const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID)); // sheets never configured here
      const body = notification(sheets);

      const unsigned = await postNudge(port, body);
      expect(unsigned.status).toBe(404);
      // Even a correctly-formed demo signature gets 404, not 401: with no secret
      // configured there is no verification to fail — the door does not exist.
      const signed = await postNudge(port, body, signBody(body, "demo-secret-sheets"));
      expect(signed.status).toBe(404);
    } finally {
      if (saved.allow !== undefined) process.env.ALLOW_DEV_SECRETS = saved.allow;
      if (saved.secret !== undefined) process.env.WEBHOOK_SECRET_SHEETS = saved.secret;
    }
    expect(await rawSheetEvents(pool)).toHaveLength(0);
    expect(await quarantineRows(pool)).toHaveLength(0);
  });

  it("a signed nudge in a process with NO sheets runner wired answers 503 — accepting a nudge that can have no effect would be a lie to the channel", async () => {
    const { sheets } = startSheet();
    const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID)); // no sheetsNudge hook
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
    const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID));
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
    const { port } = startIngest(createIngestApp(pool, DEFAULT_TENANT_ID, { sheetsNudge: () => c.nudge(pool) }));
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

// ── A5 pair 2 — the stage-1 oracle: sheet ⇄ RAW convergence, quarantine-aware ────────────

// The oracle's expectation of "which rows the door refuses" is deliberately RE-STATED
// here, not imported from the connector: an expectation computed by the code under test
// would follow that code into any regression. It mirrors the L1 contract for the two
// sheet fields with rules — amount_cents (strict integer/2dp shapes, ≤13 whole digits;
// anything else rides through as a raw string and the contract refuses it) and currency
// (^[A-Z]{3}$). Empty cells are ABSENT (the contract's absence rule), so "" never fails
// anything — that is exactly why only 3 of the mock's 4 garbage currencies quarantine.
const AMOUNT_OK = /^\d{1,13}(\.\d{1,2})?$/;
const CURRENCY_OK = /^[A-Z]{3}$/;
function doorFailure(content: Record<string, string>): "amount_cents" | "currency" | null {
  if (content.amount_cents !== undefined && !AMOUNT_OK.test(content.amount_cents.trim())) {
    return "amount_cents";
  }
  if (content.currency !== undefined && !CURRENCY_OK.test(content.currency)) return "currency";
  return null;
}

/** The sheet's own current truth, row by row. Content/hash use the connector's canonical
 *  convention (shared spelling — hashes must be comparable to quarantine payloads); the
 *  door VERDICT comes from the independent predicate above. */
function sheetTruth(sheets: SheetsApp): { rowKey: string; content: Record<string, string>; hash: string; failure: string | null }[] {
  const grid = sheets.sheet.values();
  const mapping = resolveHeaderMapping(grid.header);
  return sheets.sheet.metadata().map(({ rowKey, rowIndex }) => {
    const content = canonicalRowContent(mapping, grid.rows[rowIndex]);
    return { rowKey, content, hash: contentHash(content), failure: doorFailure(content) };
  });
}

/**
 * The quarantine-aware accounting identity, asserted in full:
 *
 *   sheet rows  =  raw-latest-CURRENT rows  +  quarantined-current rows
 *
 * where "quarantined-current" is defined precisely as: the row's LATEST sheet content
 * fails the door. A row whose garbage was later fixed and re-ingested counts as CLEAN,
 * however many quarantine entries its past left behind — the definition looks only at
 * current content. Concretely:
 *   - `extra` is always empty (tombstones carry no field rules; deletes always land);
 *   - `stale` ∪ `missing` is EXACTLY the quarantined-current set (stale = an older clean
 *     version is live in raw; missing = no version ever landed — M3's conflation,
 *     resolved here by consulting the quarantine table rather than excusing the buckets);
 *   - every quarantined-current row has a quarantine entry for its CURRENT content hash
 *     whose reason names the failing field.
 */
async function expectQuarantineAwareConvergence(
  db: pg.Pool,
  sheets: SheetsApp,
  c: SheetSnapshotConnector,
): Promise<void> {
  const truth = sheetTruth(sheets);
  const failing = new Map(truth.filter((r) => r.failure !== null).map((r) => [r.rowKey, r]));

  const rec = await c.reconcile(db);
  expect(rec.integrity.ok).toBe(true);
  const rep = rec.report!;
  expect(rep.ledger).toBe(truth.length);
  expect(rep.extra).toEqual([]);
  expect([...rep.stale, ...rep.missing].sort()).toEqual([...failing.keys()].sort());
  // The identity itself: converged (raw-latest-current) + quarantined-current = sheet rows.
  const converged = rep.ledger - rep.stale.length - rep.missing.length;
  expect(converged + failing.size).toBe(truth.length);

  const q = await quarantineRows(db);
  for (const [rowKey, row] of failing) {
    const entry = q.find((e) => e.row_key === rowKey && e.hash === row.hash);
    expect(entry, `row ${rowKey}: latest content failed the door (${row.failure}) but has no quarantine entry for its current hash`).toBeDefined();
    expect(entry!.reason).toContain(row.failure!);
  }
}

/** Bounded persistence for the 429-heavy seed: a cycle may exhaust its attempts and fail
 *  LOUDLY (that is the connector's documented posture — stateless, next cycle re-diffs);
 *  the ORACLE's claim is that convergence is still reached across cycles. */
async function withRetries<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

describe("A5 pair 2 — stage-1 oracle: convergence under every seeded fault plan", () => {
  // Seeded, interleaved, deterministic: N editor steps with a catchUp every 4th step
  // (mid-run cycles observe half-finished mess — that is the point), then a final
  // catchUp and the full quarantine-aware accounting. Per-plan seeds are fixed so a
  // red run is reproducible bit-for-bit.
  const PLAN_SEEDS = { calm: 101, messy: 102, bulk: 103, hostile: 104 } as const;
  const STEPS = 36;

  for (const plan of ["calm", "messy", "bulk", "hostile"] as const) {
    it(`plan "${plan}": ${STEPS} seeded steps with interleaved cycles → sheet ⇄ raw converges, every quarantined row accounted`, async () => {
      const { sheets, baseUrl } = startSheet({ seed: PLAN_SEEDS[plan], rowCount: 8 });
      const c = mkConnector(baseUrl);
      await c.catchUp(pool); // baseline: the seeded book ingests

      for (let i = 1; i <= STEPS; i++) {
        sheets.editor.applyStep(plan);
        if (i % 4 === 0) await c.catchUp(pool);
      }
      await c.catchUp(pool); // final cycle

      await expectQuarantineAwareConvergence(pool, sheets, c);

      if (plan === "calm" || plan === "bulk") {
        // These mixes contain no garbage ops at all: convergence must be LITERALLY clean
        // (empty buckets, empty quarantine), not merely accounted-for.
        const rec = await c.reconcile(pool);
        expect(rec.report).toMatchObject({ missing: [], stale: [], extra: [] });
        expect(await quarantineRows(pool)).toHaveLength(0);
      }
      if (plan === "hostile") {
        // The hostile rotation guarantees every garbage class within 12 steps, so over
        // 36 steps the door MUST have refused something — an all-green hostile run with
        // an empty quarantine would mean the oracle tested nothing.
        expect((await quarantineRows(pool)).length).toBeGreaterThan(0);
      }
    });
  }
});

describe("A5 pair 2 — quarantine accounting, pinned at the edges", () => {
  it("M2: a blank row ingests CLEAN as a field-less upsert — fields absent per the contract's absence rule, nothing quarantined", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);

    sheets.sheet.apply({ type: "insert_blank_row", position: 0 });
    const report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(1);
    expect(report.quarantined).toBe(0);

    const rows = await rawSheetEvents(pool);
    const blank = rows[rows.length - 1].payload.data as Record<string, unknown>;
    // Entity-less by design: row_key + content_hash + the honesty flag, nothing else.
    expect(Object.keys(blank).sort()).toEqual(["content_hash", "occurred_at_derived", "row_key"]);
    await expectQuarantineAwareConvergence(pool, sheets, c);
  });

  it("M4: garbage currencies quarantine 3-of-4 — '' degrades to ABSENT and ingests clean; the three real garbage variants quarantine naming currency", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);

    // One variant per row: ["usd", "US Dollars", "₱", ""] onto rows 0..3.
    const rks = sheets.sheet.metadata().slice(0, 4).map((m) => m.rowKey);
    GARBAGE_CURRENCIES.forEach((value, i) => {
      sheets.sheet.apply({ type: "garbage_currency", rowKey: rks[i], value });
    });

    const report = await c.catchUpWithReport(pool);
    // Do NOT expect 4/4: "" empties the cell, the cell becomes an absent field, and
    // absent passes the optional-currency rule. That row is a real content change (it
    // LOST its currency) and ingests clean.
    expect(report.quarantined).toBe(3);
    expect(report.ingested).toBe(1);

    const q = await quarantineRows(pool);
    expect(q.map((e) => e.row_key).sort()).toEqual(rks.slice(0, 3).sort());
    for (const e of q) expect(e.reason).toContain("currency");

    // The ""-row's landed event genuinely has no currency field: its LATEST raw event
    // (insertion order) is the emptied re-upsert.
    const rows = await rawSheetEvents(pool);
    const forRow = rows.filter((r) => (r.payload.data as Record<string, unknown>).row_key === rks[3]);
    expect(forRow).toHaveLength(2); // seed upsert + the emptied re-upsert
    expect(forRow[1].payload.data as Record<string, unknown>).not.toHaveProperty("currency");
    await expectQuarantineAwareConvergence(pool, sheets, c);
  });

  it("fix-after-quarantine (THE pin): 'quarantined-current' means the row's LATEST content failed the door — a fixed row counts clean, and the identity holds at every stage", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);
    const [rk1, rk2] = sheets.sheet.metadata().slice(0, 2).map((m) => m.rowKey);

    // Stage 1: two humans make two different messes — an unparseable amount and a
    // garbage currency. Both quarantine, reasons naming their fields; both rows are
    // quarantined-current; identity: 6 sheet rows = 4 converged + 2 quarantined-current.
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk1, column: COL.amount, value: "US$ 500" });
    sheets.sheet.apply({ type: "garbage_currency", rowKey: rk2, value: "usd" });
    let report = await c.catchUpWithReport(pool);
    expect(report.quarantined).toBe(2);
    await expectQuarantineAwareConvergence(pool, sheets, c);
    let rec = await c.reconcile(pool);
    expect(rec.report!.stale.sort()).toEqual([rk1, rk2].sort());

    // Stage 2: the amount cell is FIXED in the sheet. The fixed row re-ingests clean and
    // leaves the quarantined-current set — its quarantine HISTORY stays in the table
    // (evidence, replayable), but the definition looks only at latest content. The
    // still-garbage currency row re-quarantines (each cycle re-attempts the mismatch —
    // one more entry, same reason). Identity: 6 = 5 converged + 1 quarantined-current.
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk1, column: COL.amount, value: "750.00" });
    report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(1);
    expect(report.quarantined).toBe(1); // rk2, again
    await expectQuarantineAwareConvergence(pool, sheets, c);
    rec = await c.reconcile(pool);
    expect(rec.report!.stale).toEqual([rk2]);
    // rk1's history is still on file — clean-now must not mean scrubbed-then.
    expect((await quarantineRows(pool)).filter((e) => e.row_key === rk1).length).toBeGreaterThan(0);

    // Stage 3: the currency cell is fixed too. Fully clean; identity: 6 = 6 + 0.
    sheets.sheet.apply({ type: "edit_cell", rowKey: rk2, column: COL.currency, value: "PHP" });
    report = await c.catchUpWithReport(pool);
    expect(report.ingested).toBe(1);
    expect(report.quarantined).toBe(0);
    await expectQuarantineAwareConvergence(pool, sheets, c);
    rec = await c.reconcile(pool);
    expect(rec.report).toMatchObject({ missing: [], stale: [], extra: [] });
  });
});

describe("A5 pair 2 — standing scenarios", () => {
  it("ABA soak: deliberate reverts every cycle across three rows — convergence after EVERY cycle, and the supersession salt visibly did the landing (A4.1 at oracle scale)", async () => {
    // The seeded plans cannot GUARANTEE reverts (they merely make them likely), so this
    // standing scenario drives the editor primitives directly — the brief's sanctioned
    // fallback — and toggles three rows A→B→A→… for eight cycles. Pre-A4.1 the first
    // full toggle left reconcile permanently stale; here every cycle must read clean.
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);

    const rks = sheets.sheet.metadata().slice(0, 3).map((m) => m.rowKey);
    const original = rks.map((rk) => sheets.sheet.rowByKey(rk)!.cells[COL.status]);

    for (let cycle = 1; cycle <= 8; cycle++) {
      rks.forEach((rk, i) => {
        const value = cycle % 2 === 1 ? "renegotiating" : original[i];
        sheets.sheet.apply({ type: "edit_cell", rowKey: rk, column: COL.status, value });
      });
      expect(await c.catchUp(pool)).toBe(3); // every swing LANDS — nothing dedupes away
      const rec = await c.reconcile(pool);
      expect(rec.integrity.ok).toBe(true);
      expect(rec.report).toMatchObject({ missing: [], stale: [], extra: [] });
    }

    // The mechanism, not just the outcome: repeated re-sightings carry incrementing -r<n>
    // salts. 8 cycles × 3 rows on two alternating contents ⇒ suffixes up to -r3 exist.
    const ids = (await rawSheetEvents(pool)).map((r) => r.event_id);
    expect(ids.filter((id) => /-r\d+$/.test(id)).length).toBeGreaterThan(0);
    expect(ids.some((id) => id.endsWith("-r3"))).toBe(true);
  });

  it("429-heavy seed: a 35% read-quota storm end-to-end — cycles retry through it (bounded, seeded, observed) and convergence is still reached", async () => {
    const { sheets, baseUrl } = startSheet({
      seed: 11,
      rowCount: 6,
      read429: { seed: 5, rate: 0.35 },
    });
    const c = mkConnector(baseUrl);
    await withRetries(() => c.catchUp(pool), 5);

    for (let i = 1; i <= 24; i++) {
      sheets.editor.applyStep("calm");
      if (i % 6 === 0) await withRetries(() => c.catchUp(pool), 5);
    }
    await withRetries(() => c.catchUp(pool), 5);

    // The storm was real and the backoff worked through it — not a lucky quiet stream.
    expect(c.stats().retried429).toBeGreaterThan(0);

    const rec = await withRetries(async () => {
      const r = await c.reconcile(pool);
      if (!r.integrity.ok) throw new Error(r.integrity.detail ?? "integrity failure");
      return r;
    }, 5);
    expect(rec.report).toMatchObject({ missing: [], stale: [], extra: [] });
    expect(await quarantineRows(pool)).toHaveLength(0); // calm content: the storm quarantines nothing
  });
});

// ── PRE-3 / #33 — a column REORDER, finally exercised ────────────────────────────────
//
// The register entry ("column reorder is UNPROVEN against a real sheet") carried a
// supporting sentence — "no test can exercise a reorder" — that was false as stated. It
// described the mock we wrote, whose `rename_header` changes labels and never positions,
// not the world, where a human drags a column and everything under it moves. The sheets
// mock now models `move_column`, so the claim can be tested.
//
// The entry is NOT retired by this, and the wording is deliberate: proving the connector
// against our own mock is a weaker oracle than a real spreadsheet, and the headline claim
// stays true. What changes is that "expected-safe by construction" — the connector
// resolves positions by header NAME on every fetch and caches nothing — becomes
// "expected-safe by construction AND exercised". A pass here was the expected outcome;
// the value is that a future change which starts caching positions now reds.
describe("PRE-3 #33 — the connector survives a column reorder because it resolves by name, not position", () => {
  it("a reorder between cycles produces NO events: same rows, same content, same hashes", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    const first = await c.catchUp(pool);
    expect(first).toBeGreaterThan(0);

    const before = await pool.query(
      `select event_id, payload->'data'->>'content_hash' as h from raw.raw_events
        where source = 'sheets' order by event_id`,
    );

    // The human drags Currency to the front. Every header label and every cell moves.
    sheets.sheet.apply({ type: "move_column", from: COL.currency, to: 0 });

    // THE ASSERTION. A position-caching connector would now hash different content for
    // every row and emit a full grid of spurious "changed" events.
    expect(await c.catchUp(pool)).toBe(0);
    const after = await pool.query(
      `select event_id, payload->'data'->>'content_hash' as h from raw.raw_events
        where source = 'sheets' order by event_id`,
    );
    expect(after.rows).toEqual(before.rows);
  });

  it("reconcile stays clean across the reorder — the gate does not read a permutation as drift", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);
    sheets.sheet.apply({ type: "move_column", from: COL.notes, to: COL.clientName });

    const { report } = await c.reconcile(pool);
    expect(report!.missing).toEqual([]);
    expect(report!.extra).toEqual([]);
    expect(report!.stale).toEqual([]);
  });

  it("a REAL edit still lands after a reorder — the reorder must not deafen the connector", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = mkConnector(baseUrl);
    await c.catchUp(pool);
    sheets.sheet.apply({ type: "move_column", from: COL.status, to: COL.email });

    const rowKey = sheets.sheet.metadata()[0].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey, column: COL.notes, value: "post-reorder note" });
    expect(await c.catchUp(pool)).toBe(1);
  });
});
