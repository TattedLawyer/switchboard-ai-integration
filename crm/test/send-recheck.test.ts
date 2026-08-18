// Part 2 / Piece C pins — the SEND-TIME recheck: `liveDetailRecheck` behind the optional
// `EmailExecutorDeps.recheckLiveDetails` seam, on a real ephemeral database with the REAL
// A2 spine wired in at the seam and a FAKE sheet transport.
//
// WHAT PIECE C IS. A card approved on Monday can be sent on Tuesday to an address she has
// since corrected in her sheet: the proposer reads live at PROPOSAL time (Piece A), and
// nothing rechecked at SEND time. The recheck runs between step 4 (`checkSendable`) and
// step 6 (`beginExecution`):
//   · "send"  → proceed exactly as today.
//   · "wait"  → refuse BEFORE the claim: ZERO `approval.executions` rows, the proposal
//               stays `approved`, and the next tick retries.
//   · "block" → claim, then IMMEDIATELY fail the execution: the proposal lands in
//               `execution_failed` (terminal, so `closeTerminatedFollowUps` can clean up)
//               and NO touch row is created — `beginTouch` is step 7 and must not run.
//
// 🚨 RULING #2 — RECIPIENT-ONLY. Only the recipient (the email address) may block a send.
// A changed NAME must never block; neither may source_detail, looking_for, or notes.
// P3 pins this and must go red if anyone widens the comparison.
//
// NO NETWORK. The fake `SendEmail` is the only sender; the sheet is a FakeSheet.
// NO FIXTURE FORGES STATE: proposals come from the SHIPPED PROPOSER through a door that
// inserts them for real; approval goes through the real decision path; every fact is READ
// BACK from the database. The recheck runs on the `switchboard_crm` pool, exactly as the
// composition root wires it — so a query that reads a 022-revoked column reds here.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  dayAfter,
  freshCrmDb,
  seedContact,
  seedLinkedSheet,
  seedSettings,
  TEST_TENANT,
} from "./helpers/crmdb.js";
import { FakeSheet } from "./helpers/fakesheet.js";
import { payloadHash } from "../../approval/src/canonical.js";
import { beginExecution, finishExecution } from "../../approval/src/execute.js";
import { followUpEmailPayloadSchema } from "../../approval/src/proposal.js";
import { runCycle, type DoorProposal } from "../src/proposer.js";
import type { SheetTransport } from "../src/sheet-client.js";
import { unlinkSheet } from "../src/sheet-adopt.js";
import { liveDetailRecheck } from "../src/send-recheck.js";
import {
  executeEmail,
  EmailRefused,
  type EmailApprovalSpine,
  type EmailExecutorDeps,
  type SendEmailFn,
} from "../src/executor.js";

// The REAL A2 functions and the REAL grammar, wired in at the seam.
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

