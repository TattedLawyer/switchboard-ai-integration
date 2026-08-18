// Part 2 / Piece A — the proposer's cycle-level sheet read.
//
// WHAT THIS IS. Her Google Sheet is the MASTER contact list; the proposer reads contact
// DETAILS (name, email, phones, context) from it LIVE at proposal time, so a card can
// never carry a detail she has already corrected away — and never a detail that exists
// only in a stale synced-down copy. This loader takes ONE snapshot per cycle and hands
// every claimed contact the same indexed view; per-contact fetches would multiply API
// reads by the batch size and let two contacts in one cycle see two different sheets.
//
// 🚨 THREE STATES, AND THE CALLER MUST TREAT THEM DIFFERENTLY:
//   · no_linked_sheet — the tenant runs manual-only; sheet-bound contacts cannot exist
//     bound to an ACTIVE sheet (unlink deactivates them), so nothing special follows.
//   · unavailable(reason) — the sheet exists but must not be proposed from THIS cycle:
//     the last adoption pass did not complete (a circuit-breaker halt included — F1a
//     below), or the read itself failed (transport unconfigured, network, revoked access,
//     unusable headers). Sheet-bound contacts must
//     SKIP: no follow_ups row, no block, no clock change beyond the claim lease already
//     taken — the lease expires and the next cycle re-claims. NEVER a stored-detail
//     fall-back; post-022 the stored details are not even readable by this role, and that
//     42501 is the control that keeps this rule honest.
//   · available — rows indexed by ref, fields already normalized by the shipped
//     `contactRowFields`.
//
// 🚨 NO LEDGER ROW IS WRITTEN HERE. `crm.sheet_reads` is the OWNER-run adoption pass's
// ledger and `switchboard_crm` holds SELECT only (021 — the insert is a measured 42501).
// A failed cycle read surfaces in the per-contact `skipped` reasons and the daemon log;
// the durable health record stays the adoption pass's single responsibility.
//
// 🚨 THE LANDMINE FROM sheet-columns.ts IS HONORED: columns are resolved BY HEADER NAME
// on THIS snapshot, inside this call, every cycle. Nothing here caches a mapping or an
// index across fetches — the returned rows are already reduced to named fields, so no
// positional information survives to be misused after the next column insert/reorder.
import type pg from "pg";
import {
  contactRowFields,
  isSheetRefusal,
  resolveContactColumns,
  type ContactRowFields,
} from "./sheet-columns.js";
import { classifySheetFailure, sheetReadCode } from "./sheet-adopt.js";
import type { SheetTransport } from "./sheet-client.js";

export type SheetCycleContext =
  | { kind: "no_linked_sheet" }
  | { kind: "unavailable"; reason: string }
  | {
      kind: "available";
      linkedSheetId: string;
      /** Data rows by ref. A ref ABSENT here means the row vanished or was cleared to
       *  blanks (the cell-clearing rule — an emptied row is a vanished row, exactly as
       *  the adoption pass reads it); the caller skips and the owner-run adoption pass
       *  writes the real `sheet_row_missing` block. */
      rowsByRef: Map<string, ContactRowFields>;
    };

/**
 * Load the active linked sheet's snapshot for one proposer cycle.
 *
 * Runs as `switchboard_crm`: SELECT on `crm.linked_sheets` is 021's grant, and the sheet
 * itself is read through the injected transport (the same `SheetTransport` seam the
 * adoption pass uses — FakeSheet in tests, the raw-API client in production).
 */
