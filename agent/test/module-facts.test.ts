// A1 — the bypass corpus, covering ALL THREE layers of the writer-boundary control.
//
// Round 1 replaced a regex sweep that stayed green while a reviewer parked a full-privilege
// writable pool with literal INSERT SQL in `agent/src/host/`, using nothing but default
// TypeScript idiom (`import { Pool } from "pg"`, `process.env["X"]`). Eight bypasses became
// permanent cases here, checked against the shipped predicate.
//
// Round 2's reviewer then found two MORE, and the interesting thing about both is that the
// predicate never got to see them. They attacked the layers in front of it:
//
//   · WHICH FILES ARE READ — a `.mjs` file was never collected, so the naive bypass the
//     corpus already covered worked verbatim when spelled with a different extension.
//     Nothing suppressed, nothing clever; this is the one that happens by accident.
//   · HOW REFERENCES ARE NORMALISED — `../../../node_modules/pg/lib/index.js` is a driver
//     import wearing a relative path. Relative specifiers were skipped by the whitelist as
//     "internal", and the `/^pg/` test never matched a path, so no fact was ever recorded
//     for a rule to fire on.
//
// So the corpus now exercises collection and resolution too, not just the decision. The
// general lesson, written here because it is the thing worth remembering: a corpus proves
// the layer it is pointed at, and every layer in front of that one is untested by
// construction. Both reviewers found bugs one layer out from wherever the tests stopped.
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeModule,
  writerBoundaryViolations,
  WRITER_BOUNDARY_DEFAULTS,
  type WriterBoundaryConfig,
} from "./helpers/module-facts.js";
import {
  ALLOWED_EXTERNAL_MODULES,
  POOL_ENTRYPOINTS,
  SWEPT_EXTENSIONS,
  UNSWEPT_ALLOWED_EXTENSIONS,
  collectSources,
} from "./helpers/writer-boundary-config.js";

// THE CONFIG IS IMPORTED, NOT RESTATED. It used to be duplicated here as literals, which
// quietly weakened the shared-predicate property this file exists to provide: widening the
// sweep's module whitelist alone would not have redded a single case. Now the corpus runs
// the shipped predicate against the shipped configuration, so loosening either is visible
// here — pinned by its own test at the bottom.
const CONFIG: WriterBoundaryConfig = {
  ...WRITER_BOUNDARY_DEFAULTS,
  poolEntrypoints: POOL_ENTRYPOINTS,
  allowedExternalModules: ALLOWED_EXTERNAL_MODULES,
};

/** One module, plus any sibling files that must count as swept for relative resolution. */
const check = (rel: string, src: string, companions: string[] = []): string[] =>
  writerBoundaryViolations(
    [analyzeModule(rel, src), ...companions.map((c) => analyzeModule(c, ""))],
    CONFIG,
  );

/** Writes a whole tree to a temp dir and runs the REAL collector over it — the only way to
 *  test the file-selection layer, since that layer's input is a directory, not a string. */
