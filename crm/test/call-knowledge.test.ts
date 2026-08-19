// Knowledge-on-the-call-path pins (K1–K8) — the broker's saved knowledge reaching a live
// call's agent, proven end to end against a SCRIPTED fake caller, with no telephony vendor.
//
// The seam under test is `ExecutorDeps.lookupKnowledge` -> `CallContext.lookupKnowledge`:
// optional exactly like `recheckLiveDetails` (absent ⇒ the agent has no knowledge base and
// the call proceeds unchanged), tenant-scoped IN THE QUERY, capped PER CALL by the
// executor, and fail-closed at every layer below it.
//
// Everything runs through the pools whose roles production uses: entries authored via
// `switchboard_approval`, retrieval via `switchboard_crm`, proposals reached through the
// real A2 spine (crmdb.ts's own header on forged-state fixtures).
import { createHash } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import pg from "pg";
import {
  freshCrmDb,
  seedContact,
  seedNumber,
  seedQuestionSet,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { placeCallPayloadSchema } from "../../approval/src/proposal.js";
import {
  executeCall,
  KNOWLEDGE_LOOKUP_CAP,
  type ApprovalSpine,
  type ExecutorDeps,
  type KnowledgePassage,
  type LookupKnowledge,
} from "../src/executor.js";
import { scriptedPlaceCall, type CallScript } from "../src/call-transport.js";
import { knowledgeLookup } from "../src/kb/lookup.js";
import { runKbEmbedPass } from "../src/kb/embed-pass.js";
import { createEmbedder } from "../src/kb/embedder.js";
import { EMBED_DIM } from "../src/kb/dimensions.js";
import { AnswerRefused } from "../src/answers.js";

// The REAL A2 functions and the REAL grammar, wired in at the seam (executor.test.ts's
// precedent: test code is the established exception to the cross-workspace import ban).
const SPINE: ApprovalSpine = {
  beginExecution,
  finishExecution,
  parsePayload: (input) => {
    const r = placeCallPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
};

const TENANT_B = "00000000-0000-0000-0000-0000000000b2";
const WINDOW = { windowStart: "00:00:00", windowEnd: "23:59:00", timezone: "Asia/Manila" };
const INTERVALS = { defaultIntervalDays: 30, shortRetryDays: 3 };

let admin: pg.Pool;
let crm: pg.Pool;
let approval: pg.Pool;
let cleanup: () => Promise<void>;
let setId: string;
let questionIds: string[];

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  const u = new URL(db.url);
  u.username = "switchboard_approval";
  u.password = "switchboard_approval";
  approval = new pg.Pool({ connectionString: u.toString(), max: 4 });
  approval.on("error", () => {});
  cleanup = async () => {
    await approval.end().catch(() => {});
    await db.cleanup();
  };
  await seedSettings(admin, INTERVALS);
  const qs = await seedQuestionSet(admin);
  setId = qs.setId;
  questionIds = qs.questionIds;
}, 120_000);

