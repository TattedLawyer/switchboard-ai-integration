// Part 2 / Piece A pins — the proposer reads contact DETAILS live from the linked sheet.
//
// THE PRODUCT PRINCIPLE UNDER TEST: her Google Sheet is the MASTER contact list.
// Switchboard owns follow-up state only; name, email address and phone numbers are read
// from the sheet AT PROPOSAL TIME, so the system never proposes from a stale synced-down
// copy — and never hallucinates a detail that is no longer on the sheet.
//
// ONE SNAPSHOT PER CYCLE: `runCycle` reads the sheet once and hands the same snapshot to
// every claimed contact. The transport here is the stateful FakeSheet; the database is a
// real ephemeral cluster with migrations 001–022 applied, so every read below runs under
// the REAL post-022 grants (`switchboard_crm` cannot read email_address / source_detail /
// looking_for — the 42501 is pinned in migration-022.test.ts).
//
// 🚨 SHEET UNREACHABLE => SKIP, NOT BLOCK. No follow_ups row, no blocked reason, no clock
// write beyond the claim lease the cycle already took. NEVER a fall-back to stored
// details: a proposal built from the stored copy is exactly the stale-data dial this
// piece exists to kill.
//
// TDD RED RECORD (RUN ✅ 2026-08-18, before any implementation and before migration 022):
//   `Tests  11 failed | 7 passed (18)` across this file + migration-022.test.ts —
//   P1 red dialing the STALE number (`expected '+639171111111' to be '+639179998888'`),
//   P2 red sending to the STORED address, P3 red greeting with the stored name, P4/P5 red
//   proposing from stored details while the sheet was unreachable/vanished, P8 red
//   `expected 'NO-ERROR' to be '42501'`, P10 red reporting `no_email_address`. P6/P7's
//   happy paths passed pre-implementation by coincidence (stored == live in their
//   fixtures); their discriminating power is their post-implementation mutations below.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedNumber,
  seedSettings,
  TEST_INSTANT,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { FakeSheet, type FakeRow } from "./helpers/fakesheet.js";
import { publishQuestionSet } from "../src/questions.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { placeCallPayloadSchema, followUpEmailPayloadSchema } from "../../approval/src/proposal.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

/** The A2 door, faithfully faked: same key -> same id (the shipped suites' discipline). */
function fakeDoor() {
  const byKey = new Map<string, string>();
  const posted: DoorProposal[] = [];
  return {
    posted,
    byKey,
    post: async (p: DoorProposal): Promise<{ id: string }> => {
      posted.push(p);
      const existing = byKey.get(p.idempotency_key);
      if (existing !== undefined) return { id: existing };
      const id = randomUUID();
      byKey.set(p.idempotency_key, id);
      return { id };
    },
  };
}

// Header in HER vocabulary; "Looking For" and "Met At" map to the payload-context fields.
const HEADER = ["Name", "Email", "Contact #", "Met At", "Looking For"];

function row(
  ref: string | null,
  cells: { name?: string; email?: string; phone?: string; metAt?: string; lookingFor?: string },
): FakeRow {
  return {
    ref,
    cells: [
      cells.name ?? "",
      cells.email ?? "",
      cells.phone ?? "",
      cells.metAt ?? "",
      cells.lookingFor ?? "",
    ],
  };
}

/** A sheet-bound contact: linked sheet + FakeSheet row (adoption's work, seeded through
 *  the owner pool exactly as the owner-run pass writes it) whose LIVE cells the proposer
 *  must read. Returns the transport to inject into `runCycle`. */
