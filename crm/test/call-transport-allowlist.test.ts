// Call allowlist pins, TRANSPORT half (A5) — the SECOND check, inside `livekitPlaceCall`,
// so even a caller that bypasses the executor cannot dial an unlisted number. The email
// twin of this property is `smtpSender`'s re-check (email-spike review I5: the fail-closed
// property must belong to the thing that reaches the vendor, not to one call site).
//
// NO NETWORK. The vendor client is a fake handed through the factory's injection seam;
// nothing in this file can open a socket.
import { describe, it, expect } from "vitest";
import {
  livekitPlaceCall,
  type LiveKitCallClient,
  type LiveKitCallConfig,
} from "../src/call-transport.js";
import type { CallContext } from "../src/executor.js";

const CFG: LiveKitCallConfig = {
  url: "wss://example.livekit.invalid",
  apiKey: "lk-key",
  apiSecret: "lk-secret",
  sipTrunkId: "trunk-1",
  agentName: "switchboard-intake",
  modelApiKey: "model-key",
  phoneAllowlist: ["+639171234567"],
};

const HUMAN_REPORT = JSON.stringify({
  v: 1,
  amdResult: "human",
  conversation: "identity_not_asked_complete",
  answersPersisted: 0,
  reachedOrdinal: 0,
});

function ctxFor(phoneE164: string): CallContext {
  return {
    touchId: "00000000-0000-0000-0000-0000000000d4",
    payload: {
      contact_id: "00000000-0000-0000-0000-0000000000a1",
      phone_number_id: "00000000-0000-0000-0000-0000000000b2",
      phone_e164: phoneE164,
      display_name: "Ana Reyes",
      opening_line: "Hi, may I speak with Ana Reyes?",
      question_set_id: "00000000-0000-0000-0000-0000000000c3",
      context: { source_detail: "Rotary breakfast", looking_for: "a 2BR near Alabang" },
    },
    prompts: [],
    answer: async () => {},
    reached: async () => {},
  };
}

function fakeClient(): { client: LiveKitCallClient; ops: string[] } {
  const ops: string[] = [];
  const client: LiveKitCallClient = {
    dispatchAgent: async (roomName, agentName) => {
      ops.push(`dispatch:${roomName}:${agentName}`);
    },
    dialSipParticipant: async (roomName, phoneE164) => {
      ops.push(`dial:${roomName}:${phoneE164}`);
      return { sipCallId: "SCL_fake" };
    },
    awaitCallReport: async (roomName) => {
      ops.push(`awaitReport:${roomName}`);
      return HUMAN_REPORT;
    },
    deleteRoom: async (roomName) => {
      ops.push(`deleteRoom:${roomName}`);
    },
  };
  return { client, ops };
}

describe("A5: livekitPlaceCall re-checks the allowlist immediately before the dial", () => {
  // mutation (A5): delete the `checkCallable` block from the returned PlaceCall -> the
  //   unlisted number is dialled and both refusal rows red.
  //   RUN ✅ 2026-08-19 — observed:
  //     Tests  2 failed | 3 passed (5)
  //     AssertionError: promise resolved "{ transport: { …(2) }, …(1) }" instead of rejecting
  //     × refuses an unlisted number even when the executor check is bypassed
  //     × a prefix on the allowlist permits nothing at the transport either
  it("refuses an unlisted number even when the executor check is bypassed", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);

    // The transport is invoked DIRECTLY — no executor, no first check.
    await expect(placeCall(ctxFor("+639998887777"))).rejects.toThrow("+639998887777");

    // Nothing reached the vendor: no dispatch, no dial, nothing to clean up.
    expect(ops).toEqual([]);
  });

  it("dials an allowlisted number exactly as before", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall(CFG, client);

    const result = await placeCall(ctxFor("+639171234567"));

    expect(ops).toContain("dial:call-00000000-0000-0000-0000-0000000000d4:+639171234567");
    expect(result.transport).toEqual({ sipStatus: 200, amdResult: "human" });
  });

  it("a prefix on the allowlist permits nothing at the transport either", async () => {
    const { client, ops } = fakeClient();
    const placeCall = livekitPlaceCall({ ...CFG, phoneAllowlist: ["+63"] }, client);

    await expect(placeCall(ctxFor("+639171234567"))).rejects.toThrow(/allowlist/);
    expect(ops).toEqual([]);
  });
});

describe("A5 (construction): a dialer that may dial nobody refuses to be built", () => {
  // The L1 doctrine carried onto the allowlist: an EMPTY allowlist on the LIVE transport
  // means every call this factory could ever place would be refused — a composition-time
  // misconfiguration, so it dies at composition time, loudly, naming the fix. (The
  // executor-level check still fail-closes at runtime for everything else.)
  it("an empty phone allowlist throws at construction, naming SWITCHBOARD_PHONE_ALLOWLIST", () => {
    expect(() => livekitPlaceCall({ ...CFG, phoneAllowlist: [] }, fakeClient().client)).toThrow(
      /SWITCHBOARD_PHONE_ALLOWLIST/,
    );
  });

  it("a malformed allowlist entry throws at construction", () => {
    expect(() =>
      livekitPlaceCall({ ...CFG, phoneAllowlist: ["0917-123-4567"] }, fakeClient().client),
    ).toThrow(/E\.164/);
  });
});