afterEach(async () => {
  await admin.query("delete from kb.general_chunks");
  await admin.query("delete from kb.general_entries");
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.phone_numbers");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
  await admin.query("delete from approval.users");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** A `place_call` proposal in `approved`, reached the way the system reaches it
 *  (executor.test.ts's seeding, verbatim in spirit). */
async function seedApprovedCall(opts: {
  contactId: string;
  phoneNumberId: string;
}): Promise<string> {
  const payload = {
    contact_id: opts.contactId,
    phone_number_id: opts.phoneNumberId,
    phone_e164: "+639171234567",
    display_name: "Ana Reyes",
    opening_line: "Hi, may I speak with Ana Reyes?",
    question_set_id: setId,
    context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
  };
  const ins = await admin.query<{ id: string }>(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, 'place_call', $3::jsonb, 'due today', $4, now() + interval '72 hours')
     returning id`,
    [
      TEST_TENANT,
      `call-${Math.random().toString(36).slice(2)}`,
      JSON.stringify(payload),
      payloadHash(payload),
    ],
  );
  const id = ins.rows[0].id;
  const approver = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ($1) returning id`,
    [`broker-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const c = await admin.connect();
  try {
    await c.query("begin");
    await c.query(
      `insert into approval.decisions (proposal_id, kind, approver_user_id, renderer_version)
       values ($1, 'approved', $2, 'seed')`,
      [id, approver.rows[0].id],
    );
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [id]);
    await c.query("commit");
  } finally {
    c.release();
  }
  return id;
}

/** An intake-ready contact + its approved call, in one move. */
async function seedCallReadyContact(): Promise<{ contactId: string; proposalId: string }> {
  const contactId = await seedContact(admin);
  const phoneNumberId = await seedNumber(admin, contactId, "+639171234567");
  const proposalId = await seedApprovedCall({ contactId, phoneNumberId });
  return { contactId, proposalId };
}

async function seedAuthor(): Promise<string> {
  const r = await admin.query<{ id: string }>(
    `insert into approval.users (email) values ('marisol@example.com') returning id`,
  );
  return r.rows[0].id;
}

/** Authored the way production authors: through the dashboard's role. */
async function seedEntry(
  authorId: string,
  body: string,
  o: { tenant?: string; title?: string } = {},
): Promise<string> {
  const r = await approval.query<{ id: string }>(
    `insert into kb.general_entries (tenant_id, kind, title, body, status, created_by)
     values ($1, 'listing', $2, $3, 'active', $4) returning id`,
    [o.tenant ?? TEST_TENANT, o.title ?? "BGC 2BR", body, authorId],
  );
  return r.rows[0].id;
}

const sha256 = (t: string): string => createHash("sha256").update(t).digest("hex");

/** A chunk written the way the embed pass writes it: through `switchboard_crm`. */
async function seedChunk(
  entryId: string,
  ordinal: number,
  text: string,
  embedding: number[] | null,
): Promise<string> {
  const r = await crm.query<{ id: string }>(
    `insert into kb.general_chunks (entry_id, ordinal, text, embedding, embedded_at, content_hash)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      entryId,
      ordinal,
      text,
      embedding === null ? null : `[${embedding.join(",")}]`,
      embedding === null ? null : new Date().toISOString(),
      sha256(text),
    ],
  );
  return r.rows[0].id;
}

/** A unit vector along one axis — exact distances, no fuzz (kb-store.test.ts's idiom). */
function axis(i: number): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  v[i] = 1;
  return v;
}

/** A FAKE query embedder for the plumbing pins: any question mentioning BGC lands on
 *  axis 0, everything else far away. K2 proves real semantics with the real model. */
const fakeQueryEmbedder = {
  embedQuery: async (text: string): Promise<number[]> =>
    /bgc/i.test(text) ? axis(0) : axis(500),
};

const BGC_LISTING =
  "2-bedroom condo for sale in BGC, Taguig — 58sqm at One Serendra vicinity, ₱9.8M, " +
  "ready for occupancy.";

const HUMAN_ANSWERED: Pick<CallScript, "transport" | "conversation"> = {
  transport: { sipStatus: 200, amdResult: "human" },
  conversation: "identity_confirmed_complete",
};

function deps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    approvalDb: approval,
    crmDb: crm,
    spine: SPINE,
    window: WINDOW,
    intervals: INTERVALS,
    placeCall: async () => ({ transport: { sipStatus: 480 }, conversation: null }),
    ...overrides,
  };
}

/** The recorded intake, as `(question_id, value)` pairs in commit order. */
async function recordedAnswers(): Promise<Array<[string, string]>> {
  const r = await admin.query<{ question_id: string; value: string }>(
    `select question_id, value from crm.answers order by at, id`,
  );
  return r.rows.map((x) => [x.question_id, x.value]);
}

const stateOf = async (id: string): Promise<string> =>
  (
    await admin.query<{ state: string }>(
      `select state from approval.proposals where id = $1`,
      [id],
    )
  ).rows[0].state;