async function sheetContact(o: {
  cells: Parameters<typeof row>[1];
  storedName?: string | null;
  storedEmail?: string | null;
  channel?: "call" | "email" | "both";
  dueAt?: string;
  storedPhones?: string[]; // E.164, in adoption (ordinal) order
}): Promise<{ contactId: string; ref: string; sheet: FakeSheet; phoneIds: string[] }> {
  const linked = await seedLinkedSheet(admin);
  const ref = randomUUID();
  const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [row(ref, o.cells)]);
  const contactId = await seedContact(admin, {
    displayName: o.storedName === undefined ? "Stored Name" : o.storedName,
    email: o.storedEmail === undefined ? null : o.storedEmail,
    channel: o.channel ?? "call",
    dueAt: o.dueAt ?? new Date(Date.now() - 86_400_000).toISOString(),
    linkedSheetId: linked.id,
    rowRef: ref,
  });
  const phoneIds: string[] = [];
  for (const [i, e164] of (o.storedPhones ?? []).entries()) {
    phoneIds.push(await seedNumber(admin, contactId, e164, i));
  }
  return { contactId, ref, sheet, phoneIds };
}

const followUps = async (contactId: string) =>
  (
    await admin.query<{ blocked_reason: string | null; closed_at: Date | null }>(
      `select blocked_reason, closed_at from crm.follow_ups where contact_id = $1`,
      [contactId],
    )
  ).rows;

const setRotation = (contactId: string, n: number) =>
  admin.query(`update crm.contacts set dial_rotation_ordinal = $2 where id = $1`, [contactId, n]);

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, { intervalDays: 30, shortRetryDays: 3 });
  await publishQuestionSet(admin, TEST_TENANT, [
    { key: "budget", prompt: "What budget range are you working with?", kind: "text" },
  ]);
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
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("P1 — THE PHONE FIX: the corrected number is dialed, not the stale one", () => {
  // The live defect this kills (PROVED before this piece): she corrects a number on the
  // sheet; adoption syncs the NEW number insert-only (016 grants no DELETE), so storage
  // holds BOTH and the stored-ordinal rotation dials the STALE one on half of all
  // attempts, forever — with the approval card presenting it as a legitimate
  // "entry 1 of 2". Dial candidates must be the LIVE sheet numbers, in sheet order, each
  // resolved to its stored row only for the `phone_number_id` the payload grammar needs.
  // A stored number absent from the sheet is filtered by ABSENCE — never deleted.
  //
  // mutation: revert `buildCallProposal`'s sheet-linked branch to the stored ordinal list
  //           (candidates = stored `numbers`, label from stored ordinals) -> red.
  //           RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected '+639171111111' to be '+639179998888' // Object.is equality
  //   — the STALE stored number was dialed at rotation 0, exactly the live defect this
  //   pin kills (half of all attempts, forever, presented as a legitimate entry).
  //   Restored, green.
  it("dials only the live sheet number at every rotation ordinal", async () => {
    const stale = "+639171111111"; // stored at ordinal 0; NOT on the sheet any more
    const corrected = "+639179998888"; // her fix — on the sheet, stored at ordinal 1
    const { contactId, phoneIds, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "0917 999 8888" },
      storedPhones: [stale, corrected],
    });

    for (const rotation of [0, 1, 2]) {
      await setRotation(contactId, rotation);
      await admin.query(`update crm.contacts set next_due_at = now() - interval '1 day'`);
      await admin.query(`update crm.follow_ups set closed_at = now()`);
      const door = fakeDoor();
      const [outcome] = await runCycle(
        { db: crm, postProposal: door.post, sheet },
        TEST_TENANT,
        10,
      );
      expect(outcome.actions).toHaveLength(1);
      const payload = door.posted[0].payload as Record<string, unknown>;
      expect(payload.phone_e164).toBe(corrected); // never the stale ordinal-0 number
      expect(payload.phone_number_id).toBe(phoneIds[1]);
      expect(door.posted[0].rationale).toContain(corrected);
      expect(door.posted[0].rationale).toContain("entry 1 of 1"); // the honest count
      expect(door.posted[0].rationale).not.toContain(stale);
    }
  });
});

