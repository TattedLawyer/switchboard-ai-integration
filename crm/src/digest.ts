// The daily digest — the thing that tells the broker her approval queue exists.
//
// THE PROBLEM THIS SOLVES: proposals expire after a TTL, so a follow-up she never saw
// becomes a follow-up that never happened — silently. Until this file she had to remember
// to open the page. Now, once per local day at 07:00 in HER timezone, an email arrives
// whose SUBJECT LINE carries the entire state — ignorable at the inbox line without
// opening.
//
// 🚨 IT ALWAYS SENDS, even when nothing needs her. Only-when-something makes silence
// ambiguous between "nothing needed" and "the system died", which is this repo's stated
// worst defect class. "Nothing needs you today" is a heartbeat she can ignore; no email at
// all is a question she cannot answer.
//
// 🚨 ONE CLOCK AUTHORITY: POSTGRES. This repo has produced three date-boundary bugs.
// 07:00 Manila is 23:00 UTC the PREVIOUS day: a JS-computed local date sends the digest at
// 07:00 Manila under UTC date D−1 and AGAIN at 08:00 Manila when UTC midnight flips the
// key. So the local date, the 07:00 time gate and the already-sent check are ONE SQL
// statement against `crm.outreach_settings.timezone`, and the SAME returned local_date is
// what gets inserted into `crm.digest_sends`. It is never recomputed in JS, and `now()` is
// evaluated once (it is per-statement stable). The gate is `>=`, not hour equality —
// `>=` is DST-safe (a spring-forward that skips 07:xx still passes at 08:00).
//
// 🚨 RECORD AFTER SEND. A crash mid-send leaves no row and the next tick retries — that
// fails toward noise (a possible duplicate email), the correct direction; recording first
// would fail toward silence (a digest marked sent that nobody received). Two overlapping
// daemons both send and the second insert hits the primary key: logged, never a crash.
//
// 🚨 "SINCE THE LAST DIGEST" MEANS THE PREVIOUS ROW'S `sent_at`, not a date boundary — a
// date boundary silently skips the midnight-to-07:00 gap. The first-ever digest's window
// is explicitly 24 hours, or it would dump all history.
//
// 🚨 EVERY FIGURE IS COMPUTED BY QUERY, never model-generated, and every figure lands
// wholly on one pool or the other: `switchboard_approval` cannot see `crm.*` and
// `switchboard_crm` cannot see `approval.*` (verified by `has_table_privilege`), so no
// cross-schema JOIN exists here and none is permitted. The one approval-side helper this
// file needs (`findStuckExecutions`) is INJECTED, in the executor's spine idiom —
// `crm/src` may not import `approval/src`.
import type pg from "pg";
import type { SendEmail } from "./email-transport.js";
import {
  sheetHealth,
  sheetHealthLines,
  sheetReadCode,
  type SheetHealth,
} from "./sheet-adopt.js";

export interface DigestDeps {
  /** `switchboard_approval` — proposals, users, executions. */
  approvalDb: pg.Pool;
  /** `switchboard_crm` — settings, contacts, follow-ups, touches, digest_sends. */
  crmDb: pg.Pool;
  tenantId: string;
  /** The loop's sender — real SMTP or the stub, whichever the boot chose. */
  sendEmail: SendEmail;
  /** `${APPROVAL_PUBLIC_URL}/queue` — the link into the queue. */
  queueUrl: string;
  /** `approval/src/execute.ts`'s `findStuckExecutions`, injected (spine idiom). */
  findStuckExecutions: (
    db: pg.Pool,
    minAgeSeconds: number,
  ) => Promise<ReadonlyArray<{ proposalId: string }>>;
  stuckAfterSeconds?: number;
  /** Test seam for the INSTANT only. The local-date derivation from it stays in Postgres. */
  now?: () => Date;
}

