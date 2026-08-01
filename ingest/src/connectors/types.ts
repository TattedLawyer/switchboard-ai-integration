import type pg from "pg";
import type { Source } from "../sources.js";
import type { ReconcileReport } from "../reconcile.js";
import type { SHEET_SOURCE } from "./sheet-canonical.js";

/**
 * Closed union of every source a connector may declare (A4 review I1). A5 registered
 * "sheets" into `SOURCES`, so today this union is EQUAL to `Source` — kept as a distinct
 * name because the two worlds it separates are still real: `Source` is the deployment
 * surface (registry, env conventions, per-source secrets), this is the SEAM's world, and
 * a future connector paradigm may again exist here before it earns deployment wiring.
 * Deliberately closed either way: `source` participates in the idempotency key
 * `(tenant_id, source, event_id)`, and connectors are legitimately constructed directly
 * (bypassing connectorFor's runtime throw), so a bare `string` here would let a typo'd
 * source compile and mint a fresh raw lane. A new paradigm adds its literal here — a
 * one-line, reviewed act.
 */
export type ConnectorSource = Source | typeof SHEET_SOURCE;

// The connector seam (Phase 2b Task 1).
//
// Before this, every source was assumed to have the SAME shape: an HTTP `/events` cursor feed
// plus a JSONL hash-chained ledger file, both hardcoded into the CLIs. That assumption does not
// survive contact with real vendors — a HubSpot-style source sends metadata-only events you must
// hydrate, a Stripe-style source paginates by opaque cursor, an event-bus source has no HTTP
// endpoint at all, and a Google Sheet has neither a feed nor a ledger file.
//
// ── The load-bearing design rule: RECONCILE IS THE PRIMARY CHANNEL. ───────────────────────────
// Push delivery is an OPTIMIZATION for latency; the authoritative guarantee always comes from
// reading the source's own truth and comparing it to `raw`. This is already how the spine works
// (webhooks are lossy, cursor backfill is authoritative), and for a Google Sheet it is forced:
// Google documents that "Script executions and API requests don't cause triggers to run", so any
// change not made by a human in the UI — another tool, a future integration, our own writes — is
// permanently invisible to the push path. A connector that trusted its push path there would
// silently under-report forever.
//
// Consequence for implementors: `reconcile()` must never be built on top of anything the push
// path produced. It reads the source directly. That independence is what makes it a trust anchor
// rather than an echo — including against a source-side agent that has been altered to stop
// reporting.

export type ConnectorKind = "ledger-feed" | "sheet-snapshot" | "stripe-feed" | "hub-hydrate" | "bus-replay";

// ── the durable gap ledger (Task D, cross-cutting) ───────────────────────────────────────
//
// It lives HERE, in the seam, because it belongs to no single paradigm: two connectors
// write it today (stripefeed's 30-day retention boundary, casebus's 72-hour window and
// its stream reset) and any future retention-bounded source will write the same table.
// The alternative — a helper inside one connector that the other imports — would make
// billing depend on the bus module for no reason other than birth order.
//
// A gap is UNCLOSABLE by construction: the events existed, were never ingested, and the
// source no longer serves them. No retry closes it. That is why the record carries an
// acknowledgement rather than a resolution.

/** The two honest data-loss boundaries (phase plan §3 consequence 2). `retention` = the
 *  cursor fell out of the source's window with time. `reset` = the source's retained
 *  stream was replaced wholesale, which can strike a cursor of ANY age. */
export type GapCause = "retention" | "reset";

/** The in-memory report shape shared by every loss-bearing connector. Bounds are the best
 *  KNOWABLE, and null means "not knowable", never "zero". */
export interface UnclosableGap {
  fromEventId: string | null;
  fromOccurredAt: string | null;
  toEventId?: string | null;
  toOccurredAt: string | null;
  cause: GapCause;
}

/** A gap as the ledger holds it. Every timestamp is an ISO STRING on this side of the
 *  boundary: node-pg parses `timestamptz` into Date OBJECTS, and comparing those with
 *  `===` is reference equality — false even for the same instant. That mistake already
 *  cost this project a silently-dead tiebreak (Task C cold review I1), so instants cross
 *  this seam by value or not at all. */
