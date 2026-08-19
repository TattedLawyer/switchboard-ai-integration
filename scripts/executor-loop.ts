// The executor daemon — the third of the loop's processes to run, and the only one holding
// two credentials. Same relative-import exemption as `ci-fixture.ts`, `verify-identity.ts`
// and `drive-execute.ts`: 69ad456 closed cross-workspace src imports on purpose, and the
// composition root is the one thing that must cross, so it lives outside both tsconfigs.
//
// 🚨 THE SENDER IS EITHER REAL OR A STUB, AND THE STUB IS THE DEFAULT. Real SMTP engages
// only when SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM are ALL present. A partially
// configured relay degrades to "nothing left the building" — never to "sent to whoever was
// in the env". The banner at startup says which one is live, because the difference between
// those two states is the difference between a rehearsal and mailing a real person. The
// CALL transport is chosen the same way (see the LIVEKIT_* block in `main`), with one
// addition: the live factory is deliberately unimplemented (T16) and throws at startup.
//
// THE BROWSER SURFACE IS AUTHENTICATED NOW (A0b). `/queue` and `/decide` are opt-in on
// APPROVAL_HUMAN_SURFACE=1 and sit behind magic-link login, a database-backed session and
// a CSRF pair (synchronizer token + Sec-Fetch-Site); every decision is attributed to the
// signed-in approver's user id from the SESSION. APPROVAL_OPERATOR_USER_ID no longer
// exists — the unauthenticated variant this comment used to warn about cannot be
// configured any more. Boot the surface through `scripts/approval-service.ts`, which
// wires the real link sender; `approval/src/cli/approve.ts` remains for operators.
import pg from "pg";
import { beginExecution, finishExecution, findStuckExecutions } from "../approval/src/execute.js";
import {
  followUpEmailPayloadSchema,
  placeCallPayloadSchema,
} from "../approval/src/proposal.js";
import { startScheduler } from "../crm/src/scheduler.js";
import {
  executeCall,
  executeEmail,
  selectApprovedActions,
  CallRefused,
  EmailRefused,
  type ApprovalSpine,
  type EmailApprovalSpine,
  type PlaceCall,
  type SendEmailFn,
} from "../crm/src/executor.js";
import { stubPlaceCall, livekitPlaceCall } from "../crm/src/call-transport.js";
import type { OutreachWindow } from "../crm/src/gates.js";
import { createEmbedder } from "../crm/src/kb/embedder.js";
import { knowledgeLookup } from "../crm/src/kb/lookup.js";
import { liveDetailRecheck } from "../crm/src/send-recheck.js";
import { sheetTransportFromEnv, SHEETS_KEY_FILE_ENV } from "../crm/src/sheet-client.js";
import { smtpSender } from "../crm/src/email-transport.js";
import {
  reconcileBounces,
  formatBounceReport,
  postmarkBounceFeed,
  type BounceFeed,
} from "../crm/src/bounces.js";
import { runDailyDigest, DIGEST_SEND_LOCAL_TIME } from "../crm/src/digest.js";

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

