import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type pg from "pg";
import { createCasebusApp, type CasebusApp } from "../../mocks/casebus/src/index.js";
import { freshTestDb } from "./helpers/testdb.js";
import { listGaps, recordGap } from "../src/connectors/types.js";
import { BusReplayConnector } from "../src/connectors/bus-replay.js";

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
const TENANT_B = "33333333-3333-3333-3333-333333333333";

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
  extraEnv: Record<string, string> = {},
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
          ...extraEnv,
        },
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

/**
 * Drive the mock into the aged-out-cursor state a real operator would meet, and hand back
 * the output of the run that DETECTED the loss along with the two bound ids.
 *
 * Returning the detecting run is the point (review I2): a gap is announced by the run that
 * falls back, and by the next run the cursor is valid again and the CLI says nothing about
 * it — so assertions made on any later run are vacuous no matter how they are worded.
 */
async function makeAgeOutGap(
  mock: CasebusApp,
  baseUrl: string,
): Promise<{ detectingRun: { code: number; out: string }; lostEventId: string; farEventId: string }> {
  const aged = mock.stream.emit(5, { ageS: 70 * 3600 });
  await runCli("src/cli/backfill.ts", baseUrl);
  const fresh = mock.stream.emit(6);
  mock.stream.advance(3 * 3600);
  const detectingRun = await runCli("src/cli/backfill.ts", baseUrl);
  return { detectingRun, lostEventId: aged.at(-1)!.event.id, farEventId: fresh[0].event.id };
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
    const { detectingRun, lostEventId, farEventId } = await makeAgeOutGap(mock, baseUrl);

    // What the test's NAME has always claimed, now actually asserted. The `reset` cause
    // was pinned on this surface from the start; `retention` — the commoner of the two —
    // was not, and the old body asserted only an exit code, twice.
    expect(detectingRun.out).toMatch(/PERMANENT DATA LOSS/);
    expect(detectingRun.out).toMatch(/unclosable gap \(retention\)/);
    expect(detectingRun.out).toMatch(/aged out of the source's retention window/);
    // Bounds, both edges, by name: a loss report without them tells an operator that
    // something was lost but not what.
    expect(detectingRun.out).toContain(lostEventId);
    expect(detectingRun.out).toContain(farEventId);
    // A retention gap must NOT borrow the reset explanation — the mirror of the negative
    // assertion the reset test carries.
    expect(detectingRun.out).not.toMatch(/RESET/);
    // Forward progress still reported, and the drain still exits 0: the drain succeeded,
    // and reconcile is the gate that turns a gap into a red.
    expect(detectingRun.out).toMatch(/ingested 6 event\(s\)/);
    expect(detectingRun.code).toBe(0);
  });

  it("the run AFTER a fallback says nothing about the gap — which is exactly why asserting on it proved nothing (review I2, pinned so the vacuity cannot come back)", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl);

    // The cursor is valid again, so this drain is ordinary and silent about the loss.
    // The old version of the test above asserted `code === 0` on a run like this one —
    // which would have passed with the gap line absent, misspelt, or naming the wrong
    // cause. The durable record of the loss is the ledger, and reconcile is what reads it.
    mock.stream.emit(1);
    const after = await runCli("src/cli/backfill.ts", baseUrl);
    expect(after.code).toBe(0);
    expect(after.out).not.toMatch(/PERMANENT DATA LOSS/);
    expect(await listGaps(pool, DEFAULT_TENANT, "casebus")).toHaveLength(1);
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
    // Debt-burn A3: the report's `gaps` field is CONSUMED — cross-checked against the
    // ledger rows the CLI prints — and says so even at zero, so agreement is visible.
    expect(res.out).toMatch(/gap cross-check: report agrees with the durable gap ledger \(0 gap\(s\)\)/);
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
    // Debt-burn A3: on a gap-bearing run the consumed report field must agree with the
    // printed ledger rows — the cross-check line proves the field is read, not decorative.
    expect(res.out).toMatch(/gap cross-check: report agrees with the durable gap ledger \(1 gap\(s\)\)/);
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

