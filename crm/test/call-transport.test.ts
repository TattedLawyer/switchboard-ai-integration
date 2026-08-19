// Call transport pins — the vendor seam. The stub still rings nobody; the LiveKit adapter
// is now REAL (T16) and is pinned here against a FAKE client, because no vendor credentials
// exist and 🚨 NO TEST MAY MAKE A NETWORK CALL (the fetch tripwire below is the proof, not
// a promise).
//
// P1: `stubPlaceCall` is TYPE-CHECKED against the real `PlaceCall` (the annotation lives
//     in `src/call-transport.ts`, inside the `npm run typecheck` perimeter — unlike the
//     loop's `stubSender`, which sits outside every tsconfig) and returns a canned
//     no-answer WITHOUT touching the context's callbacks or any socket.
// L1: `livekitPlaceCall` with INCOMPLETE config THROWS AT CONSTRUCTION, not per call.
//     (Supersedes P6, which pinned the factory's not-implemented throw; the property P6
//     protected — misconfiguration dies loudly at composition time, before any proposal
//     is claimed — is exactly what L1 pins, now against the real implementation.)
// L2: happy path — agent dispatched BEFORE the SIP participant is created, room names
//     match, job metadata carries the approved words verbatim, and the returned
//     `CallResult` carries the RAW signals (200 + the worker's reported AMD), interpreted
//     by nobody.
// L3: a `SipCallError` (486 / 408 / 503) surfaces its RAW `sipStatusCode` in the result —
//     not interpreted, not swallowed. 486 vs 603 are indistinguishable by LiveKit's
//     DisconnectReason, so the raw code is the only place the distinction survives.
// L4: a plain `ServerError` WITHOUT `sip_status_code` metadata (the SDK's upgrade to
//     SipCallError is conditional on that metadata) is handled deliberately: cleanup, then
//     a typed throw — never a TypeError, never a synthesized `CallResult` (rule 2).
// L6: the non-auto-closing outcomes (408/480, 5xx) trigger an EXPLICIT `deleteRoom` —
//     LiveKit does not close the session on USER_UNAVAILABLE or SIP_TRUNK_FAILURE, so
//     without this the majority outcome of an outbound dialer leaks a live agent job.
// L7: `payload.phone_e164` is dialled EXACTLY ONCE — a second dial is a call the human
//     never approved (contract rule 4).
// L8: no network I/O, proven: every test runs with global fetch replaced by a tripwire
//     that throws, and the fake client is plain local objects.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ServerError, SipCallError } from "livekit-server-sdk";
import type { CallContext, CallResult, PlaceCall } from "../src/executor.js";
import { parseCallJobMetadata, type AgentCallReport } from "../src/call-bridge.js";
import {
  stubPlaceCall,
  livekitPlaceCall,
  realLiveKitCallClient,
  LiveKitCallFailed,
  type LiveKitCallClient,
  type LiveKitCallConfig,
} from "../src/call-transport.js";

// ═══ L8: THE FETCH TRIPWIRE ═════════════════════════════════════════════════════════════
// livekit-server-sdk is Twirp over global fetch. If ANY code under these tests — the
// adapter, the real client's constructor, a fake wired wrong — reaches for the network,
// the tripwire throws and the test goes red. This is the pin that PROVES no test performs
// network I/O instead of asserting it in a comment.
beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("NETWORK I/O ATTEMPTED IN A UNIT TEST — the tripwire caught a fetch");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A context that records every callback, so silence can be asserted. */
function recordingContext(): { ctx: CallContext; callbacks: string[] } {
  const callbacks: string[] = [];
  const ctx: CallContext = {
    touchId: "00000000-0000-0000-0000-0000000000d4",
    payload: {
      contact_id: "00000000-0000-0000-0000-0000000000a1",
      phone_number_id: "00000000-0000-0000-0000-0000000000b2",
      phone_e164: "+639171234567",
      display_name: "Ana Reyes",
      opening_line: "Hi, may I speak with Ana Reyes?",
      question_set_id: "00000000-0000-0000-0000-0000000000c3",
      context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
    },
    prompts: [
      { id: "q1", questionKey: "budget", promptText: "What budget range are you working with?" },
      { id: "q2", questionKey: "timeline", promptText: "When are you hoping to move?" },
    ],
    answer: async () => {
      callbacks.push("answer");
    },
    reached: async () => {
      callbacks.push("reached");
    },
  };
  return { ctx, callbacks };
}

