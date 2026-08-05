import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type pg from "pg";
import { COL, createSheetsApp, type SheetsApp } from "../../mocks/sheets/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { SheetSnapshotConnector } from "../src/connectors/sheet-snapshot.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Gate-H cold review I1 (+ Minor 6) — the reconcile CLI path itself, exercised as the
// operator runs it (`INGEST_SOURCES=sheets npm run reconcile -w ingest`), because the
// oracle tests call connector.reconcile() directly and could never see what the CLI
// does with the report:
//   I1: the CLI computed clean from missing/extra/rawDuplicates only. `stale` — the
//       sheets paradigm's EVERYDAY drift bucket (a human edits a cell after a clean
//       ingest; RUNBOOK documents the field) — was neither printed nor gated, so a
//       drifted sheet printed PASS and exited 0.
//   M6: the CLI printed "ledger hash chain: ok" for every non-skipped source — false
//       for the sheets paradigm, which has no ledger and no hash chain. It must print
//       what reconcile actually verified for the connector's kind.

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
  await cleanup();
});

function startSheet(): { sheets: SheetsApp; baseUrl: string } {
  const sheets = createSheetsApp({ seed: 7, rowCount: 6 });
  srv = sheets.app.listen(0);
  const port = (srv.address() as { port: number }).port;
  return { sheets, baseUrl: `http://127.0.0.1:${port}` };
}

/** Runs the REAL CLI entrypoint as a child process — the exact surface the RUNBOOK
 *  documents. Non-zero exit is a result here, not an error. */
function runReconcileCli(baseUrl: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli/reconcile.ts"],
      {
        cwd: INGEST_DIR,
        timeout: 25_000,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          INGEST_SOURCES: "sheets",
          SHEETS_BASE_URL: baseUrl,
          ALLOW_DEV_SECRETS: "1",
        },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err); // spawn failure, not exit code
        resolve({ code: err ? (err.code as number) : 0, stdout, stderr });
      },
    );
  });
}

describe("reconcile CLI × sheets (cold review I1/M6)", () => {
  it("a converged sheet PASSES with exit 0 — and the integrity line states what was actually verified for the snapshot paradigm, never 'ledger hash chain'", async () => {
    const { baseUrl } = startSheet();
    const c = new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl });
    await c.catchUp(pool);

    const res = await runReconcileCli(baseUrl);
    expect(res.stderr).toBe("");
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[sheets] PASS");
    // M6: the sheets paradigm is chainless — the line must describe the snapshot
    // verification (readable + consistent), not a hash chain that does not exist.
    expect(res.stdout).not.toContain("ledger hash chain");
    expect(res.stdout).toMatch(/\[sheets\] snapshot integrity: ok/);
    // I1: the stale bucket is SURFACED even when empty — an operator reading the
    // report must see the paradigm's category, not infer it from silence.
    expect(res.stdout).toMatch(/\[sheets\] stale[^\n]*: 0/);
  });

  it("I1 (the false-PASS pin): a cell edited after a clean ingest = stale drift — the CLI must FAIL, exit nonzero, and NAME the stale row_key", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl });
    await c.catchUp(pool);

    // The everyday scenario from the review: a human edits a cell after a clean
    // ingest and no catchUp has run since. The row is present on both sides with
    // differing content — the report's `stale` bucket, invisible to the old CLI.
    const staleRk = sheets.sheet.metadata()[0].rowKey;
    sheets.sheet.apply({ type: "edit_cell", rowKey: staleRk, column: COL.status, value: "renegotiating" });

    const res = await runReconcileCli(baseUrl);
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("[sheets] FAIL");
    expect(res.stdout).not.toContain("[sheets] PASS");
    // The drift is named, not just counted: fix-the-cell triage starts from a row_key.
    expect(res.stdout).toMatch(/stale[^\n]*: 1/);
    expect(res.stdout).toContain(staleRk);
  });
});