// The call twin of SPINE, differing only in the grammar `parsePayload` wraps. Same
// composition-root exemption: `crm/src` may not import `approval/src`, so the real A2
// functions and the real schema are wired together HERE and injected at the seam.
const CALL_SPINE: ApprovalSpine = {
  beginExecution,
  finishExecution,
  parsePayload: (input) => {
    const r = placeCallPayloadSchema.safeParse(input);
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

  // 🚨 THE SENDER IS CHOSEN HERE, AND THE DEFAULT IS THE ONE THAT CANNOT REACH ANYONE.
  // Real SMTP requires SMTP_HOST, SMTP_USER, SMTP_PASS and SMTP_FROM to ALL be present;
  // anything less and the stub stands. That direction matters: a half-configured relay must
  // degrade to "nothing left the building", never to "sent to whoever was in the env".
  // `smtpSender` re-checks the allowlist itself, immediately before opening the socket, so
  // the guarantee belongs to the thing that opens sockets rather than to this call site.
  const smtpHost = process.env.SMTP_HOST;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM;
  const live = Boolean(smtpHost && smtpUser && smtpPass && smtpFrom);
  const sendEmail: SendEmailFn = live
    ? smtpSender(
        {
          host: smtpHost as string,
          port: Number(process.env.SMTP_PORT ?? 587),
          user: smtpUser as string,
          pass: smtpPass as string,
          from: smtpFrom as string,
          // Postmark routes to a named Message Stream by header. Omitting it is NOT an
          // error — it silently uses the default `outbound` stream, which is a
          // wrong-destination failure that reports success.
          ...(process.env.POSTMARK_MESSAGE_STREAM
            ? { headers: { "X-PM-Message-Stream": process.env.POSTMARK_MESSAGE_STREAM } }
            : {}),
        },
        allowlist,
      )
    : stubSender;

  // 🚨 THE CALL TRANSPORT IS CHOSEN THE SAME WAY, AND THE STUB IS THE DEFAULT. The live
  // seam engages only when LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  // LIVEKIT_SIP_TRUNK_ID and CALL_MODEL_API_KEY are ALL present; anything less and
  // `stubPlaceCall` stands — a half-configured trunk degrades to "nobody's phone rings",
  // never to "dialled whatever was in the env". Today `livekitPlaceCall` THROWS at
  // construction ("not implemented — T16"), so a fully-configured vendor env stops this
  // daemon HERE, at composition time, before any proposal is claimed — a loud startup
  // death instead of approved cards wedged `executing` one by one.
  const lkUrl = process.env.LIVEKIT_URL;
  const lkKey = process.env.LIVEKIT_API_KEY;
  const lkSecret = process.env.LIVEKIT_API_SECRET;
  const lkTrunk = process.env.LIVEKIT_SIP_TRUNK_ID;
  const lkModelKey = process.env.CALL_MODEL_API_KEY;
  const callLive = Boolean(lkUrl && lkKey && lkSecret && lkTrunk && lkModelKey);
  const placeCall: PlaceCall = callLive
    ? livekitPlaceCall({
        url: lkUrl as string,
        apiKey: lkKey as string,
        apiSecret: lkSecret as string,
        sipTrunkId: lkTrunk as string,
        modelApiKey: lkModelKey as string,
      })
    : stubPlaceCall;

  // 🚨 BOUNCE RECONCILIATION IS A TICK PHASE OF THIS DAEMON, NOT A FOURTH PROCESS. It
  // engages only when POSTMARK_SERVER_TOKEN is present — the API credential is a separate
  // decision from the SMTP one, even though Postmark uses the same value for both — and
  // degrades to OFF, loudly, in the banner. Without it, a message Postmark accepts and
  // later refuses stays recorded as 'sent' for ever, which is the defect this phase ends.
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  const bounceFeed: BounceFeed | null = postmarkToken
    ? postmarkBounceFeed(postmarkToken)
    : null;

  // 🚨 THE DAILY DIGEST IS A TICK PHASE OF THIS DAEMON, NOT A FOURTH PROCESS — same
  // reasoning as the bounce phase, plus one that is specific to it: this loop is the ONLY
  // process holding both pools, each as its own least-privilege role, and every digest
  // figure lands wholly on one pool or the other (no cross-schema JOIN is needed or
  // permitted). It must NOT move to the owner-credentialed reconcile daemon: that would
  // put the socket-opening mail path on the credential that can re-grant privileges.
  // Gated on APPROVAL_PUBLIC_URL — the queue link is the digest's whole call to action,
  // and a digest pointing nowhere is worse than a loud OFF in the banner. Recipients come
  // from active `approval.users` rows; each must be on SWITCHBOARD_EMAIL_ALLOWLIST or
  // `smtpSender` refuses the send.
  const approvalPublicUrl = (process.env.APPROVAL_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const digestOn = approvalPublicUrl !== "";

  // ONE pool each, for the life of the process. `drive-execute.ts` builds and ends its pools
  // per invocation because it is one-shot; doing that per tick would be connection churn.
  const approvalDb = new pg.Pool({ connectionString: required("APPROVAL_DATABASE_URL") });
  const crmDb = new pg.Pool({ connectionString: required("CRM_DATABASE_URL") });

  // 🚨 THE SEND-TIME RECHECK (Piece C) IS WIRED HERE, because this daemon is the only
  // process holding both roles and the proposer's transport seam already exists. NO new
  // DB grants: the recheck reads only what 021/022 already grant `switchboard_crm`.
  // A null transport is NOT a licence to send: sheet-bound sends WAIT (the recheck's own
  // rule) until the key file is configured — loud here, once, instead of silently mailing
  // addresses the sheet may have corrected.
  const sheetTransport = sheetTransportFromEnv();
  if (sheetTransport === null) {
    console.log(
      `[exec] ${SHEETS_KEY_FILE_ENV} not set — the send-time sheet recheck cannot read ` +
        `the live sheet, so sends to SHEET-BOUND contacts will WAIT until it is ` +
        `configured; manual contacts send normally.`,
    );
  }
  const recheckLiveDetails = liveDetailRecheck(crmDb, sheetTransport);

  // 🚨 THE KNOWLEDGE SEAM IS CHOSEN THE SAME WAY AS THE TRANSPORTS, AND ABSENT IS THE
  // DEFAULT. `createEmbedder()` is the ONE eager model construction this process performs
  // (~3.5s, embedder.ts doctrine: construction, not first call) and it is attempted at
  // composition time; if the vendored model is missing it throws NAMING THE FIX
  // (scripts/fetch-embedding-model.sh), and this daemon degrades to "the agent has no
  // knowledge base" — `executeCall`'s optional seam, calls proceed unchanged — never to a
  // per-call stall or a mid-call crash. All logic lives in `crm/src` (the factory and the
  // cap); this file only chooses and wires, like everything else here. The tenant is bound
  // HERE, once — the seam's call signature has no tenant field, deliberately.
  let lookupKnowledge: ReturnType<typeof knowledgeLookup> | undefined;
  let kbBanner: string;
  try {
    const embedder = await createEmbedder();
    lookupKnowledge = knowledgeLookup(crmDb, embedder, tenantId);
    kbBanner = ` Knowledge lookup ON (local embedder loaded; capped per call).`;
  } catch (err) {
    lookupKnowledge = undefined;
    kbBanner =
      ` Knowledge lookup OFF — the agent has no knowledge base on calls: ` +
      (err instanceof Error ? err.message : String(err));
  }

  const dbName = (await approvalDb.query<{ d: string }>("select current_database() as d"))
    .rows[0].d;
  if (dbName === "switchboard") {
    throw new Error("refusing to run against the named `switchboard` database");
  }

  const s = await crmDb.query<{
    default_interval_days: number;
    short_retry_days: number;
    window_start: string;
    window_end: string;
    timezone: string;
  }>(
    `select default_interval_days, short_retry_days, window_start, window_end, timezone
       from crm.outreach_settings
      where tenant_id = $1`,
    [tenantId],
  );
  if (s.rowCount !== 1) throw new Error(`no crm.outreach_settings row for tenant ${tenantId}`);
  const intervals = {
    defaultIntervalDays: s.rows[0].default_interval_days,
    shortRetryDays: s.rows[0].short_retry_days,
  };
  // The outreach window `executeCall`'s gate evaluates at EXECUTION time. Postgres `time`
  // renders 'HH:MM:SS'; `OutreachWindow` documents that spelling and `gates.ts` slices to
  // HH:MM, so the values pass through verbatim.
  const window: OutreachWindow = {
    windowStart: s.rows[0].window_start,
    windowEnd: s.rows[0].window_end,
    timezone: s.rows[0].timezone,
  };

  // The last bounce report actually printed. An unmatched bounce sits in the bounded poll
  // window for weeks, and reprinting the same aggregate every tick is silence by noise —
  // so the report surfaces when it CHANGES (including on the first tick), and compensations
  // and anomalies, which alter the report by occurring, always print at least once.
  // Deliberately in-process, not a DB cursor: losing it on restart re-prints one report,
  // and idempotency never rests on it (that is the per-proposal 'bounced'-touch check).
  let lastBounceReport: string | null = null;

  const tick = async (): Promise<void> => {
    // The selection — approved, unexpired, both action types, oldest first — lives in
    // `selectApprovedActions` (crm/src/executor.ts), NOT here: this file sits outside
    // every tsconfig, so the query and its row type stay where the compiler and the pins
    // can see them (its 🚨 expires_at anti-poison rationale is stated there too), and
    // this loop only runs it and branches on the string.
    const approved = await selectApprovedActions(approvalDb, tenantId);

    // Reported per tick when non-empty, because `executing` has no reaper by design and this
    // is the only surface that would ever mention it. A human decides; no timer adjudicates.
    const stuck = await findStuckExecutions(approvalDb, STUCK_AFTER_SECONDS);
    if (stuck.length > 0) {
      console.warn(
        `[exec] WARNING: ${stuck.length} execution(s) started and never finished — ` +
          // `proposalId`, not `proposal_id`: StuckExecution maps the row to camelCase.
          // The snake_case read printed "undefined" for every id (this file sits outside
          // every tsconfig, so no typecheck ever saw it). Found 2026-08-16.
          `these are stuck and need a person: ${stuck.map((x) => x.proposalId).join(", ")}`,
      );
    }

    // 🚨 THE BOUNCE PHASE RUNS EVEN WHEN NOTHING IS APPROVED — a bounce is the aftermath
    // of a PAST tick's send, and gating it on today's queue would silence exactly the
    // ticks that have nothing else to say. Failures here are per-tick and non-fatal, same
    // boundary reasoning as the per-proposal catch below.
    if (bounceFeed !== null) {
      try {
        const report = await reconcileBounces({ crmDb, feed: bounceFeed, intervals });
        const text = formatBounceReport(report);
        if (text !== null && text !== lastBounceReport) {
          console.log(`[exec] ${text.split("\n").join("\n[exec] ")}`);
        }
        lastBounceReport = text;
      } catch (err) {
        console.error(
          `[exec] bounce reconcile failed this tick: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // 🚨 THE DIGEST PHASE RUNS EVEN WHEN NOTHING IS APPROVED — like the bounce phase, and
    // for a sharper reason: the digest's most important edition is the one for a day when
    // nothing else happened, because "Nothing needs you today" is what disambiguates a
    // quiet system from a dead one. `runDailyDigest` is a quiet no-op until 07:00 in her
    // timezone and at most once per local date (crm.digest_sends); failures are per-tick
    // and non-fatal, and the next tick retries — toward noise, never toward silence.
    if (digestOn) {
      try {
        const d = await runDailyDigest({
          approvalDb,
          crmDb,
          tenantId,
          sendEmail,
          queueUrl: `${approvalPublicUrl}/queue`,
          findStuckExecutions,
          stuckAfterSeconds: STUCK_AFTER_SECONDS,
        });
        if (d.sent) {
          console.log(
            `[exec] daily digest for ${d.localDate} sent to ${d.recipients.join(", ")} — ` +
              `subject: ${JSON.stringify(d.subject)}`,
          );
          for (const f of d.failed) {
            console.error(
              `[exec] daily digest: send to ${f.email} failed: ${f.error} — recipients ` +
                `are active approval.users rows and each must be on SWITCHBOARD_EMAIL_ALLOWLIST`,
            );
          }
          if (d.duplicateRace) {
            console.warn(
              `[exec] daily digest for ${d.localDate} was already recorded — a second ` +
                `executor daemon appears to be running; both sent, nothing lost`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[exec] daily digest failed this tick (the next tick retries): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    if (approved.length === 0) return; // Quiet when idle. See the proposer daemon.

    for (const row of approved) {
      try {
        if (row.action_type === "place_call") {
          const out = await executeCall(
            {
              approvalDb,
              crmDb,
              placeCall,
              spine: CALL_SPINE,
              window,
              intervals,
              ...(lookupKnowledge === undefined ? {} : { lookupKnowledge }),
            },
            row.id,
          );
          console.log(
            `[exec] executed ${row.id} (call) touch=${out.touchId} ` +
              `disposition=${out.disposition} clockAdvanced=${out.advancedClock}`,
          );
        } else {
          const out = await executeEmail(
            { approvalDb, crmDb, sendEmail, spine: SPINE, allowlist, intervals, recheckLiveDetails },
            row.id,
          );
          console.log(
            `[exec] executed ${row.id} (email) touch=${out.touchId} ` +
              `disposition=${out.disposition} clockAdvanced=${out.advancedClock}`,
          );
        }
      } catch (err) {
        // PER-PROPOSAL, same reasoning as the proposer's per-contact boundary: one refused
        // recipient must not stop every other approved action in the batch.
        //
        // 🚨 A REFUSAL IS NOT AN ERROR. Outside the outreach window EVERY approved call
        // throws `CallRefused` every tick for up to ~18 hours a day — which is correct
        // and free (a window refusal leaves ZERO `approval.executions` rows; the next
        // in-window tick executes it), so it logs at `log`, not `error`. `console.error`
        // is reserved for genuine failures, or it becomes a nightly storm nobody reads.
        // (The few terminal refusals — recheck "block", a vanished question set — move
        // the proposal out of `approved`, so they stop being selected on the next tick.)
        if (err instanceof CallRefused || err instanceof EmailRefused) {
          console.log(`[exec] proposal ${row.id} refused, will retry: ${err.message}`);
        } else {
          console.error(
            `[exec] proposal ${row.id} failed: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    }
  };

  const stop = startScheduler(tick, intervalMs, true);
  console.log(
    `[exec] executor daemon running: db=${dbName} tenant=${tenantId} every ${intervalMs}ms ` +
      (live
        ? `— LIVE SMTP via ${smtpHost} as ${smtpFrom}, stream=` +
          `${process.env.POSTMARK_MESSAGE_STREAM ?? "(default outbound)"}, allowlist=` +
          `[${allowlist.join(", ")}]. MAIL CAN LEAVE THE BUILDING.`
        : `(STUB sender — nothing leaves the building)`) +
      (callLive
        ? ` Call transport LIVE via LiveKit ${lkUrl} trunk=${lkTrunk}. CALLS CAN LEAVE` +
          ` THE BUILDING.`
        : ` Call transport STUB — no phone rings (LiveKit/model env incomplete); approved` +
          ` calls execute against the canned no-answer.`) +
      (bounceFeed !== null
        ? ` Bounce reconciliation ON (Postmark API).`
        : ` Bounce reconciliation OFF — no POSTMARK_SERVER_TOKEN; an accepted-then-refused` +
          ` message will stay recorded as 'sent'.`) +
      (digestOn
        ? ` Daily digest ON — ${DIGEST_SEND_LOCAL_TIME} in outreach_settings.timezone, to` +
          ` active approval.users (each must be on SWITCHBOARD_EMAIL_ALLOWLIST), queue at` +
          ` ${approvalPublicUrl}/queue.`
        : ` Daily digest OFF — no APPROVAL_PUBLIC_URL; nothing will tell the broker her` +
          ` approval queue exists, and an expired proposal stays a silent loss.`) +
      kbBanner,
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
