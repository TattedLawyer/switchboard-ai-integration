// Bounce reconciliation — the read-back of the bounce feed, and the end of the defect
// class where Postmark refuses a message and this system keeps saying "sent".
//
// THE PROBLEM THIS SOLVES, measured three times on a live database: Postmark's SMTP
// endpoint answers 250 + a Message-ID when it accepts a message FOR PROCESSING, then
// rejects asynchronously. The refusal appears only in the bounce feed. Until this file,
// nothing read that feed — so `crm.touches.disposition = 'sent'` stood, the follow-up
// closed, and `next_due_at` advanced a full interval on mail that never existed.
//
// THE CORRELATION HOP, and why it is three steps: Postmark's Bounce API returns NO
// `Metadata` field (webhook-only), so a bounce is matched to our proposal as
//   bounce → `MessageID` (Postmark's) → `GET /messages/outbound/{MessageID}/details`
//          → `Metadata[PROPOSAL_METADATA_KEY]` → our proposal id,
// where the metadata was set at send time by the SMTP header `X-PM-Metadata-proposal-id`
// (`email-transport.ts`). `crm.touches.proposal_id` is then the join — the metadata IS the
// proposal id, so `switchboard_crm` needs NOTHING on `approval.*` and every compensating
// write below is inside 016's shipped grants.
//
// 🚨 APPEND, NEVER AMEND. The `'sent'` touch remains — it is TRUE; the relay accepted the
// submission — and the bounce is a NEW fact recorded as a NEW `'bounced'` touch. The grant
// physically permits flipping the existing disposition; this sentence is the rule that
// forbids it. History stays what happened.
//
// 🚨 THE FOLLOW-UP IS NEVER REOPENED. Clearing `closed_at` would recreate the permanent
// invisible silence this task exists to remove: an open row at an earlier due date makes
// `hasOpenFollowUpBefore` skip the contact on EVERY future cycle, and nothing could ever
// close it again (`closeTerminatedFollowUps` requires a terminal-non-executed proposal;
// this one is `executed`, terminal). The compensation is `recordTouch('bounced')`: the
// close inside it is an idempotent no-op, the clock moves to the SHORT retry (`'bounced'`
// is not in `LONG_INTERVAL_DISPOSITIONS`), and the NEXT cycle opens a fresh
// `(contact_id, due_date)` row. The contact becomes proposable again; the trail stays true.
//
// 🚨 NO CURSOR, NO WATERMARK. `switchboard_crm` cannot write `ingest.cursors`, and a
// watermark is not idempotency anyway. Idempotency is per-proposal and stateless: "does a
// `'bounced'` email touch already exist for this proposal_id?" — answerable under existing
// grants. The poll is a bounded recent window via count/offset paging (the Bounce API's
// `fromdate`/`todate` are documented as Eastern Time; date filtering is a trap).
//
// 🚨 UNMATCHED BOUNCES ARE EXPECTED, NOT ANOMALOUS — Postmark UI sends, the acceptance
// test itself, other deployments sharing the server. Three cases, classified distinctly:
//   · no metadata at all            → probably not ours: QUIET aggregate count;
//   · metadata, but no known touch  → anomaly: LOUD, listed individually;
//   · matched, already compensated  → dedupe: silent count.
//
// 🚨 NOTHING IS WRITTEN ON THE APPROVAL SIDE (stated non-goal). `executed` is terminal in
// 015's transition set and `executions.kind` has no bounce member. "Submission succeeded"
// remains literally true; the CRM trail is where the later refusal lives.
//
// 🚨 THIS FILE DECLARES NO TIMER AND COMPARES NO CLOCK. Polling cadence belongs to the
// executor loop's existing tick; `now` is used only as `recordTouch`'s timestamp.
import type pg from "pg";
import { beginTouch, recordTouch, type IntervalSettings } from "./touch.js";
import { PROPOSAL_METADATA_KEY } from "./email-transport.js";

/** One bounce, in this module's own shape. `messageId` is POSTMARK's message id (the
 *  Bounce API's `MessageID`), not the SMTP Message-ID header. */
export interface BounceRecord {
  id: string;
  type: string;
  email: string;
  bouncedAt: string;
  messageId: string | null;
}

/** The vendor seam, injected exactly like `SendEmailFn`/`PlaceCall`. Faked in tests; the
 *  real Postmark client (`postmarkBounceFeed`) otherwise. */