// ═══ K1 — END TO END, FAKE EMBEDDER: the knowledge reaches the adapter mid-intake ════════
describe("K1: a scripted caller's question retrieves her knowledge mid-call", () => {
  // mutation: RUN ✅ 2026-08-19 — in `executeCall`, drop the threading (never build
  //   `ctx.lookupKnowledge` from the dep) -> red: the adapter records "no-knowledge-base"
  //   where a passage was expected. (Exact observed output recorded in the task report.)
  it("the retrieved passage (text + updated_at) reaches the adapter, and the intake is undamaged", async () => {
    const { proposalId } = await seedCallReadyContact();

    const author = await seedAuthor();
    const bgcEntry = await seedEntry(author, BGC_LISTING, { title: "BGC 2BR" });
    await seedChunk(bgcEntry, 0, BGC_LISTING, axis(0));
    const decoy = await seedEntry(author, "Office hours: Mon–Fri 9am–5pm, Makati office.", {
      title: "Office hours",
    });
    await seedChunk(decoy, 0, "Office hours: Mon–Fri 9am–5pm, Makati office.", axis(1));
    const entryUpdatedAt = (
      await admin.query<{ updated_at: Date }>(
        `select updated_at from kb.general_entries where id = $1`,
        [bgcEntry],
      )
    ).rows[0].updated_at;

    const scripted = scriptedPlaceCall({
      turns: [
        {
          asks: ["what's available in BGC under 10 million?"],
          answer: "budget is around 9 million",
        },
        { answer: "hoping to move by December" },
      ],
      ...HUMAN_ANSWERED,
    });

    const r = await executeCall(
      deps({
        placeCall: scripted.placeCall,
        lookupKnowledge: knowledgeLookup(crm, fakeQueryEmbedder, TEST_TENANT),
      }),
      proposalId,
    );

    // The passage reached the adapter, carrying enough to be honest: the text she wrote,
    // whose entry it is, and WHEN she last touched it.
    expect(scripted.log.lookups).toHaveLength(1);
    const rec = scripted.log.lookups[0];
    expect(rec.question).toBe("what's available in BGC under 10 million?");
    if (rec.outcome === "no-knowledge-base" || !rec.outcome.ok) {
      throw new Error(`expected a successful lookup, got ${JSON.stringify(rec.outcome)}`);
    }
    const passages: KnowledgePassage[] = rec.outcome.passages;
    expect(passages.length).toBeGreaterThan(0);
    expect(passages[0].text).toBe(BGC_LISTING);
    expect(passages[0].title).toBe("BGC 2BR");
    expect(passages[0].kind).toBe("listing");
    expect(passages[0].entryId).toBe(bgcEntry);
    expect(passages[0].updatedAt).toBeInstanceOf(Date);
    expect(passages[0].updatedAt.getTime()).toBe(entryUpdatedAt.getTime());
    expect(passages[0].distance).toBeLessThan(0.5);

    // The detour did not damage the intake: right ids, right order, call completed.
    expect(r.disposition).toBe("answered");
    expect(await stateOf(proposalId)).toBe("executed");
    expect(await recordedAnswers()).toEqual([
      [questionIds[0], "budget is around 9 million"],
      [questionIds[1], "hoping to move by December"],
    ]);
  });
});

// ═══ K6 — THE PER-CALL CAP: an honest handoff, not an unbounded Q&A session ═════════════
describe("K6: a caller who asks 5 times gets at most the cap, and the adapter can tell", () => {
  // TDD red: RUN ✅ 2026-08-19 — written before the cap existed. (Observed output in the
  // task report.) mutation: RUN ✅ 2026-08-19 — remove the `lookupsUsed >= CAP` refusal
  // from `executeCall`'s wrapper -> red again, identically.
  it("lookups beyond the cap never reach the store, and come back reason:'capped'", async () => {
    const { proposalId } = await seedCallReadyContact();
    const author = await seedAuthor();
    const entry = await seedEntry(author, BGC_LISTING);
    await seedChunk(entry, 0, BGC_LISTING, axis(0));

    const base = knowledgeLookup(crm, fakeQueryEmbedder, TEST_TENANT);
    let depCalls = 0;
    const counted: LookupKnowledge = async (q) => {
      depCalls += 1;
      return base(q);
    };

    const scripted = scriptedPlaceCall({
      turns: [
        {
          asks: [
            "what's in BGC under 10M?",
            "anything in BGC with parking?",
            "how about BGC pre-selling?",
            "BGC near a school?",
          ],
          answer: "budget is around 9 million",
        },
        { asks: ["one more — BGC penthouse?"], answer: "hoping to move by December" },
      ],
      ...HUMAN_ANSWERED,
    });

    const r = await executeCall(
      deps({ placeCall: scripted.placeCall, lookupKnowledge: counted }),
      proposalId,
    );

    // The dep — and therefore the store — was reached at most CAP times.
    expect(depCalls).toBe(KNOWLEDGE_LOOKUP_CAP);
    expect(scripted.log.lookups).toHaveLength(5);

    // The first CAP asks succeeded, counting down honestly.
    const outcomes = scripted.log.lookups.map((l) => l.outcome);
    for (const [i, o] of outcomes.slice(0, KNOWLEDGE_LOOKUP_CAP).entries()) {
      if (o === "no-knowledge-base" || !o.ok) throw new Error(`ask ${i} should have succeeded`);
      expect(o.remaining).toBe(KNOWLEDGE_LOOKUP_CAP - (i + 1));
    }
    // Asks 4 and 5: the adapter is TOLD it hit the cap — the honest-handoff signal.
    for (const o of outcomes.slice(KNOWLEDGE_LOOKUP_CAP)) {
      expect(o).toEqual({ ok: false, reason: "capped", remaining: 0 });
    }

    // The intake itself was never hostage to the Q&A: it completed normally.
    expect(r.disposition).toBe("answered");
    expect(await recordedAnswers()).toEqual([
      [questionIds[0], "budget is around 9 million"],
      [questionIds[1], "hoping to move by December"],
    ]);
  });
});

