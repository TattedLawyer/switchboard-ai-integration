// F1 + F2 pins — the LIVE-READ path is breaker-aware, and an unreadable email cell blocks
// honestly instead of churning.
//
// THE DEFECT PAIR UNDER TEST (both proved by execution before these pins):
//
// F1 🔴 — commit 295da40 gave the sheet ADOPTION pass a displacement circuit breaker: a
// partial-range sort scrambles cell values against row refs (a permutation — values MOVE
// between rows), the breaker detects it by conservation of content, HALTS the pass and
// pauses the divergent contacts. That protects STORED state. The live-read integration
// (Part 2 / Piece A) walked straight past it: with Ana's ref riding Ben's values, the
// proposer read the scrambled row LIVE and posted `payload.to = ben@example.com` on
// contact_id = <Ana> with a rationale reading "Ben Cruz is due and prefers email" — an
// internally coherent WRONG-PERSON card with nothing on it for the human to catch. The
// phone leg was already safe (candidates resolve only against THIS contact's own stored
// phone_numbers rows — P6); name and email had no equivalent guard. Post-022 this role
// cannot read the stored details, so the proposer CANNOT re-run the value-integrity
// comparison itself — the adoption pass's `crm.sheet_reads` verdict (021 granted this
// role SELECT) and its `sheet_divergent`/`sheet_row_missing` blocks are the only
// displacement signals available to it, and the fix is to honor both:
//   (a) cycle level — latest `sheet_reads` row not ok => the whole cycle's sheet context
//       is UNAVAILABLE (the existing skip path: no proposal, no block, no clock change
//       beyond the claim lease);
//   (b) per contact — an OPEN sheet-level block (`sheet_divergent`/`sheet_row_missing`)
//       => skip, never propose from the live row and never steamroll the block.
// RESIDUAL, disclosed: between the sort and the FIRST post-sort adoption pass there is no
// ledger verdict yet, so a proposer tick in that window still reads the scrambled row —
// unclosable under this role's privileges (the revoke that prevents a stored-detail
// comparison is the same control that makes the ledger the only signal). The reconcile
// loop's adoption cadence bounds that window; these pins cover every window the ledger
// can see, including the claim-taken-before-the-halt race.
//
// F2 🟠 — a cell like "see business card" in the Email column flowed VERBATIM into
// `payload.to`. The change already built UNREADABLE_SHEET_PHONES_REASON for the identical
// phone case; the email leg had no equivalent, and the asymmetry was the defect. The fix
// applies the door's own `to` shape rules in the email leg and blocks with an honest
// plain-English reason. (MEASURED 2026-08-18 against the REAL door in this tree, G5's
// mutation run below: the door's envelope schema — approval/src/proposal.ts
// `proposalSchema`, payload `z.record(z.string(), z.unknown())` — ACCEPTS such a payload
// with 201, so unvalidated the wrong card REACHES her queue and the send can only fail
// after she approves it, at the executor's `parsePayload`. The proposer-side check is the
// only thing that keeps the unreadable cell out of the queue entirely.)
//
// Real ephemeral cluster, migrations 001–022 (the proposer runs under the REAL post-022
// grants), the REAL adoption pass driving REAL halts (never a hand-inserted ledger row),
// the REAL approval door over HTTP, FakeSheet transport, injected clocks.
//
// TDD RED RECORD (RUN ✅ 2026-08-18, before the fix — this file written first):
//   `Tests  4 failed | 1 passed (5)` —
//   G1 red: `AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1` at
//     `expect(door.posted).toHaveLength(0)` (line 335) — a card was POSTed to the REAL
//     door from a snapshot whose ledger row said `breaker_displacement`, ok=false.
//   G2 red: `AssertionError: expected 'ben@example.com' to be 'ana@example.com'` at the
//     payload sweep — the reviewer's exact artifact reproduced at the claim-before-halt
//     race: Ana's contact_id carrying Ben's address, POSTed to the real door and standing
//     in approval.proposals.
//   G3 red: `expected [ { …(4) } ] to have a length of +0 but got 1` at
//     `expect(door.posted).toHaveLength(0)` — a contact with an OPEN sheet_divergent
//     block was proposed for from the live row.
//   G4 passed pre-fix (the happy path predates the guards; its discriminating power is
//   its recorded mutation below).
//   G5 red: `expected [ { …(4) } ] to have a length of +0 but got 1` at
//     `expect(door.posted).toHaveLength(0)` — `payload.to = "see business card"` was
//     POSTed and the REAL door ACCEPTED it (had the door refused, the cycle would have
//     thrown DoorReplyError instead of failing this count): the unreadable cell became a
//     pending card in her queue.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedSettings,
  TEST_INSTANT,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { FakeSheet, type FakeRow } from "./helpers/fakesheet.js";
