import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// README proof artifact (Task E): the horizontal thesis needs the trio VISIBLE — the
// same pipeline over three verticals, as fenced, deterministic output excerpts a
// reader can reproduce with the stated command. This pin runs the README's OWN
// commands and diffs their output against the README's own fenced excerpts, so the
// doc sentence "seeded and reproducible by the command shown" cannot silently rot:
// a generator content edit reds this test with a message that points at README.md.
// (Home: mocks/core, the repo-wide-claims precedent of repo-hygiene.test.ts B6.)

const root = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
const readme = readFileSync(join(root, "README.md"), "utf8");

// Each excerpt is a bash fence whose first line sets PROFILE=<name>, followed by a
// text fence holding the exact expected stdout.
const EXCERPT = /```bash\n(PROFILE=(\w+) node --import tsx -e '[^']*')\n```\n\n```text\n([\s\S]*?)```/g;
const excerpts = [...readme.matchAll(EXCERPT)].map(([, command, profile, expected]) => ({
  command,
  profile,
  expected,
}));

describe("README 'one pipeline, three verticals' excerpts are real output, not prose", () => {
  it("the README carries exactly the 2b-D3 trio, in order", () => {
    expect(excerpts.map((e) => e.profile)).toEqual(["plumbing", "saas", "realestate"]);
  });

  it.each(excerpts.map((e) => [e.profile, e] as const))(
    "the %s excerpt reproduces byte-for-byte from the command the README states",
    (_profile, e) => {
      const actual = execSync(e.command, { cwd: root, encoding: "utf8", timeout: 30_000 });
      expect(actual).toBe(e.expected);
    },
  );
});
