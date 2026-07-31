import { SOURCES, baseUrlFor, isSource, type Source } from "../sources.js";
import type pg from "pg";
import { LedgerFeedConnector } from "./ledger-feed.js";
import { SheetSnapshotConnector } from "./sheet-snapshot.js";
import { StripeFeedConnector, type StripeFeedGap } from "./stripe-feed.js";
import type { Connector, ConnectorCatchUpOptions, ConnectorKind } from "./types.js";

export type {
  Connector,
  ConnectorKind,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";
export { LedgerFeedConnector } from "./ledger-feed.js";
export { SheetSnapshotConnector } from "./sheet-snapshot.js";
export { StripeFeedConnector, STRIPEFEED_SOURCE } from "./stripe-feed.js";

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
 *  carries gaps; both count ingested/duplicates/quarantined). */
export interface CatchUpReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  gaps?: StripeFeedGap[];
  degradations?: string[];
}

export interface ReportingConnector {
  catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<CatchUpReport>;
}

export function catchUpReporter(connector: Connector): ReportingConnector | null {
  const candidate = connector as Partial<ReportingConnector>;
  return typeof candidate.catchUpWithReport === "function" ? (candidate as ReportingConnector) : null;
}

/** ONE rendering of an unclosable gap, shared by every operator surface (backfill CLI,
 *  service log, reconcile CLI) so grep/alerting can key on a single phrase. */
export function formatUnclosableGap(source: string, gap: StripeFeedGap): string {
  return (
    `[${source}] PERMANENT DATA LOSS — unclosable gap (${gap.cause}): events after ` +
    `${gap.fromEventId} (occurred ${gap.fromOccurredAt ?? "unknown"}) up to ` +
    `${gap.toOccurredAt ?? "the end of the retained window"} aged out of the feed's ` +
    `retention window before ingestion and cannot be recovered`
  );
}