describe("operator-CLI scoping (debt-burn A5): recorded state over configured scope, and explicit tenancy", () => {
  it("gap-ack --list defaults to ALL recorded gap state for the tenant — a loss on a source outside INGEST_SOURCES is flagged, never invisible; --source still narrows", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl); // a loss on the ENABLED source
    // A loss recorded on a source NOT in this deployment's INGEST_SOURCES (env pins
    // casebus only) — exactly the row the enabledSources() iteration used to hide from
    // the listing that a reconcile failure points operators at.
    await recordGap(pool, {
      tenantId: DEFAULT_TENANT,
      source: "stripefeed",
      cause: "retention",
      fromEventId: "evt_lost_unconfigured",
      fromOccurredAt: null,
      toOccurredAt: null,
    });

    const res = await runCli("src/cli/gap-ack.ts", baseUrl, ["--list"]);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/\[casebus\] PERMANENT DATA LOSS/);
    expect(res.out).toMatch(/\[stripefeed\] PERMANENT DATA LOSS/);
    expect(res.out).toContain("evt_lost_unconfigured");
    // Disclosure, not noise: the row says WHY this deployment's reconcile won't red on it.
    expect(res.out).toMatch(/not currently in INGEST_SOURCES/);
    // The enabled source's row is NOT flagged — the flag distinguishes, not decorates.
    expect(res.out).not.toMatch(/\[casebus\][^\n]*not currently in INGEST_SOURCES/);

    const narrowed = await runCli("src/cli/gap-ack.ts", baseUrl, ["--list", "--source", "casebus"]);
    expect(narrowed.out).not.toContain("evt_lost_unconfigured");
    expect(narrowed.out).toMatch(/\[casebus\] PERMANENT DATA LOSS/);
  });

  it("gap-ack --tenant scopes listing AND acknowledgement; without the flag the default tenant's behavior is unchanged (non-default-tenant pin)", async () => {
    const baseUrl = listen(createCasebusApp({ seed: 42 }));
    await recordGap(pool, {
      tenantId: TENANT_B,
      source: "casebus",
      cause: "reset",
      fromEventId: "evt_tenant_b_loss",
      fromOccurredAt: null,
      toOccurredAt: null,
    });

    // Default-tenant listing stays blind to tenant B's row — scoping, not leakage…
    const defaultList = await runCli("src/cli/gap-ack.ts", baseUrl, ["--list"]);
    expect(defaultList.out).not.toContain("evt_tenant_b_loss");
    // …and the flag makes tenant B's record reachable.
    const bList = await runCli("src/cli/gap-ack.ts", baseUrl, ["--list", "--tenant", TENANT_B]);
    expect(bList.out).toContain("evt_tenant_b_loss");

    const gapId = (await listGaps(pool, TENANT_B, "casebus"))[0].id;
    // Acknowledging across the tenant line stays the refusal it always was:
    const wrongTenant = await runCli("src/cli/gap-ack.ts", baseUrl, [
      "--source", "casebus", "--id", String(gapId), "--by", "oncall",
    ]);
    expect(wrongTenant.code).toBe(1);
    expect((await listGaps(pool, TENANT_B, "casebus"))[0].acknowledgedAt).toBeNull();
    // With the flag, the named human's acknowledgement lands on the right tenant's row.
    const acked = await runCli("src/cli/gap-ack.ts", baseUrl, [
      "--tenant", TENANT_B, "--source", "casebus", "--id", String(gapId), "--by", "oncall",
    ]);
    expect(acked.code).toBe(0);
    expect((await listGaps(pool, TENANT_B, "casebus"))[0].acknowledgedAt).not.toBeNull();
  });

  it("a BARE --tenant refuses identically on BOTH CLIs — never a silent fall-back that reconciles the default tenant while the operator believes it was tenant X (checklist line 6)", async () => {
    const baseUrl = listen(createCasebusApp({ seed: 42 }));
    // Same condition, equally rich behavior across surfaces: a flag whose value was
    // forgotten (or swallowed by the shell) must be a refusal on every CLI that takes
    // it, with the same wording — a bare --tenant that quietly runs the DEFAULT tenant
    // and exits 0 is the silently-WRONG-answer class the ledger-feed refusal names.
    for (const script of ["src/cli/gap-ack.ts", "src/cli/reconcile.ts"] as const) {
      const res = await runCli(script, baseUrl, ["--tenant"]);
      expect(res.code, script).toBe(1);
      expect(res.out, script).toMatch(/--tenant requires a tenant id/);
    }
  });

  it("reconcile --tenant runs THAT tenant's reconcile: tenant B's standing loss reds and prints under the flag, and the default run stays clean (non-default-tenant pin)", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    mock.stream.emit(4);
    // Both tenants drain the same bus; only tenant B carries a recorded loss.
    await runCli("src/cli/backfill.ts", baseUrl);
    await new BusReplayConnector({ baseUrl, batchSize: 100, tenantId: TENANT_B }).catchUp(pool);
    await recordGap(pool, {
      tenantId: TENANT_B,
      source: "casebus",
      cause: "reset",
      fromEventId: "evt_tenant_b_loss",
      fromOccurredAt: null,
      toOccurredAt: null,
    });

    const defaultRun = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(defaultRun.code).toBe(0);
    expect(defaultRun.out).not.toContain("evt_tenant_b_loss");

    const bRun = await runCli("src/cli/reconcile.ts", baseUrl, ["--tenant", TENANT_B]);
    expect(bRun.code).toBe(1);
    expect(bRun.out).toContain("evt_tenant_b_loss");
    expect(bRun.out).toMatch(/UNACKNOWLEDGED/);
    expect(bRun.out).toMatch(/gap-ack/);
  });

  it("reconcile --tenant REFUSES ledger-feed sources by name rather than silently answering cross-tenant — their reconcile is not tenant-scoped", async () => {
    const baseUrl = listen(createCasebusApp({ seed: 42 }));
    const res = await runCli("src/cli/reconcile.ts", baseUrl, ["--tenant", TENANT_B], {
      INGEST_SOURCES: "crm",
      LEDGER_PATH_CRM: "/tmp/burn1-a5-ledger-does-not-exist.jsonl",
    });
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/--tenant/);
    expect(res.out).toMatch(/crm/);
    expect(res.out).toMatch(/not tenant-scoped|ledger-feed/);
  });
});

