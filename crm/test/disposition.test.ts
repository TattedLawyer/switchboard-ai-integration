// Core loop / T12 pins — the outcome set, and the two guards that keep `wrong_person`
// meaning what it says.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import {
  freshCrmDb,
  seedContact,
  seedSettings,
  seedQuestionSet,
  startTouch,
  sqlstate,
} from "./helpers/crmdb.js";
import { mapTransport, resolveDisposition } from "../src/disposition.js";
import { beginTouch, recordTouch } from "../src/touch.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;
let questionId: string;

const SETTINGS = { defaultIntervalDays: 30, shortRetryDays: 3 };

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, SETTINGS);
  questionId = (await seedQuestionSet(admin)).questionIds[0];
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

// ── the transport map ──────────────────────────────────────────────────────────────────

describe("T12: the transport can never conclude `answered`", () => {
  // mutation: `case 200: return { kind: "settled", disposition: "answered" }` — i.e. map on
  //           SIP status alone -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  5 failed | 8 passed (13)` — mapping on status alone falsifies
  //   five separate properties at once:
  //     expected { kind:'settled', disposition:'answered' } to deeply equal
  //              { kind:'settled', disposition:'voicemail' }
  //     …the same for unknown_answer, and for the 200+human hand-off to the conversation
  //     expected 'answered' to be 'wrong_person'
  //     expected { disposition:'answered', identityUnverified:false } to deeply equal
  //              { disposition:'answered', identityUnverified:true }
  //
  // SOURCED (LiveKit): "Voicemail systems answer the call at the SIP layer with a 200 OK."
  it("maps 200 + AMD machine to voicemail, not answered", () => {
    expect(mapTransport({ sipStatus: 200, amdResult: "machine" })).toEqual({
      kind: "settled",
      disposition: "voicemail",
    });
  });

  // mutation: default an absent AMD result to `answered` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected { kind: 'settled', …(1) } to deeply equal
  //                     { kind: 'settled', …(1) }   — 'answered' where 'unknown_answer'
  //                     belongs, for all three of undefined / null / "unknown".
  //
  // AMD reliability on Philippine carriers is UNKNOWN. Defaulting launders ignorance into
  // a successful contact and buys the prospect a full interval of silence.
  it("maps 200 with AMD absent or inconclusive to unknown_answer", () => {
    for (const amd of [undefined, null, "unknown"] as const) {
      expect(mapTransport({ sipStatus: 200, amdResult: amd })).toEqual({
        kind: "settled",
        disposition: "unknown_answer",
      });
    }
  });

  it("hands 200 + AMD human to the CONVERSATION, which is the only thing that knows", () => {
    expect(mapTransport({ sipStatus: 200, amdResult: "human" })).toEqual({
      kind: "conversation",
    });
    // …and a human who told the agent nothing is still not a success.
    expect(resolveDisposition({ sipStatus: 200, amdResult: "human" }, null).disposition).toBe(
      "unknown_answer",
    );
  });

  // mutation: collapse every error code to `failed` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected { kind: 'settled', …(1) } to deeply equal
  //                     { Object (kind, disposition) }   — 'failed' for a 486 busy signal,
  //                     i.e. the only information those codes carry, discarded.
  it("keeps 486/603/408/480 distinct", () => {
    expect(mapTransport({ sipStatus: 486 })).toEqual({ kind: "settled", disposition: "busy" });
    expect(mapTransport({ sipStatus: 603 })).toEqual({
      kind: "settled",
      disposition: "declined",
    });
    expect(mapTransport({ sipStatus: 408 })).toEqual({
      kind: "settled",
      disposition: "no_answer",
    });
    expect(mapTransport({ sipStatus: 480 })).toEqual({
      kind: "settled",
      disposition: "no_answer",
    });
    expect(mapTransport({ sipStatus: 503 })).toEqual({ kind: "settled", disposition: "failed" });
  });
});

