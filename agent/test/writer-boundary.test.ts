// Phase 3 / A1 — THE PIN. "No write-capable credential exists anywhere in the agent
// process," in five parts, because the single-variable version of this pin proved far
// less than it claimed.
//
// The version this replaces booted the agent with DATABASE_URL deleted and asserted its
// absence. Three defects, all fatal:
//   (a) it named a VARIABLE, not a property — a writer added as WRITER_DATABASE_URL keeps
//       it green while a full-privilege pool sits in agent/src/host/;
//   (b) it booted run-report.ts, which never proposes anything, so it was a true assertion
//       about a path with no relationship to the decision being pinned;
//   (c) it "passed today" only in a configuration that existed nowhere — ci.yml sets
//       DATABASE_URL job-wide and nothing in the repo ever set AGENT_DATABASE_URL, so
//       every actual run took the derivation path.
//
// The five parts, each of which must be able to fail:
//   1. agent-db.ts fails closed — no credential is derived from DATABASE_URL.
//      (Asserted in agent/test/agent-credential.test.ts; referenced here so the set is
//      readable in one place, and re-asserted structurally by part 3.)
//   2. A WHITELIST over credential-shaped env keys, evaluated inside the child.
//   3. A source sweep over `agent/src/**` — not just `agent/src/mcp/**`, which is where
//      the earlier draft scoped it, leaving the writer client's own directory unswept.
//   4. The child boots the A1 PROPOSAL PATH and records a proposal against a real door.
//   5. A `current_user` startup assertion that THROWS on a writable pool — the only part
//      here that catches a deployment mistake rather than a code mistake.
//
// Honest about what part 3 is: a legibility control, not a security boundary. It is a text
// assertion and is defeated by indirection (a computed env key). Parts 4 and 5 are the
// ones that run.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { createApprovalApp } from "../../approval/src/server.js";
import { assertAgentRole, REQUIRED_AGENT_ROLE } from "../src/host/agent-db.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

const SOURCES = walk(SRC_DIR).map((path) => ({
  rel: path.slice(SRC_DIR.length + 1),
  text: readFileSync(path, "utf8"),
}));

// The two entrypoints that legitimately build the agent's ONE pool. Both build it from
// agentConnectionString(), which can only ever return the read-only credential.
const POOL_ENTRYPOINTS = ["host/run-report.ts", "host/run-propose.ts"];