/** A `SendEmail` that records every call and never touches a socket. */
function fakeSender(): SendEmailFn & {
  calls: Array<{ to: string; subject: string; body: string }>;
} {
  const calls: Array<{ to: string; subject: string; body: string }> = [];
  const fn = (async (msg) => {
    calls.push(msg);
    return {
      messageId: `<${randomUUID()}@relay.example.com>`,
      accepted: [msg.to],
      rejected: [],
      response: "250 2.0.0 OK",
    };
  }) as SendEmailFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

beforeAll(async () => {
  const db = await freshCrmDb();
  admin = db.admin;
  crm = db.crm;
  cleanup = db.cleanup;
  await seedSettings(admin, INTERVALS);
}, 120_000);

afterEach(async () => {
  await admin.query("delete from crm.touches");
  await admin.query("delete from crm.follow_up_actions");
  await admin.query("delete from crm.follow_ups");
  await admin.query("delete from crm.sheet_reads");
  await admin.query("delete from crm.contacts");
  await admin.query("delete from crm.linked_sheets");
  await admin.query("delete from approval.executions");
  await admin.query("delete from approval.decisions");
  await admin.query("delete from approval.proposals");
});

afterAll(async () => {
  if (cleanup) await cleanup();
});

// ── Fixture: a sheet-bound email contact whose proposal the SHIPPED PROPOSER builds. ────

interface SheetBound {
  contactId: string;
  linkedSheetId: string;
  ref: string;
  sheet: FakeSheet;
}

/** Sheet-bound contact + FakeSheet, seeded the way the owner-run adoption pass leaves
 *  them. Header includes Name so P3 can edit a non-recipient field. */
async function sheetBoundContact(): Promise<SheetBound> {
  const linked = await seedLinkedSheet(admin);
  const ref = randomUUID();
  const sheet = new FakeSheet(linked.spreadsheetId, ["Name", "Email"], [
    { ref, cells: ["Ana Reyes", "ana@example.com"] },
  ]);
  const contactId = await seedContact(admin, {
    channel: "email",
    email: "ana@example.com",
    displayName: "Ana Reyes",
    linkedSheetId: linked.id,
    rowRef: ref,
  });
  return { contactId, linkedSheetId: linked.id, ref, sheet };
}

/** Drive the SHIPPED PROPOSER through a door that inserts the proposal for real, then
 *  approve through the real decision path. Nothing about the payload is invented here. */
async function proposeAndApprove(sheet: FakeSheet | null): Promise<string> {
  let proposalId = "";
  const door = async (p: DoorProposal): Promise<{ id: string }> => {
    proposalId = await insertProposal(p.action_type, p.payload as Record<string, unknown>, {
      idempotencyKey: p.idempotency_key,
      rationale: p.rationale,
    });
    return { id: proposalId };
  };
  await runCycle({ db: crm, postProposal: door, sheet }, TEST_TENANT, 10);
  expect(proposalId, "the shipped proposer must have produced a proposal").not.toBe("");
  await approve(proposalId);
  return proposalId;
}

async function insertProposal(
  actionType: string,
  payload: Record<string, unknown>,
  o: { idempotencyKey?: string; rationale?: string } = {},
): Promise<string> {
  const ins = await admin.query<{ id: string }>(
    `insert into approval.proposals
       (tenant_id, idempotency_key, action_type, payload, rationale, payload_hash, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, now() + interval '72 hours')
     returning id`,
    [
      TEST_TENANT,
      o.idempotencyKey ?? `k-${randomUUID()}`,
      actionType,
      JSON.stringify(payload),
      o.rationale ?? "r",
      payloadHash(payload),
    ],
  );
  return ins.rows[0].id;
}

async function approve(proposalId: string): Promise<void> {
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
}

const executions = async (proposalId: string): Promise<string[]> => {
  const r = await admin.query<{ kind: string }>(
    `select kind from approval.executions where proposal_id = $1 order by at`,
    [proposalId],
  );
  return r.rows.map((x) => x.kind);
};

const state = async (proposalId: string): Promise<string> => {
  const r = await admin.query<{ state: string }>(
    `select state from approval.proposals where id = $1`,
    [proposalId],
  );
  return r.rows[0].state;
};

/** An open sheet-level block, dated the day AFTER the contact's latest follow-up row
 *  (read back — no clock), so `follow_ups_one_per_due` cannot collide with the
 *  proposer's own Manila-dated open row. */
async function seedSheetBlock(
  contactId: string,
  reason: "sheet_divergent" | "sheet_row_missing",
): Promise<void> {
  const existing = await admin.query<{ due_date: string }>(
    `select max(due_date)::text as due_date from crm.follow_ups where contact_id = $1`,
    [contactId],
  );
  await admin.query(
    `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
     values ($1, $2::date, $3)`,
    [contactId, dayAfter(existing.rows[0].due_date), reason],
  );
}

const touches = async (proposalId: string): Promise<number> => {
  const r = await admin.query(`select 1 from crm.touches where proposal_id = $1`, [
    proposalId,
  ]);
  return r.rowCount ?? 0;
};

/** Executor deps EXACTLY as the composition root wires them: the recheck built from the
 *  `switchboard_crm` pool and the (fake) sheet transport. */
const deps = (
  sendEmail: SendEmailFn,
  transport: SheetTransport | null,
): EmailExecutorDeps => ({
  approvalDb: admin,
  crmDb: crm,
  sendEmail,
  spine: SPINE,
  allowlist: ALLOW,
  intervals: INTERVALS,
  recheckLiveDetails: liveDetailRecheck(crm, transport),
});

// ═══════════════════════════════════════════════════════════════════════════════════════
describe("Piece C P1: a recipient she corrected after approval blocks the send", () => {
  it("ends execution_failed with zero touch rows and no mail", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // Monday's approval, Tuesday's correction: she fixes the address in her sheet.
    b.sheet.rows[1].cells[1] = "ben@example.com";

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );

    expect(fake.calls.length).toBe(0); // no mail left the building
    expect(await state(proposalId)).toBe("execution_failed"); // terminal, reconcilable
    expect(await executions(proposalId)).toEqual(["started", "failed"]);
    expect(await touches(proposalId)).toBe(0); // beginTouch (step 7) never ran
  });

  it("a recipient that VANISHED from the sheet is a changed recipient — block", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    b.sheet.rows[1].cells[1] = ""; // she cleared the email cell; the name remains

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await state(proposalId)).toBe("execution_failed");
    expect(await touches(proposalId)).toBe(0);
  });
});

