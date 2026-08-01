import { describe, expect, it } from "vitest";
import { gapCrossCheck } from "../src/cli/gap-crosscheck.js";
import type { GapLedgerRow } from "../src/connectors/types.js";

// Debt-burn A3. `StripeFeedReconcileReport.gaps` (and the bus report's `gaps`) were
// populated but unread by the reconcile CLI, which prints ledger rows directly — a report
// field with no operator surface, the standing checklist inverted. AIP-180 rules out
// removing the public field; the fix is to CONSUME it as a cross-check: the report's gaps
// and the durable ledger rows the CLI prints must agree, or the run reds. This makes the
// field load-bearing — a connector whose report drifts from the ledger it claims to
// reflect can no longer drift silently.

function row(overrides: Partial<GapLedgerRow>): GapLedgerRow {
  return {
    id: 1,
    tenantId: "t",
    source: "stripefeed",
    cause: "retention",
    fromEventId: "evt_a",
    fromOccurredAt: null,
    toEventId: null,
    toOccurredAt: null,
    detectedAt: "2026-08-01T00:00:00.000Z",
    acknowledgedAt: null,
    acknowledgedBy: null,
    note: null,
    ...overrides,
  };
}

describe("gapCrossCheck — report.gaps vs the printed ledger rows", () => {
  it("agrees when both sides carry the same losses, keyed by the ledger's own identity (cause, from_event_id)", () => {
    const ledger = [row({ id: 1 }), row({ id: 2, cause: "reset", fromEventId: "evt_b" })];
    const reported = [
      { cause: "reset" as const, fromEventId: "evt_b" },
      { cause: "retention" as const, fromEventId: "evt_a" },
    ];
    expect(gapCrossCheck(reported, ledger)).toEqual({ ok: true });
  });

  it("agrees on the empty case — zero gaps on both sides is agreement, not vacuity", () => {
    expect(gapCrossCheck([], [])).toEqual({ ok: true });
  });

  it("reds when the report omits a loss the ledger holds — the exact silent-drift the unread field allowed", () => {
    const result = gapCrossCheck([], [row({})]);
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toMatch(/retention\|evt_a/);
    expect((result as { detail: string }).detail).toMatch(/report 0/);
  });

  it("reds when the report claims a loss the ledger does not hold", () => {
    const result = gapCrossCheck([{ cause: "reset", fromEventId: "evt_x" }], []);
    expect(result.ok).toBe(false);
    expect((result as { detail: string }).detail).toMatch(/reset\|evt_x/);
  });

  it("null near edges participate (the bus's first-subscribe reset can have one) rather than being collapsed away", () => {
    const ledger = [row({ fromEventId: null })];
    expect(gapCrossCheck([{ cause: "retention", fromEventId: null }], ledger)).toEqual({ ok: true });
    expect(gapCrossCheck([], ledger).ok).toBe(false);
  });
});