describe("T12: wrong_person is distinct from the silent outcomes", () => {
  // mutation: fold `not_the_contact` into `unknown_answer` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'unknown_answer' to be 'wrong_person'
  //
  // `voicemail` / `unknown_answer` mean NOBODY COMPETENT TO SPEAK ANSWERED. `wrong_person`
  // means a human answered, understood the request, and IS NOT THE PROSPECT — positive
  // evidence about this number that the silent outcomes do not carry.
  it("resolves a healthy SIP call with a failed identity check to wrong_person", () => {
    const r = resolveDisposition({ sipStatus: 200, amdResult: "human" }, "not_the_contact");
    expect(r.disposition).toBe("wrong_person");
    expect(r.identityUnverified).toBe(false);
    expect(r.disposition).not.toBe("unknown_answer");
    expect(r.disposition).not.toBe("voicemail");
  });

  // 🚨 `wrong_person` IS UNREACHABLE FROM A NAMELESS CALL, by construction.
  it("cannot produce wrong_person from either nameless outcome", () => {
    expect(
      resolveDisposition({ sipStatus: 200, amdResult: "human" }, "identity_not_asked_complete"),
    ).toEqual({ disposition: "answered", identityUnverified: true });
    expect(
      resolveDisposition({ sipStatus: 200, amdResult: "human" }, "identity_not_asked_cut_off"),
    ).toEqual({ disposition: "partial", identityUnverified: true });
  });
});

// ── the two database guards ────────────────────────────────────────────────────────────

