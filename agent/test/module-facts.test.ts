// A1 CRITICAL-1 — the bypass corpus, kept as a test rather than as a claim.
//
// The regex sweep this replaces was defeated by `import { Pool } from "pg"` plus
// `process.env["WRITER_DATABASE_URL"]`: a full-privilege writable pool with literal INSERT
// SQL inside `agent/src/host/`, with all 84 agent tests green and typecheck clean. Neither
// spelling is obfuscation; both are default TypeScript idiom.
//
// A control proven once, by hand, against the one example someone happened to try is not
// proven — it is anecdote with a green tick next to it. So every bypass is a permanent
// case here, and each is checked against `writerBoundaryViolations`, THE SAME function the
// real sweep runs over `agent/src/**`. That sharing is the point: weakening the predicate
// to make the real sweep pass reds this file immediately, and a future contributor who
// finds a seventh bypass adds it here rather than to a comment.
//
// What this does NOT claim. It is static analysis over one directory. It cannot see a
// transitive npm dependency opening its own connection, and it cannot see code that does
// not exist at build time. Those are the runtime control's job
// (`test/fixtures/boot-propose.ts` patches `pg.Client.prototype.connect` and reports every
// role the process actually connected as). Static covers dormant code; runtime covers
// executed code.
import { describe, expect, it } from "vitest";
import {
  analyzeModule,
  writerBoundaryViolations,
  WRITER_BOUNDARY_DEFAULTS,
  type WriterBoundaryConfig,
} from "./helpers/module-facts.js";

const CONFIG: WriterBoundaryConfig = {
  ...WRITER_BOUNDARY_DEFAULTS,
  poolEntrypoints: ["host/run-report.ts", "host/run-propose.ts"],
  allowedExternalModules: [
    "@anthropic-ai/sdk",
    "@modelcontextprotocol/sdk/client/index.js",
    "@modelcontextprotocol/sdk/inMemory.js",
    "@modelcontextprotocol/sdk/server/mcp.js",
    "node:fs",
    "pg",
    "zod",
  ],
};

const check = (rel: string, src: string): string[] =>
  writerBoundaryViolations([analyzeModule(rel, src)], CONFIG);

/** Every bypass is placed at a NON-entrypoint path, which is where a real one would land. */
const BYPASSES: { name: string; rel: string; src: string; because: RegExp }[] = [
  {
    name: "1. named import + bracket env access (the reviewer's exact bypass)",
    rel: "host/writer.ts",
    src: `import { Pool } from "pg";
const url = process.env["WRITER_DATABASE_URL"];
export const writerPool = new Pool({ connectionString: url });
export const write = (t: string) =>
  writerPool.query("insert into approval.proposals (action_type) values ($1)", [t]);`,
    because: /binds the database driver/,
  },
  {
    name: "2. namespace import + destructured env",
    rel: "host/writer.ts",
    src: `import * as driver from "pg";
const { WRITER_DB_URL: cs } = process.env;
export const writerPool = new driver.Pool({ connectionString: cs });`,
    because: /binds the database driver/,
  },
  {
    name: "3. barrel file re-exporting the driver (laundering the binding one hop)",
    rel: "host/barrel.ts",
    src: `export { Pool } from "pg";`,
    because: /re-exports a database module/,
  },
  {
    name: "4. dynamic await import(), no static import anywhere",
    rel: "host/writer.ts",
    src: `export async function writer(): Promise<unknown> {
  const driver = await import("pg");
  const pool = new driver.Pool({ connectionString: process.env.PGPASSFILE });
  return pool.query("insert into approval.proposals (action_type) values ('x')");
}`,
    because: /binds the database driver/,
  },
  {
    name: "5. createRequire with a COMPUTED specifier, defeating specifier analysis entirely",
    rel: "host/writer.ts",
    src: `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const name = ["p", "g"].join("");
export const driver = req(name) as { Pool: new (o: unknown) => unknown };
export const writerPool = new (driver.Pool)({ connectionString: "postgres://switchboard@db/x" });`,
    because: /createRequire escapes specifier analysis|non-whitelisted module "node:module"/,
  },
  {
    name: "6. credential from a FILE, not the environment — no env access at all",
    rel: "host/writer.ts",
    src: `import { readFileSync } from "node:fs";
import pgDriver from "pg";
const cs = readFileSync("/etc/switchboard/writer.conn", "utf8").trim();
export const writerPool = new pgDriver.Pool({ connectionString: cs });`,
    because: /binds the database driver/,
  },
  {
    name: "7. process.env aliased, so no key is ever visible to key analysis",
    rel: "host/writer.ts",
    src: `const e = process.env;
export const cs = e.WRITER_DATABASE_URL;`,
    because: /process\.env escapes static analysis/,
  },
  {
    name: "8. libpq's non-URL credential channel — a service file, no URL-shaped variable",
    rel: "host/agent-db.ts",
    src: `export const service = process.env.PGSERVICEFILE;
export const host = process.env["PGHOST"];`,
    because: /reads credential-shaped/,
  },
];

describe("A1 CRITICAL-1: every known bypass of the writer boundary is caught", () => {
  it("the corpus is non-empty and covers genuinely different mechanisms (a vacuous corpus is not evidence)", () => {
    expect(BYPASSES.length).toBeGreaterThanOrEqual(5);
    const mechanisms = new Set(BYPASSES.map((b) => b.name.replace(/^\d+\.\s*/, "").split(" ")[0]));
    expect(mechanisms.size).toBeGreaterThanOrEqual(5);
  });

  for (const b of BYPASSES) {
    it(`${b.name} — reds`, () => {
      const found = check(b.rel, b.src);
      expect(found, `NOT CAUGHT: ${b.name}`).not.toEqual([]);
      expect(
        found.join(" | "),
        `caught, but not for the reason this case exists to test`,
      ).toMatch(b.because);
    });
  }

  it("the predicate is not simply always-red: the real entrypoint shape passes", () => {
    // The other half of the vacuity guard. Without this, `return ["always"]` would satisfy
    // every assertion above.
    const legitimate = `import pg from "pg";
import { agentConnectionString, assertAgentRole } from "./agent-db.js";
const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
await assertAgentRole(pool);`;
    expect(check("host/run-propose.ts", legitimate)).toEqual([]);
  });

  it("a type-only driver import is NOT a violation — it binds nothing at runtime", () => {
    // report.ts holds exactly this. Treating it as a pool site would push implementers to
    // delete a type annotation to get green, which is a worse repo for the same claim.
    const typeOnly = `import type pg from "pg";
export function f(pool: pg.Pool): void { void pool; }`;
    expect(check("host/report.ts", typeOnly)).toEqual([]);
  });

  it("a non-credential env read outside the entrypoints is NOT a violation", () => {
    // The sweep bounds credentials, not configuration. DBT_SCHEMA and ANTHROPIC_API_KEY are
    // read in agent/src today and must stay legal, or the pin becomes something people
    // route around.
    expect(check("host/schema.ts", `export const s = process.env.DBT_SCHEMA ?? "x";`)).toEqual([]);
  });
});
