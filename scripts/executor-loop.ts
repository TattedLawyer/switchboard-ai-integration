// The executor daemon — the third of the loop's processes to run, and the only one holding
// two credentials. Same relative-import exemption as `ci-fixture.ts`, `verify-identity.ts`
// and `drive-execute.ts`: 69ad456 closed cross-workspace src imports on purpose, and the
// composition root is the one thing that must cross, so it lives outside both tsconfigs.
//
// 🚨 STILL A STUB SENDER. Nothing leaves the building. The touch it writes carries
// disposition 'sent', which migration 017 defines as "the relay accepted the submission" —
// a convenient fiction on a scratch database and a lie anywhere else. Replacing this sender
// is the next step, and it is the step that also ends the deferral of auth and CSRF, because
// the moment mail can leave, an unauthenticated /decide sends it.
import pg from "pg";
import { beginExecution, finishExecution, findStuckExecutions } from "../approval/src/execute.js";
import { followUpEmailPayloadSchema } from "../approval/src/proposal.js";
import { startScheduler } from "../crm/src/scheduler.js";
import {
  executeEmail,
  type EmailApprovalSpine,
  type SendEmailFn,
} from "../crm/src/executor.js";

const DEFAULT_INTERVAL_MS = 60_000; // Precedent, not invention: CYCLE_INTERVAL_MS
// (scheduler.ts) and SWEEP_INTERVAL_MS (expiry.ts) are both 60s, and executor latency is
// irrelevant against a 72-hour proposal TTL.
const STUCK_AFTER_SECONDS = 300;

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

const stubSender: SendEmailFn = async (msg) => {
  console.log(`[exec] STUB SEND to=${msg.to} subject=${JSON.stringify(msg.subject)}`);
  return {
    messageId: `<loop-${Date.now()}@stub.invalid>`,
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
  const intervalMs = Number(process.env.EXECUTOR_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
    throw new Error(`invalid EXECUTOR_INTERVAL_MS "${process.env.EXECUTOR_INTERVAL_MS}"`);
  }
  const allowlist = (process.env.SWITCHBOARD_EMAIL_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    throw new Error("SWITCHBOARD_EMAIL_ALLOWLIST is empty — every recipient would be refused");
  }

  // ONE pool each, for the life of the process. `drive-execute.ts` builds and ends its pools
  // per invocation because it is one-shot; doing that per tick would be connection churn.
  const approvalDb = new pg.Pool({ connectionString: required("APPROVAL_DATABASE_URL") });
  const crmDb = new pg.Pool({ connectionString: required("CRM_DATABASE_URL") });

  const dbName = (await approvalDb.query<{ d: string }>("select current_database() as d"))
    .rows[0].d;
  if (dbName === "switchboard") {
    throw new Error("refusing to run against the named `switchboard` database");
  }

  const s = await crmDb.query<{ default_interval_days: number; short_retry_days: number }>(
    `select default_interval_days, short_retry_days from crm.outreach_settings
      where tenant_id = $1`,
    [tenantId],
  );
  if (s.rowCount !== 1) throw new Error(`no crm.outreach_settings row for tenant ${tenantId}`);
  const intervals = {
    defaultIntervalDays: s.rows[0].default_interval_days,
    shortRetryDays: s.rows[0].short_retry_days,
  };

  const tick = async (): Promise<void> => {
    // 🚨 `expires_at > now()` IS NOT DECORATION. Without it an approved-but-expired row is
    // selected every tick forever, and `beginExecution`'s compare-and-set refuses it every
    // time — a permanent poison that only ever reaches a log. The queue read filters
    // expiry the same way and for the same reason (queue.ts), independently of the sweeper,
    // because a sweeper alone fails open during exactly the outage that matters.
    const approved = await approvalDb.query<{ id: string }>(
      `select id from approval.proposals
        where tenant_id = $1 and state = 'approved' and action_type = 'send_email'
          and expires_at > now()
        order by created_at, id`,
      [tenantId],
    );

    // Reported per tick when non-empty, because `executing` has no reaper by design and this
    // is the only surface that would ever mention it. A human decides; no timer adjudicates.
    const stuck = await findStuckExecutions(approvalDb, STUCK_AFTER_SECONDS);
    if (stuck.length > 0) {
      console.warn(
        `[exec] WARNING: ${stuck.length} execution(s) started and never finished — ` +
          `these are stuck and need a person: ${stuck.map((x) => x.proposal_id).join(", ")}`,
      );
    }

    if (approved.rowCount === 0) return; // Quiet when idle. See the proposer daemon.

    for (const row of approved.rows) {
      try {
        const out = await executeEmail(
          { approvalDb, crmDb, sendEmail: stubSender, spine: SPINE, allowlist, intervals },
          row.id,
        );
        console.log(
          `[exec] executed ${row.id} touch=${out.touchId} disposition=${out.disposition} ` +
            `clockAdvanced=${out.advancedClock}`,
        );
      } catch (err) {
        // PER-PROPOSAL, same reasoning as the proposer's per-contact boundary: one refused
        // recipient must not stop every other approved action in the batch.
        console.error(
          `[exec] proposal ${row.id} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  };

  const stop = startScheduler(tick, intervalMs, true);
  console.log(
    `[exec] executor daemon running: db=${dbName} tenant=${tenantId} every ${intervalMs}ms ` +
      `(STUB sender — nothing leaves the building)`,
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[exec] ${signal} — stopping`);
    stop();
    void Promise.allSettled([approvalDb.end(), crmDb.end()]).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