describe("P2 — a live email edit reaches payload.to with NO adoption pass in between", () => {
  // mutation: build the email leg from the STORED column again (email_address restored to
  //           loadContact's SELECT; `to:` from the contact row) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  13 failed (13)` — the ENTIRE file red with
  //     error: permission denied for table contacts
  //   (SQLSTATE 42501 at loadContact's widened column list: post-022 the stored copy is
  //   not merely stale, it is UNREADABLE to this role — the revoke is the control that
  //   makes the forbidden read-from-storage path unwritable, not just untested. Pre-022
  //   the same mutation would have quietly sent to the stale address.) Restored, green.
  it("sends to the address on the sheet while the stored column still holds the old one", async () => {
    const { sheet } = await sheetContact({
      cells: { name: "Ana Reyes", email: "new-address@example.com" },
      storedEmail: "old-address@example.com", // stale synced-down copy, never used
      channel: "email",
    });
    const door = fakeDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, sheet },
      TEST_TENANT,
      10,
    );
    expect(outcome.actions.map((a) => a.channel)).toEqual(["email"]);
    const payload = door.posted[0].payload as Record<string, unknown>;
    expect(payload.to).toBe("new-address@example.com");
    expect(JSON.stringify(door.posted[0])).not.toContain("old-address@example.com");
    expect(followUpEmailPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("P3 — the live name renders the opening line", () => {
  // mutation: render the opening from the STORED display_name (`displayName =
  //           contact.display_name` regardless of the live row) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  2 failed | 11 passed (13)` — this pin red with
  //     AssertionError: expected 'Hi, this is Marisol\'s assistant from…' to contain
  //     'Maria Reyes-Santos'
  //   (the card would greet her by the name she already corrected away; P9 red alongside
  //   with `expected 'Stored Name' to be 'Ana Reyes'` on payload.display_name).
  //   Restored, green.
  it("greets with the name on the sheet, not the stored one", async () => {
    const { sheet } = await sheetContact({
      cells: { name: "Maria Reyes-Santos", phone: "0917 123 4567" },
      storedName: "Maria Reyes", // pre-correction
      storedPhones: ["+639171234567"],
    });
    const door = fakeDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, sheet },
      TEST_TENANT,
      10,
    );
    expect(outcome.actions).toHaveLength(1);
    const payload = door.posted[0].payload as Record<string, unknown>;
    expect(payload.opening_line).toContain("Maria Reyes-Santos");
    expect(payload.display_name).toBe("Maria Reyes-Santos");
    expect(door.posted[0].rationale).toContain("Maria Reyes-Santos");
    expect(placeCallPayloadSchema.safeParse(payload).success).toBe(true);
  });
});

describe("P4 — 🔴 sheet unreachable => SKIP: no POST, no row, no block, no clock change", () => {
  // mutation: fall back to STORED details when the read fails (the `unavailable` branch
  //           sets `live = null` and the manual path runs) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected [ { …(4) } ] to have a length of +0 but got 1
  //   at `expect(door.posted).toHaveLength(0)` — a mere network blip produced a REAL door
  //   POST built from the stored copy (stored name + stored number), the exact
  //   stale-detail card the skip rule forbids. Restored, green.
  it("skips the cycle; the lease expires and the next cycle proposes from the recovered sheet", async () => {
    let vnow = new Date(TEST_INSTANT.getTime());
    const { contactId, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "0917 123 4567" },
      storedPhones: ["+639171234567"],
      dueAt: TEST_INSTANT.toISOString(),
    });
    sheet.failWith = new Error("ETIMEDOUT reading sheet");

    const door = fakeDoor();
    const [outcome] = await runCycle(
      { db: crm, postProposal: door.post, now: () => vnow, sheet },
      TEST_TENANT,
      10,
    );

    // SKIP, not block: zero door POSTs, zero follow_ups rows, reason surfaced in-memory.
    expect(door.posted).toHaveLength(0);
    expect(outcome.actions).toHaveLength(0);
    expect(outcome.blockedReason).toBeNull();
    expect(outcome.skipped.length).toBeGreaterThan(0);
    expect(await followUps(contactId)).toEqual([]);

    // The clock carries exactly the claim lease — no interval write, no null, no block.
    const due = await admin.query<{ next_due_at: Date }>(
      `select next_due_at from crm.contacts where id = $1`,
      [contactId],
    );
    expect(due.rows[0].next_due_at.getTime()).toBe(vnow.getTime() + 15 * 60_000);

    // 16 minutes on (lease expired), the sheet is back: the contact re-claims and proposes.
    sheet.failWith = null;
    vnow = new Date(vnow.getTime() + 16 * 60_000);
    const [second] = await runCycle(
      { db: crm, postProposal: door.post, now: () => vnow, sheet },
      TEST_TENANT,
      10,
    );
    expect(second.actions).toHaveLength(1);
    expect(door.posted).toHaveLength(1);
  });
});