describe("A1 part 3: source sweep over agent/src/** (a legibility control, stated as one)", () => {
  it("finds the source files it claims to be sweeping (a vacuous grep is not a pin)", () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(6);
    for (const known of [
      "host/agent-db.ts",
      "host/propose.ts",
      "host/run-propose.ts",
      "mcp/server.ts",
    ]) {
      expect(
        SOURCES.map((s) => s.rel),
        `${known} is one of the files this sweep must be reading`,
      ).toContain(known);
    }
    // The sweep must cover more than the MCP directory — scoping it there is exactly how
    // the earlier draft left the writer client's own directory unswept.
    expect(SOURCES.some((s) => s.rel.startsWith("host/"))).toBe(true);
    expect(SOURCES.some((s) => s.rel.startsWith("mcp/"))).toBe(true);
  });

  it("no module under agent/src/ reads a full-privilege credential", () => {
    // Every credential-shaped env read in the whole tree, with its file. The only name
    // permitted is AGENT_DATABASE_URL: the read-only role's own connection string.
    const offenders: string[] = [];
    for (const { rel, text } of SOURCES) {
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        const name = m[1];
        if (!/DATABASE_URL|DB_PASSWORD|DB_URL|PGPASSWORD|PGUSER|POSTGRES_PASSWORD/.test(name)) {
          continue;
        }
        if (name !== "AGENT_DATABASE_URL") offenders.push(`${rel}: process.env.${name}`);
      }
    }
    expect(offenders, `credential-shaped env reads outside AGENT_DATABASE_URL`).toEqual([]);
  });

  it("AGENT_DATABASE_URL is read in exactly one module, so there is one place to audit", () => {
    const readers = SOURCES.filter((s) => s.text.includes("process.env.AGENT_DATABASE_URL"));
    expect(readers.map((s) => s.rel)).toEqual(["host/agent-db.ts"]);
  });

  it("a database pool is constructed only in the two read-only entrypoints", () => {
    const builders = SOURCES.filter((s) => /new pg\.Pool/.test(s.text)).map((s) => s.rel);
    expect(builders.sort()).toEqual([...POOL_ENTRYPOINTS].sort());
  });

  it("every pool in agent/src/ is built from agentConnectionString() — no literal, no other variable", () => {
    for (const { rel, text } of SOURCES) {
      for (const m of text.matchAll(/new pg\.Pool\(\{([^}]*)\}/g)) {
        expect(
          m[1],
          `${rel} builds a pool from something other than agentConnectionString()`,
        ).toContain("connectionString: agentConnectionString()");
      }
    }
  });

  it("the proposal client contains no SQL and no pg import — the writer is not here", () => {
    const propose = SOURCES.find((s) => s.rel === "host/propose.ts");
    expect(propose).toBeDefined();
    expect(propose!.text).not.toMatch(/\bfrom "pg"/);
    expect(propose!.text).not.toMatch(/\binsert\s+into\b/i);
    expect(propose!.text).not.toMatch(/\bpool\.query\b/);
  });

  it("`pg` is imported as a VALUE only where a pool is legitimately built", () => {
    // `import type pg` in mcp/server.ts is a type-only import and erases at build; a value
    // import anywhere else is the first move of adding a second pool.
    const valueImporters = SOURCES.filter((s) => /^import pg from "pg";/m.test(s.text)).map(
      (s) => s.rel,
    );
    expect(valueImporters.sort()).toEqual([...POOL_ENTRYPOINTS].sort());
  });
});

// ── Parts 2 and 4: boot the real proposal path with a controlled environment ────────────

let admin: pg.Pool;
let approvalPool: pg.Pool;
let cleanup: () => Promise<void>;
let dbUrl: string;
let doorUrl: string;
let closeDoor: () => Promise<void>;

const TENANT = "00000000-0000-0000-0000-000000000000";
const TOKEN = "writer-boundary-pin-token";

function asRole(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role;
  return u.toString();
}

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  dbUrl = r.url;
  cleanup = r.cleanup;
  approvalPool = new pg.Pool({ connectionString: asRole(dbUrl, "switchboard_approval"), max: 2 });
  const app = createApprovalApp(approvalPool, {
    tenantId: TENANT,
    proposalToken: TOKEN,
    pendingCap: 50,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  doorUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closeDoor = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  if (closeDoor) await closeDoor();
  if (approvalPool) await approvalPool.end().catch(() => {});
  await cleanup();
});

/** Spawn the child with an environment built from nothing — not from process.env — so a
 *  credential the parent holds cannot leak in by omission.
 *
 *  ASYNC ON PURPOSE. The first draft used spawnSync, which deadlocks: the approval door
 *  under test is an express server in THIS process, and a synchronous spawn blocks the
 *  event loop that would have answered the child's request. The child hung forever on a
 *  connection nobody could serve. Recorded here because "the test harness starves the
 *  server it is testing" looks like a product hang. */
