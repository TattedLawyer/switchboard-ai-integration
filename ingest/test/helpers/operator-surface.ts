import { expect } from "vitest";
import type { ConnectorKind, GapCause } from "../../src/connectors/index.js";

// Shared operator-surface assertion helpers (mechanism part 0b, adopted from the
// operator-surface plan review). Each helper accretes every assertion its failure
// class has ever needed — extracted from what bus-cli / stripe-feed-cli / hub-cli
// already practice — and hands it to the next connector's tests for free, instead
// of each test re-deriving (and under-deriving) the checks by hand.
//
// Scope note: the sibling-NEGATIVE assertions assume output about ONE source. In a
// multi-source run a crm line legitimately says "ledger hash chain: ok" next to a
// casebus integrity line — pass such output per-source, or assert inline.
//
// Self-tested in test/operator-surface-helpers.test.ts against the real formatters,
// so these regexes cannot drift from the CLI wording unnoticed.

export interface CliRun {
  code: number;
  out: string;
}

/** Each cause's OWN explanation wording, as `formatUnclosableGap` prints it. The
 *  helper asserts the named cause's wording positively and every sibling's
 *  negatively — the retention/reset mislabeling class (checklist line 5). */
const GAP_CAUSE_WORDING: Record<GapCause, RegExp> = {
  retention: /aged out of the source's retention window/,
  reset: /RESET/,
};

/**
 * Assert a permanent-loss disclosure on an operator surface (checklist lines 1 and 5):
 * the shared alert phrase, the cause label, the cause's own explanation, NO sibling
 * cause's explanation, every named bound, and (when given) the acknowledgement state.
 */
export function expectGapDisclosure(
  out: string,
  opts: {
    cause: GapCause;
    /** Edge ids/timestamps the disclosure must name — a loss report without its bounds
     *  tells an operator that something was lost but not what. */
    bounds?: string[];
    ack?: "unacknowledged" | "acknowledged";
  },
): void {
  expect(out).toMatch(/PERMANENT DATA LOSS/);
  expect(out).toMatch(new RegExp(`unclosable gap \\(${opts.cause}\\)`));
  expect(out).toMatch(GAP_CAUSE_WORDING[opts.cause]);
  for (const [sibling, wording] of Object.entries(GAP_CAUSE_WORDING) as [GapCause, RegExp][]) {
    if (sibling !== opts.cause) expect(out, `sibling cause "${sibling}" wording must be absent`).not.toMatch(wording);
  }
  for (const bound of opts.bounds ?? []) expect(out).toContain(bound);
  if (opts.ack === "unacknowledged") {
    expect(out).toMatch(/UNACKNOWLEDGED/);
  } else if (opts.ack === "acknowledged") {
    expect(out).toMatch(/acknowledged .* by /);
    expect(out).not.toMatch(/UNACKNOWLEDGED/);
  }
}

/** What reconcile ACTUALLY verified, per paradigm — the honest lines the cold reviews
 *  forced, one per ConnectorKind so a new paradigm cannot omit its entry (compile
 *  error here), mirroring cli/reconcile.ts's integrity branch. */
const INTEGRITY_LINE: Record<ConnectorKind, RegExp> = {
  "ledger-feed": /ledger hash chain: ok/,
  "sheet-snapshot": /snapshot integrity: ok \(sheet readable/,
  "stripe-feed": /feed window integrity: ok \(retained window fully drained, envelopes well-formed/,
  "bus-replay": /event stream integrity: ok \(retained window fully drained, every frame identified/,
  "hub-hydrate": /object-store integrity: ok \(company\/contact\/deal listings read/,
};

/**
 * Assert the reconcile integrity line states what was verified for THIS paradigm and
 * borrows no sibling's claim (single-source output — see scope note above). A bus that
 * prints "ledger hash chain: ok" is asserting a mechanism it does not have.
 */
export function expectParadigmIntegrityLine(out: string, kind: ConnectorKind): void {
  expect(out).toMatch(INTEGRITY_LINE[kind]);
  for (const [sibling, line] of Object.entries(INTEGRITY_LINE) as [ConnectorKind, RegExp][]) {
    if (sibling !== kind) expect(out, `sibling paradigm "${sibling}" integrity line must be absent`).not.toMatch(line);
  }
}

/**
 * Structural guard for checklist line 2, generalizing makeAgeOutGap's
 * return-the-detecting-run design: `arrange` drives the source into the condition
 * (returning whatever bounds/ids later assertions need), `detect` is the run that must
 * disclose it — and the ONLY run handed back. By the run after detection the condition
 * is often self-healed (cursor valid again) and the CLI legitimately silent, so an
 * assertion made on any later run passes no matter how the disclosure is worded.
 */
export async function captureDetectingRun<C>(opts: {
  arrange: () => C | Promise<C>;
  detect: () => Promise<CliRun>;
}): Promise<{ detectingRun: CliRun; context: C }> {
  const context = await opts.arrange();
  return { detectingRun: await opts.detect(), context };
}
