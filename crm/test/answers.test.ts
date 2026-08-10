// Core loop / T10 pins — answers.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { freshCrmDb, seedContact, seedQuestionSet, startTouch } from "./helpers/crmdb.js";
import { recordAnswer, setReachedOrdinal, answersFor, AnswerRefused } from "../src/answers.js";

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;
let bound: string[];
let setId: string;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  const qs = await seedQuestionSet(admin, [
    ["budget", "What budget range are you working with?"],
    ["timeline", "When are you hoping to move?"],
    ["area", "Which areas are you looking at?"],
  ]);
  bound = qs.questionIds;
  setId = qs.setId;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.contacts");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

describe("T10: the value is stored verbatim", () => {
  // mutation: coerce a numeric-kind answer — `Number(value)` (or a parse-then-null) -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  2 failed | 2 passed (4)` —
  //     AssertionError: expected 'NaN' to be 'around 5, maybe 6'
  //     AssertionError: expected [ 'NaN', 'NaN' ] to deeply equal [ '5M', 'actually 4M' ]
  //   Every answer she gave, replaced by the word NaN.
  //
  // Coercion produces either NULL (the answer deleted) or 5 (the answer changed). Both are
  // the guessing the questionnaire design removed. `answer_kind` is a RENDERING HINT.
  it("keeps 'around 5, maybe 6' exactly as said", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana, { questionSetId: setId });
    await recordAnswer(crm, t, bound[0], "around 5, maybe 6", bound);
    const rows = await answersFor(admin, t);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe("around 5, maybe 6");
  });
});

describe("T10: an unreached question is not a refused one", () => {
  // mutation: drop `reached_ordinal` from the touch write -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 3 passed (4)`
  //     AssertionError: expected null to be 1
  //
  // Without it "no answer" means both "we never got there" and "she would not say" — two
  // different facts about a lead, collapsed.
  it("has no row for a question never asked, and says how far the call got", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana, { questionSetId: setId });
    await recordAnswer(crm, t, bound[0], "5M", bound);
    await setReachedOrdinal(crm, t, 1); // asked q0, reached q1, never got to q2

    const rows = await answersFor(admin, t);
    expect(rows.map((r) => r.questionId)).toEqual([bound[0]]);
    const touch = await admin.query<{ reached_ordinal: number | null }>(
      `select reached_ordinal from crm.touches where id = $1`,
      [t],
    );
    expect(touch.rows[0].reached_ordinal).toBe(1);
  });
});

describe("T10: a changed answer APPENDS", () => {
  // mutation: overwrite in place — `update crm.answers set value = …` -> red.
  //           RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 3 passed (4)`
  //     error: permission denied for table answers
  //   — the mutation cannot even be WRITTEN. It reds at the privilege boundary rather than
  //   after the earlier answer is already gone, which is the whole reason append-only lives
  //   in the grant and not in a code review comment.
  //
  // "She said 5M, then said 4M" is information. 016 grants no UPDATE and no DELETE on this
  // table, so an overwrite cannot even be written — the mutation reds at 42501 rather than
  // after the earlier answer is already gone.
  it("keeps both, with the later one current", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana, { questionSetId: setId });
    await recordAnswer(crm, t, bound[0], "5M", bound);
    await recordAnswer(crm, t, bound[0], "actually 4M", bound);
    const rows = await answersFor(admin, t);
    expect(rows.map((r) => r.value)).toEqual(["5M", "actually 4M"]);
    const current = rows.filter((r) => r.questionId === bound[0]).at(-1);
    expect(current?.value).toBe("actually 4M");
  });
});

describe("T10: a question outside the BOUND set is refused", () => {
  // mutation: drop the membership check -> red. RUN ✅ 2026-08-09
  //   Observed: `Tests  1 failed | 3 passed (4)`
  //     AssertionError: promise resolved "{ id: 'fe782c24-…' }" instead of rejecting
  //   — and the row is stored, against a question this call was never approved to ask.
  //
  // The bound set is the one the PAYLOAD named, not whatever is live. An answer against a
  // question this call was not approved to ask is noise with a foreign key.
  it("refuses and stores nothing", async () => {
    const ana = await seedContact(admin);
    const t = await startTouch(crm, ana, { questionSetId: setId });
    const other = await seedQuestionSet(admin, [["mortgage", "Pre-approved?"]], 2);
    await expect(
      recordAnswer(crm, t, other.questionIds[0], "yes", bound),
    ).rejects.toBeInstanceOf(AnswerRefused);
    expect(await answersFor(admin, t)).toHaveLength(0);
    await admin.query(`delete from crm.questions where set_id = $1`, [other.setId]);
    await admin.query(`delete from crm.question_sets where id = $1`, [other.setId]);
  });
});
