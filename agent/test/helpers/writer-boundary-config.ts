// A1 — the writer boundary's configuration and its INPUT SELECTION, in one place.
//
// WHY THIS FILE EXISTS AT ALL. The bypass corpus was written against the predicate
// (`writerBoundaryViolations`) and proved it catches eight ways of smuggling a pool into
// `agent/src/**`. A reviewer then found two more, and both of them walked straight past
// the predicate without ever being evaluated by it — because they attacked the steps in
// FRONT of it, which nothing had put under a corpus:
//
//   BYPASS-A — `import pgmod from "../../../node_modules/pg/lib/index.js"`. A relative
//     specifier, so the module whitelist skipped it by design; and `/^pg(\/|$)/` never
//     matches a path, so no driver binding was ever recorded. Rules 3 and 4 could not fire
//     on facts that were never collected. (It needs one `@ts-expect-error` for TS7016 —
//     and a suppression comment is not a control. Nothing was stopping it.)
//   BYPASS-B — `agent/src/host/writer.mjs`, containing the *naive* `import { Pool }`
//     the corpus already covers. The walker only collected `.ts`, so the file was never
//     read. tsconfig never compiles it; Node runs it natively. **This is the one that
//     happens by accident** — someone adds a file with a different extension and the
//     containment silently stops covering it, with nothing to notice.
//
// The lesson is not "two more rules". It is that a control has three layers — which files
// are read, how their references are normalised, and what the predicate then decides — and
// only the third had ever been adversarially tested. All three now live here, and all
// three are under the corpus in `module-facts.test.ts`.
import { readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

/** The two entrypoints permitted to bind the driver and open the agent's one pool. */
export const POOL_ENTRYPOINTS = ["host/run-report.ts", "host/run-propose.ts"] as const;

/**
 * Every non-relative module `agent/src/**` may reference, by any mechanism. A WHITELIST,
 * because a denylist of database drivers only lists the ones its author remembered.
 */
export const ALLOWED_EXTERNAL_MODULES = [
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk/client/index.js",
  "@modelcontextprotocol/sdk/inMemory.js",
  "@modelcontextprotocol/sdk/server/mcp.js",
  "node:fs",
  "pg",
  "zod",
] as const;

/**
 * Extensions the sweep reads. Every one of these is RUNNABLE — Node executes `.mjs`,
 * `.cjs` and `.js` natively regardless of whether `tsc` ever sees them, and tsx handles
 * the TypeScript family. The list is deliberately generous: a file this sweep cannot read
 * is a file the containment does not cover, so the cost of an extra extension here is
 * nothing and the cost of a missing one is the whole pin.
 */
export const SWEPT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

/**
 * Extensions that may exist under `agent/src/**` WITHOUT being swept, because they cannot
 * execute. Anything under the tree that is in neither list is itself a violation — that is
 * what makes "someone adds a new runnable extension" a test failure rather than a silent
 * loss of coverage. Empty today, and stated as a list rather than as a wildcard so adding
 * to it is a visible decision.
 */
export const UNSWEPT_ALLOWED_EXTENSIONS: readonly string[] = [".json", ".md", ".sql"];

export interface CollectedSource {
  rel: string;
  text: string;
}

export interface Collection {
  sources: CollectedSource[];
  /** Files under the root the sweep did not read. NON-EMPTY IS A VIOLATION. */
  uncovered: string[];
}

const extensionOf = (name: string): string => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
};

/**
 * Reads the tree. Returns both what it swept AND what it refused to sweep, because a
 * collector that silently drops what it does not understand is exactly how BYPASS-B
 * worked: the walker's `endsWith(".ts")` was a filter nobody thought of as a policy.
 */
export function collectSources(
  rootDir: string,
  readFile: (path: string) => string,
): Collection {
  const sources: CollectedSource[] = [];
  const uncovered: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, rel);
        continue;
      }
      const ext = extensionOf(entry);
      if ((SWEPT_EXTENSIONS as readonly string[]).includes(ext)) {
        sources.push({ rel, text: readFile(full) });
      } else if (!UNSWEPT_ALLOWED_EXTENSIONS.includes(ext)) {
        uncovered.push(`${rel} (extension "${ext || "<none>"}" is in neither list)`);
      }
    }
  };

  walk(rootDir, "");
  return { sources, uncovered };
}

/**
 * Where a relative specifier lands, as a path relative to the swept root.
 *
 * Returns `null` when it escapes the root — which is BYPASS-A's whole mechanism. A
 * specifier starting with `.` was previously waved through as "internal", and
 * `../../../node_modules/pg/lib/index.js` is neither internal nor recognisable as `pg`.
 */
export function resolveRelative(fromRel: string, spec: string): string | null {
  const dir = posix.dirname(fromRel);
  const joined = posix.normalize(posix.join(dir === "." ? "" : dir, spec));
  if (joined.startsWith("..") || posix.isAbsolute(joined)) return null;
  return joined;
}

/**
 * The compiled-output spellings a relative import may use for a source file in the tree —
 * TypeScript's NodeNext resolution requires importing `./x.js` for `./x.ts`.
 */
export function candidateTargets(resolved: string): string[] {
  const out = [resolved];
  const map: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"],
  };
  for (const [from, tos] of Object.entries(map)) {
    if (resolved.endsWith(from)) {
      const stem = resolved.slice(0, -from.length);
      for (const to of tos) out.push(`${stem}${to}`);
    }
  }
  for (const ext of SWEPT_EXTENSIONS) out.push(`${resolved}/index${ext}`);
  return out;
}