describe("P5 — a vanished row at proposal time => skip, nothing posted", () => {
  // mutation: treat a vanished row as a MANUAL contact (`live = row ?? null` instead of
  //           the skip) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected [ { channel: 'call', …(5) } ] to have a length of +0 but got 1
  //   — the deleted row's contact was PROPOSED from stored details (an action came back),
  //   i.e. someone she visibly removed would still be called. Restored, green.
  it("skips when the ref is gone from the snapshot, and when the row is all-blank", async () => {
    const { contactId, ref, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "0917 123 4567" },
      storedPhones: ["+639171234567"],
    });

    // She deletes the row between adoption and this cycle.
    sheet.deleteRowByRef(ref);
    const door = fakeDoor();
    const [gone] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(gone.actions).toHaveLength(0);
    expect(gone.blockedReason).toBeNull(); // the owner-run adoption pass writes the
    expect(await followUps(contactId)).toEqual([]); // sheet_row_missing block, not us
    expect(door.posted).toHaveLength(0);

    // The cell-clearing variant: the ref survives but every cell is blank — same skip.
    sheet.rows.push({ ref, cells: ["", "", "", "", ""] });
    await admin.query(`update crm.contacts set next_due_at = now() - interval '1 minute'`);
    const [blank] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(blank.actions).toHaveLength(0);
    expect(blank.blockedReason).toBeNull();
    expect(await followUps(contactId)).toEqual([]);
    expect(door.posted).toHaveLength(0);
  });
});

describe("P6 — 🔴 the phone map is CONTACT-SCOPED: another contact's number never resolves", () => {
  // A displaced number (a sort, a cross-row paste, a shared household line she is
  // reorganising) that resolved through an UNSCOPED map would put ANOTHER contact's
  // phone_number_id into this contact's payload — corrupting both the call payload and
  // the touch attribution that hangs off phone_number_id.
  //
  // mutation: drop the contact_id scope — build the E.164 -> id map from ALL of
  //           `crm.phone_numbers`, not `where contact_id = $1` -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected '4c052718-c171-4ba7-a06c-75b4e9722487' to be
  //     'acc648c9-f72f-4804-88cf-784c918bd882' // Object.is equality
  //   — BEN'S phone_number_id landed in ANA'S call payload (the displaced number
  //   resolved through the unscoped map), corrupting both the payload and the touch
  //   attribution that hangs off phone_number_id. Restored, green.
  it("excludes a live number stored only under a different contact", async () => {
    const linked = await seedLinkedSheet(admin);
    const anaRef = randomUUID();
    // Ana's sheet row lists Ben's number first (the displaced value), then her own.
    const sheet = new FakeSheet(linked.spreadsheetId, HEADER, [
      row(anaRef, { name: "Ana Reyes", phone: "0917 555 0000 / 0917 111 2222" }),
    ]);
    const ana = await seedContact(admin, {
      displayName: "Ana Reyes",
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
      linkedSheetId: linked.id,
      rowRef: anaRef,
    });
    const anaOwnId = await seedNumber(admin, ana, "+639171112222", 0);
    // Ben — a different contact — is the only one who STORES +639175550000.
    const ben = await seedContact(admin, { displayName: "Ben Cruz", dueAt: null });
    const benId = await seedNumber(admin, ben, "+639175550000", 0);

    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(outcome.actions).toHaveLength(1);
    const payload = door.posted[0].payload as Record<string, unknown>;
    expect(payload.phone_number_id).toBe(anaOwnId); // hers —
    expect(payload.phone_number_id).not.toBe(benId); // — never Ben's
    expect(payload.phone_e164).toBe("+639171112222");
    expect(door.posted[0].rationale).toContain("entry 1 of 1"); // Ben's number excluded
  });
});

