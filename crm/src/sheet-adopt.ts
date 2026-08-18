// The sheet foundation: link/unlink, the adoption pass, and the health surface.
//
// WHAT THIS IS. The client's Google Sheet is the master contact list. The adoption pass —
// OWNER-credentialed, run on the reconcile loop — reads one snapshot (values + row refs in
// one request) and makes the database agree with the sheet about WHO EXISTS. Contact
// details stay sheet-side (read live in the proposer integration, part 2); this layer owns
// identity, adoption, and health.
//
// 🚨 ABSENCE OF EVIDENCE IS NEVER DELETION. A failed read records ONE `sheet_reads` row
// with ok=false and does NOTHING else — no blocks, no deactivations, no clock changes. The
// deletion signal is a SUCCESSFUL snapshot in which a known ref does not appear (measured
// ground: delete removes exactly that row's ref; sort/insert move refs WITH their rows).
//
// 🚨 THE CIRCUIT BREAKER HAS THREE ARMS, each for a failure the others are blind to.
// COUNT: a single pass that would adopt or block more than a threshold halts — a wrong
// sheet, a mass deletion, a half-loaded snapshot. DISPLACEMENT (the primary value-integrity
// arm): a sort is a PERMUTATION — it produces no new values. A diverged row whose new
// normalized value equals a value stored under a DIFFERENT ref is a MOVED value, not an
// edited one; legitimate edits produce NOVEL values. Compared per field (display_name,
// email, phone E.164 set — never whole-tuple, because a name-only column sort displaces
// names while emails stay put), blanks excluded. TWO simultaneous displacements on any one
// field is a swap (one can be coincidence — two genuine "Maria Santos" rows), so the pass
// halts at an ABSOLUTE COUNT with no minimum sample: a 4-row book scrambled is exactly as
// halted as a 400-row one. DRIFT (percentage backstop, kept for NON-permutation drift —
// garbage overwrite, novel-value corruption — that displacement is deliberately blind to):
// when more than K% of ref'd rows diverge in one pass, and at least two rows moved (one
// changed row is never a mass event), the pass halts and says so. All arms halt BEFORE any
// adoption write; a value-integrity halt additionally PAUSES the divergent contacts
// (`sheet_divergent` block + `next_due_at = null`) so a halt stops outreach to the very
// contacts whose stored details can no longer be trusted — a halt that leaves the proposer
// dialling stored numbers is not a safety measure. Neither arm runs on a sheet's FIRST
// import (there is no stored state to corrupt, and importing every row is the point of
// linking).
//
// 🚨 BLOCKED ≠ DEACTIVATED. A contact whose row is missing from the snapshot gets an open
// `sheet_row_missing` block and a PAUSED clock (`next_due_at = null`), never
// `active = false` (deactivation on a missing row is deferred by owner decision). The
// paused clock is load-bearing, not decoration: the proposer's `openFollowUp` upsert
// CLEARS `blocked_reason` on today's row as its B-B recovery path, so a still-due contact
// would steamroll the block within one cycle and the follow-up would happen against a row
// she deleted. When the ref reappears, the pass closes the block and restarts the clock.
import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
  contactRowFields,
  isSheetRefusal,
  resolveContactColumns,
  type ContactRowFields,
} from "./sheet-columns.js";
import { SheetApiError, type SheetSnapshot, type SheetTransport } from "./sheet-client.js";
import type { NormalizedPhone } from "./phone.js";

// ── Thresholds ─────────────────────────────────────────────────────────────────────────
/** Creates + new blocks one pass may perform before halting. Env: CRM_SHEET_MAX_CHANGES. */
export const DEFAULT_MAX_CHANGES = 25;
/** Percentage of ref'd rows whose name/email/phones may change in one pass — the backstop
 *  arm for non-permutation drift. Env: CRM_SHEET_MAX_DRIFT_PCT. */
export const DEFAULT_MAX_DRIFT_PCT = 20;
/** Displaced rows (per field) at which the displacement arm halts. An ABSOLUTE count, no
 *  minimum sample — the former DRIFT_MIN_SAMPLE was the small-book blind spot: a book
 *  below the sample fully scrambled synced silently. One displacement can be coincidence
 *  (two genuine "Maria Santos" rows); two simultaneous ones is a swap.
 *  Env: CRM_SHEET_DISPLACEMENT_HALT. */
export const DEFAULT_DISPLACEMENT_HALT = 2;

export interface AdoptionThresholds {
  maxChanges?: number;
  maxDriftPct?: number;
  displacementHalt?: number;
}

/**
 * Read and VALIDATE the breaker thresholds from the environment, throwing on garbage.
 * `Number("2O")` is NaN, and every `>` comparison against NaN is false — a typo'd env var
 * would silently disable the breaker arms. The interval variable already refuses to boot on
 * garbage; the safety feature must do the same.
 */
export function adoptionThresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AdoptionThresholds {
  const read = (name: string, dflt: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) {
      throw new Error(
        `invalid ${name} "${raw}" — expected a number between ${min} and ${max}. ` +
          `Refusing to run: an unparseable threshold would silently disable the circuit breaker.`,
      );
    }
    return n;
  };
  return {
    maxChanges: read("CRM_SHEET_MAX_CHANGES", DEFAULT_MAX_CHANGES, 1, 1_000_000),
    maxDriftPct: read("CRM_SHEET_MAX_DRIFT_PCT", DEFAULT_MAX_DRIFT_PCT, 1, 100),
    displacementHalt: read("CRM_SHEET_DISPLACEMENT_HALT", DEFAULT_DISPLACEMENT_HALT, 1, 1_000_000),
  };
}

