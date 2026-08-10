// Core loop / T4 pins — her question list, immutably versioned.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, seedContact, startTouch, sqlstate, TEST_TENANT } from "./helpers/crmdb.js";
import {
  publishQuestionSet,
  currentQuestionSet,
  selectQuestionSetForProposal,
  resolveQuestionSetForExecution,
} from "../src/questions.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

const MARCH = [
  { key: "budget", prompt: "What budget range are you working with?", kind: "text" as const },
  { key: "timeline", prompt: "When are you hoping to move?", kind: "text" as const },
];
const JUNE = [
  { key: "budget", prompt: "Roughly what price bracket are you looking at?", kind: "text" as const },
  { key: "timeline", prompt: "When are you hoping to move?", kind: "text" as const },
];

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.questions");
  await admin.query("delete from crm.question_sets");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T4: an edit publishes a new version and leaves the old rows untouched", () => {
  // mutation: make the editor UPDATE in place —
  //           `update crm.questions set prompt_text = $1 where set_id = <current>`
  //           instead of inserting a new set -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  5 failed | 3 passed (8)` — five, because in-place editing
  //   falsifies nearly every property this file names at once:
  //     AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]  (March's wording gone)
  //     AssertionError: expected 'Roughly what price bracket are you lo…' to be
  //                     'What budget range are you working wit…'
  //     AssertionError: expected null not to be null                (nothing was retired)
  //     AssertionError: expected 1 to be 2                          (no second version)
  it("keeps March's rows byte-identical after a June edit", async () => {
    const march = await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const june = await publishQuestionSet(admin, TEST_TENANT, JUNE);
    expect(june.version).toBe(2);
    expect(june.retiredSetId).toBe(march.setId);

    const old = await resolveQuestionSetForExecution(admin, march.setId);
    expect(old?.questions.map((q) => q.promptText)).toEqual([
      "What budget range are you working with?",
      "When are you hoping to move?",
    ]);
    expect(old?.retiredAt).not.toBeNull();

    const live = await currentQuestionSet(admin, TEST_TENANT);
    expect(live?.version).toBe(2);
  });

  // mutation: key the answer on `question_key` instead of `question_id` — i.e. resolve an
  //           answer's wording through the LIVE set rather than through the version it was
  //           asked from -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  3 failed | 5 passed (8)` —
  //     AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]
  //     AssertionError: expected 'Roughly what price bracket are you lo…' to be
  //                     'What budget range are you working wit…'
  //     AssertionError: expected null not to be null
  //   That is a stored answer silently restating what the prospect was actually asked.
  it("resolves a March answer to March's wording after a June edit", async () => {
    const march = await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const ana = await seedContact(admin);
    const touch = await startTouch(admin, ana, { questionSetId: march.setId });
    const marchSet = await resolveQuestionSetForExecution(admin, march.setId);
    await crm.query(
      `insert into crm.answers (touch_id, question_id, value) values ($1, $2, $3)`,
      [touch, marchSet!.questions[0].id, "around 5, maybe 6 million"],
    );

    await publishQuestionSet(admin, TEST_TENANT, JUNE);

    const r = await admin.query<{ prompt_text: string; value: string; question_key: string }>(
      `select q.prompt_text, a.value, q.question_key
         from crm.answers a join crm.questions q on q.id = a.question_id
        where a.touch_id = $1`,
      [touch],
    );
    expect(r.rows[0].prompt_text).toBe("What budget range are you working with?");
    expect(r.rows[0].value).toBe("around 5, maybe 6 million");
    // …and the stable slug is what makes the cross-version query possible at all.
    expect(r.rows[0].question_key).toBe("budget");
  });
});