describe("the disclosure must survive the incident (cold review I1)", () => {
  it("an UNREACHABLE source with a standing unacknowledged gap STILL prints the loss and the next step — the moment an operator is actually reading this output", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const server = mock.app.listen(0);
    servers.push(server);
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await makeAgeOutGap(mock, baseUrl);
    expect(await listGaps(pool, DEFAULT_TENANT, "casebus")).toHaveLength(1);

    // The incident: the bus goes away. Reconcile can no longer read the live window —
    // but the ledger row is STATE, and it is exactly what the operator needs on screen.
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/bus unreadable/); // the live failure is still reported
    // …and the standing loss is NOT swallowed by it.
    expect(res.out).toMatch(/PERMANENT DATA LOSS/);
    expect(res.out).toMatch(/unclosable gap \(retention\)/);
    expect(res.out).toMatch(/UNACKNOWLEDGED/);
    expect(res.out).toMatch(/gap-ack/);
    // And it is labelled as standing, so nobody mistakes it for damage from this outage.
    expect(res.out).toMatch(/standing \(recorded before this run\)/);
  });

  it("a TRANSIENT probe failure keeps the standing disclosure AND the rest of the run: integrity red for that source only, no fabricated gap row, later sources still processed (debt-burn A1)", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    await makeAgeOutGap(mock, baseUrl); // one STANDING recorded loss

    // The incident: the bus serves the whole window fine (EARLIEST), then blips on the
    // cursor-liveness probe (the run's only CUSTOM subscribe).
    const express = (await import("express")).default;
    const proxy = express();
    proxy.get("/subscribe", async (req, res) => {
      if (String(req.query.replay_preset) === "CUSTOM") {
        res.status(500).send("transient upstream blip");
        return;
      }
      const qs = new URLSearchParams(req.query as Record<string, string>).toString();
      const upstream = await fetch(`${baseUrl}/subscribe?${qs}`);
      res.status(upstream.status).type("application/x-ndjson").send(await upstream.text());
    });
    const proxySrv = proxy.listen(0);
    servers.push(proxySrv);
    const proxyUrl = `http://127.0.0.1:${(proxySrv.address() as { port: number }).port}`;

    // A second, later source in the same run: crm with a (valid, empty) ledger — the
    // probe blip on casebus must not cost crm its reconcile.
    const res = await runCli("src/cli/reconcile.ts", proxyUrl, [], {
      INGEST_SOURCES: "casebus,crm",
      LEDGER_PATH_CRM: "/tmp/burn1-a1-empty-ledger-does-not-exist.jsonl",
    });

    expect(res.code).toBe(1);
    // Positive own-wording: the transient classification names itself…
    expect(res.out).toMatch(/\[casebus\] FAIL:.*probe/i);
    expect(res.out).toMatch(/transient/i);
    // …and the standing loss survives the degraded-path exit (checklist line 4): the
    // disclosure block prints even though this source's live read ended in a red.
    expect(res.out).toMatch(/PERMANENT DATA LOSS/);
    expect(res.out).toMatch(/standing \(recorded before this run\)/);
    expect(res.out).toMatch(/UNACKNOWLEDGED/);
    expect(res.out).toMatch(/gap-ack/);
    // Negative sibling-wording: nothing was DETECTED — a blip is not a new loss…
    expect(res.out).not.toMatch(/detected in this run/);
    // …and the durable record gained no fabricated row.
    expect(await listGaps(pool, DEFAULT_TENANT, "casebus")).toHaveLength(1);
    // Later sources still processed: the throw used to kill the whole run here.
    expect(res.out).toMatch(/\[crm\] PASS/);
    // Debt-burn A6 rider (operator-surface rule): the ledger paradigm's new
    // ledgerDuplicates count is printed by the CLI, even at its boring zero.
    expect(res.out).toMatch(/\[crm\] ledger duplicates[^\n]*: 0/);
  });

  it("a gap detected DURING the run is labelled as such, so 'standing' means what it says", async () => {
    const mock = createCasebusApp({ seed: 42 });
    const baseUrl = listen(mock);
    // Backfill runs while the cursor is still young; the age-out happens after it, so
    // reconcile is the first surface to see the dead cursor.
    mock.stream.emit(4, { ageS: 70 * 3600 });
    await runCli("src/cli/backfill.ts", baseUrl);
    mock.stream.emit(5);
    mock.stream.advance(3 * 3600);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).toMatch(/detected in this run/);
    expect(res.out).not.toMatch(/standing \(recorded before this run\)/);
    // Sibling-wording negative (debt-burn A1): the definitive corrupted-cursor verdict
    // must never dress as the transient-probe classification, or vice versa.
    expect(res.out).not.toMatch(/transient/i);
  });
});

