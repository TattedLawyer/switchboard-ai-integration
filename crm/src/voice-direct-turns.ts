// TurnAssembler — the caller-turn state machine that feeds `nextFinalTranscript` on the
// direct socket. On the plugin path the library assembled turns for us (and stamped
// `turnStartedAt` from its own generation clock — voice-agent-session.ts:102-115); on
// the raw socket the wire hands us FRAGMENTS (`inputTranscription`, one word or less at
// a time — PROOF-direct-socket-all4-passed.log:86-97) and turn boundaries, and this
// module owns the one decidable question the binding table depends on: WHEN did the
// caller's turn begin?
//
// THE RULES (each one carries a log line):
//   · A turn OPENS at the first `inputTranscription` fragment OR an `interrupted`
//     event, whichever is observed first — an interrupt is the caller's voice arriving
//     before its transcription (log :168 vs :172: the interrupt beat the first fragment
//     by 700ms). `turnStartedAt` is the INJECTED clock at that moment: decidable logic
//     never calls Date.now() itself (the date-boundary lesson — three failures, one
//     root cause).
//   · Fragments ACCUMULATE verbatim (they arrive with their own leading spaces); the
//     final transcript is the raw join, trimmed at the edges only.
//   · The turn FINALIZES at the next `turnComplete`, when say() re-arms (a new
//     directive opens a new answer window — whatever was said belongs to the old one),
//     or on drain (teardown).
//   · Whitespace-only assemblies are DISCARDED — the existing V2 semantics
//     (voice-agent-session.ts:375: whitespace is silence, not an answer).
//
// 🔴 F4a — THE CARRY (review amendment; log :168-176): `interrupted` and `turnComplete`
// arrived 2ms apart with the caller's fragments landing only 700ms LATER. The naive
// rule finalizes an EMPTY turn at that turnComplete and then stamps the real words at
// their late arrival — losing the interrupt-time stamp, which is the one timestamp that
// proves the caller began speaking at the barge-in. So: an open-but-empty turn whose
// evidence is an INTERRUPT does not die at a turn boundary — the stamp CARRIES to the
// fragments that follow. (A turn opened only by whitespace fragments takes the V2
// discard instead: whitespace is not evidence anyone spoke.) The carry is released at
// drain — there will never be fragments to carry it to.
//
// 🔴 F4b — THE OPEN-TURN SURFACE (review amendment; log :60): fragments can arrive as
// ONE end-of-utterance batch ~3s after speech began (" connectivity, New York." landed
// whole at 25855). If answer window i times out mid-answer and say(i+1) voices before
// the batch lands, `bindTurn` files the answer under i+1 — the exact misfile class
// e10a401 exists to prevent. `isTurnOpen()` is the mitigation's decidable half: the
// intake loop can see a turn is open and EXTEND the window instead of expiring onto a
// mid-speech caller. (The extension policy itself is the loop's, in Step 1 — this
// module only refuses to make the state invisible.)
import type { TimedTranscript } from "./voice-agent-session.js";

export class TurnAssembler {
  private readonly now: () => number;
  private fragments: string[] = [];
  private turnStartedAt: number | undefined;
  /** Whether the OPEN of the current turn was an interrupt — the F4a carry only applies
   *  to interrupt-opened turns (see the header: whitespace fragments are not evidence). */
  private openedByInterrupt = false;

  constructor(now: () => number) {
    this.now = now;
  }

  /** F4b's surface: is a caller turn currently accumulating? True from open to
   *  finalize — including across a carried empty finalize (F4a), where the caller is
   *  demonstrably mid-speech and the transcription simply has not landed yet. */
  isTurnOpen(): boolean {
    return this.turnStartedAt !== undefined;
  }

  /** The open turn's stamp, or undefined when none is open. The AGE discriminator the
   *  answer-window invariant needs: an F4a carry can hold `isTurnOpen()` true for the
   *  rest of the call, so the intake loop bounds its window extension by how long ago
   *  the turn STARTED — and this stamp (the carried one included, unrestamped) is the
   *  only surface that age can be computed from (voice-agent-session.ts, the unified
   *  expiry invariant). */
  openTurnStartedAt(): number | undefined {
    return this.turnStartedAt;
  }

  /** One `inputTranscription` fragment off the wire, verbatim. Opens the turn if none
   *  is open; the FIRST evidence wins the stamp — later fragments never restamp. */
  onInputTranscription(text: string): void {
    if (this.turnStartedAt === undefined) this.turnStartedAt = this.now();
    this.fragments.push(text);
  }

  /** The server's `interrupted` event. Opens a turn (the caller's voice arrived before
   *  its transcription) — but never RESTAMPS one already open: an interrupt during an
   *  open turn is the model being cut off mid-reply, not a new caller turn. */
  onInterrupted(): void {
    if (this.turnStartedAt === undefined) {
      this.turnStartedAt = this.now();
      this.openedByInterrupt = true;
    }
  }

  /** The server's `turnComplete` — the wire's own finalize signal. */
  onTurnComplete(): TimedTranscript | null {
    return this.finalize(false);
  }

  /** The loop is about to voice the next utterance: whatever accumulated belongs to the
   *  window that is CLOSING, so it must be finalized before the new one opens — a queue
   *  entry straddling windows is the misfile e10a401 fixed. The F4a carry survives this
   *  boundary too: a re-arm 2ms after an interrupt must not eat the interrupt stamp. */
  onSayRearm(): TimedTranscript | null {
    return this.finalize(false);
  }

  /** Teardown: emit what exists, release everything — including an interrupt carry,
   *  which has nothing left to carry to once the call is over. */
  drain(): TimedTranscript | null {
    return this.finalize(true);
  }

  private finalize(isDrain: boolean): TimedTranscript | null {
    if (this.turnStartedAt === undefined) return null; // nothing ever opened
    const transcript = this.fragments.join("").trim();
    if (transcript !== "") {
      const turn: TimedTranscript = { transcript, turnStartedAt: this.turnStartedAt };
      this.reset();
      return turn;
    }
    // Empty assembly. F4a: an interrupt-opened turn CARRIES its stamp across a turn
    // boundary (the fragments are still in flight) — except at drain, which is the end
    // of the line. Whitespace-opened turns take the V2 discard either way.
    if (this.openedByInterrupt && !isDrain) {
      this.fragments = []; // the whitespace, if any, is still discarded
      return null;
    }
    this.reset();
    return null;
  }

  private reset(): void {
    this.fragments = [];
    this.turnStartedAt = undefined;
    this.openedByInterrupt = false;
  }
}