export interface BounceFeed {
  /** One bounded page of recent bounces. Count/offset paging, newest first. */
  listBounces: (count: number, offset: number) => Promise<BounceRecord[]>;
  /** The metadata hop: `GET /messages/outbound/{id}/details` → `Metadata`, or null when
   *  the message is unknown to this server (404 / error 701). */
  getMessageMetadata: (messageId: string) => Promise<Record<string, string> | null>;
}

export interface BounceReconcileDeps {
  /** `switchboard_crm` — every write here is inside 016's grants. */
  crmDb: pg.Pool;
  feed: BounceFeed;
  intervals: IntervalSettings;
  /** The bounded window. One page; no cursor. */
  windowCount?: number;
  now?: () => Date;
}

export interface CompensatedBounce {
  proposalId: string;
  contactId: string;
  /** The NEW `'bounced'` touch — the `'sent'` one is untouched. */
  touchId: string;
  bounceType: string;
  email: string;
}

export interface BounceAnomaly {
  bounceId: string;
  messageId: string | null;
  proposalId: string;
  email: string;
  reason: string;
}

export interface BounceReconcileReport {
  /** Clock pulled back to the short retry; contact proposable again. */
  compensated: CompensatedBounce[];
  /** Bounce arrived AFTER a later touch for the contact: the `'bounced'` touch is
   *  appended (history stays true) but the clock is NOT moved — pulling it back would
   *  clobber a legitimate later cycle's clock. Surfaced, not silent. */
  lateAppended: CompensatedBounce[];
  /** Metadata matched a proposal whose bounce is already recorded. Silent dedupe. */
  alreadyCompensated: number;
  /** Metadata matched a proposal that never recorded `'sent'` (the send failed
   *  synchronously and `execution_failed` already tells that story). Nothing to do. */
  notClaimedSent: number;
  /** No metadata / unknown message: probably not ours. Quiet aggregate + newest few. */
  noMetadata: { count: number; newest: BounceRecord[] };
  /** Metadata present but no touch anywhere for that proposal — LOUD. */
  anomalies: BounceAnomaly[];
}

const DEFAULT_WINDOW = 100;
/** How many of the unmatched bounces the report names. An aggregate plus the newest few is
 *  the repo's reconcile-listing idiom — never one line per bounce per tick. */
const NO_METADATA_NEWEST = 3;

