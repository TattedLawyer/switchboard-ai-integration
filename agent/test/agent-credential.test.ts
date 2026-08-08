// A1 (Phase 3, Blocker-1c) — the agent's credential is FAIL CLOSED.
//
// `agentConnectionString()` used to fall back to `DATABASE_URL` and rewrite its
// user/password to `switchboard_agent`. That fallback made the published property
// ("the agent process holds no write-capable credential") a deployment-time accident:
// the full-privilege credential had to be IN the agent's environment for the default
// path to work at all, and every configuration that existed — `ci.yml`, `demo.sh`,
// `chaos.sh`, local dev — took that path. The comment in agent-db.ts said production
// sets AGENT_DATABASE_URL explicitly; nothing in the repo ever did.
//
// So the fallback is deleted and the variable is required, in the repo's own
// fail-closed idiom (`ingest/src/hmac.ts:30-42` — name the variable, name the remedy).
// After this, `agent/src/` contains ZERO references to DATABASE_URL, which is what
// makes the boot pin in `writer-boundary.test.ts` pin something structural rather
// than something aspirational.

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { agentConnectionString } from "../src/host/agent-db.js";

const AGENT_DB_SRC = readFileSync(
  fileURLToPath(new URL("../src/host/agent-db.ts", import.meta.url)),
  "utf8",
);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("A1: the agent credential is required, never derived", () => {
  it("returns AGENT_DATABASE_URL verbatim when it is set", () => {
    vi.stubEnv("AGENT_DATABASE_URL", "postgres://switchboard_agent:pw@db:5432/switchboard");
    expect(agentConnectionString()).toBe(
      "postgres://switchboard_agent:pw@db:5432/switchboard",
    );
  });

  it("throws naming AGENT_DATABASE_URL when it is absent, even though DATABASE_URL is present", () => {
    vi.stubEnv("AGENT_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://switchboard:switchboard@localhost:5433/switchboard");
    expect(() => agentConnectionString()).toThrow(/AGENT_DATABASE_URL is required/);
  });

  it("the refusal names the remedy, not just the variable (operator surface)", () => {
    vi.stubEnv("AGENT_DATABASE_URL", "");
    expect(() => agentConnectionString()).toThrow(/switchboard_agent/);
  });

  it("never silently downgrades a full-privilege URL: DATABASE_URL alone is not a credential", () => {
    vi.stubEnv("AGENT_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://switchboard:switchboard@localhost:5433/switchboard");
    let derived: string | null = null;
    try {
      derived = agentConnectionString();
    } catch {
      derived = null;
    }
    expect(derived, "a derived credential means DATABASE_URL is still load-bearing here").toBeNull();
  });

  it("the module itself no longer reads DATABASE_URL (the derivation is gone, not merely unreachable)", () => {
    expect(
      /process\.env\.DATABASE_URL/.test(AGENT_DB_SRC),
      "agent-db.ts still reads process.env.DATABASE_URL",
    ).toBe(false);
  });
});
