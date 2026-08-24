// ModelTurnTracker — the in-flight MODEL-turn accountant, the one artifact the
// 2026-08-23 adversarial review proved every fix for the self-interrupt defect secretly
// needed. Pure and injectable-clock (the date-boundary lesson), NO vendor imports (the
// crm containment rule): the worker feeds it the same wire events it already translates,
// tests feed it directly.
//
// THE DIAGNOSIS THIS MODULE ENCODES (probe-interrupt findings E7–E11, verified twice):
//   · 3.1 withholds `turnComplete` until its own playout ESTIMATE ends:
//     turnComplete ≈ firstAudio + audioMs (dry socket, n=2, ±4ms). 🚨 A WAIT BOUND
//     ONLY — erring early is safe; the equality is NOT validated on the live telephony
//     leg. `generationToTurnCompleteLagMs` in the per-turn summary exists precisely to
//     validate it there (the review: without instrumentation the live gate is "vibes").
//   · a `sendClientContent` landing while that estimate is still running makes 3.1 emit
//     `interrupted` 47–134ms later with NO caller audio involved (n=12). On the live
//     call all three `interrupted`s were exactly this: our own next-question directive,
//     fired at answer-window expiry, into the model's still-playing auto-reply — read
//     by the worker as caller barge-in, clearQueue()ing ~60% of a 15.5s deferral.
//   · the worker's only audio stamp was `firstFrameOutAt`, set ONCE PER CALL — per-turn
//     accounting simply did not exist. This module is that missing piece.
//
// WHAT CONSUMES IT (phase 1 scope):
//   · `DirectSpeechChannel` consults `sendWaitDeadline()` before putting a directive on
//     the wire — a say must WAIT for the in-flight turn to finalize, bounded by the
//     estimate + the absolute cap (voice-direct-speech.ts).
//   · the intake loop consults the same deadline (via the seam's `modelTurnDeadline`)
//     at answer-window expiry — the unified invariant: the expiry decision may only be
//     taken after the in-flight model turn finalizes, bounded (voice-agent-session.ts).
//   · the worker LOGS `classify` readings at every `interrupted`. 🚨 Classification is
//     REPORTING ONLY this phase: it changes no flush behaviour, suppresses no event,
//     and never touches how a pending say settles — the review proved that doing so
//     without a turn-attribution state machine either re-creates the 2026-08-22
//     leak-call corruption or lands in the honest-death throw and kills the call. That
//     state machine is a LATER phase, designed against the data this module logs.
//
// WHY PER-TURN ACCOUNTING AND NOT `source.queuedDuration`: the worker's AudioSource
// already exposes remaining LOCAL playout (read at the energy meter). But the server's
// interrupt behaviour keys on the SERVER's estimate, and the measured wait signal
// (turnComplete ≈ firstAudio + audioMs, ±4ms) is server-side arithmetic this module can
// reproduce exactly from event timings; `queuedDuration` measures the local queue,
// which network jitter and capture backpressure both move away from the server's clock.
// The worker still logs `queuedDuration` at every clearQueue so the live data can
// overturn this choice.
//
// RESIDUAL, NAMED: a turn opens at its FIRST AUDIO. Between a caller commit and the
// auto-reply's first audio frame (~400ms observed) there is no wire signal at all, so a
// directive sent in that gap can still race the generation (E11: interrupt 74–134ms).
// The loop's window extension makes that gap cold on the measured path — the say that
// used to land there now follows the finalize — but the gap itself is only closable
// with a vendor-side "generation started" signal that does not exist.

/** Self-inflicted classification window: the measured latency of a clientContent-
 *  induced `interrupted` is 47–134ms (n=12, dry socket + live arithmetic); 300ms is
 *  >2x the observed maximum. */
export const SELF_INFLICTED_INTERRUPT_WINDOW_MS = 300;

/** The absolute cap on any wait derived from a model turn: the longest observed
 *  auto-reply was 15.5s of speakable audio (the destroyed deferral); 20s bounds every
 *  wait above the observed maximum while still guaranteeing progress if the server
 *  withholds `turnComplete` past its own estimate. */
export const MODEL_TURN_ABSOLUTE_CAP_MS = 20_000;

export type InterruptClassification = "self_inflicted" | "candidate_caller";

/** One finished model turn, for the log line that validates the estimate on the live
 *  leg. All timestamps are the injected clock's. */
export interface ModelTurnSummary {
  firstAudioAt: number;
  /** Sum of the turn's frame durations — the playout estimate's right operand. */
  audioMs: number;
  /** How many audio events the turn comprised (the review's per-turn parts count). */
  audioParts: number;
  /** turnComplete minus generationComplete, when the latter was observed — the number
   *  that confirms or refutes `turnComplete ≈ firstAudio + audioMs` on a real call. */
  generationToTurnCompleteLagMs?: number;
}

