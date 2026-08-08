import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type pg from "pg";
import { createBillingApp } from "../../mocks/billing/src/server.js";
import { freshTestDb } from "./helpers/testdb.js";
import { catchUp } from "../src/backfill.js";
import { reconcile, verifyLedgerChain } from "../src/reconcile.js";
import { connectorFor, connectorKinds } from "../src/connectors/index.js";
import { SOURCES } from "../src/sources.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";
import { listenLoopback } from "@switchboard/mock-core";

// Phase 2b Task 1 — the connector seam.
//
// Today every source is assumed to be the SAME shape: an HTTP `/events` cursor feed plus a
// JSONL hash-chained ledger file. cli/backfill.ts hardcodes baseUrlFor(); cli/reconcile.ts
// hardcodes ledgerPathFor() + verifyLedgerChain(). A Google Sheets source has neither — no
// /events endpoint, and its "ledger" is the sheet's own rows read back through the API.
//
// This test pins the seam BEFORE the vendor-faithful sources exist, and its whole job is to
// prove the refactor is BEHAVIOR-PRESERVING: every existing source, driven through the new
// Connector interface, must produce results identical to calling the old functions directly.
// If these pass, the seam is safe to build the new connectors on. If a later change to the
// ledger-feed connector drifts from the functions it replaced, these go red.

let pool: pg.Pool;
let cleanup: () => Promise<void>;
let dir: string;
let srv: Server;
let baseUrl: string;
let ledgerPath: string;

// A fresh database PER TEST. Each test also mints a fresh ledger, and reconcile compares the
// two — so a database shared across tests would carry earlier tests' raw rows and every
// reconcile after the first would report phantom "extra" events.
beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  cleanup = result.cleanup;
});
afterEach(async () => {
  srv?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  await cleanup();
});

