// Core loop / T6 pins — the due query and the CAS claim.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { freshCrmDb, seedContact, TEST_TENANT } from "./helpers/crmdb.js";
import { claimDue } from "../src/claim.js";
import { CLAIM_LEASE_MINUTES } from "../src/due.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "claim.ts");

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T6: two concurrent claimers over ONE due contact", () => {
  // mutation: remove `for update skip locked` from the scan -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 5 passed (7)` —
  //     error: canceling statement due to statement timeout
  //     AssertionError: expected '…' to contain 'for update skip locked'  (the hygiene pin
  //                     below catches the same edit from the other side)
  //   Session B no longer skips A's locked row: it BLOCKS on it, and with A deliberately
  //   still open the 1.5s statement timeout fires. Blocking-then-EPQ is exactly the shape
  //   the round-1 reviewer measured double-claiming under the `where id in (select … limit)`
  //   form, because the hashed subplan is not re-evaluated against the updated tuple.
  //
  //   🚨 IN THIS PRODUCT A DOUBLE-CLAIM MEANS CALLING THE SAME PERSON TWICE. That is why
  //   this pin is CONCURRENT and not sequential — a sequential version would be a
  //   determinism test, which §4 forbids in the request path.
  it("lets exactly one claimer through", async () => {
    await seedContact(admin, { dueAt: new Date(Date.now() - 60_000).toISOString() });

    const a = await crm.connect();
    const b = await crm.connect();
    try {
      await a.query("begin");
      const claimedByA = await claimDue(a, TEST_TENANT, 10);
      expect(claimedByA).toHaveLength(1);

      await b.query("begin");
      // Bounded, so the mutation surfaces as a timeout rather than hanging the suite.
      await b.query("set local statement_timeout = '1500ms'");
      const claimedByB = await claimDue(b, TEST_TENANT, 10);
      expect(claimedByB).toHaveLength(0);

      await b.query("commit");
      await a.query("commit");
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
  });
});

describe("T6: the claim returns the PRE-UPDATE due date", () => {
  // mutation: `returning c.id, s.claimed_due_at` -> `returning c.id, c.next_due_at as
  //           claimed_due_at` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 6 passed (7)`
  //     AssertionError: expected 1786326771949 to be 1786066671919
  //     — i.e. the lease timestamp, not the due date the cycle claimed.
  //   T9's key is `followup:<contact>:<claimed_due_at as date>:<channel>`. Built from the
  //   POST-update value it means "next cycle's date", so a short retry landing on a date a
  //   prior cycle already claimed collides — and the collision is SILENTLY SWALLOWED by
  //   `proposals_idempotency_unique`. A follow-up that simply never happens.
  it("returns the value the row held before the lease overwrote it", async () => {
    const due = new Date(Date.now() - 3 * 86_400_000);
    const ana = await seedContact(admin, { dueAt: due.toISOString() });
    const [claimed] = await claimDue(crm, TEST_TENANT, 10);
    expect(claimed.id).toBe(ana);
    expect(claimed.claimedDueAt.getTime()).toBe(due.getTime());
  });

  it("writes a 15-MINUTE lease, not a follow-up interval", async () => {
    const ana = await seedContact(admin, { dueAt: new Date(Date.now() - 60_000).toISOString() });
    await claimDue(crm, TEST_TENANT, 10);
    const r = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [ana],
    );
    const minutes = (r.rows[0].next_due_at.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(CLAIM_LEASE_MINUTES - 1);
    expect(minutes).toBeLessThanOrEqual(CLAIM_LEASE_MINUTES + 1);
    // A crashed cycle costs a quarter of an hour, not an interval — and a BLOCKED contact
    // is re-claimable in fifteen minutes rather than thirty days.
  });
});

describe("T6: the per-prospect controls are query predicates", () => {
  // mutation: drop `channel <> 'none'` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 6 passed (7)`
  //     AssertionError: expected [ { …(2) } ] to have a length of +0 but got 1
  //   THE PER-PROSPECT CONTROL IS A QUERY PREDICATE, NOT A UI SETTING. She set this person
  //   to `none`; a UI that merely hides them still calls them.
  it("never returns a contact set to channel='none'", async () => {
    await seedContact(admin, {
      channel: "none",
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(await claimDue(crm, TEST_TENANT, 10)).toHaveLength(0);
  });

  // mutation: drop `active` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 6 passed (7)`
  //     AssertionError: expected [ { …(2) } ] to have a length of +0 but got 1
  it("never returns an inactive contact", async () => {
    await seedContact(admin, {
      active: false,
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    expect(await claimDue(crm, TEST_TENANT, 10)).toHaveLength(0);
  });

  it("never returns a contact that is not yet due", async () => {
    await seedContact(admin, { dueAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(await claimDue(crm, TEST_TENANT, 10)).toHaveLength(0);
  });
});

describe("T6: the claim takes no advisory lock", () => {
  // mutation: add `pg_advisory_lock` inside the `select … limit` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 5 passed (7)` —
  //     AssertionError: expected 'pg_advisory_lock' to be undefined
  //     error: canceling statement due to statement timeout   — worth noting: taking the
  //     advisory lock inside the LIMITed scan ALSO breaks the concurrency pin, which is
  //     the "danger!" the PG16 page is warning about, reproduced.
  //
  // A ROW LOCK VIA `for update skip locked` IS REQUIRED AND IS NOT THE SAME THING. PG16's
  // `explicit-locking.html` flags `pg_advisory_lock` inside a LIMITed SELECT "danger!"; it
  // argues nothing against row locks. Rev 2's reasoning conflated the two, and this pin is
  // narrowed to what the source actually says.
  it("uses a row lock and nothing else", () => {
    const src = readFileSync(SRC, "utf8");
    const forbidden = ["pg_advisory_lock", "pg_advisory_xact_lock", "pg_try_advisory_lock"];
    expect(forbidden.find((f) => src.includes(`${f}(`))).toBeUndefined();
    expect(src).toContain("for update skip locked");
  });
});