describe("paradigm-honest PASS line (cold review M1)", () => {
  it("a clean bus PASSes against its RETAINED WINDOW — there is no ledger in this paradigm", async () => {
    const mock = createCasebusApp({ seed: 9 });
    const baseUrl = listen(mock);
    mock.stream.emit(12);
    await runCli("src/cli/backfill.ts", baseUrl);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/PASS: raw matches the bus's retained window exactly/);
    // The boilerplate this replaces: the integrity line two lines above it was fixed for
    // exactly this reason, and the PASS line kept saying "ledger" anyway.
    expect(res.out).not.toMatch(/raw matches ledger exactly/);
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

  it("the service log also prints the catch-up COUNTS (cold review M3): for a paradigm where redelivery is the steady state, a loop that logs neither ingested nor absorbed is indistinguishable from one doing nothing", async () => {
    const mock = createCasebusApp({ seed: 5, duplicate: { seed: 5, rate: 1 } });
    const baseUrl = listen(mock);
    mock.stream.emit(9);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { createBackfillRunner } = await import("../src/main.js");
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      await createBackfillRunner(pool, "casebus", baseUrl)();
    } finally {
      process.env.DATABASE_URL = prevDb;
    }
    const logged = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/ingested 9/);
    expect(logged).toMatch(/9 duplicate\(s\) absorbed/);
  });
});
