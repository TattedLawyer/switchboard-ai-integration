// CI pipeline fixture: a faultless, in-process, docker-free pipeline seed so per-push dbt
// tests run against REAL pipeline output (not hand-inserted rows). Direct-ingest mode (no
// pg-boss) keeps it fast and deterministic; the chaos workflow covers the queue path.
// Same relative-import exemption as verify-identity.ts (script code, not shipped src).
import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";
import { getPool } from "../ingest/src/db.js";
import { runMigrations } from "../ingest/src/migrate.js";
import { createIngestApp } from "../ingest/src/server.js";
import { catchUp } from "../ingest/src/backfill.js";
import { createCrmApp } from "../mocks/crm/src/server.js";
import { createBillingApp } from "../mocks/billing/src/server.js";
import { createSupportApp } from "../mocks/support/src/server.js";
import { createSheetsApp } from "../mocks/sheets/src/index.js";
import { SheetSnapshotConnector } from "../ingest/src/connectors/sheet-snapshot.js";

// Counts chosen for full entity coverage (see Task 7's demo rationale):
const COUNTS = { crm: 108, billing: 100, support: 80 } as const;
// The sheets leg is calm-plan and fully seeded, so its raw event count is a constant of
// (seed, rowCount, steps) — pinned like the ledger counts to catch a silently short run.
// 22 = 10 seeded row births + 12 calm steps × exactly one diff event each (every calm op
// touches one row; deletes tombstone, appends/duplicates birth, edits re-upsert).
const SHEETS = { seed: 7, rowCount: 10, steps: 12, expectedEvents: 22 } as const;

async function main() {
  const pool = getPool();
  await runMigrations(pool);
  await pool.query("truncate table raw.raw_events, ingest.outbox, ingest.quarantine restart identity");
  await pool.query("delete from ingest.cursors");
  rmSync("out/ci", { recursive: true, force: true });
  mkdirSync("out/ci", { recursive: true });

  const ingestSrv = createIngestApp(pool).listen(0); // no enqueue → direct synchronous ingest
  const ingestPort = (ingestSrv.address() as { port: number }).port;

  const apps = {
    crm: createCrmApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/crm`, ledgerPath: "out/ci/ledger-crm.jsonl" }),
    billing: createBillingApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/billing`, ledgerPath: "out/ci/ledger-billing.jsonl" }),
    support: createSupportApp({ webhookUrl: `http://127.0.0.1:${ingestPort}/webhooks/support`, ledgerPath: "out/ci/ledger-support.jsonl" }),
  } as const;

  for (const [source, app] of Object.entries(apps)) {
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/simulate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: COUNTS[source as keyof typeof COUNTS] }),
    });
    if (!res.ok) throw new Error(`simulate ${source} failed: ${res.status}`);
    // Poll path exercised too (idempotent overlap with the push deliveries above):
    await catchUp(pool, source, `http://127.0.0.1:${port}`);
    srv.close();
  }
  ingestSrv.close();

  // sheets (A6): the snapshot-paradigm arm — the REAL connector diffing the in-process
  // mock over a small, deterministic calm-plan run (no garbage ops → nothing quarantines,
  // and CI's dbt leg builds stg_sheets__rows + the identity/mart extensions from REAL
  // pipeline output). Direct construction mirrors the oracle's mkConnector rationale:
  // the endpoint is a constructor input; the registry path is pinned by sources tests.
  const sheets = createSheetsApp({ seed: SHEETS.seed, rowCount: SHEETS.rowCount });
  const sheetsSrv = sheets.app.listen(0);
  const sheetsPort = (sheetsSrv.address() as { port: number }).port;
  const connector = new SheetSnapshotConnector({ baseUrl: `http://127.0.0.1:${sheetsPort}` });
  await connector.catchUp(pool); // baseline: the seeded book
  for (let i = 1; i <= SHEETS.steps; i++) {
    sheets.editor.applyStep("calm");
    if (i % 4 === 0) await connector.catchUp(pool); // interleaved cycles, like the oracle
  }
  await connector.catchUp(pool); // final cycle: converged
  sheetsSrv.close();

  const n = await pool.query("select source, count(*)::int as n from raw.raw_events group by source order by source");
  const expected = [["billing", COUNTS.billing], ["crm", COUNTS.crm], ["sheets", SHEETS.expectedEvents], ["support", COUNTS.support]];
  const got = n.rows.map((r) => [r.source, r.n]);
  if (JSON.stringify(got) !== JSON.stringify(expected))
    throw new Error(`fixture counts mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
  await pool.end();
  console.log("PASS: ci fixture seeded", got);
}
main().catch((err) => { console.error(err); process.exit(1); });
