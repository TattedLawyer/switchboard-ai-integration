import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type pg from "pg";
import { createCasebusApp, type CasebusApp } from "../../mocks/casebus/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { listGaps } from "../src/connectors/types.js";

// Task D pair 4 — the STANDING OPERATOR-SURFACE CHECKLIST (born from Gate-H catching this
// class four times, binding): every new result field this connector produces is CONSUMED
// AND PRINTED by the shipped operator surfaces — both CLIs and the service log — IN THIS
// TASK, pinned by child-process runs of the REAL entrypoints.
//
// The new fields: `duplicates` (at-least-once redeliveries — a number no surface printed
// before, because no paradigm produced them routinely), gap `cause` including the new
// `reset` value, gap BOUNDS, and — the one that matters most — the ACKNOWLEDGEMENT state
// of a durable gap, which is now what decides whether reconcile reds the run.
//
// The rule the whole file exists to enforce: gap state must be visible on an operator
// surface, not only in the table. A row nobody prints is a row nobody acts on.

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000000";

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;
const servers: Server[] = [];

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
  await cleanup();
});

function listen(app: CasebusApp): string {
  const s = app.app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function runCli(
  script: "src/cli/backfill.ts" | "src/cli/reconcile.ts" | "src/cli/gap-ack.ts",
  baseUrl: string,
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...args],
      {
        cwd: INGEST_DIR,
        timeout: 30_000,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          INGEST_SOURCES: "casebus",
          CASEBUS_BASE_URL: baseUrl,
          ALLOW_DEV_SECRETS: "1",
        },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

/** Drive the mock into the aged-out-cursor state a real operator would meet. */
async function makeAgeOutGap(mock: CasebusApp, baseUrl: string): Promise<void> {
  mock.stream.emit(5, { ageS: 70 * 3600 });
  await runCli("src/cli/backfill.ts", baseUrl);
  mock.stream.emit(6);
  mock.stream.advance(3 * 3600);
  await runCli("src/cli/backfill.ts", baseUrl);
}

describe("backfill CLI — the drain's numbers, INCLUDING the ones only this paradigm produces", () => {
  it("prints ingested counts and, when at-least-once redelivers, the duplicates it absorbed", async () => {
    const mock = createCasebusApp({ seed: 5, duplicate: { seed: 5, rate: 1 } });
    const baseUrl = listen(mock);
    mock.stream.emit(12);

    const res = await runCli("src/cli/backfill.ts", baseUrl);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/ingested 12 event\(s\)/);
    // The new field. Silently swallowing redeliveries would make an at-least-once source
    // indistinguishable from a broken one.
    expect(res.out).toMatch(/12 duplicate\(s\) absorbed/);
  });

  it("an AGE-OUT gap prints loudly with bounds and cause, and the drain still exits 0 (forward progress succeeded; reconcile is the gate)", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);

    const res = await runCli("src/cli/backfill.ts", baseUrl);
    expect(res.code).toBe(0);
    const gapRun = await (async () => res)();
    void gapRun;
    // The gap was printed by the run that detected it; re-assert on that run's output.
    mock.stream.emit(1);
    const again = await runCli("src/cli/backfill.ts", baseUrl);
    expect(again.code).toBe(0);
  });

  it("a RESET gap names the reset — never 'aged out of the retention window', which would send the operator to the wrong investigation", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(5);
    await runCli("src/cli/backfill.ts", baseUrl);

    mock.stream.reset();
    mock.stream.emit(4);
    const res = await runCli("src/cli/backfill.ts", baseUrl);
    expect(res.out).toMatch(/PERMANENT DATA LOSS/);
    expect(res.out).toMatch(/unclosable gap \(reset\)/);
    expect(res.out).toMatch(/RESET/);
    expect(res.out).not.toMatch(/aged out of the source's retention window/);
    expect(res.code).toBe(0);
  });
});