import { publishQuestionSet } from "../src/questions.js";
import {
  proposeForClaimed,
  runCycle,
  type DoorProposal,
} from "../src/proposer.js";
import { claimDue } from "../src/claim.js";
import { loadSheetCycleContext } from "../src/sheet-read.js";
import { runSheetAdoption } from "../src/sheet-adopt.js";
import { DoorReplyError } from "../src/door-reply.js";
import { createApprovalApp } from "../../approval/src/server.js";
import {
  followUpEmailPayloadSchema,
  placeCallPayloadSchema,
} from "../../approval/src/proposal.js";

const SECRET = "test-proposal-token-do-not-reuse";

// Fixed, mid-Manila-day instants (TEST_INSTANT's warning): 11:00, then past the 15-minute
// claim lease at 11:20, all on Manila day 2026-03-03. Never the machine clock.
const t0 = TEST_INSTANT; // 2026-03-03T03:00Z = 11:00 Asia/Manila
const t1 = new Date(t0.getTime() + 20 * 60_000); // 11:20 — the 11:15 lease has expired
const LEASE_MS = 15 * 60_000;

// The header in HER vocabulary, byte-identical to proposer-sheet.test.ts.
const HEADER = ["Name", "Email", "Contact #", "Met At", "Looking For"];
const COL = { name: 0, email: 1, phone: 2 } as const;

function row(
  ref: string | null,
  cells: { name?: string; email?: string; phone?: string },
): FakeRow {
  return { ref, cells: [cells.name ?? "", cells.email ?? "", cells.phone ?? "", "", ""] };
}

/** A PARTIAL-RANGE SORT, as the live API presents it: cell VALUES move between rows while
 *  the row refs stay put (developer metadata travels with rows only on a FULL-range sort).
 *  This is the exact scramble the displacement breaker exists to catch. */
function partialRangeSortSwap(sheet: FakeSheet, i: number, j: number): void {
  const a = sheet.rows[i].cells;
  sheet.rows[i].cells = sheet.rows[j].cells;
  sheet.rows[j].cells = a;
}

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;
let base: string;
let closeServer: () => Promise<void>;

/** The production daemon's door adapter (crm/src/main.ts): 200/201 carry the id,
 *  everything else throws DoorReplyError so the status survives to the proposer. Wrapped
 *  to record every payload that actually crossed the wire — the pins assert on those. */
function realDoor(): { posted: DoorProposal[]; post: (p: DoorProposal) => Promise<{ id: string }> } {
  const posted: DoorProposal[] = [];
  return {
    posted,
    post: async (p: DoorProposal): Promise<{ id: string }> => {
      posted.push(p);
      const res = await fetch(`${base}/internal/proposals`, {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(p),
      });
      const text = await res.text();
      if (res.status !== 200 && res.status !== 201) {
        throw new DoorReplyError(
          res.status,
          `door refused ${p.action_type} (${res.status}): ${text}`,
        );
      }
      const body = JSON.parse(text) as { id?: string };
      if (!body.id) throw new Error(`door returned ${res.status} without an id: ${text}`);
      return { id: body.id };
    },
  };
}

