// Part 2 / Piece C — the SEND-TIME recheck against her live sheet.
//
// WHAT THIS IS. The proposer reads contact details LIVE at proposal time (Piece A), but a
// card approved on Monday can be sent on Tuesday to an address she has since corrected in
// her sheet — nothing rechecked at SEND time until this. `liveDetailRecheck` builds the
// function `executeEmail` consults through its optional `recheckLiveDetails` seam, between
// `checkSendable` and `beginExecution`; the executor obeys the verdict, this file decides it.
//
// 🚨 RULING #2 — RECIPIENT-ONLY. Only the RECIPIENT can block a send: for an email that is
// the email address, compared under the adoption pass's own `norm` (one definition,
// imported — never a second spelling). A changed name must NEVER block a send; neither may
// source_detail, looking_for, or notes. Grounding (researched and approved): PSD2 Art. 5
// dynamic linking binds the authentication code to amount AND payee and deliberately
// excludes cosmetic attributes; HubSpot's default keeps a contact enrolled through
// non-identity edits. The approval covered "send THIS text to THIS person"; the name on
// the card is display, the address is destination.
//
// 🚨 AMENDMENT A2 — WHEN THE SHEET'S HEALTH IS IN DOUBT, WAIT; NEVER SEND. A halted
// breaker (latest `crm.sheet_reads` ok=false) or an open `sheet_divergent` /
// `sheet_row_missing` block means the pass has refused to trust the sheet — and walking
// past that verdict is the PROVED end-to-end failure: an approved card shipping to
// ben@example.com recorded as a touch on contact "Ana Reyes". Same rule, byte-consistent,
// as `sheet-read.ts`'s breaker-aware cycle read (F1a) and the proposer's F1b block gate.
// A missing transport is an outage, not a licence to send: wait.
//
// 🚨 THE VERDICTS MAP TO THE SPINE DIFFERENTLY, and the executor's comment block explains
// the ordering: "wait" refuses BEFORE `beginExecution` (zero `approval.executions` rows,
// the proposal stays `approved`, the next tick retries — transient states retry for
// free), while "block" claims and immediately fails (the proposal lands terminal in
// `execution_failed` and `closeTerminatedFollowUps` cleans up — a card that can never be
// right must not retry forever).
//
// 🚨 POST-022 THIS ROLE CANNOT READ THE STORED DETAIL COLUMNS. `switchboard_crm` holds
// SELECT on exactly (id, tenant_id, display_name, channel, source, active,
// follow_up_interval_days, next_due_at, dial_rotation_ordinal, created_at, updated_at,
// linked_sheet_id, row_ref) — verified against `ingest/migrations/022_contact_detail_revoke.sql`.
// The query below reads only tenant_id/linked_sheet_id/row_ref; there IS no stored-detail
// fallback, and the 42501 that would greet one is the control that keeps this honest.
import type pg from "pg";
import {
  contactRowFields,
  isSheetRefusal,
  resolveContactColumns,
} from "./sheet-columns.js";
import { classifySheetFailure, norm, sheetReadCode } from "./sheet-adopt.js";
import type { SheetTransport } from "./sheet-client.js";
import type { FollowUpEmailPayload, Recheck } from "./executor.js";

/**
 * Build the send-time recheck for `EmailExecutorDeps.recheckLiveDetails`.
 *
 * Runs as `switchboard_crm` (the executor daemon's CRM pool); the sheet is read through
 * the same injected `SheetTransport` seam the proposer and the adoption pass use —
 * FakeSheet in tests, `sheetTransportFromEnv()` in the composition root.
 */
