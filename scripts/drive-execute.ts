// First Drive — the executor composition root. Same relative-import exemption as
// `ci-fixture.ts` and `verify-identity.ts` (script code, not shipped src).
//
// 🚨 WHY THIS LIVES IN `scripts/` AND NOT IN A WORKSPACE. Commit 69ad456 closed
// cross-workspace source imports on purpose: `approval` and `crm` both publish an exhaustive
// `exports` map, so `crm/src` importing `@switchboard/approval/src/execute.js` is TS2307 and
// the relative spelling is TS6059. That guard is load-bearing and is NOT to be reopened to
// make this file compile. `scripts/` is outside both tsconfig `include` lists and already
// carries the documented exemption, so the composition root belongs here.
//
// 🚨 TWO POOLS, ONE PROCESS — AND THAT IS THE SHIPPED DESIGN, NOT A SHORTCUT.
// `executeEmail`'s contract names them: `approvalDb` = `switchboard_approval`, `crmDb` =
// `switchboard_crm`. Verified against the live cluster: the approval role holds NOTHING in
// `crm.*` and the CRM role holds NOTHING in `approval.*`. No single role can perform this
// step, and none is asked to — the isolation is between ROLES, and the executor is the one
// component the design licenses to hold both credentials at once.
//
// 🚨 THE SENDER IS A STUB. Nothing leaves the building. It records the message and returns a
// synthetic message id, and the resulting touch is written with disposition 'sent' — which
// migration 017 defines as "the relay accepted the submission". On this scratch database
// that row is a convenient fiction. It must never be promoted to a real deployment, and the
// first thing the real transport wave does is make this file's sender configurable.
import pg from "pg";
import { beginExecution, finishExecution } from "../approval/src/execute.js";
import { followUpEmailPayloadSchema } from "../approval/src/proposal.js";
import {
  executeEmail,
  type EmailApprovalSpine,
  type SendEmailFn,
} from "../crm/src/executor.js";

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

/** Records and returns success. Never opens a socket. */
const stubSender: SendEmailFn = async (msg) => {
  console.log("--- STUB SEND (nothing left the building) ---");
  console.log(`to:      ${msg.to}`);
  console.log(`subject: ${msg.subject}`);
  console.log(`body:    ${msg.body.replace(/\n/g, "\n         ")}`);
  console.log("---------------------------------------------");
  return {
    messageId: `<drive1-${Date.now()}@stub.invalid>`,
    accepted: [msg.to],
    rejected: [],
    response: "250 2.0.0 OK (stub)",
  };
};

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function main(): Promise<void> {
  const tenantId = required("SWITCHBOARD_TENANT_ID");
  const allowlist = (process.env.SWITCHBOARD_EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    // Fail here rather than 200 lines later inside `checkSendable`, which refuses every
    // recipient against an empty list and would read as "the guard rejected this address".
    throw new Error("SWITCHBOARD_EMAIL_ALLOWLIST is empty — every recipient would be refused");
  }

  const approvalDb = new pg.Pool({ connectionString: required("APPROVAL_DATABASE_URL") });
  const crmDb = new pg.Pool({ connectionString: required("CRM_DATABASE_URL") });

  try {
    // Guard against the failure the plan review ranked most dangerous: a drive that works
    // perfectly while writing the database we pledged never to deliberately write.
    const dbName = (await approvalDb.query<{ d: string }>("select current_database() as d"))
      .rows[0].d;
    if (dbName === "switchboard") {
      throw new Error(
        "refusing to run against the named `switchboard` database — point every " +
          "connection string at a scratch database",
      );
    }
    console.log(`[drive] database=${dbName} tenant=${tenantId}`);

    const intervals = await crmDb.query<{
      default_interval_days: number;
      short_retry_days: number;
    }>(
      `select default_interval_days, short_retry_days from crm.outreach_settings
        where tenant_id = $1`,
      [tenantId],
    );
    if (intervals.rowCount !== 1) {
      throw new Error(`no crm.outreach_settings row for tenant ${tenantId}`);
    }

    const approved = await approvalDb.query<{ id: string }>(
      `select id from approval.proposals
        where tenant_id = $1 and state = 'approved' and action_type = 'send_email'
        order by created_at, id`,
      [tenantId],
    );
    if (approved.rowCount === 0) {
      console.log(
        "no approved send_email proposals. Either nothing has been approved yet, or an " +
          "approval already executed (state moves off `approved`).",
      );
      return;
    }

    for (const row of approved.rows) {
      console.log(`[drive] executing proposal ${row.id}`);
      const out = await executeEmail(
        {
          approvalDb,
          crmDb,
          sendEmail: stubSender,
          spine: SPINE,
          allowlist,
          intervals: {
            defaultIntervalDays: intervals.rows[0].default_interval_days,
            shortRetryDays: intervals.rows[0].short_retry_days,
          },
        },
        row.id,
      );
      console.log(
        `[drive] executed  touch=${out.touchId} disposition=${out.disposition} ` +
          `clockAdvanced=${out.advancedClock}`,
      );
    }
  } finally {
    await approvalDb.end().catch(() => undefined);
    await crmDb.end().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