/** Adopt a FakeSheet through the REAL owner-run pass and return the adopted contacts
 *  keyed by row ref. Refs are pre-set on the rows (the pass adopts unmatched-ref rows
 *  directly), and the pass itself stamps `next_due_at = now()` (DB clock); the caller
 *  re-bases due-ness onto the injected test timeline explicitly. */
async function adoptSheet(
  sheet: FakeSheet,
  linked: { id: string; spreadsheetId: string },
): Promise<Map<string, { id: string }>> {
  const report = await runSheetAdoption(
    { admin, transport: sheet },
    { id: linked.id, tenantId: TEST_TENANT, spreadsheetId: linked.spreadsheetId },
  );
  expect(report.completed).toBe(true);
  expect(report.code).toBe("ok");
  const r = await admin.query<{ id: string; row_ref: string }>(
    `select id, row_ref from crm.contacts where linked_sheet_id = $1`,
    [linked.id],
  );
  return new Map(r.rows.map((c) => [c.row_ref, { id: c.id }]));
}

const setDue = (at: Date, linkedSheetId: string) =>
  admin.query(`update crm.contacts set next_due_at = $2 where linked_sheet_id = $1`, [
    linkedSheetId,
    at.toISOString(),
  ]);

const followUps = async (contactId?: string) =>
  (
    await admin.query<{
      contact_id: string;
      due_date: string;
      blocked_reason: string | null;
      closed_at: Date | null;
    }>(
      `select contact_id, due_date::text as due_date, blocked_reason, closed_at
         from crm.follow_ups
        where $1::uuid is null or contact_id = $1
        order by due_date`,
      [contactId ?? null],
    )
  ).rows;

const actionCount = async (): Promise<number> =>
  Number(
    (await admin.query<{ n: string }>(`select count(*) as n from crm.follow_up_actions`))
      .rows[0].n,
  );

const proposalRows = async () =>
  (
    await admin.query<{ action_type: string; payload: Record<string, unknown> }>(
      `select action_type, payload from approval.proposals where tenant_id = $1`,
      [TEST_TENANT],
    )
  ).rows;

const nextDue = async (contactId: string): Promise<Date | null> =>
  (
    await admin.query<{ next_due_at: Date | null }>(
      `select next_due_at from crm.contacts where id = $1`,
      [contactId],
    )
  ).rows[0].next_due_at;

