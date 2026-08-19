// Call vendor (T16) pins — the BRIDGE: the wire contract between the executor-side
// transport (`livekitPlaceCall`) and the agent worker (`voice-agent/worker.ts`), plus the
// ONE function allowed to translate the vendor's AMD vocabulary into this repo's raw
// `amdResult`. Both processes import `src/call-bridge.ts`, so the two sides cannot drift.
//
// B1 (pin L5): the AMD mapping. LiveKit's `voice.AMD` emits `human` / `machine-ivr` /
//     `machine-vm` / `machine-unavailable` / `uncertain`; this repo's raw signal is
//     `"human" | "machine" | "unknown"` (disposition.ts). The load-bearing row is
//     `uncertain -> "unknown"`: disposition.ts documents that an inconclusive AMD is NOT
//     evidence of a human, and laundering it to `"human"` would buy a voicemail box a
//     successful-contact disposition.
// B2: job metadata parses loudly or not at all. LiveKit hands `ctx.job.metadata` to the
//     worker as a PLAIN STRING that may be empty — a worker that shrugs at garbage would
//     run a call with no questions and no touch to persist into.
// B3: the report parses loudly or not at all, for the same reason on the way back.
import { describe, it, expect } from "vitest";
import {
  mapAmdCategory,
  encodeCallJobMetadata,
  parseCallJobMetadata,
  encodeAgentCallReport,
  parseAgentCallReport,
  JOB_METADATA_MAX_BYTES,
  type CallJobMetadata,
  type AgentCallReport,
} from "../src/call-bridge.js";

const JOB: CallJobMetadata = {
  v: 1,
  touchId: "00000000-0000-0000-0000-0000000000d4",
  contactId: "00000000-0000-0000-0000-0000000000a1",
  displayName: "Ana Reyes",
  openingLine: "Hi, may I speak with Ana Reyes?",
  prompts: [
    { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
    { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
  ],
};

const REPORT: AgentCallReport = {
  v: 1,
  amdResult: "human",
  conversation: "identity_not_asked_complete",
  answersPersisted: 2,
  reachedOrdinal: 2,
};

describe("B1 / L5: the AMD mapping never launders ignorance into a human", () => {
  // mutation: add `case "uncertain": return "human"` to mapAmdCategory -> red.
  //           RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 12 passed (14)`
  //     AssertionError: expected 'human' to be 'unknown' // Object.is equality
  //     AssertionError: expected 'human' not to be 'human' // Object.is equality
  it.each([
    ["human", "human"],
    ["machine-ivr", "human"], // an IVR is a system a human navigates; treat like human (LiveKit's own guidance)
    ["machine-vm", "machine"],
    ["machine-unavailable", "machine"],
    ["uncertain", "unknown"],
  ] as const)("%s -> %s", (category, expected) => {
    expect(mapAmdCategory(category)).toBe(expected);
  });

  it("uncertain NEVER becomes human, and an unrecognised category is unknown too", () => {
    // The pinned trap from disposition.ts: an inconclusive AMD stays "unknown".
    expect(mapAmdCategory("uncertain")).not.toBe("human");
    // A vendor library upgrade that renames or adds categories must degrade to honest
    // ignorance, never to a claimed human.
    expect(mapAmdCategory("something-new-the-vendor-added")).toBe("unknown");
    expect(mapAmdCategory("")).toBe("unknown");
  });
});

describe("B2: job metadata — a strict grammar that survives the wire or dies loudly", () => {
  // mutation: make parseCallJobMetadata return a default job on empty input -> red.
  it("round-trips verbatim", () => {
    expect(parseCallJobMetadata(encodeCallJobMetadata(JOB))).toEqual(JOB);
  });

  it("refuses the empty string LiveKit documents as possible", () => {
    // `ctx.job.metadata` may be empty (dispatch without metadata). Empty means "this job
    // was not dispatched by our transport" — running a call off it would be a call with
    // no touch to persist into.
    expect(() => parseCallJobMetadata("")).toThrow(/job metadata/i);
  });

  it("refuses non-JSON and JSON of the wrong shape", () => {
    expect(() => parseCallJobMetadata("not json {")).toThrow(/job metadata/i);
    expect(() => parseCallJobMetadata(JSON.stringify({ v: 1, nope: true }))).toThrow(
      /job metadata/i,
    );
  });

  it("refuses unknown extra fields rather than silently carrying them", () => {
    const withExtra = JSON.stringify({ ...JOB, surprise: "field" });
    expect(() => parseCallJobMetadata(withExtra)).toThrow(/job metadata/i);
  });

  it("refuses to encode past LiveKit's documented 512 KiB metadata limit", () => {
    // The limit is the vendor's; hitting it must be OUR loud error at dispatch time, not
    // a silent truncation discovered as a worker that cannot parse its job.
    const huge: CallJobMetadata = {
      ...JOB,
      prompts: [{ id: "q1", questionKey: "k", promptText: "x".repeat(JOB_METADATA_MAX_BYTES) }],
    };
    expect(() => encodeCallJobMetadata(huge)).toThrow(/512|KiB|bytes/i);
  });
});

describe("B3: the report — raw signals only, parsed strictly on the way back", () => {
  // mutation: make parseAgentCallReport default a missing amdResult to "human" -> red.
  it("round-trips verbatim, including a null conversation", () => {
    expect(parseAgentCallReport(encodeAgentCallReport(REPORT))).toEqual(REPORT);
    const voicemail: AgentCallReport = {
      v: 1,
      amdResult: "machine",
      conversation: null,
      answersPersisted: 0,
      reachedOrdinal: 0,
    };
    expect(parseAgentCallReport(encodeAgentCallReport(voicemail))).toEqual(voicemail);
  });

  it("refuses garbage, the empty string, and a report missing its amdResult", () => {
    expect(() => parseAgentCallReport("")).toThrow(/report/i);
    expect(() => parseAgentCallReport("not json {")).toThrow(/report/i);
    expect(() =>
      parseAgentCallReport(JSON.stringify({ v: 1, conversation: null })),
    ).toThrow(/report/i);
  });

  it("refuses an amdResult outside the raw vocabulary — the worker maps, nobody else", () => {
    expect(() =>
      parseAgentCallReport(
        JSON.stringify({ ...REPORT, amdResult: "machine-vm" /* vendor word, not ours */ }),
      ),
    ).toThrow(/report/i);
  });
});