const CFG: LiveKitCallConfig = {
  url: "wss://example.livekit.invalid",
  apiKey: "lk-key",
  apiSecret: "lk-secret",
  sipTrunkId: "trunk-1",
  agentName: "switchboard-intake",
  modelApiKey: "model-key",
};

const HUMAN_REPORT: AgentCallReport = {
  v: 1,
  amdResult: "human",
  conversation: "identity_not_asked_complete",
  answersPersisted: 2,
  reachedOrdinal: 2,
};

/** The fake vendor: plain local objects, an ordered op log, scriptable failures. */
function fakeClient(opts?: {
  dialError?: unknown;
  report?: AgentCallReport | (() => never);
  reportRaw?: string;
}): {
  client: LiveKitCallClient;
  ops: string[];
} {
  const ops: string[] = [];
  const client: LiveKitCallClient = {
    dispatchAgent: async (roomName, agentName, metadata) => {
      ops.push(`dispatch:${roomName}:${agentName}:${metadata}`);
    },
    dialSipParticipant: async (roomName, phoneE164) => {
      ops.push(`dial:${roomName}:${phoneE164}`);
      if (opts?.dialError !== undefined) throw opts.dialError;
      return { sipCallId: "SCL_fake" };
    },
    awaitCallReport: async (roomName) => {
      ops.push(`awaitReport:${roomName}`);
      if (opts?.reportRaw !== undefined) return opts.reportRaw;
      const r = opts?.report ?? HUMAN_REPORT;
      if (typeof r === "function") return r();
      return JSON.stringify(r);
    },
    deleteRoom: async (roomName) => {
      ops.push(`deleteRoom:${roomName}`);
    },
  };
  return { client, ops };
}

describe("P1: the stub is a typed PlaceCall that rings nobody", () => {
  // mutation: change the canned result's `sipStatus` to 200 -> red (a stub that reports a
  //           pick-up would launder "nothing happened" into contact). RUN ✅ 2026-08-18
  //   Observed: `Tests  1 failed | 1 passed (2)`
  //     AssertionError: expected { transport: { sipStatus: 200 }, …(1) } to deeply equal
  //     { transport: { sipStatus: 480 }, …(1) }
  it("returns the canned no-answer and never invokes a callback", async () => {
    // The load-bearing type conformance is the `: PlaceCall` annotation in
    // `src/call-transport.ts`; this assignment restates it where the behaviour is pinned.
    const typed: PlaceCall = stubPlaceCall;
    const { ctx, callbacks } = recordingContext();

    const result = await typed(ctx);

    expect(result).toEqual({ transport: { sipStatus: 480 }, conversation: null });
    // No answer was collected and no question was reached — nobody was called.
    expect(callbacks).toEqual([]);
  });
});

describe("L1: incomplete config dies at CONSTRUCTION, not per call", () => {
  // mutation: move `validateConfig(cfg)` from the factory body into the returned
  //           PlaceCall (validate per call) -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  7 failed | 20 passed (27)`
  //     AssertionError: expected [Function] to throw an error (all six incomplete-config
  //     rows and the URL-shape row — construction no longer refuses anything)
  // A returned `PlaceCall` that throws would fire AFTER `beginExecution`, wedging every
  // approved card `executing` one by one; a factory that throws stops the daemon at
  // composition time, before any proposal is claimed. This is the property P6 pinned for
  // the unimplemented factory, carried forward onto the real one.
  it.each([
    ["url", { ...CFG, url: "" }],
    ["apiKey", { ...CFG, apiKey: "" }],
    ["apiSecret", { ...CFG, apiSecret: "  " }],
    ["sipTrunkId", { ...CFG, sipTrunkId: "" }],
    ["agentName", { ...CFG, agentName: "" }],
    ["modelApiKey", { ...CFG, modelApiKey: "" }],
  ] as const)("an empty %s throws at construction", (_field, cfg) => {
    expect(() => livekitPlaceCall(cfg)).toThrow(/LiveKit call config/i);
  });

  it("a complete config constructs without dialling anyone", () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    expect(typeof placeCall).toBe("function");
    // Construction reaches for nothing — no dispatch, no dial, no socket.
    expect(ops).toEqual([]);
  });

  it("the URL must be a LiveKit server URL, not whatever was in the env", () => {
    expect(() => livekitPlaceCall({ ...CFG, url: "smtp://relay.example" })).toThrow(
      /LiveKit call config/i,
    );
  });
});