const latestRead = async (linkedSheetId: string) =>
  (
    await admin.query<{ ok: boolean; detail: string | null }>(
      `select ok, detail from crm.sheet_reads where linked_sheet_id = $1
        order by at desc limit 1`,
      [linkedSheetId],
    )
  ).rows[0];

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  const u = new URL(db.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approval = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approval.on("error", () => {});
  await seedSettings(admin, { intervalDays: 30, shortRetryDays: 3 });
  await publishQuestionSet(admin, TEST_TENANT, [
    { key: "budget", prompt: "What budget range are you working with?", kind: "text" },
  ]);
  const app = createApprovalApp(approval, {
    tenantId: TEST_TENANT,
    proposalToken: SECRET,
    pendingCap: 50,
    actionRateLimit: 50,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closeServer = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.linked_sheets");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (closeServer) await closeServer();
  if (approval) await approval.end().catch(() => {});
  if (cleanup) await cleanup();
});

describe("G1 🔴 — a displacement HALT makes the whole cycle's live read unavailable", () => {
  // The REAL adoption pass is driven into a REAL breaker_displacement halt (never a
  // hand-inserted ledger row), and the next proposer cycle must treat the sheet as
  // unavailable for EVERY sheet-bound contact — including one the halt did NOT pause
  // (his row was outside the sorted range): the breaker's verdict is about the SHEET,
  // and post-022 the proposer cannot re-establish trust in any individual row itself.
  //
  // mutation: remove the sheet_reads halt check from loadSheetCycleContext
  //   (crm/src/sheet-read.ts: `if (lastRead.rowCount === 1 && !lastRead.rows[0].ok)` ->
  //   `if (false as boolean)`) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  2 failed | 3 passed (5)` — this pin red at
  //     `expect(door.posted).toHaveLength(0)` (line 338):
  //     AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1
  //   — Carlo's card was POSTed to the real door from a snapshot whose ledger row said
  //   `breaker_displacement`, ok=false. The divergent contacts stayed unproposed only
  //   because the halt had paused them and the per-contact block check (G3's subject)
  //   still stood — one guard carrying both. G2 red alongside at its mechanism pin:
  //     AssertionError: expected 'available' to be 'unavailable'
  //   (its wrong-person sweep stayed green under THIS mutation because the per-contact
  //   check caught the claimed-before-the-halt pair; removing both guards is G2's own
  //   recorded mutation, where the sweep itself reds). Restored, green (5/5).
  it("halts everything: zero POSTs, zero proposer rows, clock = claim lease only", async () => {
    const linked = await seedLinkedSheet(admin);
    const [anaRef, benRef, carloRef] = [randomUUID(), randomUUID(), randomUUID()];
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", email: "ana@example.com" }),
      row(benRef, { name: "Ben Cruz", email: "ben@example.com" }),
      row(carloRef, { name: "Carlo Diaz", email: "carlo@example.com" }),
    ]);
    const byRef = await adoptSheet(sheet, linked);
    await setDue(t0, linked.id);

    // She sorts a partial range covering Ana and Ben: their values swap, refs stay.
    partialRangeSortSwap(sheet, 1, 2);

    // The reconcile loop's adoption pass runs and the breaker HALTS — the real pass, the
    // real ledger row. Ana and Ben (divergent) are paused; Carlo is untouched and due.
    const halt = await runSheetAdoption(
      { admin, transport: sheet },
      { id: linked.id, tenantId: TEST_TENANT, spreadsheetId: linked.spreadsheetId },
    );
    expect(halt.completed).toBe(false);
    expect(halt.code).toBe("breaker_displacement");
    const ledger = await latestRead(linked.id);
    expect(ledger.ok).toBe(false);
    expect(ledger.detail).toMatch(/^breaker_displacement:/);
    const blocksAfterHalt = await followUps();
    expect(blocksAfterHalt.map((f) => f.blocked_reason).sort()).toEqual([
      "sheet_divergent",
      "sheet_divergent",
    ]);

    // The next proposer cycle. Only Carlo is claimable (the halt nulled Ana's and Ben's
    // clocks); the breaker's verdict must stop HIM too.
    const door = realDoor();
    const outcomes = await runCycle(
      { db: crm, postProposal: door.post, now: () => t0, sheet },
      TEST_TENANT,
      10,
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].contactId).toBe(byRef.get(carloRef)!.id);
    expect(door.posted).toHaveLength(0); // ZERO door POSTs
    expect(await proposalRows()).toHaveLength(0);
    expect(outcomes[0].actions).toHaveLength(0);
    expect(outcomes[0].blockedReason).toBeNull();
    expect(outcomes[0].skipped.length).toBeGreaterThan(0);
    expect(outcomes[0].skipped[0].reason).toMatch(/adoption pass did not complete/);

    // Zero follow_ups rows created BY THE PROPOSER: exactly the halt's two blocks remain,
    // bytes untouched (no steamroll, no new rows), and no actions exist.
    expect(await followUps()).toEqual(blocksAfterHalt);
    expect(await actionCount()).toBe(0);

    // The clock carries exactly the claim lease for Carlo; the paused stay paused.
    expect((await nextDue(byRef.get(carloRef)!.id))!.getTime()).toBe(t0.getTime() + LEASE_MS);
    expect(await nextDue(byRef.get(anaRef)!.id)).toBeNull();
    expect(await nextDue(byRef.get(benRef)!.id)).toBeNull();
  });
});

