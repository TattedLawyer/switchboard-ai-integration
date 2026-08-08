import { describe, expect, it } from "vitest";
import {
  captureDetectingRun,
  expectGapDisclosure,
  expectParadigmIntegrityLine,
} from "./helpers/operator-surface.js";
import { formatGapLedgerRow, formatUnclosableGap } from "../src/connectors/index.js";

// Self-test for the shared operator-surface assertion helpers (mechanism part 0b),
// in the repo-hygiene "not vacuously green" tradition: a helper library that PASSES
// on output it should reject is worse than no helpers, because every migrated test
// inherits the blindness at once. Positive cases are built with the REAL shared
// formatters (formatUnclosableGap / formatGapLedgerRow), so if the CLI wording and
// the helpers' expectations drift apart, this file reds before any migrated pin
// silently weakens.

const retentionGap = {
  cause: "retention" as const,
  fromEventId: "evt_lost_0001",
  fromOccurredAt: "2026-07-01T00:00:00.000Z",
  toEventId: "evt_far_0009",
  toOccurredAt: "2026-07-02T00:00:00.000Z",
};
const resetGap = { ...retentionGap, cause: "reset" as const };

const retentionOut = formatUnclosableGap("casebus", retentionGap);
const resetOut = formatUnclosableGap("casebus", resetGap);

const ledgerRowBase = {
  id: 7,
  tenantId: "00000000-0000-0000-0000-000000000000",
  source: "casebus",
  ...retentionGap,
  detectedAt: "2026-07-02T01:00:00.000Z",
  acknowledgedAt: null,
  acknowledgedBy: null,
  note: null,
};

describe("expectGapDisclosure", () => {
  it("passes on the real formatter's output for the named cause", () => {
    expect(() => expectGapDisclosure(retentionOut, { cause: "retention" })).not.toThrow();
    expect(() => expectGapDisclosure(resetOut, { cause: "reset" })).not.toThrow();
  });

  it("rejects output that names the WRONG cause (positive own-wording is required)", () => {
    expect(() => expectGapDisclosure(resetOut, { cause: "retention" })).toThrow();
    expect(() => expectGapDisclosure(retentionOut, { cause: "reset" })).toThrow();
  });

  it("rejects output that carries a SIBLING cause's wording alongside its own — the retention/reset mislabeling class", () => {
    expect(() => expectGapDisclosure(`${retentionOut}\n${resetOut}`, { cause: "retention" })).toThrow();
  });

  it("rejects output missing the shared PERMANENT DATA LOSS alert phrase", () => {
    const noAlert = retentionOut.replace(/PERMANENT DATA LOSS/, "data note");
    expect(() => expectGapDisclosure(noAlert, { cause: "retention" })).toThrow();
  });

  it("bounds are asserted by name: a disclosure that drops an edge id fails", () => {
    expect(() =>
      expectGapDisclosure(retentionOut, { cause: "retention", bounds: ["evt_lost_0001", "evt_far_0009"] }),
    ).not.toThrow();
    expect(() =>
      expectGapDisclosure(retentionOut, { cause: "retention", bounds: ["evt_absent_9999"] }),
    ).toThrow();
  });

  it("ack: 'unacknowledged' demands the UNACKNOWLEDGED marker; 'acknowledged' demands the by-line and refuses a lingering UNACKNOWLEDGED", () => {
    const unacked = formatGapLedgerRow("casebus", ledgerRowBase);
    const acked = formatGapLedgerRow("casebus", {
      ...ledgerRowBase,
      acknowledgedAt: "2026-07-03T00:00:00.000Z",
      acknowledgedBy: "oncall",
      note: "loss accepted",
    });
    expect(() => expectGapDisclosure(unacked, { cause: "retention", ack: "unacknowledged" })).not.toThrow();
    expect(() => expectGapDisclosure(acked, { cause: "retention", ack: "acknowledged" })).not.toThrow();
    expect(() => expectGapDisclosure(acked, { cause: "retention", ack: "unacknowledged" })).toThrow();
    expect(() => expectGapDisclosure(unacked, { cause: "retention", ack: "acknowledged" })).toThrow();
    expect(() =>
      expectGapDisclosure(`${unacked}\n${acked}`, { cause: "retention", ack: "acknowledged" }),
    ).toThrow();
  });
});

describe("expectParadigmIntegrityLine", () => {
  const lines = {
    "ledger-feed": "[crm] ledger hash chain: ok",
    "sheet-snapshot": "[sheets] snapshot integrity: ok (sheet readable, metadata/key mapping consistent)",
    "stripe-feed":
      "[stripefeed] feed window integrity: ok (retained window fully drained, envelopes well-formed, feed advancing)",
    "bus-replay":
      "[casebus] event stream integrity: ok (retained window fully drained, every frame identified, subscription advancing)",
    "hub-hydrate":
      "[hubcrm] object-store integrity: ok (company/contact/deal listings read; " +
      "current state compared against raw thin events + hydrated snapshots)",
  } as const;

  it("passes each paradigm's own honest line and rejects every sibling's", () => {
    for (const [kind, line] of Object.entries(lines) as [keyof typeof lines, string][]) {
      expect(() => expectParadigmIntegrityLine(line, kind), kind).not.toThrow();
      for (const [other, otherLine] of Object.entries(lines) as [keyof typeof lines, string][]) {
        if (other === kind) continue;
        expect(() => expectParadigmIntegrityLine(otherLine, kind), `${kind} vs ${other}`).toThrow();
      }
    }
  });

  it("rejects a paradigm line CONTAMINATED by the ledger boilerplate — the dishonesty class the integrity lines were rewritten to kill", () => {
    const contaminated = `${lines["bus-replay"]}\n[casebus] ledger hash chain: ok`;
    expect(() => expectParadigmIntegrityLine(contaminated, "bus-replay")).toThrow();
  });
});

describe("captureDetectingRun", () => {
  it("hands back the run the detect step produced — and only that run — plus the arrange step's context", async () => {
    const runs: string[] = [];
    const { detectingRun, context } = await captureDetectingRun({
      arrange: async () => {
        runs.push("arrange-run");
        return { lostEventId: "evt_bound_1" };
      },
      detect: async () => {
        runs.push("detect-run");
        return { code: 0, out: "output of the detecting run" };
      },
    });
    expect(runs).toEqual(["arrange-run", "detect-run"]); // arrange strictly precedes detection
    expect(detectingRun.out).toBe("output of the detecting run");
    expect(context.lostEventId).toBe("evt_bound_1");
  });
});