describe("P7 — candidates dedupe by E.164: two spellings of one number don't skew rotation", () => {
  // mutation: remove the by-E.164 dedupe from the live candidate list
  //           (`liveOrder = live.phones`) -> red. RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'Ana Reyes is due: never contacted · f…' to contain 'of 2'
  //       Received: "… calling +639171112222 (entry 1 of 3)."
  //   — one number spelled twice inflated the candidate list to 3, skewing the rotation
  //   (the duplicated line would get two attempts in three, the other line one).
  //   Restored, green.
  it("rotates over unique numbers only", async () => {
    // One number spelled twice ("0917 111 2222" and "+63 917 111 2222"), plus a second.
    const { contactId, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "0917 111 2222 / +63 917 111 2222 / 0917 999 8888" },
      storedPhones: ["+639171112222", "+639179998888"],
    });

    const picks: string[] = [];
    for (const rotation of [0, 1, 2, 3]) {
      await setRotation(contactId, rotation);
      await admin.query(`update crm.contacts set next_due_at = now() - interval '1 day'`);
      await admin.query(`update crm.follow_ups set closed_at = now()`);
      const door = fakeDoor();
      const [outcome] = await runCycle(
        { db: crm, postProposal: door.post, sheet },
        TEST_TENANT,
        10,
      );
      expect(outcome.actions).toHaveLength(1);
      picks.push((door.posted[0].payload as Record<string, string>).phone_e164);
      expect(door.posted[0].rationale).toContain("of 2"); // two candidates, not three
    }
    expect(picks).toEqual([
      "+639171112222",
      "+639179998888",
      "+639171112222", // modulo 2 — back to the top
      "+639179998888",
    ]);
  });

  it("skips (never falsely blocks no_phone_number) when the row's numbers await adoption", async () => {
    // The sheet carries a number storage does not know yet (adoption hasn't run since her
    // edit). Zero resolvable candidates while the row DOES carry phones => SKIP this
    // cycle — a `no_phone_number` block would be a false statement about her sheet.
    const { contactId, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "0917 333 4444" },
      storedPhones: [], // nothing adopted yet
    });
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(outcome.actions).toHaveLength(0);
    expect(outcome.blockedReason).toBeNull(); // NOT no_phone_number — the row has phones
    expect(await followUps(contactId)).toEqual([]);
    expect(door.posted).toHaveLength(0);
  });

  it("surfaces unreadable phones in the reason instead of claiming there are none", async () => {
    const { contactId, sheet } = await sheetContact({
      cells: { name: "Ana Reyes", phone: "not-a-number" },
      storedPhones: [],
    });
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(outcome.actions).toHaveLength(0);
    expect(outcome.blockedReason).not.toBe("no_phone_number"); // there ARE numbers — unreadable ones
    expect(outcome.blockedReason).toMatch(/could not be read|unreadable/i);
    const rows = await followUps(contactId);
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked_reason).toMatch(/could not be read|unreadable/i);
  });

  it("still blocks no_phone_number when the row genuinely carries no phones", async () => {
    const { contactId, sheet } = await sheetContact({
      cells: { name: "Ana Reyes" }, // no phone cell at all
      storedPhones: [],
    });
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);
    expect(outcome.blockedReason).toBe("no_phone_number");
    expect((await followUps(contactId))[0]?.blocked_reason).toBe("no_phone_number");
  });
});

