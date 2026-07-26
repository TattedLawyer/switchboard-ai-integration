import type pg from "pg";
import type { Source } from "../sources.js";
import type { ReconcileReport } from "../reconcile.js";

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

export type ConnectorKind = "ledger-feed";

export interface ConnectorCatchUpOptions {
  /** Overrides the source's configured base URL. Feed-shaped connectors only. */
  baseUrl?: string;
  limit?: number;
  maxRounds?: number;
}

export interface ConnectorReconcileOptions {
  /** Overrides the source's configured ledger path. Ledger-shaped connectors only. */
  ledgerPath?: string;
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
  readonly source: Source;
  readonly kind: ConnectorKind;
  /** Pull path. Returns the number of events newly ingested. */
  catchUp(pool: pg.Pool, opts?: ConnectorCatchUpOptions): Promise<number>;
  /** Authoritative comparison of the source's own truth against `raw`. See the rule above. */
  reconcile(pool: pg.Pool, opts?: ConnectorReconcileOptions): Promise<ConnectorReconcileResult>;
}