describe("L2: the happy path — dispatch first, rooms match, raw signals through", () => {
  // mutation 1: dispatch the agent AFTER `dialSipParticipant` -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 25 passed (27)`
  //     AssertionError: expected [ 'dial', 'dispatch', 'awaitReport' ] to deeply equal
  //     [ 'dispatch', 'dial', 'awaitReport' ]
  // mutation 2: return `sipStatus: 486` on the answered path instead of the raw 200 ->
  //           red. RUN ✅ 2026-08-19
  //   Observed: `Tests  3 failed | 24 passed (27)`
  //     AssertionError: expected 486 to be 200 // Object.is equality
  it("dispatches the agent BEFORE creating the SIP participant, into the SAME room", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    const result = await placeCall(ctx);

    // Order: dispatch, then dial, then the wait for the worker's report. Dispatching
    // second loses the early media AMD needs and can answer a call no agent ever joins.
    expect(ops.map((o) => o.split(":")[0])).toEqual(["dispatch", "dial", "awaitReport"]);
    const room = (op: string): string => op.split(":")[1];
    expect(room(ops[1])).toBe(room(ops[0]));
    expect(room(ops[2])).toBe(room(ops[0]));

    // Rule 4: the dialled number is the approved number, verbatim.
    expect(ops[1].split(":")[2]).toBe("+639171234567");

    // The raw signals, interpreted by NOBODY on the way through: 200 is the documented
    // meaning of a resolved waitUntilAnswered dial (voicemail ALSO arrives as 200 — the
    // amdResult is the worker's, carried verbatim).
    const expected: CallResult = {
      transport: { sipStatus: 200, amdResult: "human" },
      conversation: "identity_not_asked_complete",
    };
    expect(result).toEqual(expected);
  });

  it("the job metadata carries her approved words verbatim, parseable by the worker's own grammar", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await placeCall(ctx);

    const dispatchOp = ops[0];
    expect(dispatchOp.startsWith("dispatch:")).toBe(true);
    // dispatch:<room>:<agentName>:<metadata json — contains ':' so split with a limit>
    const agentName = dispatchOp.split(":")[2];
    expect(agentName).toBe("switchboard-intake");
    const metadata = dispatchOp.split(":").slice(3).join(":");
    const job = parseCallJobMetadata(metadata);
    expect(job.touchId).toBe(ctx.touchId);
    expect(job.contactId).toBe(ctx.payload.contact_id);
    expect(job.openingLine).toBe("Hi, may I speak with Ana Reyes?");
    expect(job.displayName).toBe("Ana Reyes");
    expect(job.prompts).toEqual(ctx.prompts);
  });

  it("never invokes ctx.answer/ctx.reached itself, and never deletes the room on success", async () => {
    // The WORKER leg persists per turn (recordAnswer / reached_ordinal, voice-agent
    // session) — that is how contract rule 1's stream-never-buffer property is honoured
    // across two processes. This adapter buffers nothing and invents nothing; a callback
    // fired here would be a SECOND writer for the same answer. On success the worker owns
    // the goodbye and the hang-up (deleting the room is the documented PSTN hangup).
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx, callbacks } = recordingContext();

    await placeCall(ctx);

    expect(callbacks).toEqual([]);
    expect(ops.filter((o) => o.startsWith("deleteRoom:"))).toEqual([]);
  });

  it("a machine report rides through as raw 200 + machine — voicemail is not an error", async () => {
    const { client } = fakeClient({
      report: { v: 1, amdResult: "machine", conversation: null, answersPersisted: 0, reachedOrdinal: 0 },
    });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    const result = await placeCall(ctx);

    // disposition.ts turns this into `voicemail`; the transport decides NOTHING (rule 3).
    expect(result).toEqual({
      transport: { sipStatus: 200, amdResult: "machine" },
      conversation: null,
    });
  });
});