// ── Health codes ───────────────────────────────────────────────────────────────────────
/** `sheet_reads.detail` begins with one of these, colon-terminated. The digest and the
 *  reconcile listing branch on the code because the ACTIONS differ: unreachable = wait
 *  (nothing lost), permission_revoked = re-share with the named service account,
 *  breaker_* = look at the sheet before trusting it, refused = fix the headers. */
export type SheetReadCode =
  | "ok"
  | "unreachable"
  | "permission_revoked"
  | "breaker_count"
  | "breaker_displacement"
  | "breaker_drift"
  | "refused";

export function sheetReadCode(detail: string | null): SheetReadCode {
  const m = /^([a-z_]+):/.exec(detail ?? "");
  switch (m?.[1]) {
    case "ok":
    case "unreachable":
    case "permission_revoked":
    case "breaker_count":
    case "breaker_displacement":
    case "breaker_drift":
    case "refused":
      return m[1];
    default:
      return "unreachable"; // an unclassifiable failure pauses, it never deletes
  }
}

/** 403 and 404 both mean "the service account cannot see the sheet" (Google answers 404
 *  for exists-but-not-shared); everything else — network, 429 exhausted, 5xx — is
 *  unreachability: follow-ups pause, nothing is lost. */
export function classifySheetFailure(err: unknown, serviceAccountEmail: string): string {
  if (err instanceof SheetApiError && (err.status === 403 || err.status === 404)) {
    return (
      `permission_revoked: the sheet no longer shares access with ${serviceAccountEmail} ` +
      `(HTTP ${err.status}). Re-share the sheet with that address and adoption resumes by itself.`
    );
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `unreachable: ${msg}`;
}

// ── Link / unlink ──────────────────────────────────────────────────────────────────────

export interface LinkResult {
  linkedSheetId: string;
  /** true when an unlinked row for this spreadsheet was reactivated (same identity). */
  relinked: boolean;
}

/**
 * Link a sheet (owner-credentialed). ONE linked sheet at a time: linking while another is
 * active raises 23505 on `linked_sheets_one_active` — unlink first, by design.
 *
 * 🚨 A RELINK REACTIVATES THE SAME ROW, matched on `spreadsheet_id`. A fresh row would
 * change every contact's identity tuple `(linked_sheet_id, row_ref)` and the next adoption
 * pass would re-import the whole sheet as duplicates with the history orphaned on the
 * deactivated originals.
 */
export async function linkSheet(
  admin: pg.Pool,
  tenantId: string,
  spreadsheetId: string,
  label: string | null = null,
): Promise<LinkResult> {
  const existing = await admin.query<{ id: string }>(
    `select id from crm.linked_sheets where tenant_id = $1 and spreadsheet_id = $2`,
    [tenantId, spreadsheetId],
  );
  if (existing.rowCount === 1) {
    await admin.query(
      `update crm.linked_sheets
          set unlinked_at = null, label = coalesce($2, label)
        where id = $1`,
      [existing.rows[0].id, label],
    );
    return { linkedSheetId: existing.rows[0].id, relinked: true };
  }
  const inserted = await admin.query<{ id: string }>(
    `insert into crm.linked_sheets (tenant_id, spreadsheet_id, label)
     values ($1, $2, $3) returning id`,
    [tenantId, spreadsheetId, label],
  );
  return { linkedSheetId: inserted.rows[0].id, relinked: false };
}

export interface UnlinkResult {
  linkedSheetId: string;
  contactsDeactivated: number;
  followUpsClosed: number;
}

/**
 * Unlink the active sheet (owner-credentialed). ONE TRANSACTION, three effects:
 *   1. `unlinked_at` set — the row is never deleted (identity must survive for relink);
 *   2. that sheet's contacts deactivated and their clocks killed (`next_due_at = null`);
 *   3. 🚨 EVERY open follow-up of those contacts closed — BLOCKED ONES INCLUDED. This is
 *      the permanent-noise class this repo has re-fixed three times:
 *      `closeTerminatedFollowUps` requires `blocked_reason is null` AND inner-joins
 *      `follow_up_actions`, and a blocked row has no actions — so no shipped writer can
 *      EVER close a blocked row of a deactivated contact, and it would sit in the digest
 *      and the reconcile listing forever.
 */
export async function unlinkSheet(admin: pg.Pool, tenantId: string): Promise<UnlinkResult> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    const sheet = await client.query<{ id: string }>(
      `update crm.linked_sheets set unlinked_at = now()
        where tenant_id = $1 and unlinked_at is null
        returning id`,
      [tenantId],
    );
    if (sheet.rowCount !== 1) {
      await client.query("rollback");
      throw new Error(`no linked sheet to unlink for tenant ${tenantId}`);
    }
    const sheetId = sheet.rows[0].id;
    // Blocked ones included: no `blocked_reason` predicate, deliberately.
    const closed = await client.query(
      `update crm.follow_ups f
          set closed_at = now()
         from crm.contacts c
        where f.contact_id = c.id
          and c.linked_sheet_id = $1
          and f.closed_at is null`,
      [sheetId],
    );
    const deactivated = await client.query(
      `update crm.contacts
          set active = false, next_due_at = null, updated_at = now()
        where linked_sheet_id = $1 and active`,
      [sheetId],
    );
    await client.query("commit");
    return {
      linkedSheetId: sheetId,
      contactsDeactivated: deactivated.rowCount ?? 0,
      followUpsClosed: closed.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ── The adoption pass ──────────────────────────────────────────────────────────────────

export interface AdoptionDeps {
  /** MIGRATION OWNER. The pass creates contacts and writes follow-up blocks — 016 §I-3
   *  operator territory; `switchboard_crm` is deliberately not widened for any of it. */
  admin: pg.Pool;
  transport: SheetTransport;
  thresholds?: AdoptionThresholds;
}

export interface AdoptionReport {
  linkedSheetId: string;
  spreadsheetId: string;
  completed: boolean;
  /** true when another pass held this sheet's advisory lock — nothing was done or recorded. */
  skipped: boolean;
  code: SheetReadCode;
  /** What was written to `sheet_reads.detail`, verbatim. */
  detail: string;
  adopted: number;
  rebound: number;
  reactivated: number;
  refsMinted: number;
  blocked: number;
  recovered: number;
  synced: number;
  refWriteFailed: boolean;
  rowErrors: Array<{ rowIndex: number; error: string }>;
}

interface BoundContact {
  id: string;
  row_ref: string;
  display_name: string | null;
  email_address: string | null;
  active: boolean;
}

/** The adoption pass's normalisation — trim + lowercase. EXPORTED so the send-time
 *  recheck (`send-recheck.ts`) compares recipients under the SAME rule: one definition,
 *  because two `norm`s that drift apart would let the same sheet edit read as "changed"
 *  to one reader and "unchanged" to the other. */
export const norm = (s: string | null): string => (s ?? "").trim().toLowerCase();

async function recordRead(
  db: pg.Pool | pg.PoolClient,
  tenantId: string,
  linkedSheetId: string,
  ok: boolean,
  detail: string,
): Promise<void> {
  await db.query(
    `insert into crm.sheet_reads (tenant_id, linked_sheet_id, ok, detail)
     values ($1, $2, $3, $4)`,
    [tenantId, linkedSheetId, ok, detail],
  );
}

/** Today's date in the tenant's timezone, Postgres-computed (the one clock authority —
 *  digest.ts's rule; Manila is UTC+8 and a JS date here would be the fourth boundary bug). */
async function localToday(db: pg.Pool, tenantId: string): Promise<string> {
  const r = await db.query<{ today: string }>(
    `select ((now() at time zone coalesce(
               (select s.timezone from crm.outreach_settings s where s.tenant_id = $1),
               'Asia/Manila')))::date::text as today`,
    [tenantId],
  );
  return r.rows[0].today;
}

/** The advisory-lock namespace, one key per linked sheet: `hashtextextended(NS || id, 0)`.
 *  Exported so a test can hold the very lock the pass takes. */
export const SHEET_ADOPT_LOCK_NS = "switchboard.sheet_adopt:";

/**
 * Run the adoption pass for ONE active linked sheet. Every outcome — success, refusal,
 * failure, breaker halt — records exactly one `sheet_reads` row; a pass that says nothing
 * is the failure mode this repo names as its worst. (One deliberate exception: a pass that
 * SKIPS because another pass holds the sheet's lock records nothing — the pass that holds
 * the lock records the outcome, and two ledger rows for one read would be noise.)
 *
 * 🚨 ONE PASS PER SHEET AT A TIME, enforced by `pg_try_advisory_lock` on a per-sheet key.
 * Two overlapping passes (a hung read outliving the scheduler tick) have minted duplicate
 * contacts AND permanently blocked a live one via a stale snapshot — demonstrated, not
 * hypothesized. Non-blocking: a held lock means skip quietly. No TTL to tune: Postgres
 * releases session advisory locks when the connection closes, so a crashed pass cannot
 * wedge the next one (PostgreSQL docs, "Advisory Locks" — verified established practice).
 */
export async function runSheetAdoption(
  deps: AdoptionDeps,
  sheet: { id: string; tenantId: string; spreadsheetId: string },
): Promise<AdoptionReport> {
  const report: AdoptionReport = {
    linkedSheetId: sheet.id,
    spreadsheetId: sheet.spreadsheetId,
    completed: false,
    skipped: false,
    code: "ok",
    detail: "",
    adopted: 0,
    rebound: 0,
    reactivated: 0,
    refsMinted: 0,
    blocked: 0,
    recovered: 0,
    synced: 0,
    refWriteFailed: false,
    rowErrors: [],
  };

  // The lock lives on ONE dedicated session for the whole pass (a pool's `query()` may use
  // a different connection per call, and advisory locks are session-scoped).
  const lockClient = await deps.admin.connect();
  let locked = false;
  try {
    const lk = await lockClient.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(hashtextextended($1 || $2, 0)) as locked`,
      [SHEET_ADOPT_LOCK_NS, sheet.id],
    );
    locked = lk.rows[0].locked;
    if (!locked) {
      report.skipped = true;
      report.detail =
        "skipped: another adoption pass holds this sheet's lock; nothing was done";
      return report;
    }
    return await adoptionPass(deps, sheet, report);
  } finally {
    if (locked) {
      await lockClient
        .query(`select pg_advisory_unlock(hashtextextended($1 || $2, 0))`, [
          SHEET_ADOPT_LOCK_NS,
          sheet.id,
        ])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

async function adoptionPass(
  deps: AdoptionDeps,
  sheet: { id: string; tenantId: string; spreadsheetId: string },
  report: AdoptionReport,
): Promise<AdoptionReport> {
  const { admin, transport } = deps;
  const maxChanges = deps.thresholds?.maxChanges ?? DEFAULT_MAX_CHANGES;
  const maxDriftPct = deps.thresholds?.maxDriftPct ?? DEFAULT_MAX_DRIFT_PCT;
  const displacementHalt = deps.thresholds?.displacementHalt ?? DEFAULT_DISPLACEMENT_HALT;

  const halt = async (code: SheetReadCode, detail: string): Promise<AdoptionReport> => {
    report.code = code;
    report.detail = detail;
    await recordRead(admin, sheet.tenantId, sheet.id, false, detail);
    return report;
  };

  // ── 1. Read. On failure: record ok=false and DO NOTHING ELSE. ────────────────────────
  let snapshot: SheetSnapshot;
  try {
    snapshot = await transport.readSnapshot(sheet.spreadsheetId);
  } catch (err) {
    return halt(
      sheetReadCode(classifySheetFailure(err, transport.serviceAccountEmail)),
      classifySheetFailure(err, transport.serviceAccountEmail),
    );
  }

  // The FIRST tab is the contact list. Refs on other tabs are invisible to this pass —
  // and a duplicated tab carries no metadata at all (measured), so a copy cannot compete.
  const tab = snapshot.tabs[0];
  const headerRow = tab?.rows.find((r) => r.rowIndex === 0);
  if (!tab || !headerRow) {
    return halt("refused", "refused: the sheet has no header row on its first tab");
  }
  const mapping = resolveContactColumns(headerRow.cells);
  if (isSheetRefusal(mapping)) {
    return halt("refused", `refused: ${mapping.error}`);
  }

  interface SheetContactRow {
    rowIndex: number;
    ref: string | null;
    fields: ContactRowFields;
  }
  // 🚨 An all-blank row is NOT a row, even when a ref still rides it. Clearing a row's
  // CELLS (rather than deleting the row) leaves the ref alive; treating that as a matched
  // row would keep the contact active and due, dialling someone she visibly removed with
  // the nameless greeting. Dropped here, the ref goes unseen and the contact takes the
  // missing-row path: blocked, paused, recoverable when the cells return.
  const dataRows: SheetContactRow[] = tab.rows
    .filter((r) => r.rowIndex > 0)
    .filter((r) => r.cells.some((c) => c.trim() !== ""))
    .map((r) => ({ rowIndex: r.rowIndex, ref: r.ref, fields: contactRowFields(mapping, r.cells) }));

  // ── 2. Plan against what is stored. ──────────────────────────────────────────────────
  const bound = await admin.query<BoundContact>(
    `select id, row_ref, display_name, email_address, active
       from crm.contacts where linked_sheet_id = $1`,
    [sheet.id],
  );
  const byRef = new Map(bound.rows.map((c) => [c.row_ref, c]));
  const firstImport = bound.rowCount === 0;

  // Stored phone sets (E.164) per bound contact — the phone leg of divergence,
  // displacement, and the matched-row sync.
  const storedPhoneRows = await admin.query<{ contact_id: string; phone_e164: string }>(
    `select contact_id, phone_e164 from crm.phone_numbers
      where contact_id in (select id from crm.contacts where linked_sheet_id = $1)`,
    [sheet.id],
  );
  const phonesByContact = new Map<string, Set<string>>();
  for (const p of storedPhoneRows.rows) {
    const set = phonesByContact.get(p.contact_id) ?? new Set<string>();
    set.add(p.phone_e164);
    phonesByContact.set(p.contact_id, set);
  }

  const seenRefs = new Set(dataRows.flatMap((r) => (r.ref !== null ? [r.ref] : [])));
  const matched = dataRows.filter((r) => r.ref !== null && byRef.has(r.ref));
  const unmatchedRef = dataRows.filter((r) => r.ref !== null && !byRef.has(r.ref));
  const noRef = dataRows.filter((r) => r.ref === null);
  const missing = bound.rows.filter((c) => c.active && !seenRefs.has(c.row_ref));

  // Standing outages stay blocked without re-tripping the breaker: only NEW blocks count.
  const alreadyBlocked = await admin.query<{ contact_id: string }>(
    `select distinct f.contact_id from crm.follow_ups f
      where f.blocked_reason = 'sheet_row_missing' and f.closed_at is null
        and f.contact_id in (select id from crm.contacts where linked_sheet_id = $1)`,
    [sheet.id],
  );
  const blockedSet = new Set(alreadyBlocked.rows.map((r) => r.contact_id));
  const newBlocks = missing.filter((c) => !blockedSet.has(c.id));

  // Per-row divergence, PER FIELD. Phone divergence is one-directional by design: a number
  // on the sheet that is not stored is divergence; a stored number absent from the sheet is
  // not (nothing here deletes numbers, so the stored set is a superset after every sync and
  // a symmetric comparison would mark rows divergent forever).
  interface RowChanges {
    nameChanged: boolean;
    emailChanged: boolean;
    /** Snapshot numbers not yet stored for this contact, deduped by E.164, dial order. */
    newPhones: NormalizedPhone[];
  }
  const changesByRow = new Map<SheetContactRow, RowChanges>();
  for (const r of matched) {
    const c = byRef.get(r.ref as string) as BoundContact;
    const stored = phonesByContact.get(c.id) ?? new Set<string>();
    const inRow = new Set<string>();
    const newPhones = r.fields.phones.filter((p) => {
      if (stored.has(p.e164) || inRow.has(p.e164)) return false;
      inRow.add(p.e164);
      return true;
    });
    const nameChanged = norm(c.display_name) !== norm(r.fields.displayName);
    const emailChanged = norm(c.email_address) !== norm(r.fields.emailAddress);
    if (nameChanged || emailChanged || newPhones.length > 0) {
      changesByRow.set(r, { nameChanged, emailChanged, newPhones });
    }
  }
  const divergent = matched.filter((r) => changesByRow.has(r));

  // A value-integrity halt pauses the divergent contacts: `sheet_divergent` block + clock
  // to null — the `sheet_row_missing` shape with its own reason. Without this, a halt only
  // stops ADOPTING while the proposer keeps proposing from stored (possibly already-corrupt)
  // contacts and phones. A completed pass closes these blocks again (step 7).
  const pauseDivergent = async (): Promise<number> => {
    const ids = divergent
      .map((r) => byRef.get(r.ref as string) as BoundContact)
      .filter((c) => c.active)
      .map((c) => c.id);
    if (ids.length === 0) return 0;
    const today = await localToday(admin, sheet.tenantId);
    for (const id of ids) {
      await admin.query(
        `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
         values ($1, $2::date, 'sheet_divergent')
         on conflict (contact_id, due_date)
           do update set blocked_reason = coalesce(crm.follow_ups.blocked_reason,
                                                   excluded.blocked_reason)`,
        [id, today],
      );
      await admin.query(
        `update crm.contacts set next_due_at = null, updated_at = now()
          where id = $1 and next_due_at is not null`,
        [id],
      );
    }
    return ids.length;
  };

  // ── 3. The breaker — all arms, BEFORE any adoption write, never on a first import. ────
  if (!firstImport) {
    const changes = unmatchedRef.length + noRef.length + newBlocks.length;
    if (changes > maxChanges) {
      return halt(
        "breaker_count",
        `breaker_count: one pass would adopt ${unmatchedRef.length + noRef.length} row(s) ` +
          `and block ${newBlocks.length} missing contact(s) — over the limit of ${maxChanges}. ` +
          `Nothing was changed. If this reorganisation is deliberate, raise ` +
          `CRM_SHEET_MAX_CHANGES for one run.`,
      );
    }

    // DISPLACEMENT — the primary value-integrity arm. Per field, count divergent rows
    // whose NEW normalized value is already stored under a DIFFERENT contact of this
    // sheet. Blank values never match (blank rows would otherwise "displace" each other).
    const nameOwners = new Map<string, Set<string>>();
    const emailOwners = new Map<string, Set<string>>();
    const phoneOwners = new Map<string, Set<string>>();
    const own = (m: Map<string, Set<string>>, value: string, id: string): void => {
      if (value === "") return;
      const set = m.get(value) ?? new Set<string>();
      set.add(id);
      m.set(value, set);
    };
    for (const c of bound.rows) {
      own(nameOwners, norm(c.display_name), c.id);
      own(emailOwners, norm(c.email_address), c.id);
      for (const p of phonesByContact.get(c.id) ?? []) own(phoneOwners, p, c.id);
    }
    const ownedByOther = (m: Map<string, Set<string>>, value: string, selfId: string): boolean => {
      if (value === "") return false;
      const owners = m.get(value);
      if (owners === undefined) return false;
      return [...owners].some((id) => id !== selfId);
    };
    let namesDisplaced = 0;
    let emailsDisplaced = 0;
    let phonesDisplaced = 0;
    for (const r of divergent) {
      const c = byRef.get(r.ref as string) as BoundContact;
      const ch = changesByRow.get(r) as RowChanges;
      if (ch.nameChanged && ownedByOther(nameOwners, norm(r.fields.displayName), c.id)) {
        namesDisplaced++;
      }
      if (ch.emailChanged && ownedByOther(emailOwners, norm(r.fields.emailAddress), c.id)) {
        emailsDisplaced++;
      }
      if (ch.newPhones.some((p) => ownedByOther(phoneOwners, p.e164, c.id))) {
        phonesDisplaced++;
      }
    }
    const worstDisplaced = Math.max(namesDisplaced, emailsDisplaced, phonesDisplaced);
    if (worstDisplaced >= displacementHalt) {
      const paused = await pauseDivergent();
      return halt(
        "breaker_displacement",
        `breaker_displacement: ${namesDisplaced} name(s), ${emailsDisplaced} email(s) and ` +
          `${phonesDisplaced} phone row(s) took over values already stored for a DIFFERENT ` +
          `row. Edits produce novel values; only a sort or cross-row paste MOVES them — the ` +
          `signature of a PARTIAL-RANGE SORT. Nothing was imported, and ${paused} affected ` +
          `contact(s) are paused until the sheet is fixed. Undo the sort or re-sort the ` +
          `full range; if this reorganisation is deliberate, raise ` +
          `CRM_SHEET_DISPLACEMENT_HALT for one run.`,
      );
    }

    // DRIFT — the percentage backstop for NON-permutation corruption (novel-value garbage
    // a displacement check cannot see). At least two rows must have moved: one changed row
    // is a legitimate edit at any book size, never a mass event.
    if (
      divergent.length >= 2 &&
      matched.length > 0 &&
      (divergent.length / matched.length) * 100 > maxDriftPct
    ) {
      const paused = await pauseDivergent();
      return halt(
        "breaker_drift",
        `breaker_drift: ${divergent.length} of ${matched.length} ref'd row(s) changed ` +
          `name/email/phones in one pass — over ${maxDriftPct}%. Nothing was imported, and ` +
          `${paused} affected contact(s) are paused until the sheet is fixed. This is the ` +
          `signature of a PARTIAL-RANGE SORT (values scrambled against rows while refs stay ` +
          `put); undo the sort or re-sort the full range before trusting any row.`,
      );
    }
  }

  // ── 4. Mint refs for ref-less rows, WRITE THEM BACK FIRST, then adopt. ───────────────
  // A contact created before its ref is durably on the sheet would be re-minted as a
  // duplicate on the next pass, so a failed write-back skips those rows entirely.
  let mintable: Array<SheetContactRow & { ref: string }> = noRef.map((r) => ({
    ...r,
    ref: randomUUID(),
  }));
  if (mintable.length > 0) {
    try {
      await transport.writeRowRefs(
        sheet.spreadsheetId,
        mintable.map((m) => ({ sheetId: tab.sheetId, rowIndex: m.rowIndex, ref: m.ref })),
      );
      report.refsMinted = mintable.length;
    } catch (err) {
      report.refWriteFailed = true;
      report.rowErrors.push(
        ...mintable.map((m) => ({
          rowIndex: m.rowIndex,
          error: `ref write-back failed; row skipped this pass: ${
            err instanceof Error ? err.message : String(err)
          }`,
        })),
      );
      mintable = [];
    }
  }

  // ── 5. Adopt: rebind-on-return, else create. PER-ROW ISOLATION — one malformed row
  //       must not abort the pass. ─────────────────────────────────────────────────────
  const toAdopt = [...unmatchedRef.map((r) => ({ ...r, ref: r.ref as string })), ...mintable];
  for (const row of toAdopt) {
    try {
      const outcome = await adoptRow(admin, sheet, row.ref, row.fields);
      if (outcome === "rebound") report.rebound++;
      else report.adopted++;
    } catch (err) {
      report.rowErrors.push({
        rowIndex: row.rowIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Matched rows: reactivate a relink's deactivated contacts; sync the stored name/email
  // baseline for drift the breaker accepted (per-pass drift, not cumulative — without the
  // re-baseline, months of legitimate edits would eventually trip the drift arm); and SYNC
  // PHONES — a corrected number that only ever landed at adoption would never reach the
  // dialer. Insert-only by E.164 (016 grants no DELETE and numbers are never deleted here);
  // a number she removed from the sheet stays stored until a deliberate removal path exists.
  for (const row of matched) {
    const c = byRef.get(row.ref as string) as BoundContact;
    const ch = changesByRow.get(row);
    try {
      if (!c.active) {
        await admin.query(
          `update crm.contacts
              set active = true, next_due_at = coalesce(next_due_at, now()),
                  display_name = $2, email_address = $3, updated_at = now()
            where id = $1`,
          [c.id, row.fields.displayName, row.fields.emailAddress],
        );
        for (const p of ch?.newPhones ?? []) await insertPhone(admin, c.id, p);
        report.reactivated++;
      } else if (ch !== undefined) {
        if (ch.nameChanged || ch.emailChanged) {
          await admin.query(
            `update crm.contacts
                set display_name = $2, email_address = $3, updated_at = now()
              where id = $1`,
            [c.id, row.fields.displayName, row.fields.emailAddress],
          );
        }
        for (const p of ch.newPhones) await insertPhone(admin, c.id, p);
        report.synced++;
      }
    } catch (err) {
      report.rowErrors.push({
        rowIndex: row.rowIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 6. Missing rows: block and pause — NEVER deactivate (owner decision). ────────────
  if (missing.length > 0) {
    const today = await localToday(admin, sheet.tenantId);
    for (const c of missing) {
      try {
        await admin.query(
          `insert into crm.follow_ups (contact_id, due_date, blocked_reason)
           values ($1, $2::date, 'sheet_row_missing')
           on conflict (contact_id, due_date)
             do update set blocked_reason = coalesce(crm.follow_ups.blocked_reason,
                                                     excluded.blocked_reason)`,
          [c.id, today],
        );
        // Pause the clock EVERY pass, not just on the first block: an executed in-flight
        // card restarts the clock via recordTouch, and an un-paused missing-row contact
        // would be re-proposed while the blocked row sits there pretending to protect her.
        await admin.query(
          `update crm.contacts set next_due_at = null, updated_at = now()
            where id = $1 and next_due_at is not null`,
          [c.id],
        );
        if (!blockedSet.has(c.id)) report.blocked++;
      } catch (err) {
        report.rowErrors.push({ rowIndex: -1, error: `block ${c.id}: ${String(err)}` });
      }
    }
  }

  // ── 7. Returned rows: close the block, restart the clock. `sheet_divergent` blocks
  //       (written by a value-integrity halt) close the same way: this pass COMPLETED, so
  //       every divergence was either synced or accepted — the stored values are trusted
  //       again and outreach resumes. ──────────────────────────────────────────────────
  const recovered = await admin.query<{ contact_id: string }>(
    `update crm.follow_ups f
        set closed_at = now()
       from crm.contacts c
      where f.contact_id = c.id
        and c.linked_sheet_id = $1
        and f.blocked_reason in ('sheet_row_missing', 'sheet_divergent')
        and f.closed_at is null
        and c.row_ref = any($2)
      returning f.contact_id`,
    [sheet.id, [...seenRefs]],
  );
  if ((recovered.rowCount ?? 0) > 0) {
    await admin.query(
      `update crm.contacts set next_due_at = coalesce(next_due_at, now()), updated_at = now()
        where id = any($1)`,
      [recovered.rows.map((r) => r.contact_id)],
    );
    report.recovered = recovered.rowCount ?? 0;
  }

  // ── 8. The ledger row. ───────────────────────────────────────────────────────────────
  report.completed = true;
  report.code = "ok";
  report.detail =
    `ok: adopted ${report.adopted}, rebound ${report.rebound}, reactivated ` +
    `${report.reactivated}, refs_minted ${report.refsMinted}, blocked ${report.blocked}, ` +
    `recovered ${report.recovered}, synced ${report.synced}, row_errors ${report.rowErrors.length}`;
  await recordRead(admin, sheet.tenantId, sheet.id, true, report.detail);
  return report;
}

/** Rebind-on-return, else create. This is what makes a sheet SWAP safe: she reorganises
 *  her list, links the new one, and people already mid-sequence get their history and
 *  interval back instead of flooding in as brand-new strangers. */
async function adoptRow(
  admin: pg.Pool,
  sheet: { id: string; tenantId: string },
  ref: string,
  fields: ContactRowFields,
): Promise<"rebound" | "created"> {
  const client = await admin.connect();
  try {
    await client.query("begin");

    let contactId: string | null = null;
    let outcome: "rebound" | "created" = "created";

    // REBIND ON RETURN: the row's email against DEACTIVATED contacts of the tenant. The
    // most recently touched match wins; history reattaches because it is the SAME row.
    if (fields.emailAddress !== null) {
      const back = await client.query<{ id: string }>(
        `select id from crm.contacts
          where tenant_id = $1 and not active and lower(email_address) = lower($2)
          order by updated_at desc limit 1`,
        [sheet.tenantId, fields.emailAddress],
      );
      if (back.rowCount === 1) {
        contactId = back.rows[0].id;
        outcome = "rebound";
        await client.query(
          `update crm.contacts
              set linked_sheet_id = $2, row_ref = $3, active = true,
                  display_name = $4, email_address = $5,
                  next_due_at = coalesce(next_due_at, now()), updated_at = now()
            where id = $1`,
          [contactId, sheet.id, ref, fields.displayName, fields.emailAddress],
        );
      }
    }

    if (contactId === null) {
      // Channel derived from what the row carries; a gap is the shipped blocked-reason
      // machinery's job (intake's philosophy: refuse almost nothing).
      const channel =
        fields.phones.length > 0 && fields.emailAddress !== null
          ? "both"
          : fields.emailAddress !== null
            ? "email"
            : "call";
      const created = await client.query<{ id: string }>(
        `insert into crm.contacts
           (tenant_id, linked_sheet_id, row_ref, display_name, email_address, channel,
            source, source_detail, looking_for, next_due_at)
         values ($1, $2, $3, $4, $5, $6, 'manual', $7, $8, now())
         returning id`,
        [
          sheet.tenantId,
          sheet.id,
          ref,
          fields.displayName,
          fields.emailAddress,
          channel,
          fields.sourceDetail,
          fields.lookingFor,
        ],
      );
      contactId = created.rows[0].id;
    }

    // Numbers: dial order is sheet order; dedupe on E.164, exactly like intake.
    for (const p of fields.phones) {
      await insertPhone(client, contactId, p);
    }

    await client.query("commit");
    return outcome;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Resolve-or-insert by E.164 (`phone_numbers_one_per_contact`), ordinal appended — the
 *  intake/adoptRow idiom, shared by adoption and the matched-row phone sync. Never deletes:
 *  016 grants no DELETE, and removal is a deliberate operator action, not a sync side
 *  effect. */
async function insertPhone(
  db: pg.Pool | pg.PoolClient,
  contactId: string,
  p: NormalizedPhone,
): Promise<void> {
  await db.query(
    `insert into crm.phone_numbers (contact_id, phone_e164, phone_raw, phone_region, ordinal)
     select $1, $2, $3, $4, coalesce(max(pn.ordinal) + 1, 0)
       from crm.phone_numbers pn where pn.contact_id = $1
     on conflict on constraint phone_numbers_one_per_contact do nothing`,
    [contactId, p.e164, p.raw, p.region],
  );
}

// ── The loop entry: every active linked sheet, per-sheet isolation. ───────────────────
export async function runSheetAdoptionAll(
  admin: pg.Pool,
  transport: SheetTransport,
  thresholds?: AdoptionThresholds,
): Promise<AdoptionReport[]> {
  const sheets = await admin.query<{ id: string; tenant_id: string; spreadsheet_id: string }>(
    `select id, tenant_id, spreadsheet_id from crm.linked_sheets where unlinked_at is null`,
  );
  const out: AdoptionReport[] = [];
  for (const s of sheets.rows) {
    try {
      out.push(
        await runSheetAdoption(
          { admin, transport, thresholds },
          { id: s.id, tenantId: s.tenant_id, spreadsheetId: s.spreadsheet_id },
        ),
      );
    } catch (err) {
      // The pass itself failing is a read-side problem for THIS sheet only; the ledger row
      // is best-effort here because the failure may be the database itself.
      console.error(`[sheet] adoption pass failed for ${s.spreadsheet_id}:`, err);
      await recordRead(
        admin,
        s.tenant_id,
        s.id,
        false,
        `unreachable: adoption pass error: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined);
    }
  }
  return out;
}

// ── Health, for the digest (CRM role — SELECT granted in 021) and reconcile (owner). ──
export interface SheetHealth {
  linkedSheetId: string;
  spreadsheetId: string;
  label: string | null;
  lastReadAt: Date | null;
  lastReadOk: boolean | null;
  lastReadDetail: string | null;
  /** Active contacts currently carrying an open `sheet_row_missing` block. */
  rowsMissing: number;
}

export async function sheetHealth(
  db: pg.Pool,
  tenantId?: string,
): Promise<SheetHealth[]> {
  const r = await db.query<{
    id: string;
    spreadsheet_id: string;
    label: string | null;
    at: Date | null;
    ok: boolean | null;
    detail: string | null;
    rows_missing: number;
  }>(
    `select ls.id, ls.spreadsheet_id, ls.label, sr.at, sr.ok, sr.detail,
            (select count(*)::int from crm.follow_ups f
              join crm.contacts c on c.id = f.contact_id
             where c.linked_sheet_id = ls.id
               and f.blocked_reason = 'sheet_row_missing'
               and f.closed_at is null) as rows_missing
       from crm.linked_sheets ls
       left join lateral (
             select at, ok, detail from crm.sheet_reads r
              where r.linked_sheet_id = ls.id
              order by at desc limit 1) sr on true
      where ls.unlinked_at is null
        and ($1::uuid is null or ls.tenant_id = $1)
      order by ls.linked_at`,
    [tenantId ?? null],
  );
  return r.rows.map((row) => ({
    linkedSheetId: row.id,
    spreadsheetId: row.spreadsheet_id,
    label: row.label,
    lastReadAt: row.at,
    lastReadOk: row.ok,
    lastReadDetail: row.detail,
    rowsMissing: row.rows_missing,
  }));
}

/** The operator sentences. The three states demand three DIFFERENT actions, so the
 *  sentences differ — wait / re-share / check the sheet. Shared by digest and reconcile
 *  so the two surfaces can never drift apart. */
export function sheetHealthLines(h: SheetHealth): string[] {
  const name = h.label ?? h.spreadsheetId;
  const lines: string[] = [];
  if (h.lastReadOk === null) {
    lines.push(`sheet "${name}": linked, not yet read — the next reconcile tick reads it`);
    return lines;
  }
  const code = h.lastReadOk ? "ok" : sheetReadCode(h.lastReadDetail);
  const at = h.lastReadAt ? h.lastReadAt.toISOString() : "unknown";
  switch (code) {
    case "ok":
      lines.push(`sheet "${name}": healthy (last read ${at})`);
      break;
    case "unreachable":
      lines.push(
        `sheet "${name}": unreachable since ${at} — sheet follow-ups are paused; ` +
          `nothing has been lost, and reading resumes by itself`,
      );
      break;
    case "permission_revoked":
      // The detail already names the service account (written at record time).
      lines.push(`sheet "${name}": ${stripCode(h.lastReadDetail)}`);
      break;
    case "breaker_count":
    case "breaker_displacement":
    case "breaker_drift":
      lines.push(`sheet "${name}": import HALTED by a safety check — ${stripCode(h.lastReadDetail)}`);
      break;
    case "refused":
      lines.push(`sheet "${name}": ${stripCode(h.lastReadDetail)}`);
      break;
  }
  if (h.rowsMissing > 0) {
    lines.push(
      `  ${h.rowsMissing} contact(s) whose sheet row is MISSING — their follow-ups are ` +
        `blocked, not removed; restore the row (or unlink the sheet) to resolve`,
    );
  }
  return lines;
}

function stripCode(detail: string | null): string {
  return (detail ?? "").replace(/^[a-z_]+:\s*/, "");
}
