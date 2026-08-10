// Core loop / T10 — recording what the prospect actually said.
//
// 🚨 NO COERCION, EVER. `answer_kind` is a RENDERING HINT, NEVER A VALIDATOR. "around 5,
// maybe 6" against a numeric question is stored as those words: coercing it produces either
// NULL (the answer deleted) or 5 (the answer changed), and both are the guessing that the
// questionnaire design removed in the first place. She reads what her prospect said.
//
// 🚨 APPEND-ONLY, and it is a privilege fact rather than a convention: 016 grants
// `crm.answers` no UPDATE and no DELETE to anybody. A corrected answer is a SECOND ROW; the
// current state is the later one and both stay readable, because "she said 5M, then said
// 4M" is information and an overwrite destroys it.
//
// 🚨 AN UNREACHED QUESTION HAS NO ROW. That is what makes it distinguishable from one asked
// and declined, via `reached_ordinal` on the touch — without it, "no answer" means both
// "we never got there" and "she would not say", which are different facts about a lead.
import type pg from "pg";

export class AnswerRefused extends Error {}

/**
 * Record one answer, in-call.
 *
 * `boundQuestionIds` is the question set the PAYLOAD bound (T8), not whatever is live. A
 * tool call naming a question outside it is REFUSED and nothing is stored: an answer
 * against a question this call was not approved to ask is not evidence, it is noise with a
 * foreign key.
 */
export async function recordAnswer(
  db: pg.Pool,
  touchId: string,
  questionId: string,
  value: string,
  boundQuestionIds: readonly string[],
): Promise<{ id: string }> {
  if (!boundQuestionIds.includes(questionId)) {
    throw new AnswerRefused(
      `question ${questionId} is not in the question set this call was approved to ask. ` +
        `Nothing was stored.`,
    );
  }
  const r = await db.query<{ id: string }>(
    // The value goes in as given. No trim, no parse, no cast.
    `insert into crm.answers (touch_id, question_id, value) values ($1, $2, $3) returning id`,
    [touchId, questionId, value],
  );
  return { id: r.rows[0].id };
}

/** How far down her list the call got. Written as the call progresses. */
export async function setReachedOrdinal(
  db: pg.Pool,
  touchId: string,
  ordinal: number,
): Promise<void> {
  await db.query(`update crm.touches set reached_ordinal = $2 where id = $1`, [
    touchId,
    ordinal,
  ]);
}

export interface AnswerRow {
  questionId: string;
  value: string;
  at: Date;
}

/** Every row, oldest first. The CURRENT answer to a question is the last one for it. */
export async function answersFor(db: pg.Pool, touchId: string): Promise<AnswerRow[]> {
  const r = await db.query<{ question_id: string; value: string; at: Date }>(
    `select question_id, value, at from crm.answers where touch_id = $1 order by at, id`,
    [touchId],
  );
  return r.rows.map((x) => ({ questionId: x.question_id, value: x.value, at: x.at }));
}
