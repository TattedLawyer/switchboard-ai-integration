import { SOURCES, isSource, type Source } from "../sources.js";
import { LedgerFeedConnector } from "./ledger-feed.js";
import type { Connector, ConnectorKind } from "./types.js";

export type {
  Connector,
  ConnectorKind,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";
export { LedgerFeedConnector } from "./ledger-feed.js";

// Registry. Every source today is the pre-existing feed+ledger shape; the vendor-faithful
// sources and the Google Sheets source register here as they land, which is the point of the
// seam — a new paradigm becomes a new entry, not a fork of the spine.
const REGISTRY: Record<Source, () => Connector> = {
  crm: () => new LedgerFeedConnector("crm"),
  billing: () => new LedgerFeedConnector("billing"),
  support: () => new LedgerFeedConnector("support"),
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
