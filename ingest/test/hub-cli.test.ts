import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { expectParadigmIntegrityLine } from "./helpers/operator-surface.js";
import { createIngestApp } from "../src/server.js";
import { createHubcrmApp, type HubcrmApp } from "../../mocks/hubcrm/src/index.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

// Task C pair 4 — the STANDING CHECKLIST (born from Gate-H 4-for-4, binding): every new
// result field the connector produces is CONSUMED AND PRINTED by the shipped operator
// surfaces — both CLIs and the service log — in the same task, pinned by child-process
// runs of the REAL entrypoints (the Task B fix pattern). hub-hydrate's new fields:
// hydrated, tombstoned, hydrationDlq, hydrationPending, drifted, tombstonedRaw — plus
// the paradigm-honest integrity line (an object-store source has no ledger hash chain,
// and printing one would be the exact dishonesty class cold reviews caught twice).

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));

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

function listen(app: express.Express): string {
  const s = app.listen(0);
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}

function runCli(script: "src/cli/backfill.ts" | "src/cli/reconcile.ts", baseUrl: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script],
      {
        cwd: INGEST_DIR,
        timeout: 30_000,
        env: {
          ...process.env,
          DATABASE_URL: dbUrl,
          INGEST_SOURCES: "hubcrm",
          HUBCRM_BASE_URL: baseUrl,
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

async function deliver(hub: HubcrmApp): Promise<void> {
  const doorUrl = listen(createIngestApp(pool, DEFAULT_TENANT_ID));
  const stats = await hub.store.deliver({ webhookUrl: `${doorUrl}/webhooks/hubcrm` });
  if (stats.failedBatches > 0) throw new Error("test delivery failed");
}

describe("backfill CLI — the hydration pump's numbers reach the terminal", () => {
  it("prints hydrated/tombstone counts as HYDRATION work (never 'ingested 0 event(s)' as the whole story), and a loud DLQ line when a poison object dead-letters", async () => {
    const probe = createHubcrmApp({ seed: 31 });
    probe.store.simulate(1);
    const poisonId = probe.store.allObjects()[0].objectId;

    const hub = createHubcrmApp({ seed: 31, poisonObjectIds: [poisonId] });
    const baseUrl = listen(hub.app);
    hub.store.simulate(30);
    await deliver(hub);

    const res = await runCli("src/cli/backfill.ts", baseUrl);
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/hydrated \d+ snapshot\(s\)/);
    expect(res.out).toMatch(/tombstone/);
    expect(res.out).toMatch(/HYDRATION DLQ/);
    // The old dishonesty this pin forbids: a number-only line claiming ingestion.
    expect(res.out).not.toMatch(/ingested 0 event\(s\)/);
  });
});

describe("reconcile CLI — paradigm-honest integrity + every bucket printed", () => {
  it("clean world: object-store integrity line (NOT 'ledger hash chain'), object counts labeled as the store, tombstoned metabolism, PASS, exit 0", async () => {
    const hub = createHubcrmApp({ seed: 9 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(40);
    await deliver(hub);
    await runCli("src/cli/backfill.ts", baseUrl); // hydrate first

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    // Helper: this paradigm's honest line, every sibling paradigm's line excluded.
    expectParadigmIntegrityLine(res.out, "hub-hydrate");
    expect(res.out).toMatch(/object store: \d+ live object\(s\)/);
    expect(res.out).toMatch(/tombstoned .*: \d+/);
    expect(res.out).toMatch(/drifted .*: 0/);
    expect(res.out).toMatch(/hydration pending .*: 0/);
    expect(res.out).toMatch(/hydration DLQ .*: 0/);
    expect(res.out).toMatch(/PASS/);
    expect(res.code).toBe(0);
  });

  it("webhook loss: dropped mutations make missing/drifted NONZERO, each object named, FAIL, exit 1 — loss is never a silent PASS", async () => {
    const hub = createHubcrmApp({ seed: 21 });
    const baseUrl = listen(hub.app);
    hub.store.simulate(30);
    await deliver(hub);
    await runCli("src/cli/backfill.ts", baseUrl);

    // The 10-retries-then-gone loss: mutations whose webhooks never arrive.
    hub.store.simulate(20);
    const doorUrl = listen(createIngestApp(pool, DEFAULT_TENANT_ID));
    await hub.store.deliver({ webhookUrl: `${doorUrl}/webhooks/hubcrm`, faultPlan: { seed: 1, dropRate: 1 } });

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/FAIL/);
    // At least one loss bucket is nonzero and its members are NAMED on the log.
    const drifted = res.out.match(/drifted[^:]*: (\d+)/);
    const missing = res.out.match(/missing[^:]*: (\d+)/);
    expect(Number(drifted?.[1] ?? 0) + Number(missing?.[1] ?? 0)).toBeGreaterThan(0);
    expect(res.out).toMatch(/- (company|contact|deal):\d+/);
  });

  it("a poison object's DLQ'd hydrations are LISTED with reasons but do not red the run (the stripefeed quarantine precedent: one poisoned object must not permanently fail reconcile)", async () => {
    const probe = createHubcrmApp({ seed: 31 });
    probe.store.simulate(1);
    const poisonId = probe.store.allObjects()[0].objectId;

    const hub = createHubcrmApp({ seed: 31, poisonObjectIds: [poisonId] });
    const baseUrl = listen(hub.app);
    hub.store.simulate(30);
    await deliver(hub);
    await runCli("src/cli/backfill.ts", baseUrl);

    const res = await runCli("src/cli/reconcile.ts", baseUrl);
    expect(res.out).toMatch(/hydration DLQ .*: [1-9]/);
    expect(res.out).toMatch(new RegExp(`company:${poisonId}`));
    expect(res.out).toMatch(/PASS/);
    expect(res.code).toBe(0);
  });
});

describe("service log — the loop consumes the report, not just a number", () => {
  it("createBackfillRunner surfaces hydration DLQ entries on the service log (console.error), the same loud channel as gaps", async () => {
    const probe = createHubcrmApp({ seed: 31 });
    probe.store.simulate(1);
    const poisonId = probe.store.allObjects()[0].objectId;

    const hub = createHubcrmApp({ seed: 31, poisonObjectIds: [poisonId] });
    const baseUrl = listen(hub.app);
    hub.store.simulate(20);
    await deliver(hub);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createBackfillRunner } = await import("../src/main.js");
    // The runner constructs its connector through the seam registry; point it at the
    // test db + mock via env the same way the service process would be configured.
    const prevDb = process.env.DATABASE_URL;
    process.env.DATABASE_URL = dbUrl;
    try {
      const run = createBackfillRunner(pool, "hubcrm", baseUrl, DEFAULT_TENANT_ID);
      await run();
    } finally {
      process.env.DATABASE_URL = prevDb;
    }
    const logged = errSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(logged).toMatch(/HYDRATION DLQ/);
    expect(logged).toMatch(/hubcrm/);
  });
});

// CLOSE-3 — OPS-I5 and OPS-M1: two lines that were true and misleading.
describe("the pump's zero cycle and the cursorless paradigm's incident line", () => {
  it("OPS-I5: a cycle that contacted nothing SAYS it contacted nothing, instead of reporting a clean zero that reads as a reachability check", async () => {
    // A live store, but raw holds nothing awaiting hydration — so the pump does no work
    // and, critically, never touches the store. Before this, the line was
    // "hydrated 0 snapshot(s), 0 tombstone(s) … from <url>", which is indistinguishable
    // from a healthy quiet hour with a dead object store behind it.
    const probe = createHubcrmApp({ seed: 77 });
    const res = await runCli("src/cli/backfill.ts", listen(probe.app));
    expect(res.code).toBe(0);
    expect(res.out).toContain("was NOT contacted this cycle");
    expect(res.out).toContain("reachability is unproven");
    // Still says what it DID do — the honest zero is added to the report, not swapped for it.
    expect(res.out).toContain("hydrated 0 snapshot(s)");
  });

  it("OPS-M1: a source with no cursor is told to re-run, not to 'resume from cursor 0' — a fabricated position printed during an incident", async () => {
    // The sheets paradigm re-reads the whole grid every cycle and writes no ingest.cursors
    // row at all. Drive its backfill against a dead base URL so the failure branch runs.
    const res = await new Promise<{ code: number; out: string }>((resolve, reject) => {
      execFile(
        process.execPath,
        ["--import", "tsx", "src/cli/backfill.ts"],
        {
          cwd: INGEST_DIR,
          timeout: 30_000,
          env: {
            ...process.env,
            DATABASE_URL: dbUrl,
            INGEST_SOURCES: "sheets",
            // Nothing listening: the connector fails and the incident line prints.
            SHEETS_BASE_URL: "http://127.0.0.1:1",
            ALLOW_DEV_SECRETS: "1",
          },
        },
        (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(err);
          resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
        },
      );
    });
    expect(res.out).toContain("backfill[sheets] failed");
    expect(res.out).toContain("this paradigm keeps no cursor");
    // The exact fabrication the finding names must be gone.
    expect(res.out).not.toContain("resume from cursor 0");
  });
});