export interface DigestCounts {
  /** `state = 'pending'` and not yet past `expires_at`. */
  waiting: number;
  /** Of those, expiring within the next 24 hours. */
  expiringSoon: number;
  /** `state = 'expired'` with `expires_at` inside the window — the loss this digest
   *  exists to prevent; when prevention fails she is TOLD it happened. */
  expiredUnseen: number;
  newContacts: number;
  /** ALL blocked reasons, aggregated per reason (`formatReconcile` idiom). */
  blocked: Array<{ reason: string; count: number }>;
  /** `'bounced'` touches recorded in the window. Phrased exactly "bounces recorded" —
   *  the compensated/late-appended distinction lives only in a tick's in-memory report
   *  and is not queryable. */
  bouncesRecorded: number;
  stuck: number;
  /** The tenant's linked sheet, when one exists: last read outcome + missing-row count,
   *  read on the CRM pool (021 grants SELECT on the two health tables for exactly this).
   *  The three unhealthy states demand three DIFFERENT actions — wait / re-share with the
   *  named service account / check the sheet — so the body renders three different
   *  sentences (`sheetHealthLines`), and `sheet_row_missing` blocks already ride the
   *  blocked totals above. */
  sheet?: SheetHealth | null;
}

export type DigestRun =
  | { sent: false }
  | {
      sent: true;
      localDate: string;
      subject: string;
      recipients: string[];
      failed: Array<{ email: string; error: string }>;
      /** The insert lost the primary-key race to another daemon: both sent, log it. */
      duplicateRace: boolean;
      counts: DigestCounts;
    };

const STUCK_AFTER_SECONDS_DEFAULT = 300;
/** Hardcoded on purpose (one deployment serves one tenant, SEC-C1): 07:00 evaluated in
 *  `outreach_settings.timezone`, which is already per-tenant. The literal in the gate SQL
 *  below is the enforcement; this export is for banners and reports. An env override can
 *  arrive when someone asks. */
export const DIGEST_SEND_LOCAL_TIME = "07:00";

/** The subject line carries the entire actionable state, or says plainly that there is
 *  none. Exported pure so the pin reads the exact strings. */
export function formatDigestSubject(c: DigestCounts): string {
  const blockedTotal = c.blocked.reduce((n, b) => n + b.count, 0);
  const parts: string[] = [];
  if (c.waiting > 0) {
    parts.push(
      `${c.waiting} approval${c.waiting === 1 ? "" : "s"} waiting` +
        (c.expiringSoon > 0
          ? ` — ${c.expiringSoon} expire${c.expiringSoon === 1 ? "s" : ""} within 24h`
          : ""),
    );
  }
  if (c.expiredUnseen > 0) parts.push(`${c.expiredUnseen} expired unseen`);
  if (blockedTotal > 0) parts.push(`${blockedTotal} blocked`);
  if (c.stuck > 0) parts.push(`${c.stuck} stuck`);
  // The sheet only reaches the SUBJECT when it needs her — a healthy sheet is body-only.
  // (`sheet_row_missing` blocks are already inside `blockedTotal`.)
  if (c.sheet && c.sheet.lastReadOk === false) {
    switch (sheetReadCode(c.sheet.lastReadDetail)) {
      case "permission_revoked":
        parts.push("sheet access revoked");
        break;
      case "breaker_count":
      case "breaker_drift":
        parts.push("sheet import halted");
        break;
      case "refused":
        parts.push("sheet headers need attention");
        break;
      default:
        parts.push("sheet unreachable");
    }
  }
  return parts.length > 0 ? parts.join(", ") : "Nothing needs you today";
}