// ═══ K7 — A LOOKUP THAT THROWS DEGRADES THE ANSWER, NEVER THE CALL ══════════════════════
describe("K7: a knowledge lookup that throws does not kill the call", () => {
  // SEMANTICS (decided here): the executor's wrapper catches, hands the adapter
  // `{ok:false, reason:"failed"}` — a live human is on the line, and "I can't check that
  // right now" beats a dropped call plus a proposal wedged `executing` — and makes the
  // failure VISIBLE twice: to the adapter in the outcome, to the operator via
  // console.error naming the touch. The attempt still counts against the cap: the cap
  // bounds work ATTEMPTED, and a broken store must not be hammered mid-call.
  //
  // TDD red: RUN ✅ 2026-08-19 — written before the catch existed; the whole call died on
  // the lookup's error and the proposal wedged. (Observed output in the task report.)
  // mutation: RUN ✅ 2026-08-19 — delete the try/catch from the wrapper -> red again.
  it("the intake continues, the adapter sees reason:'failed', the operator sees the error", async () => {
    const { proposalId } = await seedCallReadyContact();
    const broken: LookupKnowledge = async () => {
      throw new Error("pgvector exploded");
    };
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const scripted = scriptedPlaceCall({
        turns: [
          { asks: ["what's available in BGC?"], answer: "budget is around 9 million" },
          { answer: "hoping to move by December" },
        ],
        ...HUMAN_ANSWERED,
      });

      const r = await executeCall(
        deps({ placeCall: scripted.placeCall, lookupKnowledge: broken }),
        proposalId,
      );

      // The call survived its knowledge base: completed, terminal, intake intact.
      expect(r.disposition).toBe("answered");
      expect(await stateOf(proposalId)).toBe("executed");
      expect(await recordedAnswers()).toEqual([
        [questionIds[0], "budget is around 9 million"],
        [questionIds[1], "hoping to move by December"],
      ]);

      // Visible to the adapter…
      expect(scripted.log.lookups).toEqual([
        {
          question: "what's available in BGC?",
          outcome: { ok: false, reason: "failed", remaining: KNOWLEDGE_LOOKUP_CAP - 1 },
        },
      ]);
      // …and to the operator, naming the cause.
      expect(errors.join("\n")).toMatch(/knowledge lookup failed/);
      expect(errors.join("\n")).toMatch(/pgvector exploded/);
    } finally {
      spy.mockRestore();
    }
  });
});

// ═══ K4 — TENANT SCOPING IS IN THE QUERY, AND A CALL SITE CANNOT FORGE IT ═══════════════
describe("K4: another tenant's knowledge is never returned", () => {
  // Born green, deliberately: the scoping pre-exists in `searchGeneralChunks`' WHERE
  // clause and the seam's signature carries no tenant field — this pin exists so a future
  // refactor cannot lose either. mutation: RUN ✅ 2026-08-19 — replaced
  // `where e.tenant_id = $1` with `where true` (keeping $1 bound) in store.ts -> red.
  it("a forged tenant id at the call site cannot cross the boundary", async () => {
    const { proposalId } = await seedCallReadyContact();
    // The ONLY matching knowledge in the store belongs to tenant B.
    const author = await seedAuthor();
    const foreign = await seedEntry(author, BGC_LISTING, { tenant: TENANT_B });
    await seedChunk(foreign, 0, BGC_LISTING, axis(0));

    const lookup = knowledgeLookup(crm, fakeQueryEmbedder, TEST_TENANT);

    // Forgery at the DEP level: an excess `tenantId` property smuggled past the type.
    const forged = { text: "what's in BGC?", tenantId: TENANT_B } as unknown as {
      text: string;
      topK?: number;
    };
    expect(await lookup(forged)).toEqual([]);

    // Forgery at the ADAPTER level, mid-call, same smuggle.
    let midCall: unknown = null;
    await executeCall(
      deps({
        lookupKnowledge: lookup,
        placeCall: async (ctx) => {
          midCall = await ctx.lookupKnowledge!(forged);
          return { transport: { sipStatus: 200, amdResult: "human" }, conversation: null };
        },
      }),
      proposalId,
    );
    expect(midCall).toEqual({ ok: true, passages: [], remaining: KNOWLEDGE_LOOKUP_CAP - 1 });
  });
});