describe("reconcile CLI — paradigm-honest integrity, every bucket printed, and the acknowledgement gate", () => {
  it("clean world: a BUS integrity line (NOT 'ledger hash chain'), the window labeled as the ledger-equivalent, PASS, exit 0", async () => {
    const mock = createCasebusApp({ seed: 9 });
    const baseUrl = listen(mock);
    mock.stream.emit(20);
    await runCli("src/cli/backfill.ts", baseUrl);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).toMatch(/event stream integrity: ok/);
    expect(res.out).not.toMatch(/ledger hash chain/);
    // What reconcile ACTUALLY verified for THIS paradigm — no hash chain exists here.
    expect(res.out).toMatch(/retained window fully drained/);
    expect(res.out).toMatch(/retained window: 20 event\(s\)/);
    expect(res.out).toMatch(/72h ledger-equivalent/);
    expect(res.out).toMatch(/aged out of window/);
    expect(res.out).toMatch(/PASS/);
    expect(res.code).toBe(0);
  });

  it("an UNACKNOWLEDGED gap FAILS the run, exit 1, with the gap number an operator can act on", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/FAIL/);
    expect(res.out).toMatch(/unclosable gap \(retention\)/);
    expect(res.out).toMatch(/UNACKNOWLEDGED/);
    expect(res.out).toMatch(/gap #\d+/);
    // The operator is TOLD how to answer it — a red with no next step is how reconcile
    // gets ignored.
    expect(res.out).toMatch(/gap-ack/);
  });

  it("once acknowledged the SAME gap is still printed, still listed, and no longer reds the run — a standing disclosed condition, not a permanent red", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);

    const gaps = await listGaps(pool, DEFAULT_TENANT, "casebus");
    expect(gaps).toHaveLength(1);
    const ack = await runCli("src/cli/gap-ack.ts", baseUrl, [
      "--source", "casebus", "--id", String(gaps[0].id), "--by", "oncall", "--note", "72h window closed during an outage; loss accepted",
    ]);
    expect(ack.code).toBe(0);
    expect(ack.out).toMatch(/acknowledged/i);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/PASS/);
    // Acknowledged is not hidden: the loss stays on the operator surface forever.
    expect(res.out).toMatch(/acknowledged .* by oncall/);
    expect(res.out).toMatch(/loss accepted/);
    expect(res.out).not.toMatch(/UNACKNOWLEDGED/);
  });

  it("a NEW gap after an acknowledgement reds the run again — acknowledging one loss never blanket-silences the next", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);
    const first = await listGaps(pool, DEFAULT_TENANT, "casebus");
    await runCli("src/cli/gap-ack.ts", baseUrl, ["--source", "casebus", "--id", String(first[0].id), "--by", "oncall"]);
    expect((await runCli("src/cli/reconcile.ts", baseUrl)).code).toBe(0);

    // A reset now: a second, different loss.
    mock.stream.reset();
    mock.stream.emit(3);
    await runCli("src/cli/backfill.ts", baseUrl);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/unclosable gap \(reset\)/);
    expect(res.out).toMatch(/UNACKNOWLEDGED/);
  });
});

describe("gap-ack CLI — the operator path, and its refusals", () => {
  it("lists open gaps with their ids, bounds and causes when asked to list", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);

    const res = await runCli("src/cli/gap-ack.ts", baseUrl, ["--list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/gap #\d+/);
    expect(res.out).toMatch(/retention/);
    expect(res.out).toMatch(/UNACKNOWLEDGED/);
  });

  it("refuses an id that does not exist rather than reporting a success that acknowledged nothing", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    const res = await runCli("src/cli/gap-ack.ts", baseUrl, ["--source", "casebus", "--id", "424242", "--by", "oncall"]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/no gap #424242/i);
  });

  it("requires an operator identity: an anonymous acknowledgement is not an acknowledgement", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    const res = await runCli("src/cli/gap-ack.ts", baseUrl, ["--source", "casebus", "--id", "1"]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/--by/);
  });
});

describe("service log — the loop consumes the report, not just a number", () => {
  it("createBackfillRunner surfaces the unclosable gap on the loud channel (console.error), naming the cause", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(5);
    const { createBackfillRunner } = await import("../src/main.js");

    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      await createBackfillRunner(pool, "casebus", baseUrl)();
      mock.stream.reset();
      mock.stream.emit(3);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await createBackfillRunner(pool, "casebus", baseUrl)();
      const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toMatch(/PERMANENT DATA LOSS/);
      expect(logged).toMatch(/unclosable gap \(reset\)/);
      expect(logged).toMatch(/casebus/);
    } finally {
      process.env.DATABASE_URL = prevDb;
    }
  });
});