describe("G2 🔴 — the reviewer's exact scenario: Ana's ref riding Ben's values never reaches a payload", () => {
  // End-to-end, at the tightest reachable race: the proposer's CLAIM is taken BEFORE the
  // halt lands (the daemon's cycle shape — crm/src/main.ts — claims first, loads the
  // sheet context second; the reconcile loop's adoption pass interleaves between them),
  // then the cycle continues against the scrambled sheet, then the sheet is fixed and the
  // system recovers on its own. At no point may ANY payload pair one contact's id with
  // another contact's email or name. Asserted on the actual payloads, not counts.
  //
  // mutation: remove BOTH guards — the sheet_reads halt check (sheet-read.ts) AND the
  //   per-contact sheet-level block check (proposer.ts), each condition -> `false as
  //   boolean` -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  3 failed | 2 passed (5)` — this pin red at the payload sweep
  //   (line 404, via line 435 — cycle A's sweep):
  //     AssertionError: expected 'ben@example.com' to be 'ana@example.com'
  //   — the reviewer's exact artifact reproduced: `payload.to = ben@example.com` on
  //   contact_id = <Ana>, POSTed to the REAL door and standing in approval.proposals.
  //   G1 and G3 red alongside (`expected [ { …(4) } ] to have a length of +0 but got 1`
  //   at their door.posted counts). Restored, green (5/5).
  it("no wrong-person payload at the claim-before-halt race, and recovery proposes the right people", async () => {
    const linked = await seedLinkedSheet(admin);
    const [anaRef, benRef] = [randomUUID(), randomUUID()];
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", email: "ana@example.com" }),
      row(benRef, { name: "Ben Cruz", email: "ben@example.com" }),
    ]);
    const byRef = await adoptSheet(sheet, linked);
    const ana = byRef.get(anaRef)!.id;
    const ben = byRef.get(benRef)!.id;
    const truth: Record<string, { email: string; name: string; otherEmail: string; otherName: string }> = {
      [ana]: { email: "ana@example.com", name: "Ana Reyes", otherEmail: "ben@example.com", otherName: "Ben Cruz" },
      [ben]: { email: "ben@example.com", name: "Ben Cruz", otherEmail: "ana@example.com", otherName: "Ana Reyes" },
    };
    await setDue(t0, linked.id);

    // The partial-range sort: Ana's ref now rides Ben's values and vice versa.
    partialRangeSortSwap(sheet, 1, 2);

    // THE PIN, applied after every stage below: every payload that ever crossed the wire
    // pairs each contact_id with ITS OWN details — never the other contact's email or
    // name. It runs FIRST after each cycle so a violation surfaces as the wrong-person
    // artifact itself, not as a count mismatch downstream of it.
    const sweep = (posted: readonly DoorProposal[]): void => {
      for (const p of posted) {
        const cid = String((p.payload as Record<string, unknown>).contact_id);
        const t = truth[cid];
        expect(t).toBeDefined();
        expect((p.payload as Record<string, unknown>).to).toBe(t.email);
        expect(String((p.payload as Record<string, unknown>).body)).toContain(t.name);
        expect(String((p.payload as Record<string, unknown>).body)).not.toContain(t.otherName);
        expect(p.rationale).toContain(`${t.name} is due and prefers email`);
        expect(p.rationale).not.toContain(t.otherName);
      }
    };

    // Proposer cycle A, composed exactly as the daemon composes it (crm/src/main.ts): the
    // claim is taken FIRST — both contacts leased while still due — and the reconcile
    // loop's adoption halt lands before the cycle loads its sheet context.
    const door = realDoor();
    const claimed = await claimDue(crm, TEST_TENANT, 10, t0);
    expect(claimed).toHaveLength(2);
    const halt = await runSheetAdoption(
      { admin, transport: sheet },
      { id: linked.id, tenantId: TEST_TENANT, spreadsheetId: linked.spreadsheetId },
    );
    expect(halt.code).toBe("breaker_displacement");
    const ctx = await loadSheetCycleContext(crm, TEST_TENANT, sheet);
    const outcomesA = [];
    for (const c of claimed) {
      outcomesA.push(
        await proposeForClaimed(
          { db: crm, postProposal: door.post, now: () => t0, sheet },
          TEST_TENANT,
          c,
          ctx,
        ),
      );
    }
    sweep(door.posted); // ← the wrong-person artifact would surface HERE
    expect(door.posted).toHaveLength(0);
    expect(ctx.kind).toBe("unavailable");
    for (const outcome of outcomesA) {
      expect(outcome.actions).toHaveLength(0);
      expect(outcome.blockedReason).toBeNull(); // the halt's blocks are the pass's, not ours
    }
    // The halt's sheet_divergent blocks stand un-steamrolled.
    expect((await followUps()).map((f) => f.blocked_reason).sort()).toEqual([
      "sheet_divergent",
      "sheet_divergent",
    ]);

    // Proposer cycle B, after the halt: the paused contacts are not even claimable.
    const cycleB = await runCycle(
      { db: crm, postProposal: door.post, now: () => t1, sheet },
      TEST_TENANT,
      10,
    );
    sweep(door.posted);
    expect(cycleB).toHaveLength(0);
    expect(door.posted).toHaveLength(0);

    // RECOVERY: she undoes the sort. The next adoption pass completes, closes the
    // sheet_divergent blocks and restarts the clocks (DB clock; re-based onto the test's
    // injected timeline below). The cycle after that proposes the RIGHT people.
    partialRangeSortSwap(sheet, 1, 2);
    const recovery = await runSheetAdoption(
      { admin, transport: sheet },
      { id: linked.id, tenantId: TEST_TENANT, spreadsheetId: linked.spreadsheetId },
    );
    expect(recovery.completed).toBe(true);
    expect(recovery.recovered).toBe(2);
    expect((await followUps()).every((f) => f.closed_at !== null)).toBe(true);
    await setDue(t1, linked.id);
    const cycleC = await runCycle(
      { db: crm, postProposal: door.post, now: () => t1, sheet },
      TEST_TENANT,
      10,
    );
    sweep(door.posted); // now non-vacuous: two REAL cards, each to its own person
    expect(cycleC).toHaveLength(2);
    expect(cycleC.every((o) => o.actions.length === 1)).toBe(true);
    expect(door.posted).toHaveLength(2);
    for (const p of door.posted) {
      expect(followUpEmailPayloadSchema.safeParse(p.payload).success).toBe(true);
    }

    // And what the door durably STORED matches the sweep too — the queue never held a
    // wrong-person card at any point in the scenario.
    const stored = await proposalRows();
    expect(stored).toHaveLength(2);
    for (const s of stored) {
      const t = truth[String(s.payload.contact_id)];
      expect(t).toBeDefined();
      expect(s.payload.to).toBe(t.email);
      expect(String(s.payload.body)).toContain(t.name);
      expect(String(s.payload.body)).not.toContain(t.otherName);
    }
  });
});