// ═══ K5 — FAIL-CLOSED AT THIS LAYER TOO ═════════════════════════════════════════════════
describe("K5: a chunk with no embedding is never a passage", () => {
  // Born green, deliberately: inherits store.ts's `embedding is not null` filter
  // (kb-store.test.ts P8) — re-pinned HERE so a refactor of the seam away from
  // `searchGeneralChunks` cannot lose it. mutation: RUN ✅ 2026-08-19 — deleted
  // `and c.embedding is not null` from store.ts -> red.
  it("half-embedded knowledge never pads a mid-call answer", async () => {
    const { proposalId } = await seedCallReadyContact();
    const author = await seedAuthor();
    const entry = await seedEntry(author, BGC_LISTING);
    await seedChunk(entry, 0, BGC_LISTING, axis(0));
    await seedChunk(entry, 1, "BGC penthouse details — NOT YET EMBEDDED", null);

    const scripted = scriptedPlaceCall({
      turns: [
        { asks: ["what's available in BGC?"], answer: "budget is around 9 million" },
        { answer: "hoping to move by December" },
      ],
      ...HUMAN_ANSWERED,
    });
    await executeCall(
      deps({
        placeCall: scripted.placeCall,
        lookupKnowledge: knowledgeLookup(crm, fakeQueryEmbedder, TEST_TENANT),
      }),
      proposalId,
    );

    const outcome = scripted.log.lookups[0].outcome;
    if (outcome === "no-knowledge-base" || !outcome.ok) throw new Error("lookup should succeed");
    // The default topK (3) had room for the NULL row; it must still not appear.
    expect(outcome.passages.map((p) => p.text)).toEqual([BGC_LISTING]);
  });
});

// ═══ K8 — THE DETOUR DOES NOT CORRUPT THE INTAKE'S BINDING ══════════════════════════════
describe("K8: answers stay bound to the approved question set on a call that did a lookup", () => {
  // Born green, deliberately: `recordAnswer`'s bound-set refusal pre-exists (T10) — this
  // pin proves the knowledge detour did not corrupt the mapping. mutation: RUN ✅
  // 2026-08-19 — `executeCall`'s answer callback passes `[questionId]` as the bound list
  // (the check becomes a tautology) -> red.
  it("a foreign question id is refused mid-call even right after a lookup, and nothing is stored for it", async () => {
    const { proposalId } = await seedCallReadyContact();
    const author = await seedAuthor();
    const entry = await seedEntry(author, BGC_LISTING);
    await seedChunk(entry, 0, BGC_LISTING, axis(0));
    // A question that EXISTS but was never approved for this call: version 2 of her set.
    const v2 = await seedQuestionSet(admin, [["parking", "Do you need parking?"]], 2);
    const foreignId = v2.questionIds[0];

    let refused: unknown = null;
    const r = await executeCall(
      deps({
        lookupKnowledge: knowledgeLookup(crm, fakeQueryEmbedder, TEST_TENANT),
        placeCall: async (ctx) => {
          const out = await ctx.lookupKnowledge!({ text: "what's in BGC under 10M?" });
          if (!("ok" in out) || !out.ok) throw new Error("lookup should succeed");
          // The detour happened — now try to bind an answer to a question this call was
          // never approved to ask.
          try {
            await ctx.answer(foreignId, "smuggled past the approved set");
          } catch (err) {
            refused = err;
          }
          await ctx.answer(ctx.prompts[0].id, "budget is around 9 million");
          await ctx.reached(1);
          return {
            transport: { sipStatus: 200, amdResult: "human" },
            conversation: "identity_confirmed_cut_off",
          };
        },
      }),
      proposalId,
    );

    expect(refused).toBeInstanceOf(AnswerRefused);
    expect(r.disposition).toBe("partial");
    // Only the approved question's answer exists; the foreign id stored NOTHING.
    expect(await recordedAnswers()).toEqual([[questionIds[0], "budget is around 9 million"]]);
  });
});

