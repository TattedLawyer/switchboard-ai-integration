// Phase 3 / A1, Blocker-2 (runtime half) — the approval service refuses the owner's role.
//
// migration 014 and approval-role-scope.test.ts pin what `switchboard_approval` MAY do.
// They cannot pin which role a deployment actually points the service at, and that is a
// different mistake with the same consequence: connecting as the migration owner gives
// this service the ability to run `grant insert on ... to switchboard_agent` — deleting
// the differentiator rather than defeating it. So the check is at startup, against a live
// connection, where a deployment mistake shows up rather than a code mistake.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { freshTestDb } from "../../ingest/test/helpers/testdb.js";
import { assertApprovalRole, REQUIRED_APPROVAL_ROLE } from "../src/main.js";

let admin: pg.Pool;
let url: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const r = await freshTestDb();
  admin = r.pool;
  url = r.url;
  cleanup = r.cleanup;
});
afterAll(async () => {
  await cleanup();
});

function asRole(adminUrl: string, role: string): string {
  const u = new URL(adminUrl);
  u.username = role;
  u.password = role;
  return u.toString();
}

describe("A1: the approval service refuses to start on the wrong role", () => {
  it("accepts a connection authenticating as switchboard_approval", async () => {
    const pool = new pg.Pool({ connectionString: asRole(url, REQUIRED_APPROVAL_ROLE), max: 1 });
    try {
      await expect(assertApprovalRole(pool)).resolves.toBeUndefined();
    } finally {
      await pool.end();
    }
  });

  it("refuses the migration owner, naming the role it got and why that is the problem", async () => {
    // `admin` is DATABASE_URL's pool — the owner. This is the exact misconfiguration the
    // check exists for, and the one a service with no check would run happily on.
    await expect(assertApprovalRole(admin)).rejects.toThrow(/refuses to start/);
    await expect(assertApprovalRole(admin)).rejects.toThrow(/switchboard_agent/);
  });

  it("refuses the AGENT's role too — a read-only credential is the opposite mistake, equally fatal", async () => {
    const pool = new pg.Pool({ connectionString: asRole(url, "switchboard_agent"), max: 1 });
    try {
      await expect(assertApprovalRole(pool)).rejects.toThrow(/switchboard_agent/);
    } finally {
      await pool.end();
    }
  });
});