describe("L3: SipCallError surfaces the RAW sipStatusCode — not interpreted, not swallowed", () => {
  // mutation: collapse the surfaced code to a generic 500 (`{ sipStatus: 500 }`) -> red.
  //           RUN ✅ 2026-08-19
  //   Observed: `Tests  4 failed | 23 passed (27)`
  //     AssertionError: expected 500 to be 486 (and 408, 503, 480 in the sibling rows)
  // The SDK encodes a failed dial as a throw. The adapter DECODES it back into the raw
  // signal and RETURNS it: a busy line and a rejected call are normal outcomes of an
  // outbound dialer, and `disposition.ts` alone decides what they mean. The raw code is
  // persisted because 486 vs 603 are indistinguishable by DisconnectReason.
  it.each([[486], [408], [503]] as const)(
    "sipStatusCode %s comes back as transport.sipStatus %s",
    async (code) => {
      const { client } = fakeClient({
        dialError: new SipCallError("SIPStatus", "call failed", 500, "failed_precondition", {
          sip_status_code: String(code),
          sip_status: "reason phrase",
        }),
      });
      const placeCall = livekitPlaceCall(CFG, client);
      const { ctx } = recordingContext();

      const result = await placeCall(ctx);

      expect(result.transport.sipStatus).toBe(code);
      expect(result.transport.amdResult).toBeUndefined(); // nobody answered; AMD never ran
      expect(result.conversation).toBeNull();
    },
  );

  it("a plain ServerError CARRYING sip_status_code metadata is decoded too — the SDK's upgrade to SipCallError is conditional", async () => {
    const { client } = fakeClient({
      dialError: new ServerError("ServerError", "call failed", 500, "failed_precondition", {
        sip_status_code: "480",
      }),
    });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    const result = await placeCall(ctx);

    expect(result.transport.sipStatus).toBe(480);
  });
});

describe("L4: a plain ServerError without SIP metadata is handled deliberately", () => {
  // mutation: synthesize `{ transport: { sipStatus: 500 }, conversation: null }` for the
  //           no-SIP-status failure instead of throwing -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 25 passed (27)`
  //     AssertionError: promise resolved "{ transport: { sipStatus: 500 }, …(1) }"
  //     instead of rejecting
  // No SIP status exists to report, and inventing one would be the adapter deciding
  // (rule 3). Rule 2 names the honest move: clean up, then THROW a typed error — the
  // proposal stays `executing`, visibly, and reconcile lists it. A wedged card a human
  // can see beats a false outcome nobody can.
  it("cleans up and throws LiveKitCallFailed carrying the vendor's message — never a TypeError, never a CallResult", async () => {
    const { client, ops } = fakeClient({
      dialError: new ServerError("ServerError", "internal server error", 500, "internal"),
    });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await expect(placeCall(ctx)).rejects.toThrow(LiveKitCallFailed);
    // A fresh transport (dial-once forbids reusing the first): the vendor's message
    // survives into the typed error, so the operator's log names the actual failure.
    const second = fakeClient({
      dialError: new ServerError("ServerError", "internal server error", 500, "internal"),
    });
    await expect(livekitPlaceCall(CFG, second.client)(recordingContext().ctx)).rejects.toThrow(
      /internal server error/,
    );

    // The dispatched agent job does not leak: the room was explicitly deleted.
    expect(ops.filter((o) => o.startsWith("deleteRoom:")).length).toBeGreaterThan(0);
  });

  it("a non-Error throw from the vendor is wrapped, not re-crashed", async () => {
    const { client } = fakeClient({ dialError: "the vendor threw a string" });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await expect(placeCall(ctx)).rejects.toThrow(LiveKitCallFailed);
  });
});