export async function loadSheetCycleContext(
  db: pg.Pool,
  tenantId: string,
  transport: SheetTransport | null | undefined,
): Promise<SheetCycleContext> {
  const linked = await db.query<{ id: string; spreadsheet_id: string }>(
    `select id, spreadsheet_id from crm.linked_sheets
      where tenant_id = $1 and unlinked_at is null`,
    [tenantId],
  );
  if (linked.rowCount !== 1) return { kind: "no_linked_sheet" };
  const sheet = linked.rows[0];

  // 🚨 BREAKER-AWARE (F1a). The OWNER-run adoption pass owns sheet health: every pass
  // records one `crm.sheet_reads` row, and ok=false means the pass DID NOT COMPLETE —
  // unreachable, refused headers, or a circuit-breaker halt (breaker_count /
  // breaker_displacement / breaker_drift; the displacement arm is the partial-range-sort
  // detector — values scrambled against row refs). Post-022 this role cannot read the
  // stored details, so it CANNOT re-run the value-integrity comparison itself: the ledger
  // verdict is the only displacement signal available here, and walking past it hands the
  // proposer a snapshot the breaker has already refused to trust — the proved
  // wrong-person-card path (Ana's ref riding Ben's values straight into `payload.to`).
  // So: latest read not ok => UNAVAILABLE for the whole cycle. Every sheet-bound contact
  // takes the existing skip path (no proposal, no block, no clock change beyond the claim
  // lease) until a COMPLETED pass records the sheet healthy again. A sheet with NO read
  // yet is not "not ok": contacts bound to it cannot predate its first adoption pass, and
  // treating absence as a halt would silence a freshly-linked book. 021 granted
  // `switchboard_crm` SELECT on `crm.sheet_reads` for exactly this kind of health read
  // (confirmed against the migration text; the insert stays the pass's, per the header).
  const lastRead = await db.query<{ ok: boolean; detail: string | null }>(
    `select ok, detail from crm.sheet_reads
      where linked_sheet_id = $1
      order by at desc limit 1`,
    [sheet.id],
  );
  if (lastRead.rowCount === 1 && !lastRead.rows[0].ok) {
    return {
      kind: "unavailable",
      reason:
        `the last sheet adoption pass did not complete ` +
        `(${sheetReadCode(lastRead.rows[0].detail)}); proposing from the live sheet is ` +
        `paused until a completed pass records it healthy again`,
    };
  }

  if (transport === null || transport === undefined) {
    // A linked sheet with no transport is a REAL outage for sheet-bound contacts, not a
    // configuration nuance: they skip until the key file is configured. Loud at the
    // caller, honest here.
    return {
      kind: "unavailable",
      reason:
        "the sheet transport is not configured (SHEETS_SERVICE_ACCOUNT_KEY_FILE unset), " +
        "so the linked sheet cannot be read",
    };
  }

  let snapshot;
  try {
    snapshot = await transport.readSnapshot(sheet.spreadsheet_id);
  } catch (err) {
    // Same classifier as the adoption pass, so "re-share with <service account>" reads
    // identically wherever it surfaces.
    return { kind: "unavailable", reason: classifySheetFailure(err, transport.serviceAccountEmail) };
  }

  // The FIRST tab is the contact list — the adoption pass's rule, kept byte-compatible.
  const tab = snapshot.tabs[0];
  const headerRow = tab?.rows.find((r) => r.rowIndex === 0);
  if (!tab || !headerRow) {
    return { kind: "unavailable", reason: "the sheet has no header row on its first tab" };
  }
  const mapping = resolveContactColumns(headerRow.cells);
  if (isSheetRefusal(mapping)) {
    return { kind: "unavailable", reason: mapping.error };
  }

  // 🚨 An all-blank row is NOT a row, even when a ref still rides it (sheet-adopt.ts's
  // cell-clearing rule, applied identically so the two readers can never disagree about
  // whether a row exists).
  const rowsByRef = new Map<string, ContactRowFields>();
  for (const r of tab.rows) {
    if (r.rowIndex === 0 || r.ref === null) continue;
    if (!r.cells.some((c) => c.trim() !== "")) continue;
    rowsByRef.set(r.ref, contactRowFields(mapping, r.cells));
  }
  return { kind: "available", linkedSheetId: sheet.id, rowsByRef };
}
