// Bounce reconciliation pins — `reconcileBounces`, on a real ephemeral database with the
// REAL A2 spine, the REAL proposer, and the REAL touch lifecycle; only the two vendor
// seams (the SMTP sender and the Postmark bounce feed) are fakes that record every call.
//
// NO NETWORK. Nothing in this file can reach an inbox or api.postmarkapp.com.
//
// 🚨 THE FOUR PROPERTIES UNDER PIN, in order of what they cost when lost:
//   1. the `'sent'` touch is NEVER amended — the bounce is a NEW row (append, never amend);
//   2. the follow-up is NEVER reopened — reopening recreates the permanent invisible
//      silence (`hasOpenFollowUpBefore` + an open `executed` row nothing can ever close);
//   3. the clock comes BACK to the short retry so the contact is proposable again — except
//      when a LATER touch exists, in which case history is appended and the clock is not
//      touched;
//   4. the same bounce polled twice compensates ONCE (per-proposal, stateless idempotency).
//
// 🚨 NO FIXTURE FORGES STATE. Proposals come from the shipped proposer, approval goes
// through the real decision path, the `'sent'` touch is written by the real `executeEmail`,
// and every acceptance-relevant fact is READ BACK from the database.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import { freshCrmDb, seedContact, seedSettings, TEST_TENANT } from "./helpers/crmdb.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { followUpEmailPayloadSchema } from "../../approval/src/proposal.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import { hasOpenFollowUpBefore } from "../src/followups.js";
import { PROPOSAL_METADATA_KEY } from "../src/email-transport.js";
import {
  executeEmail,
  type EmailApprovalSpine,
  type SendEmailFn,
} from "../src/executor.js";
import {
  reconcileBounces,
  formatBounceReport,
  type BounceFeed,
  type BounceRecord,
} from "../src/bounces.js";

const SPINE: EmailApprovalSpine = {
  beginExecution,
  finishExecution,
  parsePayload: (input) => {
    const r = followUpEmailPayloadSchema.safeParse(input);
    return r.success
      ? { ok: true, value: r.data }
      : { ok: false, problem: r.error.issues.map((i) => i.path.join(".")).join("; ") };
  },
};

const INTERVALS = { defaultIntervalDays: 30, shortRetryDays: 3 };
const ALLOW = ["ana@example.com"];

let admin: pg.Pool;
let crm: pg.Pool;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, INTERVALS);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.answers");
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

/** Drive the SHIPPED PROPOSER through a door that inserts the proposal for real, then
 *  approve through the real decision path — the email-executor suite's idiom, verbatim. */
async function proposeAndApprove(contactId: string): Promise<string> {
  let proposalId = "";
  const door = async (p: DoorProposal): Promise<{ id: string }> => {
    const payload = p.payload as Record<string, unknown>;
    const ins = await admin.query<{ id: string }>(
      `insert into approval.proposals
         (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash,
          expires_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, now() + interval '72 hours')
       returning id`,
      [
        TEST_TENANT,
        p.idempotency_key,
        p.action_type,
        JSON.stringify(payload),
        p.rationale,
        payloadHash(payload),
      ],
    );
    proposalId = ins.rows[0].id;
    return { id: proposalId };
  };
  await runCycle({ db: crm, postProposal: door }, TEST_TENANT, 10);
  expect(proposalId, "the shipped proposer must have produced a proposal").not.toBe("");

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
      [proposalId, approver.rows[0].id],
    );
    await c.query(`update approval.proposals set state = 'approved' where id = $1`, [
      proposalId,
    ]);
    await c.query("commit");
  } finally {
    c.release();
  }
  return proposalId;
}

const okSender: SendEmailFn = async (msg) => ({
  messageId: `<${randomUUID()}@relay.example.com>`,
  accepted: [msg.to],
  rejected: [],
  response: "250 2.0.0 OK",
});

const throwingSender: SendEmailFn = async () => {
  throw new Error("relay refused the connection");
};