export async function reconcileBounces(
  deps: BounceReconcileDeps,
): Promise<BounceReconcileReport> {
  const now = deps.now?.() ?? new Date();
  const bounces = await deps.feed.listBounces(deps.windowCount ?? DEFAULT_WINDOW, 0);

  const report: BounceReconcileReport = {
    compensated: [],
    lateAppended: [],
    alreadyCompensated: 0,
    notClaimedSent: 0,
    noMetadata: { count: 0, newest: [] },
    anomalies: [],
  };

  for (const bounce of bounces) {
    // No Postmark message id at all — nothing to look up. Quiet.
    if (bounce.messageId === null || bounce.messageId === "") {
      noteNoMetadata(report, bounce);
      continue;
    }

    const metadata = await deps.feed.getMessageMetadata(bounce.messageId);
    const proposalId = metadataProposalId(metadata);
    if (proposalId === undefined || proposalId === "") {
      // A real message with no proposal-id metadata: a UI send, another deployment on the
      // same server, or a pre-correlation send. Expected. Quiet.
      noteNoMetadata(report, bounce);
      continue;
    }

    // ── Idempotency, per-proposal and stateless. A `'bounced'` touch for this proposal
    //    means a previous poll already compensated; this window will keep containing the
    //    same bounce, and it must keep being a silent no-op.
    const already = await deps.crmDb.query(
      `select 1 from crm.touches where proposal_id = $1 and disposition = 'bounced' limit 1`,
      [proposalId],
    );
    if ((already.rowCount ?? 0) > 0) {
      report.alreadyCompensated += 1;
      continue;
    }

    // ── The touch that claimed success.
    const sent = await deps.crmDb.query<{
      id: string;
      contact_id: string;
      occurred_at: Date;
    }>(
      `select id, contact_id, occurred_at from crm.touches
        where proposal_id = $1 and channel = 'email' and disposition = 'sent'
        order by occurred_at limit 1`,
      [proposalId],
    );

    if (sent.rowCount !== 1) {
      const anyTouch = await deps.crmDb.query(
        `select 1 from crm.touches where proposal_id = $1 limit 1`,
        [proposalId],
      );
      if ((anyTouch.rowCount ?? 0) > 0) {
        // The send failed SYNCHRONOUSLY (touch left with a NULL disposition, proposal
        // `execution_failed`) — that story is already told and reconciled elsewhere.
        // Nothing here claimed success, so there is nothing to walk back.
        report.notClaimedSent += 1;
      } else {
        // Metadata says this is ours; the CRM has never heard of it. That is not "not
        // ours" and not "already handled" — it is a real anomaly, and it is LOUD.
        report.anomalies.push({
          bounceId: bounce.id,
          messageId: bounce.messageId,
          proposalId,
          email: bounce.email,
          reason: "bounce metadata names a proposal with no touch in crm.touches",
        });
      }
      continue;
    }

    const { id: sentTouchId, contact_id: contactId, occurred_at: sentAt } = sent.rows[0];

    // ── The late-bounce guard. A bounce can arrive after the contact was legitimately
    //    re-proposed and re-advanced; pulling the clock back then would clobber the later
    //    cycle's truth. The clock moves ONLY when no later touch exists for this contact
    //    after the bounced send. (Touches on THIS proposal do not count — there is only
    //    the `'sent'` one, and the row this pass appends must not shadow the next check.)
    const later = await deps.crmDb.query<{ n: string }>(
      `select count(*) as n from crm.touches
        where contact_id = $1
          and occurred_at > $2
          and (proposal_id is distinct from $3)`,
      [contactId, sentAt.toISOString(), proposalId],
    );
    const hasLaterTouch = Number(later.rows[0].n) > 0;

    if (hasLaterTouch) {
      // APPEND ONLY. `recordTouch` is deliberately not used here: it always writes a
      // clock, and the entire point of this branch is that the clock belongs to a later,
      // legitimate cycle. The follow-up needs no close (its own cycle closed it), history
      // gains the true fact, the listing below surfaces it.
      const touchId = await beginTouch(deps.crmDb, {
        contactId,
        channel: "email",
        proposalId,
      });
      await deps.crmDb.query(
        `update crm.touches set disposition = 'bounced' where id = $1`,
        [touchId],
      );
      report.lateAppended.push({
        proposalId,
        contactId,
        touchId,
        bounceType: bounce.type,
        email: bounce.email,
      });
      continue;
    }

    // ── The compensation, exactly the shipped lifecycle: a NEW touch through `beginTouch`
    //    + `recordTouch`. `'bounced'` is not in `LONG_INTERVAL_DISPOSITIONS`, so the clock
    //    moves to the SHORT retry; the follow-up close inside is an idempotent no-op (the
    //    row stays CLOSED — see the file header for why reopening it is forbidden).
    const touchId = await beginTouch(deps.crmDb, {
      contactId,
      channel: "email",
      proposalId,
    });
    await recordTouch(
      deps.crmDb,
      touchId,
      { disposition: "bounced" },
      deps.intervals,
      now,
    );
    report.compensated.push({
      proposalId,
      contactId,
      touchId,
      bounceType: bounce.type,
      email: bounce.email,
    });
  }

  return report;
}

/** 🚨 CASE-INSENSITIVE BY MEASUREMENT, NOT BY TASTE. We send the SMTP header
 *  `X-PM-Metadata-proposal-id`; Postmark's Messages API returned the key as
 *  `Proposal-ID` (measured live, 2026-08-15 — header-name canonicalisation on their
 *  side). An exact-key read of `proposal-id` matches NOTHING, silently classifying every
 *  one of our bounces as "not ours" — the whole feature off, reporting itself as quiet.
 *  So the key is matched case-insensitively, and the live-measured spelling is pinned. */