export function liveDetailRecheck(
  db: pg.Pool,
  transport: SheetTransport | null | undefined,
): (payload: FollowUpEmailPayload) => Promise<Recheck> {
  return async (payload) => {
    // a. The contact — only the post-022-readable identity columns (see header).
    const c = await db.query<{
      tenant_id: string;
      linked_sheet_id: string | null;
      row_ref: string | null;
    }>(`select tenant_id, linked_sheet_id, row_ref from crm.contacts where id = $1`, [
      payload.contact_id,
    ]);
    if (c.rowCount !== 1) {
      return {
        verdict: "block",
        reason:
          `this card's contact no longer exists in the database, so there is nobody to ` +
          `record the follow-up against; the card cannot be sent`,
      };
    }
    const contact = c.rows[0];

    // b. MANUAL contact — her sheet has no say. Send, and make NO transport call.
    if (contact.linked_sheet_id === null) return { verdict: "send" };

    // c. AMENDMENT A2 — health first. Latest ledger row not ok => the last adoption pass
    //    did not complete (breaker halts included), and this reader cannot re-run the
    //    value-integrity comparison itself (post-022 it cannot read the stored details):
    //    wording via `sheetReadCode`, same as sheet-read.ts's cycle read.
    const lastRead = await db.query<{ ok: boolean; detail: string | null }>(
      `select ok, detail from crm.sheet_reads
        where linked_sheet_id = $1
        order by at desc limit 1`,
      [contact.linked_sheet_id],
    );
    if (lastRead.rowCount === 1 && !lastRead.rows[0].ok) {
      return {
        verdict: "wait",
        reason:
          `the last sheet adoption pass did not complete ` +
          `(${sheetReadCode(lastRead.rows[0].detail)}); sending from the live sheet is ` +
          `paused until a completed pass records it healthy again`,
      };
    }
    //    …and an open sheet-level block on THIS contact is the pass's own verdict that
    //    its sheet values cannot be trusted (or its row vanished). The pass owns
    //    recovery; sending under it would be outreach to the very contact it paused.
    const paused = await db.query(
      `select 1 from crm.follow_ups
        where contact_id = $1 and closed_at is null
          and blocked_reason in ('sheet_row_missing', 'sheet_divergent')
        limit 1`,
      [payload.contact_id],
    );
    if ((paused.rowCount ?? 0) > 0) {
      return {
        verdict: "wait",
        reason:
          `this contact is paused by a sheet-level block (its sheet row went missing or ` +
          `its values diverged from storage); the sheet adoption pass owns recovery — ` +
          `the send waits until the pass closes the block`,
      };
    }

    // d. No transport is an OUTAGE for a sheet-bound contact, not a licence to send.
    if (transport === null || transport === undefined) {
      return {
        verdict: "wait",
        reason:
          "the sheet transport is not configured (SHEETS_SERVICE_ACCOUNT_KEY_FILE unset), " +
          "so the live sheet cannot be rechecked before sending",
      };
    }

    // e. The live row, by the SAME machinery the cycle read uses: spreadsheet id from the
    //    linked-sheets row (021's SELECT grant), first tab, columns re-resolved BY HEADER
    //    NAME on THIS snapshot, an all-blank row == a vanished row (the cell-clearing
    //    rule, applied identically so no two readers can disagree about row existence).
    const linked = await db.query<{ spreadsheet_id: string }>(
      `select spreadsheet_id from crm.linked_sheets
        where id = $1 and unlinked_at is null`,
      [contact.linked_sheet_id],
    );
    if (linked.rowCount !== 1) {
      // F2 — the FK guarantees the row EXISTS (never deleted, per unlinkSheet), so an
      // empty read here means `unlinked_at` is set: the kill-switch fired after this
      // card was approved. `sheet-read.ts`'s cycle read carries the same
      // `unlinked_at is null` filter — the two sheet readers must agree, or an
      // in-flight approved card re-validates against a severed sheet.
      return {
        verdict: "wait",
        reason:
          `the sheet this contact came from is no longer linked, so her sheet can no ` +
          `longer confirm the recipient; the send waits until a sheet is linked again`,
      };
    }
    let snapshot;
    try {
      snapshot = await transport.readSnapshot(linked.rows[0].spreadsheet_id);
    } catch (err) {
      return {
        verdict: "wait",
        reason: classifySheetFailure(err, transport.serviceAccountEmail),
      };
    }
    const tab = snapshot.tabs[0];
    const headerRow = tab?.rows.find((r) => r.rowIndex === 0);
    if (!tab || !headerRow) {
      return { verdict: "wait", reason: "the sheet has no header row on its first tab" };
    }
    const mapping = resolveContactColumns(headerRow.cells);
    if (isSheetRefusal(mapping)) {
      return { verdict: "wait", reason: mapping.error };
    }
    //    F1 — an unresolved EMAIL COLUMN is a mapping doubt, not a vanished recipient:
    //    the address may still sit in her sheet under a header this mapper no longer
    //    recognises (a renamed "Email" header). Same family as the whole-sheet refusal
    //    just above — WAIT, never the terminal block. `positions.email` is the honest
    //    signal: `contactRowFields` reads the email cell through exactly this position,
    //    so an undefined position means emailAddress:null for STRUCTURAL reasons, which
    //    must not impersonate "her sheet says this contact has no email".
    if (mapping.positions.email === undefined) {
      return {
        verdict: "wait",
        reason:
          `the email column could not be found in the sheet's headers ` +
          `(headers seen: ${JSON.stringify(headerRow.cells)}); the send waits until ` +
          `the email column is recognisable again`,
      };
    }
    const row = tab.rows.find(
      (r) =>
        r.rowIndex !== 0 &&
        r.ref === contact.row_ref &&
        r.cells.some((cell) => cell.trim() !== ""),
    );
    if (row === undefined) {
      // Vanished (or cleared to blanks). The OWNER-run adoption pass writes the real
      // `sheet_row_missing` block; this reader only declines to send meanwhile.
      return {
        verdict: "wait",
        reason:
          `this contact's row is not in the live sheet any more; the send waits for the ` +
          `sheet adoption pass to record what happened to it`,
      };
    }

    // f. RULING #2 — compare ONLY the recipient, under the adoption pass's own `norm`.
    const live = contactRowFields(mapping, row.cells);
    if (norm(live.emailAddress) !== norm(payload.to)) {
      const now =
        live.emailAddress === null
          ? "no longer lists an email address for this contact"
          : `now lists ${live.emailAddress} for this contact`;
      return {
        verdict: "block",
        reason:
          `this card was approved to send to ${payload.to}, but the sheet ${now} — ` +
          `the approved card is out of date, so it was not sent; the next proposal will ` +
          `use the corrected address`,
      };
    }
    return { verdict: "send" };
  };
}