/** A `BounceFeed` that records every call and never touches the network. `metadata` maps a
 *  Postmark message id to what the details lookup would return for it. */
function fakeFeed(
  bounces: BounceRecord[],
  metadata: Record<string, Record<string, string> | null>,
): BounceFeed & { detailCalls: string[] } {
  const detailCalls: string[] = [];
  return {
    detailCalls,
    listBounces: async () => bounces,
    getMessageMetadata: async (messageId) => {
      detailCalls.push(messageId);
      return metadata[messageId] ?? null;
    },
  };
}

function bounce(o: Partial<BounceRecord> = {}): BounceRecord {
  return {
    id: o.id ?? `b-${randomUUID()}`,
    type: o.type ?? "HardBounce",
    email: o.email ?? "ana@example.com",
    bouncedAt: o.bouncedAt ?? new Date().toISOString(),
    messageId: o.messageId === undefined ? `pm-${randomUUID()}` : o.messageId,
  };
}

const emailContact = () =>
  seedContact(admin, {
    channel: "email",
    email: "ana@example.com",
    displayName: "Ana Reyes",
  });

/** Every touch for a proposal, oldest first, read back through the OWNER pool. */
const touches = async (
  proposalId: string,
): Promise<Array<{ id: string; disposition: string | null; channel: string }>> => {
  const r = await admin.query<{ id: string; disposition: string | null; channel: string }>(
    `select id, disposition, channel from crm.touches
      where proposal_id = $1 order by occurred_at, id`,
    [proposalId],
  );
  return r.rows;
};

const nextDueAt = async (contactId: string): Promise<Date | null> => {
  const r = await admin.query<{ next_due_at: Date | null }>(
    `select next_due_at from crm.contacts where id = $1`,
    [contactId],
  );
  return r.rows[0].next_due_at;
};

const followUpCloseTime = async (proposalId: string): Promise<Date | null> => {
  const r = await admin.query<{ closed_at: Date | null }>(
    `select f.closed_at from crm.follow_ups f
       join crm.follow_up_actions a on a.follow_up_id = f.id
      where a.proposal_id = $1`,
    [proposalId],
  );
  expect(r.rowCount).toBe(1);
  return r.rows[0].closed_at;
};

/** The full sent-then-bounced setup: propose, approve, execute (real `executeEmail`, fake
 *  sender), then a feed carrying ONE bounce whose metadata names the proposal. */
async function sentThenBounced(): Promise<{
  contactId: string;
  proposalId: string;
  feed: ReturnType<typeof fakeFeed>;
  pmMessageId: string;
}> {
  const contactId = await emailContact();
  const proposalId = await proposeAndApprove(contactId);
  await executeEmail(
    { approvalDb: admin, crmDb: crm, sendEmail: okSender, spine: SPINE, allowlist: ALLOW, intervals: INTERVALS },
    proposalId,
  );
  const pmMessageId = `pm-${randomUUID()}`;
  const feed = fakeFeed([bounce({ messageId: pmMessageId })], {
    [pmMessageId]: { [PROPOSAL_METADATA_KEY]: proposalId },
  });
  return { contactId, proposalId, feed, pmMessageId };
}