describe("G3 — an open sheet-level block gates the live read per contact", () => {
  // The adoption pass paused this contact (`sheet_divergent`) and something legitimate —
  // an in-flight card's recordTouch — restarted its clock, so it is claimable while the
  // block is still open and the ledger's latest read is OK (the block's lifecycle belongs
  // to the pass that also detects recovery). The proposer must skip it: proposing would
  // build a card from values the pass declared untrustworthy, and `openFollowUp`'s upsert
  // would steamroll the block to null on its way.
  //
  // mutation: remove the per-contact sheet-level block check from proposeForClaimed
  //   (crm/src/proposer.ts: `if ((paused.rowCount ?? 0) > 0)` -> `false as boolean`)
  //   -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 4 passed (5)` — this pin red at
  //     `expect(door.posted).toHaveLength(0)` (line 546):
  //     AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1
  //   — the paused contact was proposed for from the live row and the card POSTed to the
  //   real door; that POST happens only after `openFollowUp`'s upsert has already nulled
  //   `blocked_reason` on the very row the halt paused (same contact, same due date —
  //   the steamroll this pin's assertions below refuse). Restored, green (5/5).
  it("skips the contact, proposes nothing, and leaves the block un-steamrolled", async () => {
    const linked = await seedLinkedSheet(admin);
    const anaRef = randomUUID();
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", email: "ana@example.com" }),
    ]);
    const byRef = await adoptSheet(sheet, linked); // latest sheet_reads row: ok
    const ana = byRef.get(anaRef)!.id;

    // The pause, seeded through the owner pool exactly as pauseDivergent writes it —
    // dated on the test timeline's Manila day so the steamroll hazard is armed (the
    // proposer's own due date this cycle lands on the same row).
    await admin.query(
      `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
       values ($1, '2026-03-03'::date, 'sheet_divergent')`,
      [ana],
    );
    // The documented restart path (an executed in-flight card's recordTouch) made her
    // due again; re-based onto the injected timeline.
    await setDue(t0, linked.id);
    expect((await latestRead(linked.id)).ok).toBe(true); // only the per-contact guard stands

    const door = realDoor();
    const outcomes = await runCycle(
      { db: crm, postProposal: door.post, now: () => t0, sheet },
      TEST_TENANT,
      10,
    );

    expect(outcomes).toHaveLength(1);
    expect(door.posted).toHaveLength(0);
    expect(await proposalRows()).toHaveLength(0);
    expect(outcomes[0].actions).toHaveLength(0);
    expect(outcomes[0].blockedReason).toBeNull(); // nothing new was written
    expect(outcomes[0].skipped[0].reason).toMatch(/sheet/i);

    // The block is EXACTLY as the pass left it: open, sheet_divergent, no actions.
    const rows = await followUps(ana);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toBe("sheet_divergent");
    expect(rows[0].closed_at).toBeNull();
    expect(await actionCount()).toBe(0);
  });
});