// Debt-burn sweep (A8 follow-through): the RUNBOOK env table promises, verbatim —
//   "unset → reconcile FAILS naming the missing var (fail-closed); the literal `skip`
//    opts the source out explicitly"
// — and until now that sentence was pinned only through the connector's return value,
// never through the CLI surface the RUNBOOK is describing (checklist lines 3+7: the
// claim lives in this test's name AND body, and the doc sentence is quoted here so a
// wording change breaks something visible).
describe("A8 on the real CLI — an enabled ledger-feed source with no ledger path", () => {
  function runLedgerFeedReconcile(extraEnv: Record<string, string>): Promise<{ code: number; out: string }> {
    return new Promise((resolve, reject) => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        DATABASE_URL: dbUrl,
        INGEST_SOURCES: "crm",
        ALLOW_DEV_SECRETS: "1",
        ...extraEnv,
      };
      delete env.LEDGER_PATH_CRM; // the typo'd/missed-export deployment, guaranteed
      for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
      execFile(
        process.execPath,
        ["--import", "tsx", "src/cli/reconcile.ts"],
        { cwd: INGEST_DIR, timeout: 25_000, env: env as NodeJS.ProcessEnv },
        (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(err);
          resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
  }

  it("reconcile CLI FAILS naming the missing LEDGER_PATH_CRM and exits nonzero — unset is never consent", async () => {
    const res = await runLedgerFeedReconcile({});
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/\[crm\] FAIL: LEDGER_PATH_CRM is not set for enabled source crm/);
    // Both remedies the refusal promises are on the operator's terminal:
    expect(res.out).toMatch(/Set LEDGER_PATH_CRM to the ledger file/);
    expect(res.out).toMatch(/literal value "skip" to opt this source out explicitly/);
    expect(res.out).not.toMatch(/\[crm\] PASS/);
  });

  it("the literal `skip` opts the source out explicitly — printed as a skip, never a silent absence", async () => {
    const res = await runLedgerFeedReconcile({ LEDGER_PATH_CRM: "skip" });
    expect(res.out).toMatch(/\[crm\] skipped \(LEDGER_PATH_CRM=skip \(explicit opt-out\)\)/);
    // With the only enabled source opted out, nothing was reconciled — and the CLI
    // says so rather than passing an empty run.
    expect(res.out).toMatch(/FAIL: no source had a ledger path set; nothing was reconciled/);
    expect(res.code).toBe(1);
  });
});

// ── PRE-3 / #14 — a vanished mapped column reaches the RECONCILE gate ─────────────────
//
// The lie (gate-H I5): a mapped column disappearing from the sheet header produces a
// `degradations` entry on the CATCH-UP report — printed by `backfill` on stderr, which
// exits 0 — and nothing at all on the reconcile report, which had no degradation channel
// (`SheetReconcileReport` carried `stale` alone). After one catchUp cycle the new events
// carry the truncated content and reconcile recomputes hashes through the SAME truncated
// mapping, so both sides agree and it prints `PASS: raw latest-state matches the sheet
// exactly`. Permanent field loss, gate green — a silent-correctness hole in the zero-loss
// surface that is this repo's headline claim.
//
// Within the drift window the rows read `stale` instead — "present on both sides, content
// differs" — which sends the operator to cell-level triage for what is a MAPPING failure
// (operator-surface checklist line 5: a cause must name itself and exclude its siblings).
//
// The shape follows the house paradigm rather than inventing one: the same field NAME and
// the same phrasing as the catch-up surface, so an operator greps one sentence across
// both; and the verdict goes through `standingConditionsNote`, not a hard red — the
// stripefeed-quarantine precedent says a disclosed permanent condition must not red every
// run forever.
describe("PRE-3 #14 — reconcile can see a mapped column that vanished", () => {
  it("the degraded column is NAMED on the reconcile report's operator surface", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl });
    await c.catchUp(pool);
    // A human renames a mapped, NON-KEY column to something the column map does not
    // recognise. (Deliberately NOT one of the modelled HEADER_VARIANTS — those are all
    // aliases in SHEET_COLUMN_MAP and map cleanly, which is the point of having them.)
    // The field stops being extractable; the sheet still has its key columns, so nothing
    // refuses — the pipeline just quietly gets thinner.
    sheets.sheet.apply({ type: "rename_header", column: COL.amount, name: "$$ (Q3 rollup)" });
    await c.catchUp(pool); // the truncated content is now on both sides

    const res = await runReconcileCli(baseUrl);
    expect(res.stdout).toMatch(/\[sheets\] degradations[^\n]*: 1/);
    expect(res.stdout).toContain("amount_cents");
    // Checklist line 5: it must name ITS cause and not borrow a sibling's. A mapping
    // failure is not cell drift.
    const degradationLine = res.stdout.split("\n").find((l) => l.includes("degradation"))!;
    expect(degradationLine).not.toMatch(/content differs/);
  });

  it("the verdict is a PASS that NAMES the standing condition — never the bare clean line, never a hard red", async () => {
    const { sheets, baseUrl } = startSheet();
    const c = new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl });
    await c.catchUp(pool);
    sheets.sheet.apply({ type: "rename_header", column: COL.amount, name: "$$ (Q3 rollup)" });
    await c.catchUp(pool);

    const res = await runReconcileCli(baseUrl);
    // NOT a hard red: a disclosed permanent condition must not red every run forever.
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("[sheets] PASS");
    // ...and NOT the bare clean line either. This is the actual defect: green AND silent.
    expect(res.stdout).not.toMatch(/PASS: raw latest-state matches the sheet exactly, no duplicates\n/);
    const passLine = res.stdout.split("\n").find((l) => l.includes("[sheets] PASS"))!;
    expect(passLine).toMatch(/degrad/i);
    expect(passLine).toContain("amount_cents");
  });

  it("a healthy sheet still prints the bucket at ZERO and the ordinary clean PASS — the category is never inferred from silence", async () => {
    const { baseUrl } = startSheet();
    const c = new SheetSnapshotConnector({ tenantId: DEFAULT_TENANT_ID, baseUrl });
    await c.catchUp(pool);

    const res = await runReconcileCli(baseUrl);
    expect(res.code).toBe(0);
    expect(res.stdout).toMatch(/\[sheets\] degradations[^\n]*: 0/);
    const passLine = res.stdout.split("\n").find((l) => l.includes("[sheets] PASS"))!;
    expect(passLine).not.toMatch(/degrad/i);
  });
});