// ═══════════════════════════════════════════════════════════════════════════════════════
describe("bounce pin 1: a refused message is learned, and the contact becomes proposable", () => {
  // mutation: replace the compensation's `recordTouch` with the append-only path (no
  //           clock write) -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × appends a 'bounced' touch and pulls next_due_at back to the short retry
  //     AssertionError: expected 30 to be 3   (the clock stayed a full interval out)
  it("appends a 'bounced' touch and pulls next_due_at back to the short retry", async () => {
    const { contactId, proposalId, feed } = await sentThenBounced();

    // After the send: full interval out, follow-up closed. The silenced state.
    const before = await nextDueAt(contactId);
    expect(before).not.toBeNull();
    expect(Math.round((before!.getTime() - Date.now()) / 86_400_000)).toBe(30);

    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    expect(report.compensated.length).toBe(1);
    expect(report.compensated[0].proposalId).toBe(proposalId);
    expect(report.anomalies).toEqual([]);

    // The correlation hop was actually taken — bounce → MessageID → details → metadata.
    expect(feed.detailCalls.length).toBe(1);

    const after = await nextDueAt(contactId);
    expect(Math.round((after!.getTime() - Date.now()) / 86_400_000)).toBe(
      INTERVALS.shortRetryDays,
    );

    // Proposable again: no open earlier row silences the next cycle.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await hasOpenFollowUpBefore(crm, contactId, tomorrow)).toBe(false);
  });

  // 🚨 APPEND, NEVER AMEND. The grant physically permits flipping the `'sent'` row; this
  // pin is what makes the discipline enforceable.
  // mutation: compensate by UPDATING the existing `'sent'` touch to `'bounced'` instead of
  //           appending -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  2 failed | 7 passed (9)`
  //     × keeps the 'sent' touch present and unmodified; the bounce is a NEW row
  //     × second poll: no second touch, no clock write, counted as alreadyCompensated
  //     AssertionError (both): expected [ 'bounced' ] to deeply equal [ 'sent', 'bounced' ]
  it("keeps the 'sent' touch present and unmodified; the bounce is a NEW row", async () => {
    const { proposalId, feed } = await sentThenBounced();
    const sentBefore = (await touches(proposalId))[0];
    expect(sentBefore.disposition).toBe("sent");

    await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    const after = await touches(proposalId);
    expect(after.map((t) => t.disposition)).toEqual(["sent", "bounced"]);
    // The original row, by id, still says 'sent' — the submission WAS accepted.
    expect(after[0].id).toBe(sentBefore.id);
    expect(after.every((t) => t.channel === "email")).toBe(true);
  });

  // 🚨 FINDING-4 RESPECTED: the follow-up stays CLOSED. Reopening it would be an open row
  // at an earlier due date that `hasOpenFollowUpBefore` reads for ever and that
  // `closeTerminatedFollowUps` can never close (the proposal is `executed`, terminal) —
  // the permanent invisible silence this whole task exists to remove.
  // mutation: make the reconciler clear `closed_at` on the bounced cycle's follow-up ->
  //           red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × leaves the follow-up CLOSED — compensation never reopens the cycle's row
  //     AssertionError: expected null to deeply equal 2026-08-15T21:43:53.008Z
  //   The mutation ran to completion under `switchboard_crm` — the `update (closed_at)`
  //   grant makes the reopen physically possible, so this pin is the only thing standing
  //   between the reconciler and the permanent-silence class.
  it("leaves the follow-up CLOSED — compensation never reopens the cycle's row", async () => {
    const { contactId, proposalId, feed } = await sentThenBounced();
    const closedBefore = await followUpCloseTime(proposalId);
    expect(closedBefore).not.toBeNull();

    await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    expect(await followUpCloseTime(proposalId)).toEqual(closedBefore);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    expect(await hasOpenFollowUpBefore(crm, contactId, tomorrow)).toBe(false);
  });
});

describe("bounce pin 1b: the metadata key is matched as the VENDOR spells it back", () => {
  // 🚨 MEASURED ON THE LIVE API, 2026-08-15: we send `X-PM-Metadata-proposal-id`; the
  // Messages API returned the key as `Proposal-ID` (Postmark canonicalises header names).
  // An exact-key read of `proposal-id` matches nothing — every one of our bounces would be
  // classified "not ours" and the whole feature would be OFF while reporting itself quiet.
  // mutation: revert `metadataProposalId` to the exact-key lookup
  //           (`metadata?.[PROPOSAL_METADATA_KEY]`) -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 9 passed (10)`
  //     × compensates when the metadata key comes back as 'Proposal-ID'
  //     AssertionError: expected [] to have a length of 1 but got +0
  it("compensates when the metadata key comes back as 'Proposal-ID'", async () => {
    const { proposalId, feed, pmMessageId } = await sentThenBounced();
    void feed;
    // The SAME bounce, but the details lookup answers with the key spelling the live API
    // actually produced.
    const measured = fakeFeed([bounce({ messageId: pmMessageId })], {
      [pmMessageId]: { "Proposal-ID": proposalId },
    });

    const report = await reconcileBounces({ crmDb: crm, feed: measured, intervals: INTERVALS });

    expect(report.compensated).toHaveLength(1);
    expect(report.compensated[0].proposalId).toBe(proposalId);
    expect((await touches(proposalId)).map((t) => t.disposition)).toEqual([
      "sent",
      "bounced",
    ]);
  });
});