async function bootChild(
  extra: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const harness = fileURLToPath(new URL("./fixtures/boot-propose.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", harness], {
    cwd: REPO_ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      AGENT_DATABASE_URL: asRole(dbUrl, REQUIRED_AGENT_ROLE),
      AGENT_PROPOSAL_TOKEN: TOKEN,
      APPROVAL_BASE_URL: doorUrl,
      ...extra,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const status = await new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  return { status, stdout, stderr };
}

describe("A1 parts 2+4: the proposal path runs with no write-capable credential in reach", () => {
  it("boots, sees only AGENT_DATABASE_URL, and records a real proposal", async () => {
    const key = `pin-${Date.now()}`;
    const out = await bootChild({ PROPOSAL_KEY: key });
    expect(out.stderr + out.stdout).toContain("ENV_WHITELIST_OK");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("PROPOSAL_PATH_OK");
    expect(out.stdout).toMatch(/recorded proposal [0-9a-f-]{36} \(state=pending/);
  });

  it("the proposal really landed in the database — written by the approval service, not by the agent", async () => {
    const out = await bootChild();
    expect(out.status, out.stderr).toBe(0);
    const id = /recorded proposal ([0-9a-f-]{36})/.exec(out.stdout)?.[1];
    expect(id).toBeDefined();
    const row = await admin.query(
      "select state, action_type from approval.proposals where id = $1",
      [id],
    );
    expect(row.rowCount).toBe(1);
    expect(row.rows[0].state).toBe("pending");
  });

  it("the SAME process, on its own pool, gets 42501 attempting that insert itself", async () => {
    // The round trip stated as one sentence: the agent's credential can ask for a proposal
    // to be recorded, and cannot record one.
    const agent = new pg.Pool({ connectionString: asRole(dbUrl, REQUIRED_AGENT_ROLE), max: 1 });
    try {
      await expect(
        agent.query(
          `insert into approval.proposals (tenant_id, idempotency_key, action_type, payload, rationale)
           values ($1, 'forged-by-agent', 'send_email', '{}'::jsonb, 'forged')`,
          [TENANT],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await agent.end();
    }
  });

  it("a credential-shaped variable under ANY name fails the whitelist — renaming does not evade it", async () => {
    // The adversarial revert-check, run as a test rather than performed by hand: this is
    // precisely the move that kept the single-variable version of this pin green.
    const out = await bootChild({ WRITER_DATABASE_URL: "postgres://switchboard:switchboard@localhost:5433/switchboard" });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("CREDENTIAL_LEAK");
    expect(out.stderr).toContain("WRITER_DATABASE_URL");
  });

  it("DATABASE_URL itself fails the whitelist too", async () => {
    const out = await bootChild({ DATABASE_URL: "postgres://switchboard:switchboard@localhost:5433/switchboard" });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("CREDENTIAL_LEAK");
  });

  it("an unrecorded proposal is a LOUD failure, never a plausible-looking success", async () => {
    const out = await bootChild({ APPROVAL_BASE_URL: "http://127.0.0.1:1" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("NOT recorded");
    expect(out.stdout).not.toContain("PROPOSAL_PATH_OK");
  });

  it("a wrong bearer token is a loud failure, not a silent skip", async () => {
    const out = await bootChild({ AGENT_PROPOSAL_TOKEN: "wrong-token" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("NOT recorded");
    expect(out.stderr).toContain("401");
  });
});

// ── Part 5: the runtime role assertion ────────────────────────────────────────────────

describe("A1 part 5: the host refuses to serve on any connection that is not switchboard_agent", () => {
  it("accepts the read-only role", async () => {
    const pool = new pg.Pool({ connectionString: asRole(dbUrl, REQUIRED_AGENT_ROLE), max: 1 });
    try {
      await expect(assertAgentRole(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("THROWS on a writable pool — the deployment mistake CI cannot see", async () => {
    // `admin` is the migration owner. Code review would not catch this: the code is
    // correct and the environment is wrong.
    await expect(assertAgentRole(admin)).rejects.toThrow(/refuses to serve tools/);
    await expect(assertAgentRole(admin)).rejects.toThrow(/switchboard/);
  });

  it("throws on the APPROVAL role too — any role but the read-only one is refused", async () => {
    await expect(assertAgentRole(approvalPool)).rejects.toThrow(/refuses to serve tools/);
  });

  it("the entrypoints call it — an assertion nothing invokes is not an assertion", () => {
    for (const rel of POOL_ENTRYPOINTS) {
      const src = SOURCES.find((s) => s.rel === rel);
      expect(src, rel).toBeDefined();
      expect(src!.text, `${rel} builds a pool without asserting the role`).toContain(
        "assertAgentRole(pool)",
      );
    }
  });
});
