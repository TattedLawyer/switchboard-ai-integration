// CI pipeline fixture: a faultless, in-process, docker-free pipeline seed so per-push dbt
// tests run against REAL pipeline output (not hand-inserted rows). Direct-ingest mode (no
// pg-boss queue on the push path) keeps it fast and deterministic; the chaos workflow
// covers the queue path. Same relative-import exemption as verify-identity.ts (script
// code, not shipped src).
//
// F-1c composition — the FLIPPED warehouse's sources, exactly what staging consumes:
//   · hubcrm  (thin webhooks → the batch door; hydration pump → snapshots) — the CRM arm
//   · stripefeed (envelope feed → pull connector)                          — the billing arm
//   · casebus (subscribe/replay bus → pull connector)                      — the support arm
//   · support (2a mock, REMAINS by decision)                               — the csat arm only
//   · sheets  (snapshot connector)                                         — the sheets arm
// The 2a crm mock is retired and the 2a billing mock feeds no model — neither runs here.
import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";
import { getPool } from "../ingest/src/db.js";
import { runMigrations } from "../ingest/src/migrate.js";
import { createIngestApp } from "../ingest/src/server.js";
import { DEFAULT_TENANT_ID } from "../ingest/src/ingest-event.js";
import { catchUp } from "../ingest/src/backfill.js";
import { createSupportApp } from "../mocks/support/src/server.js";
import { createSheetsApp, COL } from "../mocks/sheets/src/index.js";
import { createHubcrmApp, OPS_UNTIL_MERGES_COMPLETE } from "../mocks/hubcrm/src/index.js";
import { createStripeFeedApp } from "../mocks/stripefeed/src/index.js";
import { NUMERIC_CONTRACT } from "../ingest/src/numeric-contract.js";
import { createCasebusApp } from "../mocks/casebus/src/index.js";
import { generateManifest } from "../mocks/core/src/manifest.js";
import { SheetSnapshotConnector } from "../ingest/src/connectors/sheet-snapshot.js";
import { HubHydrateConnector } from "../ingest/src/connectors/hub-hydrate.js";
import { StripeFeedConnector } from "../ingest/src/connectors/stripe-feed.js";
import { BusReplayConnector } from "../ingest/src/connectors/bus-replay.js";

// ── the hubcrm leg's op count, DERIVED, not chosen by accident ─────────────────────────
// 300 = 30 whole script cycles, and every term below is load-bearing:
//   · ≥ OPS_UNTIL_MERGES_COMPLETE (the exported constant — both manifest merges have
//     fired), or the 22→20 identity proof silently degrades to a merge-free universe;
//   · ≥ 262: support tier-1 evidence needs CRM contact index 26 (P-0027, S-0009's
//     SuppliedEmail target), and the script creates contact index n at op 10n+1 → 261;
//   · = 300: whole cycles, and the dupe-attached deals reach staging (D-0057/D-0059 on
//     DEMO-C-0021 at ops 282/292), so the merge collapse demonstrably re-points deal
//     history rather than passing vacuously.
const HUB = { ops: 300, opsPerCycle: 10 } as const;
if (HUB.ops < OPS_UNTIL_MERGES_COMPLETE) {
  throw new Error(
    `hubcrm leg runs ${HUB.ops} ops < OPS_UNTIL_MERGES_COMPLETE=${OPS_UNTIL_MERGES_COMPLETE} — the 22→20 proof depends on both merges firing`,
  );
}
// stripefeed 100 = 25 four-slot cycles → all 16 customers (n%16) appear by n=15.
// casebus 80 = 20 case lifecycles → all 14 requesters appear via the first 14 tickets.
// support 80 (2a, csat arm) = 20 cycles → csat rows for the same first 20 tickets.
const COUNTS = { stripefeed: 100, casebus: 80, support: 80 } as const;
// The sheets leg is calm-plan and fully seeded; 22 = 10 seeded row births + 12 calm
// steps × exactly one diff event each (see the alignment note below — alignment rewrites
// only never-ingested rows, so the count is unmoved).
const SHEETS = { seed: 7, rowCount: 10, steps: 12, expectedEvents: 22 } as const;