describe("bounce pin 2: the same bounce re-polled compensates exactly once", () => {
  // The poll window is stateless (no cursor, by design), so the SAME bounce arrives every
  // tick until it ages out of the window. Idempotency lives in the data: a `'bounced'`
  // touch for the proposal already exists.
  // mutation: remove the already-compensated dedupe check -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × second poll: no second touch, no clock write, counted as alreadyCompensated
  //     AssertionError: expected [ { …(5) } ] to deeply equal []
  //   i.e. the second poll compensated AGAIN — every tick would append another 'bounced'
  //   row and re-write the clock for ever.
  it("second poll: no second touch, no clock write, counted as alreadyCompensated", async () => {
    const { contactId, proposalId, feed } = await sentThenBounced();

    const first = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });
    expect(first.compensated.length).toBe(1);
    const dueAfterFirst = await nextDueAt(contactId);

    const second = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });
    expect(second.compensated).toEqual([]);
    expect(second.alreadyCompensated).toBe(1);

    expect((await touches(proposalId)).map((t) => t.disposition)).toEqual([
      "sent",
      "bounced",
    ]);
    // The clock was not re-written by the second pass (a re-write would move it forward
    // to a NEW now+3d every tick — a contact never actually coming due).
    expect(await nextDueAt(contactId)).toEqual(dueAfterFirst);
  });
});

describe("bounce pin 3: classification — quiet, loud, and silent are three different things", () => {
  // mutation: classify metadata-with-no-touch as quiet no-metadata instead of an anomaly
  //           -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × no metadata → quiet count; metadata with no touch → loud anomaly; both distinct
  //     AssertionError: expected 3 to be 2   (the anomaly drowned in the not-ours count)
  //   i.e. the one case that means "our metadata, no record of it" — a real defect —
  //   would never be seen.
  it("no metadata → quiet count; metadata with no touch → loud anomaly; both distinct", async () => {
    // Not ours: a message with no proposal-id metadata (a UI send, another deployment).
    const uiSend = bounce({ email: "someone@elsewhere.example.com", messageId: "pm-ui-send" });
    // No message id at all — nothing to even look up.
    const noId = bounce({ email: "mystery@elsewhere.example.com", messageId: null });
    // Claims to be ours, but no touch anywhere: a real anomaly.
    const ghostProposal = randomUUID();
    const ghost = bounce({ email: "ghost@elsewhere.example.com", messageId: "pm-ghost" });

    const feed = fakeFeed([uiSend, noId, ghost], {
      "pm-ui-send": {},
      "pm-ghost": { [PROPOSAL_METADATA_KEY]: ghostProposal },
    });

    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    expect(report.noMetadata.count).toBe(2);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0].proposalId).toBe(ghostProposal);
    expect(report.compensated).toEqual([]);
    // Nothing was written for any of them.
    const n = await admin.query<{ n: string }>(`select count(*) as n from crm.touches`);
    expect(Number(n.rows[0].n)).toBe(0);
  });

  it("a synchronously-failed send (never claimed 'sent') is counted, not compensated", async () => {
    const contactId = await emailContact();
    const proposalId = await proposeAndApprove(contactId);
    await expect(
      executeEmail(
        { approvalDb: admin, crmDb: crm, sendEmail: throwingSender, spine: SPINE, allowlist: ALLOW, intervals: INTERVALS },
        proposalId,
      ),
    ).rejects.toThrow(/relay refused/);

    const pm = `pm-${randomUUID()}`;
    const feed = fakeFeed([bounce({ messageId: pm })], {
      [pm]: { [PROPOSAL_METADATA_KEY]: proposalId },
    });
    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    expect(report.notClaimedSent).toBe(1);
    expect(report.anomalies).toEqual([]);
    expect(report.compensated).toEqual([]);
    // The NULL-disposition touch from the failed send is the only row; nothing appended.
    expect((await touches(proposalId)).map((t) => t.disposition)).toEqual([null]);
  });
});