/** What an `interrupted` looked like from here — REPORTING ONLY this phase. */
export interface InterruptReading {
  classification: InterruptClassification;
  /** Clock delta from the last directive send; undefined when none was ever sent. */
  msSinceDirective: number | undefined;
  /** How much of the aborted turn's estimated playout had elapsed, 0..1; undefined
   *  when no turn was in flight. */
  heardFraction: number | undefined;
  /** The turn the interrupt aborted, when one was in flight. */
  abortedTurn: ModelTurnSummary | undefined;
}

interface InFlightTurn {
  firstAudioAt: number;
  audioMs: number;
  audioParts: number;
  generationCompleteAt: number | undefined;
}

export class ModelTurnTracker {
  private readonly now: () => number;
  private readonly capMs: number;
  private turn: InFlightTurn | undefined;
  private lastDirectiveSentAt: number | undefined;
  private lastCallerEvidenceAt: number | undefined;

  constructor(now: () => number, opts?: { capMs?: number }) {
    this.now = now;
    this.capMs = opts?.capMs ?? MODEL_TURN_ABSOLUTE_CAP_MS;
  }

  /** A directive of OURS just hit the wire — the classifier's reference point. */
  onDirectiveSent(): void {
    this.lastDirectiveSentAt = this.now();
  }

  /** A caller transcription fragment landed — the caller is demonstrably in the
   *  exchange, which disqualifies a later interrupt from the self-inflicted label. */
  onCallerFragment(): void {
    this.lastCallerEvidenceAt = this.now();
  }

  /** One model audio event, with its frame duration. Returns true when this frame
   *  OPENED a turn (the worker's `model-turn-open` log line). Per-turn on purpose:
   *  the once-per-call stamp is the defect this module replaces. */
  onAudioFrame(durationMs: number): boolean {
    if (this.turn === undefined) {
      this.turn = {
        firstAudioAt: this.now(),
        audioMs: durationMs,
        audioParts: 1,
        generationCompleteAt: undefined,
      };
      return true;
    }
    this.turn.audioMs += durationMs;
    this.turn.audioParts += 1;
    return false;
  }

  /** The server finished GENERATING (playout continues) — the lag's left edge. */
  onGenerationComplete(): void {
    if (this.turn !== undefined && this.turn.generationCompleteAt === undefined) {
      this.turn.generationCompleteAt = this.now();
    }
  }

  /** The wire's own finalize signal. Closes the turn and returns its summary for the
   *  instrumentation line; undefined when no audio ever opened one. */
  onTurnComplete(): ModelTurnSummary | undefined {
    const t = this.turn;
    if (t === undefined) return undefined;
    this.turn = undefined;
    return {
      firstAudioAt: t.firstAudioAt,
      audioMs: t.audioMs,
      audioParts: t.audioParts,
      ...(t.generationCompleteAt !== undefined
        ? { generationToTurnCompleteLagMs: this.now() - t.generationCompleteAt }
        : {}),
    };
  }

  /** An `interrupted` off the wire: classify it (REPORTING ONLY — see the header) and
   *  close the in-flight turn, because the server aborts the turn's playout either
   *  way. SELF_INFLICTED = within the measured window of our own send with no caller
   *  evidence since that send; everything else stays CANDIDATE_CALLER — the honest
   *  default, because mislabelling a real caller costs more than mislabelling a race. */
  onInterrupted(): InterruptReading {
    const at = this.now();
    const heardFraction = this.heardFraction();
    const abortedTurn = this.onTurnComplete(); // the server aborted it; account it closed
    const msSinceDirective =
      this.lastDirectiveSentAt === undefined ? undefined : at - this.lastDirectiveSentAt;
    const evidenceSinceSend =
      this.lastDirectiveSentAt !== undefined &&
      this.lastCallerEvidenceAt !== undefined &&
      this.lastCallerEvidenceAt >= this.lastDirectiveSentAt;
    const classification: InterruptClassification =
      msSinceDirective !== undefined &&
      msSinceDirective <= SELF_INFLICTED_INTERRUPT_WINDOW_MS &&
      !evidenceSinceSend
        ? "self_inflicted"
        : "candidate_caller";
    return { classification, msSinceDirective, heardFraction, abortedTurn };
  }

  isTurnInFlight(): boolean {
    return this.turn !== undefined;
  }

  /** The absolute clock time a sender should wait until before putting a directive on
   *  the wire: the playout estimate (firstAudio + audioMs), capped absolutely so no
   *  turn can demand an unbounded wait. Undefined = nothing in flight, send freely.
   *  May legitimately read in the PAST when the server runs late — consumers treat it
   *  as "wait no longer than this", never as a promise the turn will finalize by it. */
  sendWaitDeadline(): number | undefined {
    const t = this.turn;
    if (t === undefined) return undefined;
    return t.firstAudioAt + Math.min(t.audioMs, this.capMs);
  }

  /** How much of the in-flight turn's estimated playout has elapsed, 0..1. */
  heardFraction(): number | undefined {
    const t = this.turn;
    if (t === undefined || t.audioMs <= 0) return undefined;
    const elapsed = this.now() - t.firstAudioAt;
    return Math.min(Math.max(elapsed / t.audioMs, 0), 1);
  }
}