describe("L6: the non-auto-closing outcomes shut the session down EXPLICITLY", () => {
  // mutation: delete the `await cleanup(...)` before returning the raw SIP status -> red.
  //           RUN ✅ 2026-08-19
  //   Observed: `Tests  3 failed | 24 passed (27)`
  //     AssertionError: expected [ …(2) ] to include
  //     'deleteRoom:call-00000000-0000-0000-00…'
  // LiveKit documents that USER_UNAVAILABLE (408/480) and SIP_TRUNK_FAILURE (5xx) do NOT
  // auto-close the session — and no-answer is the MAJORITY outcome of an outbound dialer,
  // so skipping this leaks a dispatched agent job on most calls.
  it.each([[408], [480], [503]] as const)(
    "sipStatusCode %s ends with deleteRoom on the call's room",
    async (code) => {
      const { client, ops } = fakeClient({
        dialError: new SipCallError("SIPStatus", "call failed", 500, "failed_precondition", {
          sip_status_code: String(code),
        }),
      });
      const placeCall = livekitPlaceCall(CFG, client);
      const { ctx } = recordingContext();

      await placeCall(ctx);

      const dispatchRoom = ops[0].split(":")[1];
      expect(ops).toContain(`deleteRoom:${dispatchRoom}`);
    },
  );

  it("a report that never arrives is a mid-call transport failure: cleanup, then an honest throw (rule 2)", async () => {
    const { client, ops } = fakeClient({
      report: () => {
        throw new Error("timed out waiting for the agent's report");
      },
    });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await expect(placeCall(ctx)).rejects.toThrow(LiveKitCallFailed);
    expect(ops.filter((o) => o.startsWith("deleteRoom:")).length).toBe(1);
  });

  it("a malformed report is the same failure — never guessed into a CallResult", async () => {
    const { client, ops } = fakeClient({ reportRaw: "not a report {" });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await expect(placeCall(ctx)).rejects.toThrow(LiveKitCallFailed);
    expect(ops.filter((o) => o.startsWith("deleteRoom:")).length).toBe(1);
  });
});

describe("L7: the approved number is dialled EXACTLY ONCE", () => {
  // mutation: remove the `if (dialed) throw` guard -> red. RUN ✅ 2026-08-19
  //   Observed: `Tests  2 failed | 25 passed (27)`
  //     AssertionError: promise resolved "{ transport: { …(2) }, …(1) }" instead of
  //     rejecting (and the 486 path resolved too — a second, unapproved dial happened)
  it("a second invocation of the same placed call throws and dials nobody", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await placeCall(ctx);
    await expect(placeCall(ctx)).rejects.toThrow(/exactly once|already placed/i);

    expect(ops.filter((o) => o.startsWith("dial:")).length).toBe(1);
    expect(ops.filter((o) => o.startsWith("dispatch:")).length).toBe(1);
  });

  it("a failed dial does not license a retry either — no fallback, no vendor-side redial", async () => {
    const { client, ops } = fakeClient({
      dialError: new SipCallError("SIPStatus", "call failed", 500, "failed_precondition", {
        sip_status_code: "486",
      }),
    });
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();

    await placeCall(ctx);
    await expect(placeCall(ctx)).rejects.toThrow(/exactly once|already placed/i);

    expect(ops.filter((o) => o.startsWith("dial:")).length).toBe(1);
  });
});

describe("L8: no test performs network I/O — the tripwire proves it", () => {
  // mutation: make the adapter call `await fetch("https://livekit.invalid/ping")` before
  //           dispatching -> red, loudly, everywhere the adapter runs. RUN ✅ 2026-08-19
  //   Observed: `Tests  18 failed | 9 passed (27)`
  //     Error: NETWORK I/O ATTEMPTED IN A UNIT TEST — the tripwire caught a fetch
  it("the full happy path and the real client's CONSTRUCTOR run to completion under a fetch that throws", async () => {
    // Every test in this file already runs under the tripwire (beforeEach). This one makes
    // the property explicit: the whole adapter round-trip touches no transport, and even
    // constructing the REAL client (what `livekitPlaceCall(cfg)` does when no client is
    // injected) opens nothing — the network could only ever be reached per-call, through
    // methods no test invokes on the real client.
    const real = realLiveKitCallClient(CFG);
    expect(typeof real.dialSipParticipant).toBe("function");

    const { client } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);
    const { ctx } = recordingContext();
    const result = await placeCall(ctx);
    expect(result.transport.sipStatus).toBe(200);
  });
});
