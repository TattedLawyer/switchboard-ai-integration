import type { GapCause, GapLedgerRow } from "../connectors/index.js";

// Debt-burn A3: the reconcile CLI consumes the loss-bearing reports' `gaps` field as a
// CROSS-CHECK against the durable ledger rows it prints. Removing the field was ruled out
// (AIP-180: removing a component from a public type is a breaking change, and the Task B
// oracle reads it); consuming it makes it load-bearing — a connector whose in-report gap
// accounting drifts from the ledger it claims to reflect reds the run instead of
// drifting silently.

/** The common denominator of the two report shapes: the bus reports full ledger rows,
 *  the stripefeed maps them to its own gap type — both carry the ledger's identity key
 *  minus (tenant, source), which the CLI's own listing already fixes. */
export interface ReportedGapLike {
  cause: GapCause;
  fromEventId: string | null;
}

const keyOf = (g: ReportedGapLike): string => `${g.cause}|${g.fromEventId ?? "<null>"}`;

function countByKey(gaps: readonly ReportedGapLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of gaps) counts.set(keyOf(g), (counts.get(keyOf(g)) ?? 0) + 1);
  return counts;
}

/**
 * Multiset comparison on (cause, from_event_id) — the gap ledger's own idempotency key
 * scoped to one (tenant, source). `ok: false` names every key the two sides disagree on,
 * with both counts, so the red line says WHAT drifted rather than only that something did.
 */
export function gapCrossCheck(
  reported: readonly ReportedGapLike[],
  ledger: readonly GapLedgerRow[],
): { ok: true } | { ok: false; detail: string } {
  const reportCounts = countByKey(reported);
  const ledgerCounts = countByKey(ledger);
  const mismatches: string[] = [];
  for (const key of new Set([...reportCounts.keys(), ...ledgerCounts.keys()])) {
    const r = reportCounts.get(key) ?? 0;
    const l = ledgerCounts.get(key) ?? 0;
    if (r !== l) mismatches.push(`${key} (report ${r}, ledger ${l})`);
  }
  if (mismatches.length === 0) return { ok: true };
  return { ok: false, detail: mismatches.sort().join("; ") };
}