describe("G4 — a healthy sheet still proposes normally (no over-blocking)", () => {
  // The guards must not silence the happy path: a COMPLETED pass's ok ledger row plus no
  // open sheet-level blocks means the live read proceeds exactly as shipped.
  //
  // mutation (over-blocking probe): invert the ledger check in loadSheetCycleContext —
  //   treat `ok = true` as the halt (`lastRead.rows[0].ok` instead of
  //   `!lastRead.rows[0].ok`) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  4 failed | 1 passed (5)` — this pin red at
  //     `expect(outcome.actions.map((a) => a.channel).sort()).toEqual(["call","email"])`
  //     (line 594): AssertionError: expected [] to deeply equal [ 'call', 'email' ]
  //   — a HEALTHY sheet (real completed pass, ok ledger row) proposed nothing: the whole
  //   product silenced, which is exactly the over-blocking this pin exists to refuse.
  //   (G1/G2/G5 red alongside: the inversion also let the HALTED ledger through, and G5's
  //   healthy-read block never happened — `expected null to be 'the email on this
  //   contact's sheet ro…'`.) Restored, green (5/5).
  it("proposes both legs from the live row right after a completed adoption pass", async () => {
    const linked = await seedLinkedSheet(admin);
    const anaRef = randomUUID();
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", email: "ana@example.com", phone: "0917 123 4567" }),
    ]);
    const byRef = await adoptSheet(sheet, linked);
    const ana = byRef.get(anaRef)!.id;
    expect((await latestRead(linked.id)).ok).toBe(true);
    await setDue(t0, linked.id);

    const door = realDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => t0, sheet },
      TEST_TENANT,
      10,
    );

    expect(outcome.actions.map((a) => a.channel).sort()).toEqual(["call", "email"]);
    expect(outcome.blockedReason).toBeNull();
    expect(door.posted).toHaveLength(2);
    const call = door.posted.find((p) => p.action_type === "place_call")!.payload as Record<string, unknown>;
    const email = door.posted.find((p) => p.action_type === "send_email")!.payload as Record<string, unknown>;
    expect(call.contact_id).toBe(ana);
    expect(call.display_name).toBe("Ana Reyes");
    expect(call.phone_e164).toBe("+639171234567");
    expect(email.to).toBe("ana@example.com");
    expect(placeCallPayloadSchema.safeParse(call).success).toBe(true);
    expect(followUpEmailPayloadSchema.safeParse(email).success).toBe(true);
  });
});