describe("bounce pin 4: the late-bounce guard — history is appended, the clock is not stolen", () => {
  // mutation: remove the later-touch guard (always run the compensating `recordTouch`) ->
  //           red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × with a later touch present: 'bounced' is appended, next_due_at is untouched, …
  //     AssertionError: expected [ { …(5) } ] to deeply equal []
  //   (the compensated list, asserted first, caught it; had the run got further, the
  //   next_due_at assert would show the 30-day clock dragged back to now+3d — a bounce
  //   from a dead cycle clobbering a legitimately re-advanced contact)
  it("with a later touch present: 'bounced' is appended, next_due_at is untouched, and it is surfaced", async () => {
    const { contactId, proposalId, feed } = await sentThenBounced();

    // A LATER, legitimate touch for the same contact (the next cycle happened before the
    // bounce surfaced). Inserted through the CRM role at a strictly later occurred_at —
    // this is the one timeline the fake sender cannot produce for us quickly.
    await crm.query(
      `insert into crm.touches (contact_id, channel, disposition, occurred_at)
       values ($1, 'email', 'sent', now() + interval '1 minute')`,
      [contactId],
    );
    const dueBefore = await nextDueAt(contactId);

    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });

    expect(report.compensated).toEqual([]);
    expect(report.lateAppended).toHaveLength(1);
    expect(report.lateAppended[0].proposalId).toBe(proposalId);

    // History gained the true fact…
    expect((await touches(proposalId)).map((t) => t.disposition)).toEqual([
      "sent",
      "bounced",
    ]);
    // …and the clock still belongs to the later cycle.
    expect(await nextDueAt(contactId)).toEqual(dueBefore);

    // And it is SURFACED — a late bounce is information, not a silent branch.
    const text = formatBounceReport(report);
    expect(text).toMatch(/LATE BOUNCE/);
    expect(text).toMatch(/clock NOT moved/);
  });
});

describe("bounce pin 5: unmatched bounces surface as an aggregate, never a per-bounce flood", () => {
  // mutation: emit one listing line per no-metadata bounce -> red. RUN ✅ 2026-08-15
  //   Observed: `Tests  1 failed | 8 passed (9)`
  //     × ten not-ours bounces produce one aggregate line plus the newest few
  //     AssertionError: expected 11 to be less than or equal to 3
  //   Ten shared-server bounces per tick, one line each, for ever: the anomaly listing
  //   drowns — silence by noise, the failure class the design forbids.
  it("ten not-ours bounces produce one aggregate line plus the newest few", async () => {
    const bounces = Array.from({ length: 10 }, (_, i) =>
      bounce({ email: `other-${i}@elsewhere.example.com`, messageId: `pm-other-${i}` }),
    );
    const metadata = Object.fromEntries(bounces.map((b) => [b.messageId as string, {}]));
    const feed = fakeFeed(bounces, metadata);

    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });
    expect(report.noMetadata.count).toBe(10);

    const text = formatBounceReport(report);
    expect(text).not.toBeNull();
    // The aggregate count is stated…
    expect(text).toMatch(/10 without metadata/);
    // …and the whole report stays a summary plus one aggregate listing line — bounded,
    // whatever the count.
    expect(text!.split("\n").length).toBeLessThanOrEqual(3);
  });

  it("says nothing at all when the window is empty", async () => {
    const feed = fakeFeed([], {});
    const report = await reconcileBounces({ crmDb: crm, feed, intervals: INTERVALS });
    expect(formatBounceReport(report)).toBeNull();
  });
});