async function main() {
  const pool = getPool();
  await runMigrations(pool);
  await pool.query(
    "truncate table raw.raw_events, ingest.ingest_journal, ingest.quarantine, ingest.hydrated_snapshots restart identity",
  );
  await pool.query("delete from ingest.cursors");
  await pool.query("delete from ingest.gap_ledger");
  // The hydration DLQ lives in pg-boss; a fresh scratch DB has no pgboss schema yet.
  await pool.query("delete from pgboss.job").catch(() => undefined);
  rmSync("out/ci", { recursive: true, force: true });
  mkdirSync("out/ci", { recursive: true });

  const ingestSrv = createIngestApp(pool, DEFAULT_TENANT_ID).listen(0); // no enqueue → direct synchronous ingest
  const ingestPort = (ingestSrv.address() as { port: number }).port;

  // ── hubcrm: thin webhook batches through the REAL door, hydration pump interleaved ──
  // The pump runs once per script CYCLE, which is the structural guarantee behind the
  // merge-edge translation: a merge only ever consumes objects created in EARLIER
  // cycles (pendingMerge fires at slot 0 against pre-existing store state), so pumping
  // at every cycle boundary hydrates every object at least once WHILE ALIVE — the
  // snapshot that merge_edges later translates the consumed ids through.
  const hub = createHubcrmApp({ seed: 42, webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/hubcrm` });
  const hubSrv = hub.app.listen(0);
  const hubPort = (hubSrv.address() as { port: number }).port;
  const hubConnector = new HubHydrateConnector({ baseUrl: `http://127.0.0.1:${hubPort}` });
  for (let done = 0; done < HUB.ops; done += HUB.opsPerCycle) {
    const res = await fetch(`http://127.0.0.1:${hubPort}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: HUB.opsPerCycle }),
    });
    if (!res.ok) throw new Error(`simulate hubcrm failed: ${res.status}`);
    await hubConnector.catchUp(pool);
  }
  // Trichotomy at rest: every thin event has a terminal hydration state, nothing in the
  // DLQ — a faultless fixture with a dead letter is a fixture bug, not chaos.
  const hubReport = await hubConnector.catchUpWithReport(pool);
  if (hubReport.hydrationPending !== 0 || hubReport.hydrationDlq !== 0) {
    throw new Error(`hubcrm hydration not terminal: pending=${hubReport.hydrationPending} dlq=${hubReport.hydrationDlq}`);
  }
  hubSrv.close();

  // ── stripefeed: emit, then drain the retained window through the pull connector ─────
  // One ABOVE-BOUND charge (close F7): script index 2 is the first charge.succeeded; its
  // amount is overridden to plausibleMax + 1, derived from the CONTRACT (never re-typed),
  // so CI's dbt leg demonstrably FIRES the unlikely-value surface (is_unlikely_amount
  // true on one payments row; assert_amounts_plausible WARNS with exactly that row)
  // instead of passing vacuously on all-plausible amounts. Flagged is never refused —
  // the row stays in every sum — so every equality/aggregate check is unmoved.
  // The permanent WARN this creates is the project's green criterion, pinned as data in
  // scripts/dbt-warn-contract.ts and enforced by scripts/verify-dbt-warns.ts after the
  // dbt step (dbt exits 0 on warnings, so this one would otherwise mask a second).
  const chargeBound = NUMERIC_CONTRACT["charge.succeeded"].amount_cents.plausibleMax;
  if (chargeBound === undefined) throw new Error("charge.succeeded declares no plausibleMax — the F7 fixture row needs one");
  const feed = createStripeFeedApp({ seed: 42, amountCentsAt: { 2: chargeBound + 1 } });
  const feedSrv = feed.app.listen(0);
  const feedPort = (feedSrv.address() as { port: number }).port;
  const feedRes = await fetch(`http://127.0.0.1:${feedPort}/simulate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: COUNTS.stripefeed }),
  });
  if (!feedRes.ok) throw new Error(`simulate stripefeed failed: ${feedRes.status}`);
  await new StripeFeedConnector({ baseUrl: `http://127.0.0.1:${feedPort}` }).catchUp(pool);
  feedSrv.close();

  // ── casebus: emit, then drain the subscription through the pull connector ───────────
  const bus = createCasebusApp({ seed: 42 });
  const busSrv = bus.app.listen(0);
  const busPort = (busSrv.address() as { port: number }).port;
  const busRes = await fetch(`http://127.0.0.1:${busPort}/simulate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: COUNTS.casebus }),
  });
  if (!busRes.ok) throw new Error(`simulate casebus failed: ${busRes.status}`);
  await new BusReplayConnector({ baseUrl: `http://127.0.0.1:${busPort}` }).catchUp(pool);
  busSrv.close();

  // ── support (2a, csat arm): push through the door + idempotent poll overlap ─────────
  const supportApp = createSupportApp({
    webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/support`,
    ledgerPath: "out/ci/ledger-support.jsonl",
  });
  const supportSrv = supportApp.listen(0);
  const supportPort = (supportSrv.address() as { port: number }).port;
  const supportRes = await fetch(`http://127.0.0.1:${supportPort}/simulate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: COUNTS.support }),
  });
  if (!supportRes.ok) throw new Error(`simulate support failed: ${supportRes.status}`);
  await catchUp(pool, "support", `http://127.0.0.1:${supportPort}`);
  supportSrv.close();
  ingestSrv.close();

  // sheets (A6): the snapshot-paradigm arm — the REAL connector diffing the in-process
  // mock over a small, deterministic calm-plan run (no garbage ops → nothing quarantines,
  // and CI's dbt leg builds stg_sheets__rows + the identity/mart extensions from REAL
  // pipeline output).
  const sheets = createSheetsApp({ seed: SHEETS.seed, rowCount: SHEETS.rowCount });
  const sheetsSrv = sheets.app.listen(0);
  const sheetsPort = (sheetsSrv.address() as { port: number }).port;
  const connector = new SheetSnapshotConnector({ baseUrl: `http://127.0.0.1:${sheetsPort}` });

  // ALIGNMENT INVARIANT (cold review C1, re-pointed by F-1c): the CI fixture is a
  // faultless CORRELATED universe by design — every sheet client's email must be one the
  // CRM arm actually ingested, or the client lands tier-3, flows into manual_review +
  // customer_360, and verify-identity's billing+support-pinned expectations fail on the
  // very composition ci.yml runs. The CRM arm is now hubcrm: its identity evidence lives
  // in the hydrated CONTACT snapshots (staging's crm_emails reads latest-state contact
  // emails), so ground truth is the snapshot table — the emails the pump REALLY landed —
  // never a replica of the script's index math.
  const crmIngested = await pool.query(
    `select distinct s.snapshot -> 'properties' ->> 'email' as email
       from ingest.hydrated_snapshots s
      where s.object_type = 'contact' and not s.tombstone`,
  );
  const ingestedEmails = new Set(crmIngested.rows.map((r) => r.email as string));
  const { contacts, companies } = generateManifest(42).crm; // same fixed master seed as every mock
  const companyNameById = new Map(companies.map((c) => [c.id, c.name]));
  const targets = contacts.filter((c) => ingestedEmails.has(c.email)); // manifest order → deterministic
  if (targets.length === 0) throw new Error("alignment: hubcrm leg hydrated no contact emails");
  let cursor = 0;
  const assigned = new Map<string, (typeof contacts)[number]>(); // stable orphan→target mapping
  const alignSheetToCrmUniverse = () => {
    for (const { rowKey } of sheets.sheet.metadata()) {
      const row = sheets.sheet.rowByKey(rowKey)!;
      const email = row.cells[COL.email];
      if (ingestedEmails.has(email)) continue;
      let t = assigned.get(email);
      if (!t) { t = targets[cursor++ % targets.length]; assigned.set(email, t); }
      // Rewrite the whole identity triple so the row stays a coherent manifest person.
      sheets.sheet.apply({ type: "edit_cell", rowKey, column: COL.email, value: t.email });
      sheets.sheet.apply({ type: "edit_cell", rowKey, column: COL.clientName, value: t.name });
      sheets.sheet.apply({ type: "edit_cell", rowKey, column: COL.company, value: companyNameById.get(t.company_id)! });
    }
  };

  alignSheetToCrmUniverse();
  await connector.catchUp(pool); // baseline: the seeded book, aligned
  for (let i = 1; i <= SHEETS.steps; i++) {
    sheets.editor.applyStep("calm");
    if (i % 4 === 0) { alignSheetToCrmUniverse(); await connector.catchUp(pool); } // interleaved cycles, like the oracle
  }
  alignSheetToCrmUniverse();
  await connector.catchUp(pool); // final cycle: converged
  sheetsSrv.close();

  const n = await pool.query("select source, count(*)::int as n from raw.raw_events group by source order by source");
  const expected = [
    ["casebus", COUNTS.casebus],
    ["hubcrm", HUB.ops], // one thin event per script op, merges included
    ["sheets", SHEETS.expectedEvents],
    ["stripefeed", COUNTS.stripefeed],
    ["support", COUNTS.support],
  ];
  const got = n.rows.map((r) => [r.source, r.n]);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    throw new Error(`fixture counts mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  await pool.end();
  console.log("PASS: ci fixture seeded", got);
}
main().catch((err) => { console.error(err); process.exit(1); });
