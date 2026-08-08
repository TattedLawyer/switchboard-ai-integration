// Phase 3 / A1 — the approval service's boot-time configuration, fail closed.
//
// Deliberately NOT a second HMAC implementation. The proposal door's caller is one
// internal process, and the proposal already carries an idempotency key — so the replay
// machinery ingest's per-source HMAC exists for (a ±300s timestamp window absorbing
// unsolicited vendor pushes) would be ceremony here. What is reused is the SHAPE that
// module established for this repo: name every missing variable in one aggregated throw
// so an operator fixes the deploy once instead of discovering variables one crash at a
// time, with ALLOW_DEV_SECRETS=1 as the only, explicit, local-demo opt-out.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalConnectionString,
  assertApprovalConfig,
  bindHost,
  pendingCap,
  proposalToken,
} from "../src/config.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The full set of variables a real deployment must supply. */
function setAll(): void {
  vi.stubEnv("ALLOW_DEV_SECRETS", undefined);
  vi.stubEnv(
    "APPROVAL_DATABASE_URL",
    "postgres://switchboard_approval:pw@localhost:5433/switchboard",
  );
  vi.stubEnv("AGENT_PROPOSAL_TOKEN", "a-real-token");
}

describe("A1: the approval service fails closed on its secrets", () => {
  it("boots when every variable is supplied", () => {
    setAll();
    expect(() => assertApprovalConfig()).not.toThrow();
  });

  it("refuses to boot with no proposal token, naming the variable and the remedy", () => {
    setAll();
    vi.stubEnv("AGENT_PROPOSAL_TOKEN", undefined);
    expect(() => assertApprovalConfig()).toThrow(/AGENT_PROPOSAL_TOKEN/);
    expect(() => assertApprovalConfig()).toThrow(/ALLOW_DEV_SECRETS/);
  });

  it("refuses to boot with no database url, naming the variable", () => {
    setAll();
    vi.stubEnv("APPROVAL_DATABASE_URL", undefined);
    expect(() => assertApprovalConfig()).toThrow(/APPROVAL_DATABASE_URL/);
  });

  it("names EVERY missing variable in one throw, not the first one it meets", () => {
    vi.stubEnv("ALLOW_DEV_SECRETS", undefined);
    vi.stubEnv("APPROVAL_DATABASE_URL", undefined);
    vi.stubEnv("AGENT_PROPOSAL_TOKEN", undefined);
    let message = "";
    try {
      assertApprovalConfig();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("APPROVAL_DATABASE_URL");
    expect(message).toContain("AGENT_PROPOSAL_TOKEN");
  });

  it("ALLOW_DEV_SECRETS=1 is the only opt-out, and it supplies a demo token", () => {
    vi.stubEnv("ALLOW_DEV_SECRETS", "1");
    vi.stubEnv("AGENT_PROPOSAL_TOKEN", undefined);
    vi.stubEnv(
      "APPROVAL_DATABASE_URL",
      "postgres://switchboard_approval:pw@localhost:5433/switchboard",
    );
    expect(() => assertApprovalConfig()).not.toThrow();
    expect(proposalToken()).toBe("demo-proposal-token");
  });

  it("ALLOW_DEV_SECRETS does NOT invent a database url — a wrong database is not a dev convenience", () => {
    vi.stubEnv("ALLOW_DEV_SECRETS", "1");
    vi.stubEnv("APPROVAL_DATABASE_URL", undefined);
    expect(() => assertApprovalConfig()).toThrow(/APPROVAL_DATABASE_URL/);
  });

  it("an explicit token always wins over the dev default", () => {
    vi.stubEnv("ALLOW_DEV_SECRETS", "1");
    vi.stubEnv("AGENT_PROPOSAL_TOKEN", "a-real-token");
    expect(proposalToken()).toBe("a-real-token");
  });

  it("the connection string is required and never derived from DATABASE_URL", () => {
    vi.stubEnv("APPROVAL_DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_URL", "postgres://switchboard:switchboard@localhost:5433/switchboard");
    // Same reasoning as the agent's credential: a derivation makes the full-privilege
    // credential load-bearing inside a process that must not hold it. Here it would hand
    // the approval service the migration owner's role — the one able to grant insert to
    // switchboard_agent, i.e. to delete the differentiator rather than defeat it.
    expect(() => approvalConnectionString()).toThrow(/APPROVAL_DATABASE_URL/);
  });
});

describe("A1: the door is loopback-bound and capped by default", () => {
  it("binds 127.0.0.1 unless an operator says otherwise", () => {
    vi.stubEnv("APPROVAL_BIND_HOST", undefined);
    expect(bindHost()).toBe("127.0.0.1");
    vi.stubEnv("APPROVAL_BIND_HOST", "0.0.0.0");
    expect(bindHost()).toBe("0.0.0.0");
  });

  it("has a finite pending cap by default, and range-checks an override", () => {
    vi.stubEnv("PENDING_PROPOSAL_CAP", undefined);
    expect(Number.isFinite(pendingCap())).toBe(true);
    expect(pendingCap()).toBeGreaterThan(0);
    vi.stubEnv("PENDING_PROPOSAL_CAP", "25");
    expect(pendingCap()).toBe(25);
    for (const bad of ["0", "-1", "not-a-number", "1.5"]) {
      vi.stubEnv("PENDING_PROPOSAL_CAP", bad);
      expect(() => pendingCap(), bad).toThrow(/PENDING_PROPOSAL_CAP/);
    }
  });
});
