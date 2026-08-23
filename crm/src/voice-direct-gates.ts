// PreVerdictGate — the decidable replacement for AMD's `pauseReplyAuthorization` on the
// direct socket, and a strictly STRONGER property than the one it replaces.
//
// WHAT THE LIBRARY DOES (traced end to end after the 2026-08-21 live call): AMD's
// execute() calls `session.pauseReplyAuthorization()` (amd.ts:398), which pauses
// PLAYBACK — the model still hears everything and still generates; tokens burn,
// transcripts flow, and only the last hop to the caller is held
// (agent_activity.ts:924, :2235, :3705-3712). The model has already been TALKED TO by
// the voicemail greeting; we merely hope nothing leaks.
//
// WHAT THIS GATE DOES: pre-verdict, the model receives NOTHING — no caller audio is
// forwarded to Gemini at all, and no directive may be sent. A model that never heard
// the answering machine cannot speak to it EVEN IN PRINCIPLE. That is the voicemail-
// protection property, and it is only possible because on the direct socket WE own the
// audio pump (the worker forwards frames through this gate; AMD hears the caller via a
// separate tee that BYPASSES it — AMD must classify exactly the audio the model is
// being protected from).
//
// THE VERDICT VOCABULARY is `mapAmdCategory`'s range (call-bridge.ts:79-90) — already
// this repo's raw grammar, never the vendor's:
//   · "human"   → open. The script runs.
//   · "unknown" → open. `runIntakeCall` runs the script for unknown — hanging up on a
//     possible human is worse than asking (voice-agent-session.ts:198-199) — and a gate
//     that stayed closed on unknown would silence exactly those calls.
//   · "machine" → closed FOREVER. Terminal in both directions: a late "human" cannot
//     reopen a voicemail call, and a late "machine" closes an optimistically-opened
//     gate. (On the live path AMD settles once; the gate does not depend on that.)
//
// THE COUNTERS ARE NOT TELEMETRY DECORATION: a test asserting "nothing was forwarded"
// with zero frames offered passes with the gate deleted. `droppedFrameCount()` is the
// anti-vacuity guard — the gate must be SEEN refusing — and at runtime it is the
// operator's proof that pre-verdict audio actually existed and actually died here.

/** `mapAmdCategory`'s range (call-bridge.ts) — the only vocabulary this gate speaks. */
export type AmdScriptVerdict = "human" | "machine" | "unknown";

export class PreVerdictGate {
  private state: "pending" | "open" | "machine" = "pending";
  private dropped = 0;
  private forwarded = 0;

  /** The AMD verdict, in this repo's raw grammar. Machine is sticky — see the header. */
  settle(verdict: AmdScriptVerdict): void {
    if (verdict === "machine") {
      this.state = "machine"; // machine wins whenever it arrives
      return;
    }
    if (this.state === "machine") return; // …and nothing un-wins it
    this.state = "open";
  }

  /** Offer one caller-audio frame for forwarding to Gemini. Returns the SAME frame when
   *  the gate is open (no copy on the hot path), or null — counted — when it is not.
   *  Generic so the worker can pass whatever its pump carries; the gate decides, it
   *  never inspects. */
  offerCallerFrame<T>(frame: T): T | null {
    if (this.state === "open") {
      this.forwarded += 1;
      return frame;
    }
    this.dropped += 1;
    return null;
  }

  /** May a DirectiveTurn be sent? False until a non-machine verdict settles — the
   *  pre-verdict half of "the model cannot speak to an answering machine": no
   *  directive, no generation, nothing for a paused-playback bug to leak. */
  maySendDirective(): boolean {
    return this.state === "open";
  }

  /** Frames offered while closed. The anti-vacuity guard (see the header). */
  droppedFrameCount(): number {
    return this.dropped;
  }

  /** Frames passed since the gate opened. */
  forwardedFrameCount(): number {
    return this.forwarded;
  }
}