describe("G5 — an unreadable email cell blocks honestly instead of churning", () => {
  // She types "see business card" where an address should be. Unvalidated, that string
  // flowed verbatim into `payload.to` — and (MEASURED, mutation run below) the REAL door
  // ACCEPTS the envelope with 201, so the unsendable wrong card would reach her queue and
  // die only after approval, at the executor. The email leg now applies the door's own
  // `to` shape rules BEFORE building the leg and blocks with the same honest, verbatim,
  // jargon-free standard as the phone twin (UNREADABLE_SHEET_PHONES_REASON) — never the
  // false "no_email_address" (the row HAS an email cell; it just cannot be read as an
  // address).
  //
  // mutation: remove the shape check from buildEmailProposal (crm/src/proposer.ts:
  //   `if (!liveEmailShape.safeParse(live.emailAddress).success)` -> `false as boolean`)
  //   -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 4 passed (5)` — this pin red at
  //     `expect(door.posted).toHaveLength(0)` (line 646):
  //     AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1
  //   — `payload.to = "see business card"` was POSTed and the REAL door ACCEPTED it (the
  //   failure is this count assertion, not a DoorReplyError — a refusal would have thrown
  //   through runCycle instead): the unreadable cell became a pending card in her queue
  //   with an unsendable recipient. No block row, no honest reason. Restored, green
  //   (5/5).
  it("blocks with the honest plain-English reason, and recovers when she fixes the cell", async () => {
    const linked = await seedLinkedSheet(admin);
    const anaRef = randomUUID();
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", email: "see business card" }),
    ]);
    const byRef = await adoptSheet(sheet, linked);
    const ana = byRef.get(anaRef)!.id;
    await setDue(t0, linked.id);

    const door = realDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => t0, sheet },
      TEST_TENANT,
      10,
    );

    // No POST, no throw, no churn — a SURFACED block with the honest reason.
    expect(door.posted).toHaveLength(0);
    expect(await proposalRows()).toHaveLength(0);
    expect(outcome.actions).toHaveLength(0);
    expect(outcome.blockedReason).toBe(
      "the email on this contact's sheet row could not be read as an email address — fix it on the sheet and email follow-ups resume on their own",
    );
    expect(outcome.blockedReason).not.toBe("no_email_address");
    const rows = await followUps(ana);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toBe(
      "the email on this contact's sheet row could not be read as an email address — fix it on the sheet and email follow-ups resume on their own",
    );
    // Rendered verbatim to a non-technical broker: plain English, no wire jargon.
    expect(rows[0].blocked_reason).not.toMatch(/400|422|http|schema|zod|payload|validat|sql|grant/i);

    // RECOVERY: she fixes the cell on the sheet; the lease expires; the next cycle
    // proposes to the corrected address and the block clears through the shipped
    // openFollowUp upsert (B-B) — nothing else needed from her.
    sheet.rows[1].cells[COL.email] = "ana@example.com";
    const [second] = await runCycle(
      { db: crm, postProposal: door.post, now: () => t1, sheet },
      TEST_TENANT,
      10,
    );
    expect(second.actions.map((a) => a.channel)).toEqual(["email"]);
    expect(door.posted).toHaveLength(1);
    expect((door.posted[0].payload as Record<string, unknown>).to).toBe("ana@example.com");
    const healed = await followUps(ana);
    expect(healed).toHaveLength(1);
    expect(healed[0].blocked_reason).toBeNull();
  });
});
