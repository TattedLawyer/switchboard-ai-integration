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
import {
  analyzeModule,
  writerBoundaryViolations,
  WRITER_BOUNDARY_DEFAULTS,
} from "./helpers/module-facts.js";
import {
  ALLOWED_EXTERNAL_MODULES,
  POOL_ENTRYPOINTS,
  SWEPT_EXTENSIONS,
  UNSWEPT_ALLOWED_EXTENSIONS,
  collectSources,
} from "./helpers/writer-boundary-config.js";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

// Input selection lives in writer-boundary-config.ts, with the extension policy, because
// it is part of the control rather than plumbing in front of it: a walker that silently
// drops what it does not recognise (`endsWith(".ts")`) is a policy nobody reviewed, and it
// is how a `.mjs` writer sat in this tree invisibly.
const COLLECTION = collectSources(SRC_DIR, (path) => readFileSync(path, "utf8"));
const SOURCES = COLLECTION.sources;

const FACTS = SOURCES.map((s) => analyzeModule(s.rel, s.text));

describe("A1 part 3: AST sweep over agent/src/** — bindings and specifiers, not text", () => {
  it("finds the source files it claims to be sweeping (a vacuous sweep is not a pin)", () => {
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
    // an earlier draft left the writer client's own directory unswept.
    expect(SOURCES.some((s) => s.rel.startsWith("host/"))).toBe(true);
    expect(SOURCES.some((s) => s.rel.startsWith("mcp/"))).toBe(true);
    // …and the analyzer must actually be seeing structure, not returning empty facts for
    // everything. If this ever reads zero, every assertion below passes for free.
    expect(FACTS.flatMap((f) => f.specifiers).length).toBeGreaterThanOrEqual(6);
  });

  it("INPUT SELECTION: every file under agent/src/ is either swept or a declared non-code type", () => {
    // BYPASS-B: `agent/src/host/writer.mjs` holding the naive `import { Pool } from "pg"`
    // was invisible, because the walker collected only `.ts`. tsc never compiles a `.mjs`
    // and Node runs it natively, so nothing anywhere noticed. This assertion makes adding a
    // runnable extension to this tree a test failure unless the sweep is taught to read it.
    expect(COLLECTION.uncovered, "files the containment does not cover").toEqual([]);
  });

  it("the swept extension set covers every runnable form, and the policy is explicit", () => {
    // A guard on the guard: if someone "simplifies" SWEPT_EXTENSIONS back to [".ts"], this
    // reds before any bypass has to be written.
    for (const ext of [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]) {
      expect(SWEPT_EXTENSIONS, `${ext} is runnable and must be swept`).toContain(ext);
    }
    // And the escape hatch stays narrow: nothing executable may be parked in it.
    for (const ext of UNSWEPT_ALLOWED_EXTENSIONS) {
      expect([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]).not.toContain(ext);
    }
  });

  it("nothing under agent/src/ defeats static analysis — an unresolvable construct IS the finding", () => {
    // The inversion that makes this a control rather than a formality: a computed module
    // specifier, a computed process.env key, an aliased or spread process.env, a
    // createRequire — none of them analyse to "no finding". They red here. Cleverness
    // cannot buy silence.
    const opaque = FACTS.flatMap((f) => f.opaque.map((o) => `${f.rel}: ${o}`));
    expect(opaque, "these constructs make the sweep below unable to see what they do").toEqual([]);
  });

  it("agent/src/ speaks to no module outside the whitelist, by ANY import mechanism", () => {
    // Collected from static imports, namespace imports, named imports, `export … from`,
    // `import x = require()`, `import()` and `require()`. The module specifier is the one
    // thing a second pool cannot avoid naming, whatever its credential comes from —
    // environment, file, or a hardcoded string.
    const external = [
      ...new Set(FACTS.flatMap((f) => f.specifiers).filter((s) => !s.startsWith("."))),
    ].sort();
    expect(external).toEqual([...ALLOWED_EXTERNAL_MODULES].sort());
  });

  it("`pg` is reachable ONLY from the two read-only entrypoints — in any import form", () => {
    // Default, named (`import { Pool }`), namespace (`import * as pg`), re-export
    // (a barrel file leaks the binding to every importer), dynamic `import("pg")` and
    // `require("pg")` all bind here. A type-only import binds nothing at runtime and is
    // deliberately not counted — that is why report.ts may hold `import type pg from "pg"`.
    const pgUsers = FACTS.filter((f) => f.pgBindings.length > 0).map((f) => f.rel);
    expect(pgUsers.sort()).toEqual([...POOL_ENTRYPOINTS].sort());
  });

  it("no module RE-EXPORTS a database module, so a barrel file cannot launder the binding", () => {
    const reExporters = FACTS.filter((f) => f.pgBindings.includes("<re-export>")).map((f) => f.rel);
    expect(reExporters, "a re-export makes every importer of that file a pool site").toEqual([]);
  });

  it("a pool is constructed only in the two entrypoints, and only from agentConnectionString()", () => {
    const builders = FACTS.filter((f) => f.poolConstructions.length > 0).map((f) => f.rel);
    expect(builders.sort()).toEqual([...POOL_ENTRYPOINTS].sort());
    for (const f of FACTS) {
      for (const c of f.poolConstructions) {
        expect(
          c.argText,
          `${f.rel} builds ${c.form} from something other than agentConnectionString()`,
        ).toContain("connectionString: agentConnectionString()");
      }
    }
  });

  it("no module reads a credential-shaped environment variable other than AGENT_DATABASE_URL", () => {
    // Keys come from dot access, bracket access with a literal, and destructuring alike —
    // the shape of the WRITE, not the shape of the source text. `^PG` covers libpq's
    // non-URL channels (PGPASSFILE, PGSERVICE, PGSERVICEFILE, PGHOST, PGSSLKEY), through
    // which a credential can arrive without any URL-shaped variable existing.
    const CREDENTIAL_SHAPED = /DATABASE_URL|DB_PASSWORD|DB_URL|^PG|POSTGRES_/;
    const offenders: string[] = [];
    for (const f of FACTS) {
      for (const a of f.envAccesses) {
        if (a.key === null) continue; // already reported by the opaque test above
        if (!CREDENTIAL_SHAPED.test(a.key)) continue;
        if (a.key !== "AGENT_DATABASE_URL") offenders.push(`${f.rel}: ${a.form}`);
      }
    }
    expect(offenders, "credential-shaped env reads outside AGENT_DATABASE_URL").toEqual([]);
  });

  it("AGENT_DATABASE_URL is read in exactly one module, so there is one place to audit", () => {
    const readers = FACTS.filter((f) =>
      f.envAccesses.some((a) => a.key === "AGENT_DATABASE_URL"),
    ).map((f) => f.rel);
    expect(readers).toEqual(["host/agent-db.ts"]);
  });

  it("THE PREDICATE: agent/src/** contains no writer-boundary violation of any kind", () => {
    // The aggregate, and the one that matters. `writerBoundaryViolations` is the same
    // function `module-facts.test.ts` runs its eight-case bypass corpus against — so
    // weakening it to make this line pass reds that corpus in the same run. The granular
    // assertions above stay because a named failure is a better diagnostic than a list.
    const violations = writerBoundaryViolations(
      FACTS,
      { ...WRITER_BOUNDARY_DEFAULTS, poolEntrypoints: POOL_ENTRYPOINTS, allowedExternalModules: ALLOWED_EXTERNAL_MODULES },
      COLLECTION.uncovered,
    );
    expect(violations, "writer-boundary violations under agent/src/").toEqual([]);
  });

  it("the proposal client holds no database binding and no SQL — the writer is not here", () => {
    const propose = FACTS.find((f) => f.rel === "host/propose.ts");
    expect(propose).toBeDefined();
    expect(propose!.pgBindings).toEqual([]);
    expect(propose!.poolConstructions).toEqual([]);
    const src = SOURCES.find((s) => s.rel === "host/propose.ts")!.text;
    expect(src).not.toMatch(/\binsert\s+into\b/i);
    expect(src).not.toMatch(/\bpool\.query\b/);
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
  harnessFile = "boot-propose.ts",
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const harness = fileURLToPath(new URL(`./fixtures/${harnessFile}`, import.meta.url));
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
    const out = await bootChild();
    expect(out.stderr + out.stdout).toContain("ENV_WHITELIST_OK");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain("PROPOSAL_PATH_OK");
    expect(out.stdout).toMatch(/recorded proposal [0-9a-f-]{36} \(state=pending/);
    // The RUNTIME half: every connection this process actually opened, observed at
    // pg.Client.prototype.connect, whatever module opened it and however it imported pg.
    expect(out.stdout).toContain('DB_ROLES_OK ["switchboard_agent"]');
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

  it("RUNTIME: a connection opened as any other role fails the process, even when both static controls pass", async () => {
    // The case the AST sweep provably cannot see and the environment whitelist provably
    // cannot see: the connection is opened by code outside agent/src/** (standing in for a
    // transitive dependency) using a variable named LEAK_CONN, which no credential-shaped
    // pattern matches. The prototype patch on pg.Client.prototype.connect observes it
    // anyway, because every Pool builds Clients and every Client shares that prototype.
    //
    // This test exists so "every connection was switchboard_agent" is an assertion that has
    // been SEEN failing. An assertion nobody has ever watched go red is not a pin.
    const out = await bootChild(
      { LEAK_CONN: dbUrl },
      "boot-propose-leak.ts",
    );
    expect(out.stdout, "the env whitelist must have PASSED — that is the point").toContain(
      "ENV_WHITELIST_OK",
    );
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("CREDENTIAL_LEAK_RUNTIME");
    expect(out.stderr).toContain("switchboard");
  });

  it("…and the same leaky harness is clean when the leak is not configured (the control is not always-red)", async () => {
    const out = await bootChild({}, "boot-propose-leak.ts");
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('DB_ROLES_OK ["switchboard_agent"]');
  });

  it("an unrecorded proposal is a LOUD failure, never a plausible-looking success", async () => {
    const out = await bootChild({ APPROVAL_BASE_URL: "http://127.0.0.1:1" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("DOOR_REFUSED kind=unreachable");
    expect(out.stdout).not.toContain("PROPOSAL_PATH_OK");
  });

  it("a wrong bearer token is classified BY THE CODE as a refusal, not merely printed by the runtime", async () => {
    // This assertion used to read `expect(out.stderr).toContain("401")` and it was hollow:
    // deleting propose.ts's entire non-2xx branch left it green, because the child did a
    // bare top-level `await main()` and Node's unhandled-rejection dump prints the whole
    // error object — status included — for the failure two branches later. `kind` is a
    // value this code assigns, so the assertion is now about a decision rather than about
    // text the runtime may also emit.
    const out = await bootChild({ AGENT_PROPOSAL_TOKEN: "wrong-token" });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("DOOR_REFUSED kind=refused status=401");
    expect(out.stderr).not.toContain("kind=no-id");
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