export function formatDigestBody(
  c: DigestCounts,
  o: { queueUrl: string; localDate: string; sinceLabel: string },
): string {
  const lines: string[] = [];
  lines.push(`Daily follow-up digest for ${o.localDate} (${o.sinceLabel}).`);
  lines.push("");
  lines.push(`Approval queue: ${o.queueUrl}`);
  lines.push("");
  lines.push(
    `Awaiting your approval: ${c.waiting}` +
      (c.waiting > 0 ? ` (${c.expiringSoon} expire within the next 24 hours)` : ""),
  );
  lines.push(
    `Expired unseen since the last digest: ${c.expiredUnseen}` +
      (c.expiredUnseen > 0 ? " — these follow-ups never happened" : ""),
  );
  lines.push(`New contacts since the last digest: ${c.newContacts}`);
  const blockedTotal = c.blocked.reduce((n, b) => n + b.count, 0);
  lines.push(`Blocked follow-ups: ${blockedTotal}`);
  for (const b of c.blocked) lines.push(`  - ${b.reason}: ${b.count}`);
  lines.push(`Bounces recorded since the last digest: ${c.bouncesRecorded}`);
  lines.push(
    `Executions started and never finished (need a person): ${c.stuck}`,
  );
  if (c.sheet) {
    // Same sentences as the reconcile listing — one wording per state, never two.
    lines.push(...sheetHealthLines(c.sheet));
  }
  return lines.join("\n");
}

/**
 * One call per executor tick. Quiet no-op until 07:00 local; sends at most once per local
 * date; throws when it could not deliver to anyone (the caller logs; the next tick
 * retries — toward noise, never toward silence).
 */