export interface GapLedgerRow {
  id: number;
  tenantId: string;
  source: string;
  cause: GapCause;
  fromEventId: string | null;
  fromOccurredAt: string | null;
  toEventId: string | null;
  toOccurredAt: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  note: string | null;
}

interface GapLedgerDbRow {
  id: string | number;
  tenant_id: string;
  source: string;
  cause: GapCause;
  from_event_id: string | null;
  from_occurred_at: Date | string | null;
  to_event_id: string | null;
  to_occurred_at: Date | string | null;
  detected_at: Date | string;
  acknowledged_at: Date | string | null;
  acknowledged_by: string | null;
  note: string | null;
}

/** Date|string → ISO string, total in both directions. The union is not defensive
 *  clutter: a pool configured with a string parser for timestamptz is legitimate, and
 *  assuming one shape is how the identity-compare bug got in. */
function isoOf(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toGapRow(r: GapLedgerDbRow): GapLedgerRow {
  return {
    id: Number(r.id), // bigint arrives as a string from node-pg
    tenantId: r.tenant_id,
    source: r.source,
    cause: r.cause,
    fromEventId: r.from_event_id,
    fromOccurredAt: isoOf(r.from_occurred_at),
    toEventId: r.to_event_id,
    toOccurredAt: isoOf(r.to_occurred_at),
    detectedAt: isoOf(r.detected_at)!,
    acknowledgedAt: isoOf(r.acknowledged_at),
    acknowledgedBy: r.acknowledged_by,
    note: r.note,
  };
}

const GAP_COLUMNS =
  "id, tenant_id, source, cause, from_event_id, from_occurred_at, to_event_id, to_occurred_at, " +
  "detected_at, acknowledged_at, acknowledged_by, note";

/**
 * Record a permanent loss. IDEMPOTENT by (tenant, source, cause, from_event_id): the same
 * loss re-detected by a later run is the SAME gap, so a cron loop cannot manufacture a
 * row per tick.
 *
 * On a repeat the row is ENRICHED, never rewritten (Task D cold review I2, disclosed
 * decision). The rule is exactly one-directional: a NULL field may be filled by a later
 * detection that knows more; a POPULATED field is never changed. So the ledger only ever
 * gets more truthful, and specifically:
 *   · a WIDER far edge from a later detection does NOT replace the original. The far edge
 *     records where the source's window stood when the loss was first observed; letting it
 *     drift forward with the window would quietly widen a reported loss that never grew.
 *   · a POORER later detection cannot blank what we already knew.
 *   · `detected_at` is never touched — it is when we FIRST learned of the loss.
 *   · the acknowledgement columns are never touched. The loss did not get worse; it is the
 *     same loss, and un-acknowledging it would resurrect a red the operator already
 *     answered.
 *
 * Why this matters rather than being tidiness: before it, `recordGap` was first-writer-
 * wins, so whichever SURFACE happened to observe a loss first fixed the record's quality
 * for the life of that gap — a gap first seen by a cron reconcile stayed permanently less
 * useful than the identical gap first seen by a backfill.
 */
export async function recordGap(
  pool: pg.Pool,
  gap: {
    tenantId: string;
    source: string;
    cause: GapCause;
    fromEventId: string | null;
    fromOccurredAt: string | null;
    toEventId?: string | null;
    toOccurredAt: string | null;
  },
): Promise<GapLedgerRow> {
  const res = await pool.query<GapLedgerDbRow>(
    `insert into ingest.gap_ledger
       (tenant_id, source, cause, from_event_id, from_occurred_at, to_event_id, to_occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (tenant_id, source, cause, coalesce(from_event_id, '')) do update
       -- Enrichment, one-directional: the INCUMBENT value wins whenever it exists, so
       -- coalesce(existing, incoming) fills nulls and is a no-op for everything else.
       -- detected_at and the acknowledgement columns are deliberately absent from this
       -- list. The update always matches, so RETURNING gives us the row either way.
       set from_occurred_at = coalesce(ingest.gap_ledger.from_occurred_at, excluded.from_occurred_at),
           to_event_id      = coalesce(ingest.gap_ledger.to_event_id,      excluded.to_event_id),
           to_occurred_at   = coalesce(ingest.gap_ledger.to_occurred_at,   excluded.to_occurred_at)
     returning ${GAP_COLUMNS}`,
    [
      gap.tenantId,
      gap.source,
      gap.cause,
      gap.fromEventId,
      gap.fromOccurredAt,
      gap.toEventId ?? null,
      gap.toOccurredAt,
    ],
  );
  // DO UPDATE always produces a row, so unlike the previous DO NOTHING form there is no
  // read-back path to get wrong.
  return toGapRow(res.rows[0]);
}

/** This (tenant, source)'s recorded losses, newest first. Scoped IN THE QUERY, never
 *  filtered afterwards, so a count and a listing can never disagree. */
export async function listGaps(
  pool: pg.Pool,
  tenantId: string,
  source: string,
  opts?: { unacknowledgedOnly?: boolean },
): Promise<GapLedgerRow[]> {
  const res = await pool.query<GapLedgerDbRow>(
    `select ${GAP_COLUMNS} from ingest.gap_ledger
      where tenant_id = $1 and source = $2
        ${opts?.unacknowledgedOnly ? "and acknowledged_at is null" : ""}
      order by detected_at desc, id desc`,
    [tenantId, source],
  );
  return res.rows.map(toGapRow);
}

/**
 * The operator act. Returns the acknowledged row, or null when no such gap exists FOR
 * THIS TENANT — the tenant is in the WHERE clause, so acknowledging across the tenant
 * line is a no-op that says so rather than a silent success.
 *
 * Re-acknowledging an already-acknowledged gap overwrites the operator/note and refreshes
 * the timestamp: an operator correcting or re-signing a disclosure is a legitimate act,
 * and the gap's BOUNDS — the part that is a factual claim about lost data — are never
 * touched here.
 */
export async function acknowledgeGap(
  pool: pg.Pool,
  opts: { tenantId: string; id: number; by: string; note?: string },
): Promise<GapLedgerRow | null> {
  const res = await pool.query<GapLedgerDbRow>(
    `update ingest.gap_ledger
        set acknowledged_at = now(), acknowledged_by = $3, note = coalesce($4, note)
      where tenant_id = $1 and id = $2
      returning ${GAP_COLUMNS}`,
    [opts.tenantId, opts.id, opts.by, opts.note ?? null],
  );
  return res.rowCount === 0 ? null : toGapRow(res.rows[0]);
}

export interface ConnectorCatchUpOptions {
  /** Overrides the source's configured base URL (the /events feed for ledger-feed
   *  connectors, the combined-read /snapshot API for sheet-snapshot). */
  baseUrl?: string;
  /** Feed-shaped connectors only; snapshot connectors read the whole grid per cycle. */
  limit?: number;
  maxRounds?: number;
}

export interface ConnectorReconcileOptions {
  /** Overrides the source's configured ledger path. Ledger-shaped connectors only. */
  ledgerPath?: string;
  /** Overrides the source's base URL. Snapshot-shaped connectors only — their
   *  "ledger" is the source's own current state read back over HTTP. */
  baseUrl?: string;
}

export interface ConnectorReconcileResult {
  /**
   * Set when this source was deliberately not reconciled (e.g. no ledger configured). A skip is
   * NOT a pass: callers must count how many sources actually reconciled, because "nothing was
   * checked" and "everything checked out" are the same exit code otherwise.
   */
  skipped?: string;
  /**
   * Whether the source's own record can be trusted at all — hash chain intact, sheet readable.
   * When this is false there is deliberately NO report: comparing `raw` against a record we
   * already know is corrupt would produce confident, meaningless diffs.
   */
  integrity: { ok: boolean; detail?: string };
  report?: ReconcileReport;
}

export interface Connector {
  /** See ConnectorSource above (A4/A4.1): wider than `Source` so connector-paradigm
   *  sources exist without joining the deployment union, but still a CLOSED set.
   *  Concrete connectors declare their narrower literal (LedgerFeedConnector keeps
   *  `Source`; SheetSnapshotConnector declares `typeof SHEET_SOURCE`). */
  readonly source: ConnectorSource;
  readonly kind: ConnectorKind;
  /** Pull path. Returns the number of events newly ingested. */
  catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number>;
  /** Authoritative comparison of the source's own truth against `raw`. See the rule above. */
  reconcile(pool: pg.Pool, opts?: ConnectorReconcileOptions): Promise<ConnectorReconcileResult>;
}