describe("T12 / B-A: no answers may survive against a wrong_person touch", () => {
  // 🚨 EXERCISED IN THE SHIPPED ORDER — touch inserted with a NULL disposition, ANSWER
  // FIRST, disposition SECOND. Rev 4's version of this pin wrote the disposition first,
  // which is not what the system does, and the round-2 reviewer measured that it behaved
  // IDENTICALLY WITH THE PROTECTION DELETED.
  //
  // mutation: `drop trigger touches_no_wrong_person_with_answers on crm.touches` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'NO-ERROR' to be 'P0001'
  //   — the update succeeds and the forbidden state exists, exactly as the round-2 reviewer
  //   measured. Note the SQLSTATE: both new triggers raise the DEFAULT P0001, so §4's
  //   "assert the SQLSTATE" rule means P0001 here and 23514 for the CHECK-based pin below.
  //
  // The realistic case: the spouse answers ambiguously ("sure, go ahead"), two questions
  // get answered, and only THEN says "that's my husband, he's not here."
  it("raises P0001 on the end-of-call disposition update", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana);
    await crm.query(
      `insert into crm.answers (touch_id, question_id, value) values ($1, $2, 'around 5')`,
      [t, questionId],
    );
    // §4: assert the SQLSTATE. Both new triggers raise the default P0001, and a bare
    // toThrow() would stay green against a widened grant producing a different code.
    expect(
      await sqlstate(() =>
        crm.query(`update crm.touches set disposition = 'wrong_person' where id = $1`, [t]),
      ),
    ).toBe("P0001");
    const after = await admin.query<{ disposition: string | null }>(
      `select disposition from crm.touches where id = $1`,
      [t],
    );
    expect(after.rows[0].disposition).toBeNull(); // unchanged
  });

  // mutation: `drop trigger answers_no_wrong_person on crm.answers` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'NO-ERROR' to be 'P0001'
  //
  // The FAST PATH: the agent learns it has the wrong person before any question is asked.
  // Retained, and no longer the load-bearing guard.
  it("raises P0001 when an answer arrives against an already-wrong_person touch", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana);
    await crm.query(`update crm.touches set disposition = 'wrong_person' where id = $1`, [t]);
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.answers (touch_id, question_id, value) values ($1, $2, 'x')`,
          [t, questionId],
        ),
      ),
    ).toBe("P0001");
  });
});

describe("T12: the guards read the DISPOSITION and nothing else", () => {
  // 🚨 mutation: extend either trigger to cover identity-unverified touches — e.g.
  //           `if d = 'wrong_person' or (select identity_unverified …)` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'P0001' to be 'NO-ERROR'
  //   — i.e. a legitimate nameless call's answer is REFUSED. That is the entire nameless
  //   path deleted by a trigger edit nobody would flag in review.
  //
  // The refactor this pin exists to stop is a plausible one — "tidy up the identity
  // handling" — and it would SILENTLY DELETE THE ENTIRE NAMELESS PATH. Refusing data we
  // KNOW is wrong is correct; refusing data we merely cannot ATTRIBUTE is the outcome the
  // owner explicitly rejected.
  it("stores a nameless call's answers, and labels them", async () => {
    const nameless = await seedContact(admin, { displayName: null });
    const t = await startTouch(crm, nameless);
    // Mid-call: disposition still NULL, identity never asked.
    await crm.query(`update crm.touches set identity_unverified = true where id = $1`, [t]);
    expect(
      await sqlstate(() =>
        crm.query(
          `insert into crm.answers (touch_id, question_id, value) values ($1, $2, 'two bedrooms')`,
          [t, questionId],
        ),
      ),
    ).toBe("NO-ERROR");
    // End of call: an ORDINARY disposition, and both triggers stay quiet.
    expect(
      await sqlstate(() =>
        crm.query(`update crm.touches set disposition = 'answered' where id = $1`, [t]),
      ),
    ).toBe("NO-ERROR");
    const r = await admin.query<{ n: string; identity_unverified: boolean }>(
      `select (select count(*) from crm.answers a where a.touch_id = t.id) as n,
              t.identity_unverified
         from crm.touches t where t.id = $1`,
      [t],
    );
    expect(r.rows[0].n).toBe("1");
    expect(r.rows[0].identity_unverified).toBe(true);
  });

  // 🚨 I-5. mutation: drop
  //           `check (not (disposition = 'wrong_person' and identity_unverified))` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 'NO-ERROR' to be '23514'   — the forbidden row inserts
  //     cleanly, which is precisely the state rev 4 asserted was unreachable.
  //
  // Rev 4's version of this pin asserted `wrong_person` was "unreachable for a nameless
  // contact" while `identity_unverified` was a plain boolean with no constraint — the
  // reviewer inserted a row with both set, cleanly. THE PIN'S STATED MUTATION WAS NOT
  // PERFORMABLE, which §4 calls a finding. The CHECK gives it a mechanism.
  it("refuses wrong_person together with identity_unverified, at 23514", async () => {
    const ana = await seedContact(admin);
    // On INSERT.
    expect(
      await sqlstate(() =>
        admin.query(
          `insert into crm.touches (contact_id, channel, disposition, identity_unverified,
                                    transcript_delivery)
           values ($1, 'call', 'wrong_person', true, 'pending')`,
          [ana],
        ),
      ),
    ).toBe("23514");
    // And on UPDATE, in the shipped ordering.
    const t = await startTouch(crm, ana);
    await crm.query(`update crm.touches set identity_unverified = true where id = $1`, [t]);
    expect(
      await sqlstate(() =>
        crm.query(`update crm.touches set disposition = 'wrong_person' where id = $1`, [t]),
      ),
    ).toBe("23514");
  });
});

describe("T12: what wrong_person does to the machine", () => {
  // mutation: remove `wrong_person` from `ROTATION_ADVANCING_DISPOSITIONS` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected false to be true
  //
  // Without it the next cycle re-dials the SAME number and reaches the SAME spouse, for
  // ever. This is the pin T5 could not carry, because rotation is T12's.
  it("advances dial_rotation_ordinal", async () => {
    const ana = await seedContact(admin);
    const t = await beginTouch(crm, { contactId: ana, channel: "call" });
    const r = await recordTouch(crm, t, { disposition: "wrong_person" }, SETTINGS);
    expect(r.rotationAdvanced).toBe(true);
    const c = await admin.query<{ dial_rotation_ordinal: number }>(
      `select dial_rotation_ordinal from crm.contacts where id = $1`,
      [ana],
    );
    expect(c.rows[0].dial_rotation_ordinal).toBe(1);
  });

  it("does not advance the rotation on any other disposition", async () => {
    const ana = await seedContact(admin);
    const t = await beginTouch(crm, { contactId: ana, channel: "call" });
    await recordTouch(crm, t, { disposition: "no_answer" }, SETTINGS);
    const c = await admin.query<{ dial_rotation_ordinal: number }>(
      `select dial_rotation_ordinal from crm.contacts where id = $1`,
      [ana],
    );
    expect(c.rows[0].dial_rotation_ordinal).toBe(0);
  });
});

describe("T12: message_left is recorded and changes nothing", () => {
  // mutation: let `message_left` lengthen the interval — e.g. treat it as a successful
  //           contact in `recordTouch` -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 12 passed (13)`
  //     AssertionError: expected 30 to be 3   — a message left with a spouse silently
  //     bought the prospect a full follow-up interval.
  //
  // She needs to know a message is outstanding so a call two days later does not look odd.
  // It deliberately does NOT change the clock — one fewer knob she has to invent, and the
  // signal is visible either way.
  it("stores the flag and still uses the short retry", async () => {
    const ana = await seedContact(admin);
    const t = await beginTouch(crm, { contactId: ana, channel: "call" });
    const r = await recordTouch(
      crm,
      t,
      { disposition: "wrong_person", messageLeft: true },
      SETTINGS,
    );
    expect(r.intervalDaysUsed).toBe(SETTINGS.shortRetryDays);
    const row = await admin.query<{ message_left: boolean }>(
      `select message_left from crm.touches where id = $1`,
      [t],
    );
    expect(row.rows[0].message_left).toBe(true);
  });
});
