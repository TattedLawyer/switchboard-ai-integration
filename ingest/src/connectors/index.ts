import { SOURCES, baseUrlFor, isSource, type Source } from "../sources.js";
import type pg from "pg";
import { LedgerFeedConnector } from "./ledger-feed.js";
import { SheetSnapshotConnector } from "./sheet-snapshot.js";
import { StripeFeedConnector } from "./stripe-feed.js";
import { HubHydrateConnector } from "./hub-hydrate.js";
import { BusReplayConnector } from "./bus-replay.js";
import type { Connector, ConnectorCatchUpOptions, ConnectorKind, GapLedgerRow, UnclosableGap } from "./types.js";

export type {
  Connector,
  ConnectorKind,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
  GapCause,
  GapLedgerRow,
  UnclosableGap,
} from "./types.js";
export { acknowledgeGap, listGaps, recordGap } from "./types.js";
export { LedgerFeedConnector } from "./ledger-feed.js";
export { SheetSnapshotConnector } from "./sheet-snapshot.js";
export { StripeFeedConnector, STRIPEFEED_SOURCE } from "./stripe-feed.js";
export { HubHydrateConnector, HUBCRM_SOURCE, handleHubcrmBatch, mapThinEvent } from "./hub-hydrate.js";
export { BusReplayConnector, CASEBUS_SOURCE, type BusGap, type FallbackPreset } from "./bus-replay.js";

// Registry. The point of the seam, now exercised: a new paradigm is a new entry, not a
// fork of the spine. sheets (A5) is the first non-feed arm — its base URL resolves at
// construction time because the snapshot connector's endpoint is a constructor input,
// unlike the ledger-feed connectors, which re-read their env per call. stripefeed
// (Task B) is the third paradigm: an opaque-cursor envelope feed, same
// construction-time base URL convention as sheets.
const REGISTRY: Record<Source, () => Connector> = {
  crm: () => new LedgerFeedConnector("crm"),
  billing: () => new LedgerFeedConnector("billing"),
  support: () => new LedgerFeedConnector("support"),
  sheets: () => new SheetSnapshotConnector({ baseUrl: baseUrlFor("sheets") }),
  stripefeed: () => new StripeFeedConnector({ baseUrl: baseUrlFor("stripefeed") }),
  // hubcrm (Task C): the fourth paradigm — thin batched webhooks land at the door;
  // catchUp is a hydration pump; reconcile reads the vendor object store's own truth.
  hubcrm: () => new HubHydrateConnector({ baseUrl: baseUrlFor("hubcrm") }),
  // casebus (Task D): the fifth arm and the LAST paradigm — a stream you subscribe to.
  // catchUp resubscribes from a stored opaque replay id; reconcile reads the retained
  // 72h window, which is the only truth this paradigm has.
  casebus: () => new BusReplayConnector({ baseUrl: baseUrlFor("casebus") }),
};

/**
 * Throws on an unknown source rather than returning a default. A silent fallback here would let
 * a typo ingest under some other source's connector — writing one source's data into another's
 * lane, which `(source, event_id)` idempotency would then happily accept as legitimate.
 */
export function connectorFor(source: Source): Connector {
  if (!isSource(source)) {
    throw new Error(`unknown source: ${String(source)} (known: ${SOURCES.join(", ")})`);
  }
  return REGISTRY[source]();
}

/** Which paradigm each source speaks. Pinned by test so a new kind cannot appear unnoticed. */
export function connectorKinds(): Record<Source, ConnectorKind> {
  return Object.fromEntries(
    SOURCES.map((s) => [s, REGISTRY[s]().kind]),
  ) as Record<Source, ConnectorKind>;
}

// ── loss-report plumbing (Gate-H cold review C1) ─────────────────────────────────────────
//
// The report-bearing catchUp variant is a widening METHOD on the concrete connectors
// (house precedent: sheets' catchUpWithReport), not a seam-interface change — but the
// operator surfaces (backfill CLI, service loop) must still reach it, because the whole
// point of a gap report is to be SEEN. The cold review proved the machinery existed,
// tested, and was wired to no door an operator uses: a permanent 8-event loss printed
// as "ingested 6 event(s)". This guard is how every catchUp surface asks "does this
// connector have more to say than a number?" without the seam knowing paradigm shapes.

/** The common shape of the widening reports (sheets carries degradations, stripe-feed
 *  carries gaps, hub-hydrate carries hydration accounting; all count
 *  ingested/duplicates/quarantined). Every optional field here is an OPERATOR-SURFACE
 *  OBLIGATION: the standing checklist (Gate-H 4-for-4) says a field a connector reports
 *  must be consumed and PRINTED by the shipped CLIs and service log in the same task —
 *  never oracle-only. */
export interface CatchUpReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  /** Widened in Task D from the stripefeed-only shape: the bus paradigm reports the same
   *  kind of loss with a second cause (`reset`) and a far edge that can be an event ID. */
  gaps?: UnclosableGap[];
  degradations?: string[];
  hydrated?: number;
  tombstoned?: number;
  hydrationDlq?: number;
  hydrationPending?: number;
}

export interface ReportingConnector {
  catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<CatchUpReport>;
}

export function catchUpReporter(connector: Connector): ReportingConnector | null {
  const candidate = connector as Partial<ReportingConnector>;
  return typeof candidate.catchUpWithReport === "function" ? (candidate as ReportingConnector) : null;
}

/** ONE rendering of an unclosable gap, shared by every operator surface (backfill CLI,
 *  service log, reconcile CLI) so grep/alerting can key on a single phrase. The leading
 *  "PERMANENT DATA LOSS — unclosable gap (<cause>)" is that phrase and is deliberately
 *  identical for both causes; only the EXPLANATION differs, because the two causes call
 *  for different operator responses (wait-and-widen-the-poll vs. check the source org's
 *  instance move). Naming a reset "aged out of the retention window" — which the
 *  stripefeed-shaped wording did — would send the operator to the wrong investigation. */
export function formatUnclosableGap(source: string, gap: UnclosableGap): string {
  const why =
    gap.cause === "reset"
      ? "were purged when the source's retained event stream was RESET (the vendor documents this " +
        "for an org moved to a new instance; it can strike a cursor of any age) and cannot be recovered"
      : "aged out of the source's retention window before ingestion and cannot be recovered";
  return (
    `[${source}] PERMANENT DATA LOSS — unclosable gap (${gap.cause}): events after ` +
    `${gap.fromEventId ?? "the start of our record"} (occurred ${gap.fromOccurredAt ?? "unknown"}) up to ` +
    `${gap.toEventId ?? gap.toOccurredAt ?? "the end of the retained window"} ${why}`
  );
}

/** The same gap as the DURABLE ledger holds it, for the reconcile surface: adds the
 *  acknowledgement state, which is what decides whether the gap still reds the run. */
export function formatGapLedgerRow(source: string, gap: GapLedgerRow): string {
  const base = formatUnclosableGap(source, gap);
  return gap.acknowledgedAt === null
    ? `${base} [gap #${gap.id}, detected ${gap.detectedAt}, UNACKNOWLEDGED]`
    : `${base} [gap #${gap.id}, detected ${gap.detectedAt}, acknowledged ${gap.acknowledgedAt} by ` +
        `${gap.acknowledgedBy ?? "unknown"}${gap.note ? `: ${gap.note}` : ""}]`;
}
