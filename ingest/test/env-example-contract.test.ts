// CLOSE-3 Wave 2 — SEC-I4 + OPS-M2, the coupled doc/config pair.
//
// The lie: `.env.example` said "Copy to .env and edit" and then shipped
// ALLOW_DEV_SECRETS=1 with every real secret blank, so the first-run configuration was the
// insecure one and README's "a production deploy that forgets to set them refuses to start"
// was false for the exact file we tell people to copy. Worse, the file was also WRONG — it
// named WEBHOOK_SECRET_CRM/_BILLING/_SUPPORT while boot has demanded
// _HUBCRM/_STRIPEFEED/_CASEBUS/_SUPPORT since F-1c, so an operator who set every secret in
// it still could not boot.
//
// These two edits are coupled: commenting the flag out without adding the explicit export
// to the RUNBOOK's Start/stop block breaks the manual path instead of fixing it. The file
// pair is pinned mechanically because prose drifts and nobody re-reads a template.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

const ENV_EXAMPLE = repoFile(".env.example");
const RUNBOOK = repoFile("RUNBOOK.md");

/** An assignment is "live" only when it is not commented out. */
function assigns(text: string, name: string): boolean {
  return new RegExp(`^\\s*${name}=`, "m").test(text);
}

describe("SEC-I4 — .env.example is neither insecurely defaulted nor wrong", () => {
  it("does not ship the dev-secret bypass switched on", () => {
    expect(assigns(ENV_EXAMPLE, "ALLOW_DEV_SECRETS")).toBe(false);
    // …but still explains it, so the operator who needs it locally can find it.
    expect(ENV_EXAMPLE).toContain("ALLOW_DEV_SECRETS");
  });

  it("names the webhook secrets the boot assertion actually demands", () => {
    // The four the RUNBOOK's own Start/stop line enables. Retired/opt-in sources may be
    // mentioned, but these must be present and uncommented or the template cannot boot.
    for (const source of ["HUBCRM", "STRIPEFEED", "CASEBUS", "SUPPORT"]) {
      expect(assigns(ENV_EXAMPLE, `WEBHOOK_SECRET_${source}`), source).toBe(true);
    }
    // The retired crm mock's secret must not be a live assignment — nothing serves 4001.
    expect(assigns(ENV_EXAMPLE, "WEBHOOK_SECRET_CRM")).toBe(false);
  });

  it("assigns AGENT_DATABASE_URL live, because A1 made it fail closed", () => {
    // Before A1 this was a commented-out optional override and the agent derived its
    // credential from DATABASE_URL. Deriving is gone: a template that leaves this
    // commented cannot run the agent at all, so the template must set it.
    expect(assigns(ENV_EXAMPLE, "AGENT_DATABASE_URL")).toBe(true);
    // …and it must name the read-only role, not the full-privilege one. A template that
    // pointed this at `switchboard` would satisfy the assignment check while handing the
    // agent exactly the credential the boundary exists to keep out of that process.
    const m = ENV_EXAMPLE.match(/^AGENT_DATABASE_URL=(.*)$/m);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/:\/\/switchboard_agent:/);
    // AGENT_DB_PASSWORD only ever existed to feed the derivation. It is gone with it.
    expect(ENV_EXAMPLE).not.toContain("AGENT_DB_PASSWORD");
  });

  it("pins INGEST_SOURCES to sources that exist, never the retired crm lane", () => {
    const m = ENV_EXAMPLE.match(/^INGEST_SOURCES=(.*)$/m);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map((s) => s.trim())).not.toContain("crm");
  });
});

describe("OPS-M2 — the RUNBOOK's first executable procedure is runnable as written", () => {
  it("the Start / stop block exports ALLOW_DEV_SECRETS before starting the service", () => {
    const start = RUNBOOK.indexOf("## Start / stop");
    expect(start).toBeGreaterThan(-1);
    const block = RUNBOOK.slice(start, RUNBOOK.indexOf("```", RUNBOOK.indexOf("```", start) + 3));
    expect(block).toMatch(/^export ALLOW_DEV_SECRETS=1$/m);
    // Ordering is the whole point: the export must precede the line that boots ingest.
    expect(block.indexOf("export ALLOW_DEV_SECRETS=1")).toBeLessThan(
      block.indexOf("npm run start -w ingest"),
    );
  });
});

describe("SEC-I3 — the migration-minted app role has an override and a rotation note", () => {
  it("APP_DB_PASSWORD is documented in .env.example and in the migrator", () => {
    expect(ENV_EXAMPLE).toContain("APP_DB_PASSWORD");
    const migrate = repoFile("ingest/src/migrate.ts");
    expect(migrate).toContain("APP_DB_PASSWORD");
    // The rotation note migration 005 carries and 006 does not.
    expect(migrate).toContain("alter role switchboard_app password");
  });

  it("restore.sh still creates the roles only if absent, so recovery cannot reset a rotation", () => {
    const restore = repoFile("scripts/restore.sh");
    expect(restore).not.toMatch(/create or alter role/i);
    const appBlock = restore.slice(restore.indexOf("switchboard_app"));
    expect(restore).toContain("if not exists (select from pg_roles where rolname = 'switchboard_app')");
    expect(appBlock.length).toBeGreaterThan(0);
  });
});