async function startLedgerMock(count: number): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "seam-"));
  ledgerPath = join(dir, "ledger-billing.jsonl");
  // Black-hole webhook + dropRate 1: the push path is deliberately disabled so everything must
  // arrive via the pull path, which is what these tests are about. Same pattern as
  // backfill.test.ts. The ledger still records every event, so it remains the full expectation.
  const app = createBillingApp({ ledgerPath, webhookUrl: "http://127.0.0.1:1" });
  srv = await listenLoopback(app);
  const port = (srv.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
  await fetch(`${baseUrl}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      count,
      fault_plan: { seed: 1, dropRate: 1, dupRate: 0, apiErrorRate: 0 },
    }),
  });
}

describe("connector seam — every source resolves to a connector", () => {
  it("resolves a connector for every registered source", () => {
    for (const source of SOURCES) {
      const c = connectorFor(source, DEFAULT_TENANT_ID);
      expect(c.source).toBe(source);
    }
  });

  it("reports the feed trio as ledger-feed and sheets as sheet-snapshot — the seam's first real divergence, pinned deliberately", () => {
    // SPEC CHANGE (A5): membership grew because the Sheets connector registered — the
    // exact event the old comment predicted ("when the Sheets connector lands, this test
    // changes deliberately and visibly"). The pin's job is unchanged: a new KIND still
    // cannot appear unnoticed, it must arrive together with its edit to this line.
    expect(connectorKinds()).toEqual({
      crm: "ledger-feed",
      billing: "ledger-feed",
      support: "ledger-feed",
      sheets: "sheet-snapshot",
      // SPEC CHANGE (Task B): the third paradigm — an opaque-cursor envelope feed with
      // has_more termination and a 30-day retention boundary. Lands ALONGSIDE the 2a
      // billing mock (risk rule: nothing rewritten in place; Task F owns the switch).
      stripefeed: "stripe-feed",
      // SPEC CHANGE (Task C): the fourth paradigm — thin batched webhooks + a
      // hydration pump with a D7 snapshot table. Lands ALONGSIDE the 2a crm mock
      // (same risk rule; Task F owns the old CRM's retirement).
      hubcrm: "hub-hydrate",
      // SPEC CHANGE (Task D): the FIFTH arm and the fourth-and-last paradigm — a stream
      // you SUBSCRIBE to, resumed by an opaque replay id, bounded by a 72h window that
      // can also be reset out from under the cursor. Lands ALONGSIDE the 2a support mock
      // (same risk rule; Task F owns the warehouse switch). With this entry the seam has
      // carried every paradigm the phase set out to prove.
      casebus: "bus-replay",
    });
  });

  it("rejects an unknown source rather than silently returning a default — an unknown source must never quietly ingest as some other source's connector", () => {
    expect(() => connectorFor("sheets-not-yet" as never, DEFAULT_TENANT_ID)).toThrow(/unknown source/i);
  });
});

describe("connector seam — behavior preserving vs the functions it replaces", () => {
  it("catchUp through the connector ingests exactly what the direct call does", async () => {
    await startLedgerMock(12);

    const viaConnector = await connectorFor("billing", DEFAULT_TENANT_ID).catchUp(pool, { baseUrl });
    expect(viaConnector).toBe(12);

    // Cursor is now at the end; a direct call must agree there is nothing left. Same
    // mechanism, same cursor table, same result.
    const viaDirect = await catchUp(pool, "billing", baseUrl, { tenantId: DEFAULT_TENANT_ID });
    expect(viaDirect).toBe(0);
  });

  it("reconcile through the connector returns the same report as the direct call", async () => {
    await startLedgerMock(8);
    await connectorFor("billing", DEFAULT_TENANT_ID).catchUp(pool, { baseUrl });

    const direct = await reconcile(pool, "billing", ledgerPath);
    const viaConnector = await connectorFor("billing", DEFAULT_TENANT_ID).reconcile(pool, { ledgerPath });

    expect(viaConnector.skipped).toBeUndefined();
    expect(viaConnector.integrity.ok).toBe(true);
    expect(viaConnector.report).toEqual(direct);
    expect(direct.missing).toEqual([]);
    expect(direct.extra).toEqual([]);
  });

  it("surfaces a broken hash chain as an integrity failure WITHOUT a report — matching cli/reconcile.ts, which refuses to compare against a ledger it cannot trust", async () => {
    await startLedgerMock(4);
    await connectorFor("billing", DEFAULT_TENANT_ID).catchUp(pool, { baseUrl });

    const { writeFileSync, readFileSync } = await import("node:fs");
    const lines = readFileSync(ledgerPath, "utf8").trimEnd().split("\n");
    const tampered = JSON.parse(lines[1]);
    tampered.event_type = "tampered.by.test";
    lines[1] = JSON.stringify(tampered);
    writeFileSync(ledgerPath, lines.join("\n") + "\n");

    expect(verifyLedgerChain(ledgerPath).ok).toBe(false);

    const result = await connectorFor("billing", DEFAULT_TENANT_ID).reconcile(pool, { ledgerPath });
    expect(result.integrity.ok).toBe(false);
    expect(result.report).toBeUndefined();
  });

  it("FAILS — rather than skips — an enabled source with no ledger configured, naming the missing variable; `skip` is the explicit opt-out (debt-burn A8)", async () => {
    // SPEC CHANGE (debt-burn A8): this test used to PIN the skip. Fail-closed config
    // validation (envalid/12-factor: run only when every env dependency is met) says an
    // env-var typo must never silently drop a source from the zero-loss proof — a
    // reconcile that PASSes on the remainder is not a proof of anything. Unset is not
    // consent; the literal value `skip` is, by name, on the record.
    const result = await connectorFor("billing", DEFAULT_TENANT_ID).reconcile(pool, { ledgerPath: undefined });
    expect(result.skipped).toBeUndefined();
    expect(result.integrity.ok).toBe(false);
    expect(result.integrity.detail).toMatch(/LEDGER_PATH_BILLING/);
    expect(result.report).toBeUndefined();

    // The explicit escape hatch, for the record and by name:
    const optedOut = await connectorFor("billing", DEFAULT_TENANT_ID).reconcile(pool, { ledgerPath: "skip" });
    expect(optedOut.skipped).toMatch(/explicit opt-out/);
    expect(optedOut.integrity.ok).toBe(true);
    expect(optedOut.report).toBeUndefined();
  });
});
