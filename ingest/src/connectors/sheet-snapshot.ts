// The sheet-snapshot connector (Phase 2b Task A4): CDC over a mutable document.
//
// A Google-Sheets-shaped source has no event feed, no ledger file, no event ids, and no
// event clock — the grid mutates in place. This connector manufactures the whole event
// paradigm from content (see sheet-canonical.ts) and pushes every derived event through
// the SAME door as every other source: unstorable-divert → eventSchema.safeParse →
// quarantine failures → ingestEvent.
//
// Stateless by design (decision 1): "last known state" is DERIVED from raw — the latest
// sheet.row_upserted / sheet.row_deleted per row_key, whose content hash rides in the
// payload. No connector state table, no cursor: one source of truth, and idempotency
// falls out of (tenant_id, source, event_id) uniqueness. A failed cycle costs nothing;
// the next cycle is a full fresh diff.

import type pg from "pg";
import type {
  Connector,
  ConnectorCatchUpOptions,
  ConnectorReconcileOptions,
  ConnectorReconcileResult,
} from "./types.js";
import type { ReconcileReport } from "../reconcile.js";
import { SHEET_SOURCE, type ColumnMap } from "./sheet-canonical.js";

export interface SheetSnapshotConnectorOptions {
  /** Base URL of the sheet's snapshot API (/values + /metadata). */
  baseUrl: string;
  tenantId?: string;
  /** Per-request AbortSignal.timeout — no black-hole wedge (decision 7). Default 5000ms. */
  timeoutMs?: number;
  /** Truncated exponential backoff policy for 429s: min((2^n)*base + jitter, cap),
   *  bounded attempts, then a loud failure. */
  backoff?: { baseMs?: number; capMs?: number; maxAttempts?: number };
  columnMap?: ColumnMap;
}

export interface SheetCatchUpReport {
  ingested: number;
  duplicates: number;
  quarantined: number;
  /** Degradations noted per decision 4: mapped-but-missing (non-key) columns, etc. */
  degradations: string[];
}

/**
 * Extends the seam's ledger-era report shape rather than forking it, so the existing
 * `report?: ReconcileReport` contract admits it structurally. Field semantics for a
 * snapshot source: `ledger` = rows in the sheet's own current state (the sheet IS its
 * ledger), `raw` = live rows derived from raw.raw_events, `rawDuplicates` = 0 by the
 * same uniqueness argument as reconcile.ts. `stale` is the snapshot-only category:
 * present on both sides but content hash differs.
 */
export interface SheetReconcileReport extends ReconcileReport {
  stale: string[];
}

/** Read-path counters, observable so tests can pin "bounded retries actually happened". */
export interface SheetFetchStats {
  requests: number;
  retried429: number;
}

export class SheetSnapshotConnector implements Connector {
  readonly kind = "sheet-snapshot" as const;
  readonly source: string = SHEET_SOURCE;

  constructor(private readonly opts: SheetSnapshotConnectorOptions) {}

  stats(): SheetFetchStats {
    throw new Error("not implemented (A4 RED)");
  }

  /** Pull path: snapshot → diff vs raw-derived state → ingest the delta through the door. */
  async catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number> {
    throw new Error("not implemented (A4 RED)");
  }

  /** catchUp plus the degradation notes decision 4 requires the connector to surface.
   *  Kept as a widening method (not an interface change) so the seam stays untouched. */
  async catchUpWithReport(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<SheetCatchUpReport> {
    throw new Error("not implemented (A4 RED)");
  }

  /** Read-only comparison of a fresh snapshot vs raw-derived state. Never ingests. */
  async reconcile(
    pool: pg.Pool,
    opts?: ConnectorReconcileOptions,
  ): Promise<ConnectorReconcileResult & { report?: SheetReconcileReport }> {
    throw new Error("not implemented (A4 RED)");
  }

  /** Schedules an early catchUp — the latency optimization fed by the mock's lossy trigger
   *  channel. The channel's lossiness is IRRELEVANT to correctness: reconcile-first is the
   *  guarantee (seam header), nudge only shortens the wait. HTTP wiring lands with A5. */
  async nudge(pool: pg.Pool): Promise<number> {
    throw new Error("not implemented (A4 RED)");
  }
}