describe("Piece C P2: an unchanged recipient sends exactly as today", () => {
  it("sends, executes, and records the honest touch", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    const fake = fakeSender();
    const out = await executeEmail(deps(fake, b.sheet), proposalId);

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].to).toBe("ana@example.com");
    expect(await state(proposalId)).toBe("executed");
    expect(await executions(proposalId)).toEqual(["started", "succeeded"]);
    expect(out.disposition).toBe("sent");
  });

  it("normalisation is the adoption pass's own: case/whitespace drift is NOT a change", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // She re-typed the same address with a shouty domain and a stray space.
    b.sheet.rows[1].cells[1] = "  Ana@EXAMPLE.com ";

    const fake = fakeSender();
    await executeEmail(deps(fake, b.sheet), proposalId);
    expect(fake.calls.length).toBe(1);
    expect(await state(proposalId)).toBe("executed");
  });
});

describe("Piece C P3 — RULING #2: a changed NAME never blocks a send", () => {
  it("sends although the name cell changed after approval (recipient identical)", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    b.sheet.rows[1].cells[0] = "Ana Reyes-Villanueva"; // married name; same inbox

    const fake = fakeSender();
    await executeEmail(deps(fake, b.sheet), proposalId);

    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].to).toBe("ana@example.com");
    expect(await state(proposalId)).toBe("executed");
  });
});

describe("Piece C P4 — AMENDMENT A2: a halted breaker means WAIT, not send", () => {
  it("latest sheet_reads ok=false → no mail, zero executions, proposal still approved", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // The owner-run adoption pass records a breaker halt AFTER approval (owner write,
    // exactly the producer 021 names for this ledger).
    await admin.query(
      `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok, detail)
       values ($1, $2, false, 'breaker_displacement: 2 displaced values on email')`,
      [TEST_TENANT, b.linkedSheetId],
    );

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]); // nothing claimed
    expect(await state(proposalId)).toBe("approved"); // the next tick retries
    expect(await touches(proposalId)).toBe(0);
  });
});

describe("Piece C P5: an open sheet-level block on the contact means WAIT", () => {
  it("open sheet_divergent block → no mail, zero executions, proposal still approved", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // The pass paused this contact after approval (owner write — the divergence-pause
    // shape from sheet-adopt.ts). The date is derived from the proposer's own row's
    // READ-BACK due_date, never from a clock: `current_date + 1` collided with the open
    // Manila-dated row whenever Manila sits a day ahead of the DB's date (16:00–24:00
    // UTC) — the date-boundary family date-idiom.pin.test.ts documents.
    await seedSheetBlock(b.contactId, "sheet_divergent");

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
    expect(await state(proposalId)).toBe("approved");
    expect(await touches(proposalId)).toBe(0);
  });

  it("open sheet_row_missing block → same wait", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);
    await seedSheetBlock(b.contactId, "sheet_row_missing");
    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
    expect(await state(proposalId)).toBe("approved");
  });
});

