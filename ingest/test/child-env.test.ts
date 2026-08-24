// The pin for helpers/child-env.ts — the hermetic child-env contract.
//
// HISTORY (why this file exists): a developer's `.env` legitimately gained
// SWITCHBOARD_TENANT_ID during voice work, and every CLI-spawning test that built its
// child env as a spread of process.env handed the child that tenant. The child wrote and
// read gap/ledger rows under the developer's tenant while the test asserted against the
// all-zeros default lane — 23 failures across 5 files, none of them a product defect.
// The previous control for this hazard was a register NOTE ("do not add it to .env").
// It failed. This file is the replacement: a BEHAVIOURAL pin that runs a real CLI child
// under a deliberately-poisoned parent env and asserts the poison does not reach it.
//
// Two layers, deliberately unequal:
//   1. The CONTROL is the behavioural pair below — a real child process, a real
//      database, a rogue tenant in the PARENT env only. It fails whenever leakage
//      returns, HOWEVER the leak is spelled.
//   2. The source sweep at the bottom is a SPEED BUMP, NOT A CONTROL — a regex over
//      test-file source is defeated by any idiom it did not anticipate (this repo has
//      recorded exactly that lesson). It exists to point the next author at cliEnv()
//      at edit time, nothing more.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type pg from "pg";
import { freshTestDb } from "./helpers/testdb.js";
import { cliEnv } from "./helpers/child-env.js";
import { recordGap } from "../src/connectors/types.js";
import { DEFAULT_TENANT_ID } from "../src/ingest-event.js";

const INGEST_DIR = fileURLToPath(new URL("..", import.meta.url));
const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

/** A valid non-default tenant standing in for whatever uuid a developer's `.env`
 *  happens to hold. Valid ON PURPOSE: an invalid uuid would make the child THROW
 *  (resolveDeploymentTenant rejects it), which is loud — the failure mode this pin
 *  guards against is the quiet one, where the child works diligently in the wrong lane. */
const ROGUE_TENANT = "5a6c6879-aaaa-4aaa-8aaa-123456789abc";

let pool: pg.Pool;
let dbUrl: string;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const result = await freshTestDb();
  pool = result.pool;
  dbUrl = result.url;
  cleanup = result.cleanup;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanup();
});

/** Bare `gap-ack` (no --tenant flag) resolves its tenant from the CHILD's env via
 *  resolveDeploymentTenant — exactly the resolution path the 23 failures leaked through. */
function runGapAckList(extra: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/cli/gap-ack.ts", "--list"],
      {
        cwd: INGEST_DIR,
        timeout: 30_000,
        env: cliEnv({
          DATABASE_URL: dbUrl,
          INGEST_SOURCES: "casebus",
          ALLOW_DEV_SECRETS: "1",
          ...extra,
        }),
      },
      (err, stdout, stderr) => {
        if (err && typeof err.code !== "number") return reject(err);
        resolve({ code: err ? (err.code as number) : 0, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

describe("cliEnv builds a child env the parent's shell cannot poison", () => {
  it("CONTROL: a rogue SWITCHBOARD_TENANT_ID in the PARENT env does not reach the child — it still operates on the default lane", async () => {
    // A gap the DEFAULT tenant owns.
    await recordGap(pool, {
      tenantId: DEFAULT_TENANT_ID,
      source: "casebus",
      cause: "reset",
      fromEventId: "evt_hermetic_default_lane",
      fromOccurredAt: null,
      toOccurredAt: null,
    });
    // The exact hazard, reproduced: the parent process holds a developer's tenant.
    vi.stubEnv("SWITCHBOARD_TENANT_ID", ROGUE_TENANT);

    const res = await runGapAckList();
    expect(res.code, res.out).toBe(0);
    // Leakage makes the child list the ROGUE lane and report a clean zero — the
    // wrong-lane failure is a "no gaps" answer, which is why it shipped 23 reds.
    expect(res.out, "child resolved the parent's tenant — the env leaked").toContain(
      "evt_hermetic_default_lane",
    );
    expect(res.out).not.toContain("no gaps recorded");
  });

  it("COMPANION (anti-vacuity): the same helper WITH an explicit tenant override does reach the rogue lane — the stub is live and deliberate tenants still work", async () => {
    await recordGap(pool, {
      tenantId: ROGUE_TENANT,
      source: "casebus",
      cause: "reset",
      fromEventId: "evt_hermetic_rogue_lane",
      fromOccurredAt: null,
      toOccurredAt: null,
    });
    vi.stubEnv("SWITCHBOARD_TENANT_ID", ROGUE_TENANT);
    // Proves the control's stub actually mutates this process's env (a dead stub would
    // green the control for free)…
    expect(process.env.SWITCHBOARD_TENANT_ID).toBe(ROGUE_TENANT);

    // …and proves the override lane works: pull-tenant.test.ts and
    // tenant-blind-queries.test.ts depend on explicit overrides winning.
    const res = await runGapAckList({ SWITCHBOARD_TENANT_ID: ROGUE_TENANT });
    expect(res.code, res.out).toBe(0);
    expect(res.out, "explicit override failed to reach the child").toContain(
      "evt_hermetic_rogue_lane",
    );
  });
});

// ── SPEED BUMP, NOT A CONTROL ─────────────────────────────────────────────────────────
// A regex over source is defeated by idiom (recorded lesson); the behavioural pair above
// is what actually holds the line. This sweep exists so the NEXT spawn site gets pointed
// at cliEnv() by a failing test at edit time instead of by a 23-red incident later.
describe("no ingest test builds a child env by spreading process.env", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));

  it("finds the files it claims to be sweeping (a vacuous grep is not a pin)", () => {
    // 83 at time of writing; a collapse below 40 means the sweep is reading the wrong
    // directory, not that the suite shrank by half unnoticed.
    expect(files.length).toBeGreaterThanOrEqual(40);
    for (const known of [
      "bus-cli.test.ts",
      "hub-cli.test.ts",
      "reconcile-cli.test.ts",
      "pull-tenant.test.ts",
      "tenant-blind-queries.test.ts",
    ]) {
      expect(files, `${known} is a known CLI-spawning member`).toContain(known);
    }
  });

  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"))) {
    it(`${file}: no process.env spread — build child envs with cliEnv() from helpers/child-env.ts`, () => {
      const source = readFileSync(join(TEST_DIR, file), "utf8");
      const hits = source
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\.\.\.process\.env/.test(line));
      expect(
        hits,
        `${file} spreads process.env into a child env (lines ${hits.map((h) => h.n).join(", ")}) — ` +
          "that hands the child whatever the developer's shell or .env holds; use cliEnv()",
      ).toEqual([]);
    });
  }
});
