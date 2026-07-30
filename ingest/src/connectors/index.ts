import { SOURCES, baseUrlFor, isSource, type Source } from "../sources.js";
import { LedgerFeedConnector } from "./ledger-feed.js";
import { SheetSnapshotConnector } from "./sheet-snapshot.js";
import type { Connector, ConnectorKind } from "./types.js";

export type {
  Connector,
  ConnectorKind,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";
export { LedgerFeedConnector } from "./ledger-feed.js";
export { SheetSnapshotConnector } from "./sheet-snapshot.js";

// Registry. The point of the seam, now exercised: a new paradigm is a new entry, not a
// fork of the spine. sheets (A5) is the first non-feed arm — its base URL resolves at
// construction time because the snapshot connector's endpoint is a constructor input,
// unlike the ledger-feed connectors, which re-read their env per call.
const REGISTRY: Record<Source, () => Connector> = {
  crm: () => new LedgerFeedConnector("crm"),
  billing: () => new LedgerFeedConnector("billing"),
  support: () => new LedgerFeedConnector("support"),
  sheets: () => new SheetSnapshotConnector({ baseUrl: baseUrlFor("sheets") }),
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