// ═══ K2 — END TO END ON THE REAL VENDORED MODEL ═════════════════════════════════════════
describe("K2: the real embedder composes on the call path", () => {
  // Not a plumbing pin — the proof that prefixes (query vs passage), the vector literal,
  // the chunker's real tokenizer, and the store's ranking COMPOSE on the call path: an
  // authored listing, embedded by the real pass, is found BY MEANING from a scripted
  // caller's paraphrased question, mid-intake. mutation: RUN ✅ 2026-08-19 — `knowledgeLookup`
  // returns [] without searching -> red.
  it("a paraphrased question mid-call retrieves the authored listing, ranked first", async () => {
    const real = await createEmbedder();
    const { proposalId } = await seedCallReadyContact();
    const author = await seedAuthor();
    const listing =
      "2-bedroom condo unit for sale in Bonifacio Global City (BGC), Taguig — 54sqm, " +
      "₱9.5M, high floor, near the high street and international schools.";
    await seedEntry(author, listing, { title: "BGC 2BR" });
    await seedEntry(author, "Office hours: Monday to Friday, 9am to 5pm, Makati office.", {
      title: "Office hours",
    });
    const report = await runKbEmbedPass(crm, real);
    expect(report.entriesEmbedded).toBe(2);
    expect(report.failures).toEqual([]);

    const scripted = scriptedPlaceCall({
      turns: [
        {
          asks: ["what's available in BGC under 10 million?"],
          answer: "budget is around 9 million",
        },
        { answer: "hoping to move by December" },
      ],
      ...HUMAN_ANSWERED,
    });

    const r = await executeCall(
      deps({
        placeCall: scripted.placeCall,
        lookupKnowledge: knowledgeLookup(crm, real, TEST_TENANT),
      }),
      proposalId,
    );

    const outcome = scripted.log.lookups[0].outcome;
    if (outcome === "no-knowledge-base" || !outcome.ok) throw new Error("lookup should succeed");
    expect(outcome.passages.length).toBeGreaterThan(0);
    expect(outcome.passages[0].text).toBe(listing);
    if (outcome.passages.length > 1) {
      expect(outcome.passages[0].distance).toBeLessThan(outcome.passages[1].distance);
    }
    expect(outcome.passages[0].updatedAt).toBeInstanceOf(Date);

    // And the intake around the detour is intact, on real vectors.
    expect(r.disposition).toBe("answered");
    expect(await recordedAnswers()).toEqual([
      [questionIds[0], "budget is around 9 million"],
      [questionIds[1], "hoping to move by December"],
    ]);
  }, 240_000);
});

// ═══ K3 — ABSENT SEAM ⇒ TODAY'S BEHAVIOUR, EXACTLY ═══════════════════════════════════════
describe("K3: no lookupKnowledge dep — the call proceeds unchanged", () => {
  // mutation: RUN ✅ 2026-08-19 — in `executeCall`, thread the seam unconditionally
  //   (`lookupKnowledge: async (q) => { …await deps.lookupKnowledge!(q)… }` without the
  //   undefined guard) -> `Tests  1 failed | N passed`, the call dying on a TypeError
  //   instead of completing. (Exact observed output recorded in the task report.)
  it("a scripted caller who asks anyway is told there is no knowledge base, and the intake completes", async () => {
    const { proposalId } = await seedCallReadyContact();
    const scripted = scriptedPlaceCall({
      turns: [
        {
          asks: ["what's available in BGC under 10 million?"],
          answer: "budget is around 9 million",
        },
        { answer: "hoping to move by December" },
      ],
      ...HUMAN_ANSWERED,
    });

    // NO lookupKnowledge in the deps — the agent has no knowledge base.
    const r = await executeCall(deps({ placeCall: scripted.placeCall }), proposalId);

    // The call completed exactly as today: disposition, terminal state, both answers
    // against the right question ids, full ordinal.
    expect(r.disposition).toBe("answered");
    expect(await stateOf(proposalId)).toBe("executed");
    expect(await recordedAnswers()).toEqual([
      [questionIds[0], "budget is around 9 million"],
      [questionIds[1], "hoping to move by December"],
    ]);

    // The adapter saw the ask and recorded the honest truth: no knowledge base exists.
    expect(scripted.log.lookups).toEqual([
      { question: "what's available in BGC under 10 million?", outcome: "no-knowledge-base" },
    ]);
    // The opening line was spoken exactly as bound (contract rule 4).
    expect(scripted.log.openingSpoken).toBe("Hi, may I speak with Ana Reyes?");
  });
});