export async function runDailyDigest(deps: DigestDeps): Promise<DigestRun> {
  const instantParam = deps.now ? deps.now().toISOString() : null;

  // ── THE CLOCK AUTHORITY. One statement: the local date, the >=07:00 gate, the
  //    already-sent check, and the window start — all in Postgres, all from ONE instant
  //    (`now()` is per-statement stable; the test seam substitutes the instant, never the
  //    derivation). `local_date` comes back as TEXT: node-pg parses a bare `date` into a
  //    JS Date via the local timezone, which is precisely the boundary bug this file must
  //    not have.
  const gate = await deps.crmDb.query<{
    local_date: string;
    since: Date;
    first_digest: boolean;
    instant: Date;
  }>(
    `with t as (select coalesce($2::timestamptz, now()) as instant)
     select ((t.instant at time zone s.timezone)::date)::text as local_date,
            coalesce((select max(d.sent_at) from crm.digest_sends d
                       where d.tenant_id = s.tenant_id),
                     t.instant - interval '24 hours') as since,
            not exists (select 1 from crm.digest_sends d
                         where d.tenant_id = s.tenant_id) as first_digest,
            t.instant as instant
       from crm.outreach_settings s, t
      where s.tenant_id = $1
        and (t.instant at time zone s.timezone)::time >= time '07:00'
        and not exists (
              select 1 from crm.digest_sends d
               where d.tenant_id = s.tenant_id
                 and d.digest_date = (t.instant at time zone s.timezone)::date)`,
    [deps.tenantId, instantParam],
  );
  if (gate.rowCount !== 1) return { sent: false }; // before 07:00 local, or already sent

  const { local_date: localDate, since, first_digest: firstDigest, instant } = gate.rows[0];

  // ── The figures. Approval pool and CRM pool, each wholly on its own side.
  const pending = await deps.approvalDb.query<{ waiting: number; expiring_soon: number }>(
    `select count(*)::int as waiting,
            (count(*) filter (where expires_at <= $2::timestamptz + interval '24 hours'))::int
              as expiring_soon
       from approval.proposals
      where tenant_id = $1 and state = 'pending' and expires_at > $2::timestamptz`,
    [deps.tenantId, instant.toISOString()],
  );

  // `expires_at` is the event time of an expiry regardless of when the sweeper flipped the
  // row — the queue stops rendering the card at that instant (expiry.ts's three
  // enforcement points), so it is the honest "when she lost it" timestamp.
  const expired = await deps.approvalDb.query<{ n: number }>(
    `select count(*)::int as n from approval.proposals
      where tenant_id = $1 and state = 'expired' and expires_at > $2::timestamptz`,
    [deps.tenantId, since.toISOString()],
  );

  const stuck = await deps.findStuckExecutions(
    deps.approvalDb,
    deps.stuckAfterSeconds ?? STUCK_AFTER_SECONDS_DEFAULT,
  );

  const contacts = await deps.crmDb.query<{ n: number }>(
    `select count(*)::int as n from crm.contacts
      where tenant_id = $1 and created_at > $2::timestamptz`,
    [deps.tenantId, since.toISOString()],
  );

  // ALL blocked reasons — `no_email_address`, `no_phone_number`, `no_question_set` and any
  // future one — aggregated per reason. Open follow-ups only: a lifted block clears
  // `blocked_reason` on the same row (the B-B recovery path).
  const blocked = await deps.crmDb.query<{ reason: string; n: number }>(
    `select f.blocked_reason as reason, count(*)::int as n
       from crm.follow_ups f
       join crm.contacts c on c.id = f.contact_id
      where c.tenant_id = $1 and f.blocked_reason is not null and f.closed_at is null
      group by f.blocked_reason
      order by f.blocked_reason`,
    [deps.tenantId],
  );

  const bounces = await deps.crmDb.query<{ n: number }>(
    `select count(*)::int as n
       from crm.touches t
       join crm.contacts c on c.id = t.contact_id
      where c.tenant_id = $1 and t.channel = 'email' and t.disposition = 'bounced'
        and t.occurred_at > $2::timestamptz`,
    [deps.tenantId, since.toISOString()],
  );

  // The linked sheet's health — CRM pool (SELECT on the two health tables, 021).
  const sheets = await sheetHealth(deps.crmDb, deps.tenantId);

  const counts: DigestCounts = {
    waiting: pending.rows[0].waiting,
    expiringSoon: pending.rows[0].expiring_soon,
    expiredUnseen: expired.rows[0].n,
    newContacts: contacts.rows[0].n,
    blocked: blocked.rows.map((r) => ({ reason: r.reason, count: r.n })),
    bouncesRecorded: bounces.rows[0].n,
    stuck: stuck.length,
    sheet: sheets[0] ?? null,
  };

  // ── Recipients: the active approver list, NOT an env var. Every one of them must also
  //    be on SWITCHBOARD_EMAIL_ALLOWLIST or `smtpSender` refuses the send at the socket.
  const users = await deps.approvalDb.query<{ email: string }>(
    `select email from approval.users where disabled_at is null order by email`,
  );
  if (users.rowCount === 0) {
    throw new Error(
      "daily digest: no active approval.users row — nobody to send to. Add an approver " +
        "(approval-user-add); the address must also be on SWITCHBOARD_EMAIL_ALLOWLIST or " +
        "smtpSender refuses every send.",
    );
  }

  const subject = formatDigestSubject(counts);
  const sinceLabel = firstDigest
    ? "first digest — covering the last 24 hours"
    : `since the last digest at ${since.toISOString()}`;
  const body = formatDigestBody(counts, { queueUrl: deps.queueUrl, localDate, sinceLabel });

  // ── SEND, THEN RECORD — in that order, always (see the header). Per-recipient failures
  //    are collected; total failure throws so no row is written and the next tick retries.
  const recipients: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];
  for (const u of users.rows) {
    try {
      await deps.sendEmail({ to: u.email, subject, body });
      recipients.push(u.email);
    } catch (err) {
      failed.push({ email: u.email, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (recipients.length === 0) {
    throw new Error(
      `daily digest for ${localDate} reached nobody — no digest_sends row recorded, the ` +
        `next tick retries. Recipients are active approval.users rows and each must be on ` +
        `SWITCHBOARD_EMAIL_ALLOWLIST (smtpSender refuses the rest): ` +
        failed.map((f) => `${f.email}: ${f.error}`).join("; "),
    );
  }

  // ── The record. The SAME local_date string the gate returned — never recomputed.
  let duplicateRace = false;
  try {
    await deps.crmDb.query(
      `insert into crm.digest_sends (tenant_id, digest_date) values ($1, $2::date)`,
      [deps.tenantId, localDate],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // Two overlapping daemons: both sent, the second insert loses the primary key.
      // Logged by the caller, never a crash — a duplicate email is noise, not loss.
      duplicateRace = true;
    } else {
      throw err;
    }
  }

  return { sent: true, localDate, subject, recipients, failed, duplicateRace, counts };
}