describe("Piece C P6: a manual contact's send never consults the sheet", () => {
  it("sends, and the transport is NEVER called", async () => {
    // Manual contact: her sheet has no say. The shipped proposer blocks manual email legs
    // post-022 (proposer-sheet P10), so the approved proposal is inserted directly — the
    // wrong-action_type pin's established precedent for states the proposer cannot mint.
    const manual = await seedContact(admin, {
      channel: "email",
      email: "ana@example.com",
      displayName: "Ana Reyes",
    });
    const proposalId = await insertProposal("send_email", {
      contact_id: manual,
      to: "ana@example.com",
      subject: "Following up",
      body: "Hi Ana — still looking?",
    });
    await approve(proposalId);

    let readCalls = 0;
    const spyTransport: SheetTransport = {
      serviceAccountEmail: "spy@robot.example.com",
      readSnapshot: async () => {
        readCalls += 1;
        throw new Error("the recheck consulted the sheet for a MANUAL contact");
      },
      writeRowRefs: async () => {
        throw new Error("the recheck wrote to the sheet");
      },
    };

    const fake = fakeSender();
    await executeEmail(deps(fake, spyTransport), proposalId);

    expect(readCalls).toBe(0); // the spy, asserted directly
    expect(fake.calls.length).toBe(1);
    expect(await state(proposalId)).toBe("executed");
  });
});

describe("Piece C P7: an absent seam is unconditional send — behaviour identical to today", () => {
  it("sends even though the sheet email changed, when recheckLiveDetails is undefined", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    b.sheet.rows[1].cells[1] = "ben@example.com"; // the recheck WOULD block…

    const fake = fakeSender();
    const noSeam: EmailExecutorDeps = {
      approvalDb: admin,
      crmDb: crm,
      sendEmail: fake,
      spine: SPINE,
      allowlist: ALLOW,
      intervals: INTERVALS,
      // no recheckLiveDetails: every existing caller compiles and behaves unchanged
    };
    await executeEmail(noSeam, proposalId); // …but nothing rechecks: today's behaviour

    expect(fake.calls.length).toBe(1);
    expect(await state(proposalId)).toBe("executed");
  });
});

describe("Piece C P8 — the load-bearing spine properties", () => {
  it("a 'block' leaves ZERO crm.touches rows for that proposal", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);
    b.sheet.rows[1].cells[1] = "ben@example.com";

    await expect(
      executeEmail(deps(fakeSender(), b.sheet), proposalId),
    ).rejects.toThrow(EmailRefused);

    expect(await touches(proposalId)).toBe(0);
    // and the claim WAS burned, honestly: started → failed, terminal.
    expect(await executions(proposalId)).toEqual(["started", "failed"]);
  });

  it("a 'wait' leaves ZERO approval.executions rows and the proposal approved", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);
    b.sheet.failWith = new Error("ECONNRESET: sheets api unreachable"); // outage → wait

    await expect(
      executeEmail(deps(fakeSender(), b.sheet), proposalId),
    ).rejects.toThrow(EmailRefused);

    expect(await executions(proposalId)).toEqual([]);
    expect(await state(proposalId)).toBe("approved");
  });
});

