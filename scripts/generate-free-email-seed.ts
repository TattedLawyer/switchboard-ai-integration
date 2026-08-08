// Regenerates warehouse/seeds/free_email_domains.csv from the vendored
// `free-email-domains` npm package (HubSpot-derived list of free/disposable email
// providers; MIT — attribution in NOTICE; version pinned exact in package.json).
//
// Run: npx tsx scripts/generate-free-email-seed.ts   (then commit the CSV diff)
//
// Why a committed CSV instead of a build-time read: the seed is warehouse INPUT — dbt
// builds must be reproducible from the tree alone, and a list change must arrive as a
// reviewable diff, never as a silent dependency-bump side effect. The generator
// validates shape so a bad upstream release fails HERE, loudly, not in the warehouse:
// every entry must be a lowercase domain, deduplicated, sorted; the output is
// deterministic for a given package version. The sentinel + demotion pins in
// ingest/test/free-email-blocklist.test.ts guard the committed CSV's content
// independently of this script.
//
// Category note (disclosed on the seed schema): the upstream list includes both FREE
// providers (gmail.com) and disposable/webmail hosts. Both are correct here — the seed
// answers "does this domain identify a COMPANY?", and for either category the answer is
// no; a match on one demotes to manual review (conservative: a human decides, nothing
// is dropped).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const list = require("free-email-domains") as unknown;

if (!Array.isArray(list) || list.length < 1000) {
  throw new Error(
    `free-email-domains did not yield a plausible list (got ${Array.isArray(list) ? list.length : typeof list}) — refusing to write the seed`,
  );
}

const DOMAIN_SHAPE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;
const domains = [...new Set(list.map((d) => String(d).trim().toLowerCase()))].sort();
const malformed = domains.filter((d) => !DOMAIN_SHAPE.test(d));
if (malformed.length > 0) {
  throw new Error(`upstream list carries non-domain-shaped entries: ${malformed.slice(0, 5).join(", ")}`);
}
for (const sentinel of ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com"]) {
  if (!domains.includes(sentinel)) {
    throw new Error(`upstream list is missing canonical provider ${sentinel} — refusing to write the seed`);
  }
}
// The synthetic-universe guard: nothing example-shaped may enter the blocklist, or the
// seeded corporate domains could demote and the CI fixture's expectations would rot.
const exampleShaped = domains.filter((d) => d === "example.com" || d.endsWith(".example.com"));
if (exampleShaped.length > 0) {
  throw new Error(`upstream list carries example-universe domains: ${exampleShaped.join(", ")}`);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const seedPath = join(repoRoot, "warehouse/seeds/free_email_domains.csv");
const next = ["domain", ...domains].join("\n") + "\n";
const prev = ((): string | null => {
  try {
    return readFileSync(seedPath, "utf8");
  } catch {
    return null;
  }
})();
writeFileSync(seedPath, next);
console.log(
  prev === next
    ? `seed unchanged (${domains.length} domains)`
    : `seed written: ${domains.length} domains → ${seedPath}`,
);
