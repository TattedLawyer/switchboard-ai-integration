// Core loop / T4 — her question list, immutably versioned.
//
// The call is a PRE-PROGRAMMED QUESTION LIST SHE EDITS, not an open conversation (owner
// decision 1). That makes her questions the schema — which is why there are no hardcoded
// budget/area/timeline columns anywhere in 016.
//
// 🚨 EDITING CREATES A NEW VERSION AND RETIRES THE OLD ONE. Rewriting in place would
// silently restate what a prospect was actually asked: an answer recorded in March would
// start resolving to June's wording, and nothing would record that the wording had moved.
// Answers are therefore keyed to `question_id` — a VERSION — and never to `question_key`.
//
// 🚨 RETIREMENT GATES SELECTION, NEVER EXECUTION, and the difference is the whole of §I5.
// A retired set is not chosen for a NEW proposal. An ALREADY APPROVED proposal that binds
// it still executes and still asks it: the payload is immutable (015:353-363) and she
// approved those exact questions. The alternative — validating "the set must not be
// retired" in the executor — means EVERY QUESTION EDIT SILENTLY STRANDS HER ENTIRE
// APPROVED QUEUE at execution time. `resolveQuestionSetForExecution` below therefore
// deliberately does not look at `retired_at`, and a pin watches for someone adding it.
import type pg from "pg";

export type AnswerKind = "text" | "number" | "yes_no" | "date";

export interface QuestionDraft {
  /** A STABLE SLUG, carried forward verbatim across versions. Never regenerated: it is
   *  what makes "every answer to this question, across every version" a query. */
  key: string;
  /** The wording used in THIS version. */
  prompt: string;
  /** A RENDERING HINT, NEVER A VALIDATOR (T10). */
  kind: AnswerKind;
}

export interface Question {
  id: string;
  ordinal: number;
  questionKey: string;
  promptText: string;
  answerKind: AnswerKind;
}

export interface QuestionSet {
  id: string;
  version: number;
  retiredAt: Date | null;
  questions: Question[];
}

async function loadSet(db: pg.Pool, setId: string): Promise<QuestionSet | null> {
  const s = await db.query<{ id: string; version: number; retired_at: Date | null }>(
    `select id, version, retired_at from crm.question_sets where id = $1`,
    [setId],
  );
  if (s.rowCount !== 1) return null;
  const q = await db.query<{
    id: string;
    ordinal: number;
    question_key: string;
    prompt_text: string;
    answer_kind: AnswerKind;
  }>(
    `select id, ordinal, question_key, prompt_text, answer_kind
       from crm.questions where set_id = $1 order by ordinal`,
    [setId],
  );
  return {
    id: s.rows[0].id,
    version: s.rows[0].version,
    retiredAt: s.rows[0].retired_at,
    questions: q.rows.map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      questionKey: r.question_key,
      promptText: r.prompt_text,
      answerKind: r.answer_kind,
    })),
  };
}

/** The live set for a tenant: the one that has not been retired. */
export async function currentQuestionSet(
  db: pg.Pool,
  tenantId: string,
): Promise<QuestionSet | null> {
  const s = await db.query<{ id: string }>(
    `select id from crm.question_sets
      where tenant_id = $1 and retired_at is null
      order by version desc limit 1`,
    [tenantId],
  );
  if (s.rowCount !== 1) return null;
  return loadSet(db, s.rows[0].id);
}

/**
 * The set a NEW proposal binds. Retirement gates HERE and only here.
 *
 * Returns null when she has retired everything and written nothing — the proposer must not
 * invent a question list, and a call bound to no version is unreproducible.
 */
export async function selectQuestionSetForProposal(
  db: pg.Pool,
  tenantId: string,
): Promise<QuestionSet | null> {
  return currentQuestionSet(db, tenantId);
}

/**
 * The set an APPROVED proposal executes, resolved BY ID FROM THE PAYLOAD.
 *
 * 🚨 IT DOES NOT CHECK `retired_at`, DELIBERATELY. See the file header: a retirement check
 * here strands her entire approved queue the moment she edits a question. She approved
 * these exact words; asking them is correct.
 */
export async function resolveQuestionSetForExecution(
  db: pg.Pool,
  questionSetId: string,
): Promise<QuestionSet | null> {
  return loadSet(db, questionSetId);
}

export interface EditResult {
  setId: string;
  version: number;
  retiredSetId: string | null;
}

/**
 * Publish a new version of her question list and retire the previous one.
 *
 * Runs as the MIGRATION OWNER — this is the operator editor CLI (016 §I-3). Under
 * `switchboard_crm` both statements are `42501`, which is pinned: there is no DELETE grant
 * anywhere either, so "retire" cannot degrade into "delete" by accident.
 */
export async function publishQuestionSet(
  db: pg.Pool,
  tenantId: string,
  drafts: QuestionDraft[],
): Promise<EditResult> {
  if (drafts.length === 0) {
    throw new Error("a question set with no questions is not a question set");
  }
  const keys = new Set(drafts.map((d) => d.key));
  if (keys.size !== drafts.length) {
    throw new Error("question keys must be unique within a set — they are the cross-version join");
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    const prev = await client.query<{ id: string; version: number }>(
      `select id, version from crm.question_sets
        where tenant_id = $1 order by version desc limit 1
        for update`,
      [tenantId],
    );
    const nextVersion = (prev.rows[0]?.version ?? 0) + 1;
    const s = await client.query<{ id: string }>(
      `insert into crm.question_sets (tenant_id, version) values ($1, $2) returning id`,
      [tenantId, nextVersion],
    );
    const setId = s.rows[0].id;
    for (const [i, d] of drafts.entries()) {
      await client.query(
        `insert into crm.questions (set_id, ordinal, question_key, prompt_text, answer_kind)
         values ($1, $2, $3, $4, $5)`,
        // 🚨 `d.key` verbatim. Regenerating keys on edit would break the cross-version
        // query the key exists for, and nothing downstream would notice.
        [setId, i, d.key, d.prompt, d.kind],
      );
    }
    // RETIRE, never delete or rewrite. The old rows stay readable forever: they are what an
    // answer recorded against them means.
    let retiredSetId: string | null = null;
    if (prev.rowCount === 1) {
      await client.query(
        `update crm.question_sets set retired_at = now()
          where tenant_id = $1 and id <> $2 and retired_at is null`,
        [tenantId, setId],
      );
      retiredSetId = prev.rows[0].id;
    }
    await client.query("commit");
    return { setId, version: nextVersion, retiredSetId };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