describe("Piece C verdicts at the unit seam (liveDetailRecheck directly)", () => {
  const payloadFor = (contactId: string) =>
    ({
      contact_id: contactId,
      to: "ana@example.com",
      subject: "Following up",
      body: "Hi Ana",
    }) as const;

  it("a contact that no longer exists is a block, in plain English", async () => {
    const verdict = await liveDetailRecheck(crm, null)(payloadFor(randomUUID()));
    expect(verdict.verdict).toBe("block");
    if (verdict.verdict === "block") {
      expect(verdict.reason).toMatch(/contact/i);
    }
  });

  it("a missing transport is an outage → wait, never a licence to send", async () => {
    const b = await sheetBoundContact();
    const verdict = await liveDetailRecheck(crm, null)(payloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
  });

  it("a transport failure is classified and waits", async () => {
    const b = await sheetBoundContact();
    b.sheet.failWith = new Error("getaddrinfo ENOTFOUND sheets.googleapis.com");
    const verdict = await liveDetailRecheck(crm, b.sheet)(payloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
    if (verdict.verdict === "wait") {
      expect(verdict.reason).toMatch(/unreachable/);
    }
  });

  it("a row vanished from a healthy snapshot waits (the pass owns the real block)", async () => {
    const b = await sheetBoundContact();
    b.sheet.deleteRowByRef(b.ref);
    const verdict = await liveDetailRecheck(crm, b.sheet)(payloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
  });

  it("a row cleared to blanks is a vanished row (the cell-clearing rule) → wait", async () => {
    const b = await sheetBoundContact();
    b.sheet.rows[1].cells = ["", ""];
    const verdict = await liveDetailRecheck(crm, b.sheet)(payloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
  });

  it("a block reason names both the approved and the corrected address", async () => {
    const b = await sheetBoundContact();
    b.sheet.rows[1].cells[1] = "ben@example.com";
    const verdict = await liveDetailRecheck(crm, b.sheet)(payloadFor(b.contactId));
    expect(verdict.verdict).toBe("block");
    if (verdict.verdict === "block") {
      expect(verdict.reason).toContain("ana@example.com");
      expect(verdict.reason).toContain("ben@example.com");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════
// F1/F2 regression pins (cold adversarial review of Piece C, approved 2026-08-18).

/** The unit-seam payload the executor would hand the recheck for the fixture contact. */
const recheckPayloadFor = (contactId: string) =>
  ({
    contact_id: contactId,
    to: "ana@example.com",
    subject: "Following up",
    body: "Hi Ana",
  }) as const;

describe("Piece C N1 — F1: a renamed email HEADER is a mapping doubt → WAIT, never block", () => {
  it("owner renames 'Email' to something unrecognised, the cell unchanged → wait", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // She renamed the HEADER only. ana@example.com still sits in the cell below it —
    // the recipient did NOT vanish; the mapper just cannot see the column any more.
    b.sheet.rows[0].cells[1] = "Client Inbox";

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0); // no mail
    expect(await executions(proposalId)).toEqual([]); // wait: nothing claimed
    expect(await state(proposalId)).toBe("approved"); // the next tick retries
    expect(await touches(proposalId)).toBe(0);
  });

  it("the wait reason names the email column and the headers seen", async () => {
    const b = await sheetBoundContact();
    b.sheet.rows[0].cells[1] = "Client Inbox";
    const verdict = await liveDetailRecheck(crm, b.sheet)(recheckPayloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
    if (verdict.verdict === "wait") {
      expect(verdict.reason).toMatch(/email column/i);
      expect(verdict.reason).toContain("Client Inbox"); // so she can fix it, not guess
    }
  });
});

describe("Piece C N3 — the email column IS mapped but her cell is EMPTY: still BLOCK", () => {
  it("an emptied email cell under a recognised header is a vanished recipient", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    b.sheet.rows[1].cells[1] = ""; // header untouched; the CELL itself was cleared

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await state(proposalId)).toBe("execution_failed"); // terminal, reconcilable
    expect(await executions(proposalId)).toEqual(["started", "failed"]);
    expect(await touches(proposalId)).toBe(0);
  });
});

describe("Piece C N4 — F2: an UNLINKED sheet cannot vouch for a recipient → WAIT", () => {
  it("kill-switch after approval → no mail, zero executions, proposal still approved", async () => {
    const b = await sheetBoundContact();
    const proposalId = await proposeAndApprove(b.sheet);

    // The kill-switch: the owner unlinks the sheet. Contacts deactivate and follow-ups
    // close — but this approved card is already in flight and must not escape.
    await unlinkSheet(admin, TEST_TENANT);

    const fake = fakeSender();
    await expect(executeEmail(deps(fake, b.sheet), proposalId)).rejects.toThrow(
      EmailRefused,
    );
    expect(fake.calls.length).toBe(0);
    expect(await executions(proposalId)).toEqual([]);
    expect(await state(proposalId)).toBe("approved");
    expect(await touches(proposalId)).toBe(0);
  });

  it("the wait reason says the sheet is no longer linked", async () => {
    const b = await sheetBoundContact();
    await unlinkSheet(admin, TEST_TENANT);
    const verdict = await liveDetailRecheck(crm, b.sheet)(recheckPayloadFor(b.contactId));
    expect(verdict.verdict).toBe("wait");
    if (verdict.verdict === "wait") {
      expect(verdict.reason).toMatch(/no longer linked/i);
    }
  });
});