describe("T4: a proposal binds a VERSION, and an edit cannot reach into it", () => {
  // mutation: have the executor resolve the set at execution time
  //           (`currentQuestionSet(tenant)`) instead of by the id bound in the payload
  //           -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  3 failed | 5 passed (8)`, the same three as above — this pin and
  //   the March-answer pin fail together under the one mutation, which is the point:
  //     AssertionError: expected 'Roughly what price bracket are you lo…' to be
  //                     'What budget range are you working wit…'
  //   The DB already forbids mutating the payload (015:353-363); this pin guards the APP
  //   PATH that would route around it by simply not reading the payload's id.
  it("executes the bound version even after the set is superseded", async () => {
    const march = await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const boundPayload = { question_set_id: march.setId };
    await publishQuestionSet(admin, TEST_TENANT, JUNE);

    const forTheCall = await resolveQuestionSetForExecution(
      admin,
      boundPayload.question_set_id,
    );
    expect(forTheCall?.questions[0].promptText).toBe("What budget range are you working with?");
  });

  // 🚨 I5 — RETIREMENT GATES SELECTION, NEVER EXECUTION.
  // mutation: add a retirement check to `resolveQuestionSetForExecution`
  //           (`if (set.retiredAt) return null`) -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  3 failed | 5 passed (8)` —
  //     AssertionError: expected undefined to deeply equal [ …(2) ]
  //     AssertionError: expected undefined to be 'What budget range are you working wit…'
  //     AssertionError: expected null not to be null
  //   i.e. the approved call resolves to NOTHING TO ASK. The validating variant means EVERY
  //   question edit silently strands her entire approved queue at execution time. She
  //   approved those exact words; asking them is correct.
  it("still executes a proposal whose set was retired after approval", async () => {
    const march = await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const approvedPayload = { question_set_id: march.setId };
    await publishQuestionSet(admin, TEST_TENANT, JUNE); // she edits after approving

    const set = await resolveQuestionSetForExecution(admin, approvedPayload.question_set_id);
    expect(set).not.toBeNull();
    expect(set!.retiredAt).not.toBeNull(); // retired…
    expect(set!.questions).toHaveLength(2); // …and asked anyway
  });

  // mutation: select for a NEW proposal without the `retired_at is null` predicate -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 6 passed (8)` —
  //     AssertionError: expected 1 to be 2
  //     AssertionError: expected '0c98d093-…' to be '78669a03-…'   (the retired set chosen)
  it("never selects a retired set for a NEW proposal", async () => {
    await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const june = await publishQuestionSet(admin, TEST_TENANT, JUNE);
    const chosen = await selectQuestionSetForProposal(admin, TEST_TENANT);
    expect(chosen?.id).toBe(june.setId);
    expect(chosen?.version).toBe(2);
  });

  // mutation: DELETE the old set on retire instead of stamping `retired_at` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected '23503' to be '42501'
  //   Read that carefully rather than as a pass: with a DELETE grant in place the refusal
  //   DEGRADES from a privilege boundary to an incidental foreign key — which would stop
  //   protecting the sets nothing references yet. That is precisely why there is no DELETE
  //   grant anywhere in schema `crm`, and why this pin asserts 42501 rather than "it
  //   threw".
  it("has no DELETE path for a retired set, under switchboard_crm", async () => {
    await publishQuestionSet(admin, TEST_TENANT, MARCH);
    expect(await sqlstate(() => crm.query(`delete from crm.question_sets`))).toBe("42501");
    expect(await sqlstate(() => crm.query(`delete from crm.questions`))).toBe("42501");
  });
});

describe("T4 / M4: question_key is unique in a set and carried forward verbatim", () => {
  // mutation: drop the duplicate-key guard in `publishQuestionSet`, or regenerate keys on
  //           edit (`key: \`q\${i}\``) -> red. RUN ✅ 2026-08-09
  //   Observed, dropping the guard:  `Tests  1 failed | 7 passed (8)`
  //     AssertionError: expected [Function] to throw error matching /unique within a set/
  //                     but got 'duplicate key value violates unique c…'
  //     — i.e. 016's `questions_key_unique_in_set` catches it, one layer down.
  //   Observed, regenerating keys:   `Tests  2 failed | 6 passed (8)`
  //     AssertionError: expected 'q0' to be 'budget'
  //     AssertionError: expected [ 'q0', 'q1' ] to deeply equal [ 'budget', 'timeline' ]
  //   The cross-version query (`core-loop-research.md:153`) is the thing that breaks, and
  //   nothing downstream would notice.
  it("refuses a duplicate key within one set", async () => {
    await expect(
      publishQuestionSet(admin, TEST_TENANT, [
        { key: "budget", prompt: "A?", kind: "text" },
        { key: "budget", prompt: "B?", kind: "text" },
      ]),
    ).rejects.toThrow(/unique within a set/);
  });

  it("carries the keys forward unchanged across an edit", async () => {
    await publishQuestionSet(admin, TEST_TENANT, MARCH);
    const june = await publishQuestionSet(admin, TEST_TENANT, JUNE);
    const set = await resolveQuestionSetForExecution(admin, june.setId);
    expect(set!.questions.map((q) => q.questionKey)).toEqual(["budget", "timeline"]);
  });
});