describe("P9 — post-022, a full runCycle completes end-to-end for a sheet-linked contact", () => {
  it("proposes BOTH legs from the live row under the real revoked grants", async () => {
    const { contactId, sheet } = await sheetContact({
      cells: {
        name: "Ana Reyes",
        email: "ana@example.com",
        phone: "0917 123 4567",
        metAt: "Rotary breakfast (live)",
        lookingFor: "a 3BR in BGC (live)",
      },
      channel: "both",
      storedPhones: ["+639171234567"],
    });
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post, sheet }, TEST_TENANT, 10);

    expect(outcome.actions.map((a) => a.channel).sort()).toEqual(["call", "email"]);
    expect(outcome.blockedReason).toBeNull();
    const call = door.posted.find((p) => p.action_type === "place_call")!.payload as Record<
      string,
      unknown
    >;
    const email = door.posted.find((p) => p.action_type === "send_email")!.payload as Record<
      string,
      unknown
    >;
    // Every detail is the LIVE one — computed from her sheet, never generated or stored.
    expect(call.display_name).toBe("Ana Reyes");
    expect(call.context).toEqual({
      source_detail: "Rotary breakfast (live)",
      looking_for: "a 3BR in BGC (live)",
    });
    expect(email.to).toBe("ana@example.com");
    expect(String(email.body)).toContain("a 3BR in BGC (live)");
    expect(placeCallPayloadSchema.safeParse(call).success).toBe(true);
    expect(followUpEmailPayloadSchema.safeParse(email).success).toBe(true);
    // One open follow-up row carrying both actions.
    const rows = await admin.query<{ n: string }>(
      `select count(*) as n from crm.follow_up_actions fa
         join crm.follow_ups f on f.id = fa.follow_up_id where f.contact_id = $1`,
      [contactId],
    );
    expect(rows.rows[0].n).toBe("2");
  });
});

describe("P10 — a manual contact's email leg blocks with the HONEST reason", () => {
  // 🔴 PER MICHAEL'S RULING: after the revoke, a manual contact's stored address EXISTS
  // and is merely unreadable to the proposer — so "no_email_address" would be a false
  // statement rendered verbatim to the broker. The block must say, in plain English, that
  // the contact is not on the linked sheet. Intake itself keeps working (owner role).
  //
  // mutation: report `no_email_address` for the manual email leg again -> red.
  //           RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'no_email_address' not to be 'no_email_address'
  //   — the FALSE reason (Wanda's address IS on file, merely unreadable post-revoke)
  //   was recorded and would render verbatim in her queue. Restored, green.
  it("blocks with a plain-English not-on-the-sheet reason, never no_email_address", async () => {
    const manual = await seedContact(admin, {
      displayName: "Walk-in Wanda",
      channel: "email",
      email: "wanda@example.com", // ON FILE — written by owner-role intake
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);

    expect(door.posted).toHaveLength(0);
    expect(outcome.blockedReason).not.toBe("no_email_address");
    expect(outcome.blockedReason).toMatch(/linked sheet/i);
    const rows = await followUps(manual);
    expect(rows).toHaveLength(1);
    // Rendered verbatim to the broker (DETAILS_CHANGED_REASON's standard): plain English,
    // states what is true, no wire jargon.
    expect(rows[0].blocked_reason).toMatch(/linked sheet/i);
    expect(rows[0].blocked_reason).not.toMatch(/42501|grant|revoke|sql|column|http/i);
  });

  it("a manual contact's CALL leg is unchanged: stored name and stored numbers", async () => {
    const manual = await seedContact(admin, {
      displayName: "Manual Mando",
      channel: "call",
      dueAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await seedNumber(admin, manual, "+639170001111");
    const door = fakeDoor();
    const [outcome] = await runCycle({ db: crm, postProposal: door.post }, TEST_TENANT, 10);
    expect(outcome.actions.map((a) => a.channel)).toEqual(["call"]);
    const payload = door.posted[0].payload as Record<string, unknown>;
    expect(payload.display_name).toBe("Manual Mando");
    expect(payload.phone_e164).toBe("+639170001111");
    // Post-022 the proposer cannot read source_detail/looking_for for a manual contact;
    // the payload context is honestly null rather than a stale or invented value.
    expect(payload.context).toEqual({ source_detail: null, looking_for: null });
    expect(placeCallPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