function checkTree(files: Record<string, string>): string[] {
  const root = mkdtempSync(join(tmpdir(), "a1-corpus-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, "utf8");
    }
    const collection = collectSources(root, (p) => readFileSync(p, "utf8"));
    return writerBoundaryViolations(
      collection.sources.map((s) => analyzeModule(s.rel, s.text)),
      CONFIG,
      collection.uncovered,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const NAIVE_WRITER = `import { Pool } from "pg";
export const writerPool = new Pool({ connectionString: process.env.WRITER_DATABASE_URL });
export const write = () =>
  writerPool.query("insert into approval.proposals (action_type) values ('x')");`;

// ── Layer 3: the predicate ─────────────────────────────────────────────────────────────

const PREDICATE_BYPASSES: { name: string; rel: string; src: string; because: RegExp }[] = [
  {
    name: "1. named import + bracket env access (round 1's reviewer bypass)",
    rel: "host/writer.ts",
    src: NAIVE_WRITER,
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

// ── Layers 1 and 2: what gets read, and how references are normalised ──────────────────

const SELECTION_BYPASSES: { name: string; files: Record<string, string>; because: RegExp }[] = [
  {
    name: "A. relative specifier reaching into node_modules (round 2 reviewer)",
    files: {
      "host/run-propose.ts": `import pg from "pg";
import { agentConnectionString, assertAgentRole } from "./agent-db.js";
const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
await assertAgentRole(pool);`,
      "host/agent-db.ts": "export const agentConnectionString = () => ''; export const assertAgentRole = async () => {};",
      // @ts-expect-error would silence the type error; it silences no control.
      "host/writer.ts": `import pgmod from "../../../node_modules/pg/lib/index.js";
const cs = process.argv.find((a) => a.startsWith("--conn="))?.slice(7);
export const writerPool = new pgmod.Pool({ connectionString: cs });
export const write = () => writerPool.query("insert into approval.proposals values ('x')");`,
    },
    because: /node_modules|escapes the swept tree|does not cover/,
  },
  {
    name: "B. .mjs file, never collected — the naive bypass with a different extension (round 2 reviewer)",
    files: { "host/writer.mjs": NAIVE_WRITER },
    because: /binds the database driver/,
  },
  {
    name: "C. writer parked OUTSIDE the swept root and pulled in relatively (mine)",
    files: {
      "host/run-propose.ts": `import { writerPool } from "../../lib/writer.js";
export const p = writerPool;`,
    },
    because: /escapes the swept tree/,
  },
  {
    name: "D. entrypoint pool overrides the URL's role via discrete fields (mine)",
    files: {
      "host/run-propose.ts": `import pg from "pg";
import { agentConnectionString } from "./agent-db.js";
export const pool = new pg.Pool({ connectionString: agentConnectionString(), user: "switchboard", password: "switchboard" });`,
      "host/agent-db.ts": "export const agentConnectionString = () => '';",
    },
    because: /overrides connection field/,
  },
  {
    name: "I. a permitted entrypoint EXPORTS the driver class, laundering it outward (round 4 reviewer)",
    files: {
      "host/run-propose.ts": `import pg from "pg";
import { agentConnectionString } from "./agent-db.js";
export const PoolCtor = pg.Pool;
export const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });`,
      "host/agent-db.ts": "export const agentConnectionString = (): string => '';",
      "host/laundered-writer.ts": `import { PoolCtor } from "./run-propose.js";
export const writerPool = new PoolCtor({ connectionString: process.argv[2] });
export async function writeProposal(t: string) {
  return writerPool.query("insert into approval.proposals (action_type) values ($1)", [t]);
}`,
    },
    // Every layer is satisfied LEGITIMATELY by the consumer: swept file, specifier resolving
    // to a file the sweep read, no driver binding of its own, no opaque construct, a
    // credential from process.argv that no rule inspects. The only thing that was ever
    // wrong is upstream, in what the exempted file handed out.
    because: /exports "PoolCtor", which derives from the database driver/,
  },
  {
    name: "J. laundering through an ALIAS CHAIN, so the export does not name pg directly (mine)",
    files: {
      "host/run-report.ts": `import pg from "pg";
const A = pg.Pool;
const B = A;
export { B };`,
    },
    because: /exports "B", which derives from the database driver/,
  },
  {
    name: "K. two-hop driver path inside an entrypoint: new pg.native.Client (mine)",
    files: {
      "host/run-propose.ts": `import pg from "pg";
import { agentConnectionString } from "./agent-db.js";
export const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
const sneaky = new pg.native.Client({ connectionString: process.argv[2] });
void sneaky;`,
      "host/agent-db.ts": "export const agentConnectionString = (): string => '';",
    },
    // Found by probing what the corpus GRANTS rather than what it forbids: the construction
    // rule unwrapped exactly one property access, so anything two hops off the driver
    // namespace was never recorded as a construction and never had its argument checked.
    because: /new pg\.native\.Client.*is not built from/,
  },
  {
    name: "L. exported FACTORY returning a pool, with inference hiding the return type (mine)",
    files: {
      "host/run-report.ts": `import pg from "pg";
export function getPool() {
  return new pg.Pool({ connectionString: process.argv[2] });
}`,
    },
    // The narrowing that let `main(): Promise<void>` through must not also let this through.
    // An unannotated export is a violation precisely because inference would be silent.
    because: /exports "getPool", which derives from the database driver/,
  },
  {
    name: "G. an unlisted module whose ONLY violation is the whitelist (pins the shared config)",
    files: {
      "host/hash.ts": `import { createHash } from "node:crypto";
export const h = (s: string): string => createHash("sha256").update(s).digest("hex");`,
    },
    // Deliberately NOT a database module. Its only finding is the whitelist, so widening
    // the whitelist reds this case — which is the property "the corpus shares the shipped
    // config" is supposed to buy, and which no other case here would have demonstrated.
    because: /non-whitelisted module "node:crypto"/,
  },
  {
    name: "H. node_modules INSIDE the swept tree, so the relative path never escapes (mine)",
    files: {
      "host/writer.ts": `import pgmod from "./node_modules/pg/index.js";
export const writerPool = new pgmod.Pool({ connectionString: "postgres://switchboard@db/x" });`,
      "host/node_modules/pg/index.js": `export default { Pool: class {} };`,
    },
    // The escape check cannot fire (the path stays inside the root) and the file it names
    // really is swept — so this is the case that makes the node_modules-by-path rule
    // load-bearing rather than decorative. Reason-specific on purpose.
    because: /reaches into node_modules by path/,
  },
  {
    name: "E. runnable file with NO extension, which no extension list mentions (mine)",
    files: { "host/writer": NAIVE_WRITER },
    because: /UNCOVERED/,
  },
  {
    name: "F. .cjs sibling — the same accident as B in the other module system (mine)",
    files: { "host/legacy-writer.cjs": `const { Pool } = require("pg");\nmodule.exports = new Pool({ connectionString: process.env.WRITER_DATABASE_URL });` },
    because: /binds the database driver/,
  },
];

describe("A1: every known bypass of the writer boundary is caught", () => {
  it("the corpus is non-empty and spans all three layers (a vacuous corpus is not evidence)", () => {
    expect(PREDICATE_BYPASSES.length).toBeGreaterThanOrEqual(5);
    expect(SELECTION_BYPASSES.length).toBeGreaterThanOrEqual(5);
  });

  for (const b of PREDICATE_BYPASSES) {
    it(`predicate — ${b.name} — reds`, () => {
      const found = check(b.rel, b.src);
      expect(found, `NOT CAUGHT: ${b.name}`).not.toEqual([]);
      expect(found.join(" | "), "caught, but not for the reason this case exists to test").toMatch(
        b.because,
      );
    });
  }

  for (const b of SELECTION_BYPASSES) {
    it(`input selection — ${b.name} — reds`, () => {
      const found = checkTree(b.files);
      expect(found, `NOT CAUGHT: ${b.name}`).not.toEqual([]);
      expect(found.join(" | "), "caught, but not for the reason this case exists to test").toMatch(
        b.because,
      );
    });
  }
});

describe("A1: the corpus is not simply always-red, and rests on the shipped configuration", () => {
  it("the real entrypoint shape passes", () => {
    // Without this, `return ["always"]` would satisfy every assertion above.
    const legitimate = `import pg from "pg";
import { agentConnectionString, assertAgentRole } from "./agent-db.js";
const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
await assertAgentRole(pool);`;
    expect(check("host/run-propose.ts", legitimate, ["host/agent-db.ts"])).toEqual([]);
  });

  it("a whole legitimate tree passes through the real collector", () => {
    expect(
      checkTree({
        "host/run-propose.ts": `import pg from "pg";
import { agentConnectionString } from "./agent-db.js";
const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
void pool;`,
        "host/agent-db.ts": `export const agentConnectionString = (): string => process.env.AGENT_DATABASE_URL ?? "";`,
        "mcp/server.ts": `import type pg from "pg";\nexport const f = (p: pg.Pool): void => void p;`,
        "host/notes.md": "not code, and not swept — the escape hatch, exercised",
      }),
    ).toEqual([]);
  });

  it("an exported function that PROVES it hands nothing back is legal (the narrowing, pinned)", () => {
    // run-propose.ts exports `main(): Promise<void>`, which builds the read-only pool, uses
    // it and ends it. Without this guard the BYPASS-C rule would forbid the entrypoint's own
    // shape, and the fix would be to weaken the rule rather than to keep the property.
    const legit = `import pg from "pg";
import { agentConnectionString } from "./agent-db.js";
export async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: agentConnectionString(), max: 1 });
  await pool.end();
}`;
    expect(check("host/run-propose.ts", legit, ["host/agent-db.ts"])).toEqual([]);
  });

  it("a type-only driver import is NOT a violation — it binds nothing at runtime", () => {
    // report.ts holds exactly this. Treating it as a pool site would push implementers to
    // delete a type annotation to get green: a worse repo for the same claim.
    const typeOnly = `import type pg from "pg";
export function f(pool: pg.Pool): void { void pool; }`;
    expect(check("host/report.ts", typeOnly)).toEqual([]);
  });

  it("a non-credential env read outside the entrypoints is NOT a violation", () => {
    // The sweep bounds credentials, not configuration. DBT_SCHEMA and ANTHROPIC_API_KEY are
    // read in agent/src today and must stay legal, or the pin becomes something people
    // route around rather than something they satisfy.
    expect(check("host/schema.ts", `export const s = process.env.DBT_SCHEMA ?? "x";`)).toEqual([]);
  });

  it("the corpus uses the SHIPPED config object, not a copy of its values", () => {
    // The property the shared predicate is supposed to give: loosening the real whitelist
    // or the real entrypoint list has to be visible in this file. Identity, not equality —
    // a restated literal would satisfy a `toEqual` and defeat the point.
    expect(CONFIG.allowedExternalModules).toBe(ALLOWED_EXTERNAL_MODULES);
    expect(CONFIG.poolEntrypoints).toBe(POOL_ENTRYPOINTS);
    expect(CONFIG.credentialShaped).toBe(WRITER_BOUNDARY_DEFAULTS.credentialShaped);
  });

  it("the extension policy is exhaustive: swept and non-code lists do not overlap and cover the runnable forms", () => {
    for (const ext of SWEPT_EXTENSIONS) {
      expect(UNSWEPT_ALLOWED_EXTENSIONS, `${ext} cannot be both`).not.toContain(ext);
    }
    for (const ext of [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]) {
      expect(SWEPT_EXTENSIONS, `${ext} is runnable by node or tsx`).toContain(ext);
    }
  });
});