function metadataProposalId(
  metadata: Record<string, string> | null,
): string | undefined {
  if (metadata === null) return undefined;
  const want = PROPOSAL_METADATA_KEY.toLowerCase();
  for (const [k, v] of Object.entries(metadata)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

function noteNoMetadata(report: BounceReconcileReport, bounce: BounceRecord): void {
  report.noMetadata.count += 1;
  if (report.noMetadata.newest.length < NO_METADATA_NEWEST) {
    report.noMetadata.newest.push(bounce);
  }
}

/** The reconcile-listing idiom: loud things individually, expected things as an aggregate
 *  count plus the newest few. Returns null only when there is NOTHING to say at all —
 *  unmatched bounces DO surface (as the aggregate), because "never shown" is silence
 *  proper; the caller (the executor loop) prints a report only when it CHANGED since the
 *  last tick, because reprinting an unchanged aggregate every minute is silence by noise.
 *  The two dedupe classes (`alreadyCompensated`, `notClaimedSent`) alone never trigger a
 *  report: each is a bounce this system has already fully accounted for. */
export function formatBounceReport(r: BounceReconcileReport): string | null {
  const nothingHappened =
    r.compensated.length === 0 &&
    r.lateAppended.length === 0 &&
    r.anomalies.length === 0 &&
    r.noMetadata.count === 0;
  if (nothingHappened) return null;

  const lines: string[] = [];
  lines.push(
    `bounce reconcile: ${r.compensated.length} compensated, ` +
      `${r.lateAppended.length} late-appended, ${r.anomalies.length} anomalies ` +
      `(${r.alreadyCompensated} already recorded, ${r.notClaimedSent} never claimed sent, ` +
      `${r.noMetadata.count} without metadata — not ours)`,
  );
  for (const c of r.compensated) {
    lines.push(
      `  BOUNCED ${c.email} (${c.bounceType}) — proposal ${c.proposalId} ` +
        `touch ${c.touchId}: 'bounced' appended, clock pulled to short retry`,
    );
  }
  for (const c of r.lateAppended) {
    lines.push(
      `  LATE BOUNCE ${c.email} (${c.bounceType}) — proposal ${c.proposalId} ` +
        `touch ${c.touchId}: 'bounced' appended; clock NOT moved (later touch exists)`,
    );
  }
  for (const a of r.anomalies) {
    lines.push(
      `  ANOMALY bounce ${a.bounceId} (${a.email}): metadata proposal ${a.proposalId} ` +
        `has no touch — ${a.reason}`,
    );
  }
  if (r.noMetadata.count > 0) {
    const newest = r.noMetadata.newest
      .map((b) => `${b.email} (${b.type}) at ${b.bouncedAt}`)
      .join("; ");
    lines.push(`  without metadata: ${r.noMetadata.count} total — newest: ${newest}`);
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The real Postmark client. HTTPS to api.postmarkapp.com — NOT a mail relay socket;
// `email-transport.ts` remains the only file that can put a message ON the wire, and this
// one can only read back what the relay did with it.
// ─────────────────────────────────────────────────────────────────────────────────────────

const POSTMARK_API = "https://api.postmarkapp.com";

export function postmarkBounceFeed(
  serverToken: string,
  baseUrl: string = POSTMARK_API,
): BounceFeed {
  const headers = {
    Accept: "application/json",
    "X-Postmark-Server-Token": serverToken,
  };

  return {
    listBounces: async (count, offset) => {
      const res = await fetch(`${baseUrl}/bounces?count=${count}&offset=${offset}`, {
        headers,
      });
      if (!res.ok) {
        throw new Error(`Postmark bounces list failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        Bounces?: Array<{
          ID?: number | string;
          Type?: string;
          Email?: string;
          BouncedAt?: string;
          MessageID?: string;
        }>;
      };
      return (body.Bounces ?? []).map((b) => ({
        id: String(b.ID ?? ""),
        type: String(b.Type ?? ""),
        email: String(b.Email ?? ""),
        bouncedAt: String(b.BouncedAt ?? ""),
        messageId: b.MessageID ? String(b.MessageID) : null,
      }));
    },
    getMessageMetadata: async (messageId) => {
      const res = await fetch(
        `${baseUrl}/messages/outbound/${encodeURIComponent(messageId)}/details`,
        { headers },
      );
      if (res.status === 404) return null;
      if (!res.ok) {
        const text = await res.text();
        // 422 + ErrorCode 701 is Postmark's "message not found" — same meaning as 404.
        if (res.status === 422 && text.includes('"ErrorCode":701')) return null;
        throw new Error(`Postmark message details failed: ${res.status} ${text}`);
      }
      const body = (await res.json()) as { Metadata?: Record<string, string> };
      return body.Metadata ?? {};
    },
  };
}
