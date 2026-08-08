// PRE-3 / #41 — agent test files assigned `DBT_SCHEMA` at module top level.
//
// The entry OVER-STATED the exposure and is reworded rather than merely struck: the three
// schemas are distinct (`agent_priv_test`, `mcp_test_analytics`, `host_test_analytics`),
// so the collision the phrasing implies is already absent. The residual hazard is
// narrower and real: a module-top-level `process.env.X = ...` is a side effect of IMPORT,
// so it escapes the file that wrote it the moment these files share a process — which is
// exactly what the entry's own trigger (parallelisation, or a merged vitest project) names.
// `vi.stubEnv` + `vi.unstubAllEnvs` scopes the mutation to the suite that needs it and
// undoes it afterwards.
//
// Pinned as a GREP over the directory rather than as three edits, because "a fix applied
// to one member of a family with the siblings missed" is this repo's most-repeated defect
// and three known members is exactly the size at which someone fixes two.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Lines that assign to `process.env.<NAME>` outside any block — i.e. at module scope,
 *  where the assignment happens on import and outlives the file. Indented assignments are
 *  inside a hook or a test and are not this defect. */
function topLevelEnvAssignments(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => /^process\.env\.[A-Z_]+\s*=/.test(line));
}

describe("PRE-3 #41 — no agent test mutates the environment as a side effect of import", () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"));

  it("finds the test files it claims to be sweeping (a vacuous grep is not a pin)", () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const known of ["db-privileges.test.ts", "mcp.test.ts", "report.test.ts"]) {
      expect(files, `${known} is one of the three the entry names`).toContain(known);
    }
  });

  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith(".test.ts"))) {
    it(`${file}: no top-level process.env assignment — use vi.stubEnv in a setup hook`, () => {
      const found = topLevelEnvAssignments(readFileSync(join(TEST_DIR, file), "utf8"));
      expect(found, `${file} assigns env at import time: ${found.join(" | ")}`).toEqual([]);
    });
  }
});
