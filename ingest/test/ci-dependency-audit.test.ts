// PRE-3 / #27 (gate-H, hygiene) — no dependency audit or update automation in CI.
//
// `.github/workflows/` is `ci.yml` and `chaos.yml`, with no `dependabot.yml` and no
// `npm audit` step: nothing in this repo ever looks at whether a shipped dependency has a
// published advisory. The entry blesses the cheap version explicitly ("a non-blocking step
// is acceptable whenever someone wants the signal") and explicitly refuses the blocking
// one, for a good reason — a single high-severity advisory in a transitive DEV dependency
// would turn CI permanently red on something the repo cannot fix and does not ship, and a
// permanently red gate is a gate everyone learns to ignore.
//
// So the pin is on BOTH halves. The step must exist, and it must NOT be able to fail the
// run — the second half is the one a future "let's make this strict" edit would break, and
// it is the half that carries the reasoning.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ci = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");

describe("PRE-3 #27 — CI emits a dependency-advisory signal, and cannot be reddened by it", () => {
  it("runs npm audit at high severity", () => {
    expect(ci).toMatch(/npm audit --audit-level=high/);
  });

  it("is NON-BLOCKING — the command's failure is swallowed, deliberately and visibly", () => {
    const line = ci.split("\n").find((l) => l.includes("npm audit --audit-level=high"));
    expect(line, "the audit step vanished").toBeDefined();
    // `|| true` on the same line: a transitive dev-dependency advisory must not turn CI
    // permanently red on something this repo neither fixes nor ships.
    expect(line).toMatch(/\|\|\s*true/);
  });

  it("says WHY it is non-blocking, in the workflow, where the person tempted to tighten it will read it", () => {
    expect(ci).toMatch(/non-blocking/i);
    expect(ci).toMatch(/transitive dev dependency/i);
  });
});
